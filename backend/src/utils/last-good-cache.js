import $ from '@/core/app';
import { CacheShards, jsonBytes, SHARD_BYTES } from '@/utils/cache-shards';
import { LAST_GOOD_CACHE_KEY } from '@/constants';

// Opt-in last successful geo result (scripts/check/geo.js keep_last).
// This store is the explicit exception to the global scriptCacheTtl rule:
// entries stay until a newer success overwrites them, keep_last_max_age
// rejects them at read time, or refresh/clear-cache calls revokeAll().
// Writes batch like script-resource-cache. Large maps use CacheShards so
// one value stays under the iOS $persistentStore limit.
const BATCH = 25;
const DEBOUNCE_MS = 200;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export class LastGoodCache {
    constructor(storeKey = LAST_GOOD_CACHE_KEY, io = {}) {
        this.storeKey = storeKey;
        this.shards = new CacheShards(storeKey, {
            read: io.read,
            write: io.write,
        });
        this.entries = this.shards.load();
        this._dirty = false;
        this._timer = null;
        this._writesSinceFlush = 0;
        this._flushing = false;
    }

    get(id) {
        const entry = this.entries[id];
        if (
            !entry ||
            entry.api == null ||
            !Number.isFinite(Number(entry.savedAt))
        ) {
            return null;
        }
        return clone(entry);
    }

    set(id, value) {
        if (!id || value == null || value.api == null) return false;
        const entry = {
            api: clone(value.api),
            savedAt: Number(value.savedAt),
        };
        if (!Number.isFinite(entry.savedAt)) return false;
        if (jsonBytes([id, entry]) > SHARD_BYTES) return false;
        this.entries[id] = entry;
        this._schedule();
        return true;
    }

    revokeAll() {
        this.entries = {};
        this._writeThrough();
    }

    flush() {
        if (this._flushing) return;
        this._flushing = true;
        try {
            this._clearTimer();
            this._writesSinceFlush = 0;
            if (!this._dirty) return;
            this._dirty = false;
            this.shards.save(this.entries);
        } finally {
            this._flushing = false;
        }
    }

    _writeThrough() {
        this._clearTimer();
        this._dirty = false;
        this._writesSinceFlush = 0;
        this.shards.save(this.entries);
    }

    _clearTimer() {
        if (this._timer != null && typeof clearTimeout === 'function') {
            clearTimeout(this._timer);
        }
        this._timer = null;
    }

    _schedule() {
        this._dirty = true;
        this._writesSinceFlush += 1;
        if (this._writesSinceFlush >= BATCH) {
            this.flush();
            return;
        }
        if (this._timer != null) return;
        if (typeof setTimeout !== 'function') {
            this.flush();
            return;
        }
        this._timer = setTimeout(() => {
            this._timer = null;
            this.flush();
        }, DEBOUNCE_MS);
        if (this._timer && typeof this._timer.unref === 'function') {
            this._timer.unref();
        }
    }
}

const cache = new LastGoodCache();

export default cache;
