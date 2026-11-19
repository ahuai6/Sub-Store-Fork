import $ from '@/core/app';
import { CacheShards, jsonBytes, SHARD_BYTES } from '@/utils/cache-shards';
import { BatchFlush, ttlFromSetting } from '@/utils/bounded-cache';
import {
    SCRIPT_RESOURCE_CACHE_KEY,
    DEFAULT_SCRIPT_CACHE_TTL,
    SETTINGS_KEY,
} from '@/constants';
import checkResultCache, { checkKey } from '@/utils/check-result-cache';
import lastGoodCache from '@/utils/last-good-cache';
import { flushLogEntries } from '@/utils/debug-logs';

// Coalesce the per-node JSON rewrite of #sub-store-cached-script-resource.
// get/set semantics stay on the in-memory object. The persistent store is
// updated every 25 sets, on a short quiet period, and when the request
// ends. Entries still expire with settings.scriptCacheTtl (default 48h).
// revokeAll, used by the clear-cache action, writes immediately.

class ResourceCache {
    constructor() {
        this.shards = new CacheShards(SCRIPT_RESOURCE_CACHE_KEY);
        this._batch = new BatchFlush(() => this._persist());
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
        if (clear) this._writeThrough();
    }

    revokeAll() {
        this._dirty.clear();
        this._deleted.clear();
        if (!this._loaded) {
            this._batch.reset();
            this._resourceCache = {};
            this._loaded = true;
            this.shards.clearAll();
        } else {
            this._resourceCache = {};
            this._writeThrough();
        }
        // Clear-cache calls revokeAll. Shared network checks live in their
        // own store and use scriptCacheTtl as well.
        try {
            checkResultCache.revokeAll();
        } catch (e) {
            $.error(e?.message ?? e);
        }
        // keep_last is exempt from scriptCacheTtl, but clear-cache still
        // drops that store and every shard it has registered.
        try {
            lastGoodCache.revokeAll();
        } catch (e) {
            $.error(e?.message ?? e);
        }
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

    _writeThrough() {
        this._batch.reset();
        this._persist();
    }

    _schedule() {
        this._batch.schedule();
    }

    flush() {
        this._batch.flush();
        try {
            checkResultCache.flush();
        } catch (e) {
            $.error(e?.message ?? e);
        }
        try {
            lastGoodCache.flush();
        } catch (e) {
            $.error(e?.message ?? e);
        }
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
                    this._writeThrough();
                    return null;
                }
                this._ensureLoaded();
                delete this._resourceCache[id];
                this._writeThrough();
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
            this._schedule();
            return;
        }
        this._ensureLoaded();
        this._resourceCache[id] = entry;
        this._schedule();
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
        'scriptCacheTtl',
        DEFAULT_SCRIPT_CACHE_TTL,
    );
}

function effectiveExpiry(cached) {
    if (!cached?.time) return null;
    return cached.created != null
        ? Math.min(cached.time, cached.created + getTTL())
        : cached.time;
}

const cache = new ResourceCache();

// Additive helpers. Existing get/set behavior is unchanged. revokeAll also
// drops the shared check store and the opt-in last-good store.
cache.sharedCheckGet = (identity) => checkResultCache.get(checkKey(identity));
cache.sharedCheckSet = (identity, value) =>
    checkResultCache.set(checkKey(identity), value);
cache.sharedCheckClaim = (identity) => checkResultCache.claim(identity);
cache.sharedCheck = (identity, producer) =>
    checkResultCache.sharedCheck(identity, producer);
cache.sharedCheckFlush = () => checkResultCache.flush();
cache.lastGoodGet = (id) => lastGoodCache.get(id);
cache.lastGoodSet = (id, value) => lastGoodCache.set(id, value);
cache.lastGoodFlush = () => lastGoodCache.flush();

function wrapDone(fn) {
    if (typeof fn !== 'function' || fn.__scriptCacheFlush) return fn;
    const wrapped = function (...args) {
        try {
            cache.flush();
        } catch (e) {
            $.error(e?.message ?? e);
        }
        try {
            flushLogEntries($);
        } catch {
            // Never block $done on log flush.
        }
        return fn.apply(this, args);
    };
    wrapped.__scriptCacheFlush = true;
    return wrapped;
}

if (typeof $.done === 'function') {
    $.done = wrapDone($.done.bind($));
}

try {
    if (typeof globalThis.$done === 'function') {
        globalThis.$done = wrapDone(globalThis.$done);
    }
} catch (e) {
    // Some hosts freeze $done. Response.send still flushes before calling it.
}

export function bindScriptCacheFlush(res) {
    if (!res || typeof res.on !== 'function' || res.__scriptCacheFlush) return;
    res.__scriptCacheFlush = true;
    const flush = () => {
        try {
            cache.flush();
        } catch (e) {
            $.error(e?.message ?? e);
        }
        try {
            flushLogEntries($);
        } catch {
            // Never block response completion on log flush.
        }
    };
    res.on('finish', flush);
    res.on('close', flush);
}

export default cache;
