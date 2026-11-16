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

// Coalesce the per-node JSON rewrite of #sub-store-cached-script-resource.
// get/set semantics stay on the in-memory object. The persistent store is
// updated every 25 sets, on a short quiet period, and when the request
// ends. Entries still expire with settings.scriptCacheTtl (default 48h).
// revokeAll, used by the clear-cache action, writes immediately.

class ResourceCache {
    constructor() {
        this.shards = new CacheShards(SCRIPT_RESOURCE_CACHE_KEY);
        this._batch = new BatchFlush(() => this._persist());
        this.resourceCache = this.shards.load();
        this._cleanup();
    }

    _cleanup(prefix, ttl) {
        const resolvedTTL = normalizeTTL(ttl) ?? 0;
        let clear = false;
        const now = Date.now();
        Object.entries(this.resourceCache).forEach((entry) => {
            const [id, cached] = entry;
            const shouldDelete =
                !cached?.time || cached.time <= now + resolvedTTL;
            if (shouldDelete && (prefix ? id.startsWith(prefix) : true)) {
                delete this.resourceCache[id];
                clear = true;
            }
        });
        if (clear) this._writeThrough();
    }

    revokeAll() {
        this.resourceCache = {};
        this._writeThrough();
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
        for (const [id, cached] of Object.entries(this.resourceCache)) {
            if (!cached?.time || cached.time <= Date.now())
                delete this.resourceCache[id];
        }
        this.shards.save(this.resourceCache);
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

    gettime(id) {
        const cached = this.resourceCache[id];
        const time =
            cached &&
            Math.min(
                cached.time,
                cached.created != null
                    ? cached.created + getTTL()
                    : cached.time,
            );
        if (getTTL() > 0 && time && Date.now() < time) {
            return time;
        }
        return null;
    }

    get(id, ttl, remove) {
        if (!(getTTL() > 0)) return null;
        const resolvedTTL = normalizeTTL(ttl) ?? 0;
        const cached = this.resourceCache[id];
        const time =
            cached &&
            Math.min(
                cached.time,
                cached.created != null
                    ? cached.created + getTTL()
                    : cached.time,
            );
        if (time) {
            if (Date.now() + resolvedTTL < time) return cached.data;
            if (remove) {
                delete this.resourceCache[id];
                this._writeThrough();
            }
        }
        return null;
    }

    set(id, value, ttl) {
        if (!(getTTL() > 0)) return;
        const resolvedTTL = Math.min(normalizeTTL(ttl) ?? getTTL(), getTTL());
        if (
            jsonBytes([id, { time: Date.now() + resolvedTTL, data: value }]) >
            SHARD_BYTES
        )
            return;
        this.resourceCache[id] = {
            time: Date.now() + resolvedTTL,
            created: Date.now(),
            data: value,
        };
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
    };
    res.on('finish', flush);
    res.on('close', flush);
}

export default cache;
