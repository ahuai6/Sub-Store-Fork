import $ from '@/core/app';
import { ttlFromSetting } from '@/utils/bounded-cache';
import { CacheShards, jsonBytes, SHARD_BYTES } from '@/utils/cache-shards';
import {
    RESOURCE_CACHE_KEY,
    DEFAULT_CACHE_TTL,
    SETTINGS_KEY,
} from '@/constants';

class ResourceCache {
    constructor() {
        this.shards = new CacheShards(RESOURCE_CACHE_KEY);
        this._loaded = false;
        this._resourceCache = {};
        this._dirty = new Set();
        this._deleted = new Set();
    }

    get resourceCache() {
        this._ensureLoaded();
        return this._resourceCache;
    }

    set resourceCache(value) {
        this._loaded = true;
        this._resourceCache = value;
        this._dirty.clear();
        this._deleted.clear();
    }

    _applyPendingOverlay(base) {
        for (const id of this._deleted) {
            delete base[id];
        }
        for (const id of this._dirty) {
            if (Object.prototype.hasOwnProperty.call(this._resourceCache, id)) {
                base[id] = this._resourceCache[id];
            }
        }
        this._dirty.clear();
        this._deleted.clear();
        return base;
    }

    _ensureLoaded() {
        if (this._loaded) return;
        this._loaded = true;
        this._resourceCache = this._applyPendingOverlay(this.shards.load());
        this._cleanup();
    }

    _cleanup(prefix, ttl) {
        this._ensureLoaded();
        if (!(getTTL() > 0)) return;
        const resolvedTTL = normalizeTTL(ttl) ?? 0;
        let clear = false;
        const now = Date.now();
        Object.entries(this._resourceCache).forEach((entry) => {
            const [id, cached] = entry;
            const expiry = effectiveExpiry(cached);
            const shouldDelete = !expiry || expiry <= now + resolvedTTL;
            if (shouldDelete && (prefix ? id.startsWith(prefix) : true)) {
                delete this._resourceCache[id];
                clear = true;
            }
        });
        if (clear) this._persist();
    }

    revokeAll() {
        this._dirty.clear();
        this._deleted.clear();
        if (!this._loaded) {
            this._resourceCache = {};
            this._loaded = true;
            this.shards.clearAll();
            return;
        }
        this._loaded = true;
        this._resourceCache = {};
        this._persist();
    }

    _persist() {
        const now = Date.now();
        if (!this._loaded) {
            const dirtyMap = {};
            const deleteList = new Set(this._deleted);
            for (const id of this._dirty) {
                const cached = this._resourceCache[id];
                const expiry = effectiveExpiry(cached);
                if (!expiry || expiry <= now) {
                    delete this._resourceCache[id];
                    deleteList.add(id);
                } else {
                    dirtyMap[id] = cached;
                }
            }
            let ok = true;
            let fallback = false;
            if (Object.keys(dirtyMap).length > 0) {
                const res = this.shards.writeEntries(dirtyMap);
                if (res === null) fallback = true;
                else ok = res !== false;
            }
            if (ok && !fallback && deleteList.size > 0) {
                const res = this.shards.deleteEntries([...deleteList]);
                if (res === null) fallback = true;
                else ok = res !== false;
            }
            if (!fallback) {
                if (ok) {
                    this._dirty.clear();
                    this._deleted.clear();
                }
                return;
            }
            this._ensureLoaded();
        }
        this._dirty.clear();
        this._deleted.clear();
        for (const [id, cached] of Object.entries(this._resourceCache)) {
            const expiry = effectiveExpiry(cached);
            if (!expiry || expiry <= now) delete this._resourceCache[id];
        }
        this.shards.save(this._resourceCache);
    }

    _readCached(id) {
        if (this._loaded) return this._resourceCache[id];
        if (this._deleted.has(id)) return undefined;
        if (Object.prototype.hasOwnProperty.call(this._resourceCache, id)) {
            return this._resourceCache[id];
        }
        return this.shards.readEntry(id);
    }

    gettime(id) {
        if (!(getTTL() > 0)) return null;
        const cached = this._readCached(id);
        const time = effectiveExpiry(cached);
        if (time && Date.now() < time) {
            return time;
        }
        return null;
    }

    get(id, ttl, remove) {
        if (!(getTTL() > 0)) return null;
        const resolvedTTL = normalizeTTL(ttl) ?? 0;
        const cached = this._readCached(id);
        const time = effectiveExpiry(cached);
        if (time) {
            if (Date.now() + resolvedTTL < time) return cached.data;
            if (remove) {
                if (!this._loaded && this.shards.isSharded()) {
                    delete this._resourceCache[id];
                    this._dirty.delete(id);
                    this._deleted.add(id);
                    this._persist();
                    return null;
                }
                this._ensureLoaded();
                delete this._resourceCache[id];
                this._persist();
            }
        }
        return null;
    }

    set(id, value, ttl) {
        if (!(getTTL() > 0)) return;
        const resolvedTTL = Math.min(normalizeTTL(ttl) ?? getTTL(), getTTL());
        const now = Date.now();
        const entry = {
            time: now + resolvedTTL,
            created: now,
            data: value,
        };
        if (jsonBytes([id, entry]) > SHARD_BYTES) return;
        if (!this._loaded && this.shards.isSharded()) {
            this._resourceCache[id] = entry;
            this._dirty.add(id);
            this._deleted.delete(id);
            this._persist();
            return;
        }
        this._ensureLoaded();
        this._resourceCache[id] = entry;
        this._persist();
    }
}

function normalizeTTL(ttl) {
    const value = Number(ttl);
    if (!isFinite(value)) return null;
    if (value > 0) return value;
    return null;
}

function getTTL() {
    return ttlFromSetting(
        () => $.read(SETTINGS_KEY),
        'resourceCacheTtl',
        DEFAULT_CACHE_TTL,
    );
}

function effectiveExpiry(cached) {
    if (!cached) return null;
    return cached.created != null
        ? Math.min(cached.time, cached.created + getTTL())
        : cached.time;
}

export default new ResourceCache();
