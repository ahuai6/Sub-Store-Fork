import { BatchFlush } from '@/utils/bounded-cache';
import { CacheShards, jsonBytes, SHARD_BYTES } from '@/utils/cache-shards';
import { LAST_GOOD_CACHE_KEY } from '@/constants';

// Opt-in last successful geo result (scripts/check/geo.js keep_last).
// This store is the explicit exception to the global scriptCacheTtl rule:
// entries stay until a newer success overwrites them, keep_last_max_age
// rejects them at read time, or refresh/clear-cache calls revokeAll().
// Writes batch like script-resource-cache. Large maps use CacheShards so
// one value stays under the iOS $persistentStore limit.

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
        this._batch = new BatchFlush(() => this._persist());
        this._loaded = false;
        this._entries = {};
        this._dirty = new Set();
    }

    get entries() {
        this._ensureLoaded();
        return this._entries;
    }

    set entries(value) {
        this._loaded = true;
        this._entries = value;
        this._dirty.clear();
    }

    _ensureLoaded() {
        if (this._loaded) return;
        this._loaded = true;
        const loaded = this.shards.load();
        for (const id of this._dirty) {
            if (Object.prototype.hasOwnProperty.call(this._entries, id)) {
                loaded[id] = this._entries[id];
            }
        }
        this._dirty.clear();
        this._entries = loaded;
    }

    _persist() {
        if (!this._loaded) {
            const dirtyMap = {};
            for (const id of this._dirty) {
                if (Object.prototype.hasOwnProperty.call(this._entries, id)) {
                    dirtyMap[id] = this._entries[id];
                }
            }
            if (Object.keys(dirtyMap).length > 0) {
                const res = this.shards.writeEntries(dirtyMap);
                if (res !== null) {
                    if (res !== false) this._dirty.clear();
                    return;
                }
            } else {
                return;
            }
            this._ensureLoaded();
        }
        this._dirty.clear();
        this.shards.save(this._entries);
    }

    get(id) {
        const entry = !this._loaded
            ? Object.prototype.hasOwnProperty.call(this._entries, id)
                ? this._entries[id]
                : this.shards.readEntry(id)
            : this._entries[id];
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
        if (!this._loaded && this.shards.isSharded()) {
            this._entries[id] = entry;
            this._dirty.add(id);
            this._batch.schedule();
            return true;
        }
        this._ensureLoaded();
        this._entries[id] = entry;
        this._batch.schedule();
        return true;
    }

    revokeAll() {
        this._dirty.clear();
        if (!this._loaded) {
            this._batch.reset();
            this._entries = {};
            this._loaded = true;
            this.shards.clearAll();
            return;
        }
        this._entries = {};
        this._writeThrough();
    }

    flush() {
        this._batch.flush();
    }

    _writeThrough() {
        this._batch.reset();
        this._persist();
    }
}

const cache = new LastGoodCache();

export default cache;
