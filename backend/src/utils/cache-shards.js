import $ from '@/core/app';
import { hex_md5 } from '@/vendor/md5';

export const SHARD_BYTES = 3 * 1024 * 1024;
const INLINE_BYTES = 64 * 1024;

export function jsonBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
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
        if (!this._manifestLoaded) {
            this.loadManifest();
        }
        if (!this.sharded) {
            return this.legacy[id];
        }
        if (
            this.legacy &&
            Object.prototype.hasOwnProperty.call(this.legacy, id)
        ) {
            return this.legacy[id];
        }
        const shardKey = `${this.key}:v1:${hex_md5(id)}`;
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
        if (
            !this.sharded &&
            !previous.length &&
            jsonBytes(entries) <= INLINE_BYTES
        ) {
            const ok = this.write(JSON.stringify(entries), this.key) !== false;
            if (ok) {
                this.legacy = { ...entries };
                this._manifestLoaded = true;
            }
            return ok;
        }
        const pairs = Object.entries(entries).filter(
            ([id, entry]) => jsonBytes([id, entry]) <= SHARD_BYTES,
        );
        const keys = pairs.map(([id]) => `${this.key}:v1:${hex_md5(id)}`);
        const tracked = [...new Set([...previous, ...keys])];
        const staging = {
            cacheShardsVersion: 1,
            keys: tracked,
            ...(Object.keys(this.legacy).length ? { legacy: this.legacy } : {}),
        };
        if (jsonBytes(staging) > SHARD_BYTES) return false;
        if (this.write(JSON.stringify(staging), this.key) === false)
            return false;
        this.keys = tracked;
        this.sharded = true;
        for (const [id, entry] of pairs) {
            const key = `${this.key}:v1:${hex_md5(id)}`;
            const text = JSON.stringify([id, entry]);
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
        const manifest = { cacheShardsVersion: 1, keys };
        if (jsonBytes(manifest) > SHARD_BYTES) return false;
        if (this.write(JSON.stringify(manifest), this.key) === false)
            return false;
        this.keys = keys;
        this._keySet = new Set(keys);
        this._manifestLoaded = true;
        this.sharded = true;
        this.legacy = {};
        if (!keys.length) {
            this.sharded = false;
            this.write('{}', this.key);
        }
        return true;
    }
}
