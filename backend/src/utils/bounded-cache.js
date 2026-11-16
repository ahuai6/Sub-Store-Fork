import $ from '@/core/app';
import { CacheShards, jsonBytes } from '@/utils/cache-shards';

// One $persistentStore value is capped at 4 MB on Surge iOS. Stay under that
// with room for JSON quoting. Unsharded maps evict oldest entries; sharded
// maps isolate entries so an unrelated subscription is never evicted.
export const STORE_BUDGET_BYTES = 3 * 1024 * 1024;
export const DEFAULT_ENTRY_BUDGET_BYTES = 1024 * 1024;

export function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    const keys = Object.keys(value)
        .filter((key) => typeof value[key] !== 'function')
        .sort();
    return `{${keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(',')}}`;
}

function byteLength(value) {
    try {
        return jsonBytes(value);
    } catch (e) {
        return Infinity;
    }
}

export class BatchFlush {
    constructor(onFlush, { batchSize = 25, debounceMs = 200 } = {}) {
        this.onFlush = onFlush;
        this.batchSize = batchSize;
        this.debounceMs = debounceMs;
        this.dirty = false;
        this.timer = null;
        this.writesSinceFlush = 0;
        this.flushing = false;
    }

    clearTimer() {
        if (this.timer != null && typeof clearTimeout === 'function') {
            clearTimeout(this.timer);
        }
        this.timer = null;
    }

    reset() {
        this.clearTimer();
        this.dirty = false;
        this.writesSinceFlush = 0;
    }

    schedule() {
        this.dirty = true;
        this.writesSinceFlush += 1;
        if (this.writesSinceFlush >= this.batchSize) {
            this.flush();
            return;
        }
        if (this.timer != null) return;
        if (typeof setTimeout !== 'function') {
            this.flush();
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, this.debounceMs);
        if (this.timer && typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    flush() {
        if (this.flushing) return;
        this.flushing = true;
        try {
            this.clearTimer();
            this.writesSinceFlush = 0;
            if (!this.dirty) return;
            this.dirty = false;
            this.onFlush();
        } finally {
            this.flushing = false;
        }
    }
}

/**
 * Time-bounded persistent map.
 *
 * `id` is only the lookup key. get() returns nothing once `time` has passed,
 * including when the caller asks for the same id again. Callers recompute and
 * set() replaces the entry. There is no "unchanged content" exception.
 */
export class BoundedCache {
    constructor({
        storeKey,
        resolveTtl,
        label,
        budget = STORE_BUDGET_BYTES,
        read,
        write,
        sharded = false,
        batched = false,
    }) {
        this.storeKey = storeKey;
        this.resolveTtl = resolveTtl;
        this.label = label || storeKey;
        this.budget = budget;
        this.now = () => Date.now();
        this._read = read || ((key) => $.read(key));
        this._write = write || ((value, key) => $.write(value, key));
        this.shards = sharded
            ? new CacheShards(storeKey, {
                  read: this._read,
                  write: this._write,
              })
            : null;
        this._batch = batched ? new BatchFlush(() => this._persist()) : null;
        this._seq = 0;
        this._loaded = false;
        this._entries = {};
    }

    get entries() {
        this._ensureLoaded();
        return this._entries;
    }

    set entries(value) {
        this._loaded = true;
        this._entries = value;
    }

    _ensureLoaded() {
        if (this._loaded) return;
        this._loaded = true;
        this._load();
    }

    _load() {
        if (this.shards) {
            this._entries = this.shards.load();
            if (this._dropExpired(false)) this._persist();
            return;
        }
        const raw = this._read(this.storeKey);
        if (!raw) {
            this._entries = {};
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            this._entries =
                parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? parsed
                    : {};
        } catch (e) {
            $.error(
                `解析持久化缓存中的 ${this.storeKey} 失败, 重置为 {}, 错误: ${
                    e?.message ?? e
                }`,
            );
            this._entries = {};
            this._write('{}', this.storeKey);
        }
        this._dropExpired(false);
    }

    _persist() {
        if (this.shards) return this.shards.save(this._entries);
        return this._write(JSON.stringify(this._entries), this.storeKey);
    }

    _schedulePersist() {
        if (this._batch) {
            this._batch.schedule();
            return true;
        }
        return this._persist() !== false;
    }

    flush() {
        if (this._batch) {
            this._batch.flush();
        }
    }

    _dropExpired(persist) {
        this._ensureLoaded();
        const now = this.now();
        let changed = false;
        for (const id of Object.keys(this._entries)) {
            const cached = this._entries[id];
            if (!cached || !cached.time || this._expires(cached) <= now) {
                delete this._entries[id];
                changed = true;
            }
        }
        if (changed && persist) this._persist();
        return changed;
    }

    revokeAll() {
        if (this._batch) this._batch.reset();
        if (this.shards && !this._loaded) {
            this._entries = {};
            this._loaded = true;
            this.shards.clearAll();
            return;
        }
        this._entries = {};
        this._loaded = true;
        this._persist();
    }

    _expires(cached) {
        return cached.created != null
            ? Math.min(cached.time, cached.created + this.resolveTtl())
            : cached.time; // Legacy entries retain their original deadline.
    }

    get(id) {
        if (!(this.resolveTtl() > 0)) return null;
        let cached;
        if (!this._loaded && this.shards) {
            cached = this.shards.readEntry(id);
        } else {
            this._ensureLoaded();
            cached = this._entries[id];
        }
        if (!cached || !cached.time) return null;
        // Expired entries are not reusable, even when id still matches.
        if (this.now() >= this._expires(cached)) {
            this._ensureLoaded();
            delete this._entries[id];
            this._schedulePersist();
            return null;
        }
        return cached.data;
    }

    entryBudget() {
        return DEFAULT_ENTRY_BUDGET_BYTES;
    }

    set(id, value, ttlMs) {
        const ttl = Math.min(
            normalizePositive(ttlMs) ?? this.resolveTtl(),
            this.resolveTtl(),
        );
        if (!(ttl > 0)) return false;
        const now = this.now();
        const nextSeq = this._seq + 1;
        const entry = {
            time: now + ttl,
            created: now,
            seq: nextSeq,
            data: value,
        };
        const dataBytes = byteLength(value);
        const storedBytes = byteLength(entry);
        const entryBudget = this.entryBudget();
        if (
            !Number.isFinite(dataBytes) ||
            dataBytes > entryBudget ||
            storedBytes > this.budget
        ) {
            $.info(
                `${this.label} 跳过缓存: ${dataBytes} 字节超过单条上限 ${entryBudget} 或总上限 ${this.budget}`,
            );
            return false;
        }
        this._seq = nextSeq;
        this._ensureLoaded();
        this._entries[id] = entry;
        this._dropExpired(false);
        if (!this.shards) this._evictOldest();
        if (!this._entries[id]) return false;
        return this._schedulePersist();
    }

    _evictOldest() {
        const overflow = () => byteLength(this._entries) > this.budget;
        if (!overflow()) return;
        const order = Object.keys(this._entries).sort((a, b) => {
            const left = this._entries[a] || {};
            const right = this._entries[b] || {};
            return (
                (left.seq || left.created || 0) -
                (right.seq || right.created || 0)
            );
        });
        for (const id of order) {
            if (!overflow()) break;
            delete this._entries[id];
        }
    }
}

export function normalizePositive(ttl) {
    const value = Number(ttl);
    if (!Number.isFinite(value) || value <= 0) return null;
    return value;
}

/**
 * Positive seconds in `settings[name]` become milliseconds.
 * A stored 0 or negative value disables the cache (no fallback).
 * A missing setting uses `fallbackMs`.
 */
export function ttlFromSetting(readSettings, name, fallbackMs) {
    const settings = readSettings() || {};
    if (Object.prototype.hasOwnProperty.call(settings, name)) {
        const seconds = Number(settings[name]);
        if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
        return 0;
    }
    return fallbackMs;
}
