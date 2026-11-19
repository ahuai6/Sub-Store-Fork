import $ from '@/core/app';
import { hex_md5 } from '@/vendor/md5';

export const SHARD_BYTES = 3 * 1024 * 1024;
const INLINE_BYTES = 64 * 1024;
const UTF8_ENCODER = new TextEncoder();

export function utf8Bytes(text) {
    return UTF8_ENCODER.encode(text).length;
}

export function jsonBytes(value) {
    return utf8Bytes(JSON.stringify(value));
}

// Small maps keep the legacy layout. Large maps migrate to one host-store
// value per cache key; the old key becomes a versioned manifest. # keys use
// independent $persistentStore values on iOS, without changing core JSON files.
export class CacheShards {
    constructor(key, { read, write } = {}) {
        this.key = key;
        this.read = read || ((key) => $.read(key));
        this.write = write || ((value, key) => $.write(value, key));
        this.keys = [];
        this._keySet = new Set();
        this.encoded = new Map();
        this.sharded = false;
        this.legacy = {};
        this._manifestLoaded = false;
    }

    ensureManifest() {
        if (!this._manifestLoaded) {
            this.loadManifest();
        }
    }

    isSharded() {
        this.ensureManifest();
        return this.sharded && Object.keys(this.legacy).length === 0;
    }

    shardKeyFor(id) {
        return `${this.key}:v1:${hex_md5(id)}`;
    }

    loadManifest() {
        try {
            const value = JSON.parse(this.read(this.key) || '{}');
            if (value?.cacheShardsVersion === 1 && Array.isArray(value.keys)) {
                this.sharded = true;
                this.keys = value.keys.filter(
                    (key) =>
                        typeof key === 'string' &&
                        key.startsWith(`${this.key}:v1:`),
                );
                this._keySet = new Set(this.keys);
                this.legacy = value.legacy || {};
                this._manifestLoaded = true;
                return { sharded: true, entries: { ...this.legacy } };
            }
            this.sharded = false;
            this.keys = [];
            this._keySet = new Set();
            this.legacy =
                value && typeof value === 'object' && !Array.isArray(value)
                    ? value
                    : {};
            this._manifestLoaded = true;
            return { sharded: false, entries: { ...this.legacy } };
        } catch (e) {
            this.sharded = false;
            this.keys = [];
            this._keySet = new Set();
            this.legacy = {};
            this._manifestLoaded = true;
            return { sharded: false, entries: {} };
        }
    }

    /**
     * Read a single entry without loading unrelated shard payloads.
     */
    readEntry(id) {
        if (!id) return undefined;
        this.ensureManifest();
        if (!this.sharded) {
            return this.legacy[id];
        }
        if (
            this.legacy &&
            Object.prototype.hasOwnProperty.call(this.legacy, id)
        ) {
            return this.legacy[id];
        }
        const shardKey = this.shardKeyFor(id);
        if (!this._keySet.has(shardKey)) {
            return undefined;
        }
        try {
            const text = this.encoded.has(shardKey)
                ? this.encoded.get(shardKey)
                : this.read(shardKey);
            if (!text) return undefined;
            const pair = JSON.parse(text);
            if (Array.isArray(pair) && pair.length === 2) {
                this.encoded.set(shardKey, text);
                return pair[0] === id ? pair[1] : undefined;
            }
        } catch (e) {
            /* A corrupt shard must not break lookups. */
        }
        return undefined;
    }

    /**
     * Write only dirty entries when the store is already sharded, avoiding
     * reading or re-encoding unrelated shards. Returns null if a full
     * load + save migration is needed.
     */
    writeEntries(entries) {
        if (!this.isSharded()) return null;
        const prepared = [];
        const added = [];
        const addedSet = new Set();
        for (const [id, entry] of Object.entries(entries || {})) {
            const text = JSON.stringify([id, entry]);
            if (utf8Bytes(text) > SHARD_BYTES) continue;
            const shardKey = this.shardKeyFor(id);
            prepared.push({ shardKey, text });
            if (!this._keySet.has(shardKey) && !addedSet.has(shardKey)) {
                added.push(shardKey);
                addedSet.add(shardKey);
            }
        }
        if (!prepared.length) return true;
        if (added.length > 0) {
            const nextKeys = [...this.keys, ...added];
            const manifestText = JSON.stringify({
                cacheShardsVersion: 1,
                keys: nextKeys,
            });
            if (utf8Bytes(manifestText) > SHARD_BYTES) return false;
            if (this.write(manifestText, this.key) === false) return false;
            this.keys = nextKeys;
            this._keySet = new Set(nextKeys);
        }
        for (const { shardKey, text } of prepared) {
            if (this.encoded.get(shardKey) !== text) {
                if (this.write(text, shardKey) === false) return false;
                this.encoded.set(shardKey, text);
            }
        }
        return true;
    }

    /**
     * Delete specific keys from an already-sharded store without loading
     * unrelated shards. Returns null if a full load + save is needed.
     */
    deleteEntries(ids) {
        if (!this.isSharded()) return null;
        const toDelete = [];
        const toDeleteSet = new Set();
        for (const id of ids || []) {
            if (!id) continue;
            const shardKey = this.shardKeyFor(id);
            if (this._keySet.has(shardKey) && !toDeleteSet.has(shardKey)) {
                toDelete.push(shardKey);
                toDeleteSet.add(shardKey);
            }
        }
        if (!toDelete.length) return true;
        for (const shardKey of toDelete) {
            if (this.write(null, shardKey) === false) return false;
            this.encoded.delete(shardKey);
        }
        const nextKeys = this.keys.filter((key) => !toDeleteSet.has(key));
        if (!nextKeys.length) {
            if (this.write('{}', this.key) === false) return false;
            this.keys = [];
            this._keySet = new Set();
            this._manifestLoaded = true;
            this.sharded = false;
            this.legacy = {};
            return true;
        }
        const manifestText = JSON.stringify({
            cacheShardsVersion: 1,
            keys: nextKeys,
        });
        if (utf8Bytes(manifestText) > SHARD_BYTES) return false;
        if (this.write(manifestText, this.key) === false) return false;
        this.keys = nextKeys;
        this._keySet = new Set(nextKeys);
        return true;
    }

    load() {
        const { sharded, entries } = this.loadManifest();
        if (!sharded) {
            return entries;
        }
        for (const key of this.keys) {
            try {
                const text = this.encoded.has(key)
                    ? this.encoded.get(key)
                    : this.read(key);
                const pair = JSON.parse(text);
                if (Array.isArray(pair) && pair.length === 2) {
                    entries[pair[0]] = pair[1];
                    this.encoded.set(key, text);
                }
            } catch (e) {
                /* A corrupt shard must not hide other keys. */
            }
        }
        return entries;
    }

    clearAll() {
        const prevKeys = [...this.keys];
        this.loadManifest();
        this.keys = [...new Set([...prevKeys, ...this.keys])];
        this._keySet = new Set(this.keys);
        return this.save({});
    }

    save(entries) {
        const previous = this.keys;
        if (!this.sharded && !previous.length) {
            const inlineText = JSON.stringify(entries);
            if (utf8Bytes(inlineText) <= INLINE_BYTES) {
                const ok = this.write(inlineText, this.key) !== false;
                if (ok) {
                    this.legacy = { ...entries };
                    this._manifestLoaded = true;
                }
                return ok;
            }
        }
        const prepared = [];
        const keys = [];
        for (const [id, entry] of Object.entries(entries)) {
            const text = JSON.stringify([id, entry]);
            if (utf8Bytes(text) > SHARD_BYTES) continue;
            const key = this.shardKeyFor(id);
            prepared.push({ key, text });
            keys.push(key);
        }
        const hasLegacy = Object.keys(this.legacy).length > 0;
        const sameKeySet =
            this.sharded &&
            !hasLegacy &&
            keys.length === previous.length &&
            keys.every((key) => this._keySet.has(key));
        if (sameKeySet && keys.length > 0) {
            for (const { key, text } of prepared) {
                if (this.encoded.get(key) !== text) {
                    if (this.write(text, key) === false) return false;
                    this.encoded.set(key, text);
                }
            }
            this._manifestLoaded = true;
            return true;
        }
        const tracked = [...new Set([...previous, ...keys])];
        const staging = {
            cacheShardsVersion: 1,
            keys: tracked,
            ...(hasLegacy ? { legacy: this.legacy } : {}),
        };
        const stagingText = JSON.stringify(staging);
        if (utf8Bytes(stagingText) > SHARD_BYTES) return false;
        if (this.write(stagingText, this.key) === false) return false;
        this.keys = tracked;
        this._keySet = new Set(tracked);
        this.sharded = true;
        for (const { key, text } of prepared) {
            if (this.encoded.get(key) !== text) {
                if (this.write(text, key) === false) return false;
                this.encoded.set(key, text);
            }
        }
        const nextKeys = new Set(keys);
        for (const key of previous) {
            if (!nextKeys.has(key)) {
                if (this.write(null, key) === false) return false;
                this.encoded.delete(key);
            }
        }
        if (!keys.length) {
            if (this.write('{}', this.key) === false) return false;
            this.keys = [];
            this._keySet = new Set();
            this._manifestLoaded = true;
            this.sharded = false;
            this.legacy = {};
            return true;
        }
        const manifestText = JSON.stringify({ cacheShardsVersion: 1, keys });
        if (utf8Bytes(manifestText) > SHARD_BYTES) return false;
        if (this.write(manifestText, this.key) === false) return false;
        this.keys = keys;
        this._keySet = new Set(keys);
        this._manifestLoaded = true;
        this.sharded = true;
        this.legacy = {};
        return true;
    }
}
