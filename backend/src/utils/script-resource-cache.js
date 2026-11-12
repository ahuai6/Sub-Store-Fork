import $ from '@/core/app';
import {
    SCRIPT_RESOURCE_CACHE_KEY,
    DEFAULT_SCRIPT_CACHE_TTL,
    SETTINGS_KEY,
} from '@/constants';

// Coalesce the per-node JSON rewrite of #sub-store-cached-script-resource.
// get/set semantics stay on the in-memory object. The persistent store is
// updated every BATCH sets, on a short quiet period, and when the request
// ends. Entries still expire with settings.scriptCacheTtl (default 48h).
// revokeAll, used by the clear-cache action, writes immediately.
const BATCH = 25;
const DEBOUNCE_MS = 200;

class ResourceCache {
    constructor() {
        this._dirty = false;
        this._timer = null;
        this._writesSinceFlush = 0;
        this._flushing = false;
        if (!$.read(SCRIPT_RESOURCE_CACHE_KEY)) {
            $.write('{}', SCRIPT_RESOURCE_CACHE_KEY);
        }
        try {
            this.resourceCache = JSON.parse($.read(SCRIPT_RESOURCE_CACHE_KEY));
        } catch (e) {
            $.error(
                `解析持久化缓存中的 ${SCRIPT_RESOURCE_CACHE_KEY} 失败, 重置为 {}, 错误: ${
                    e?.message ?? e
                }`,
            );
            this.resourceCache = {};
            $.write('{}', SCRIPT_RESOURCE_CACHE_KEY);
        }
        this._cleanup();
    }

    _clearTimer() {
        if (this._timer != null && typeof clearTimeout === 'function') {
            clearTimeout(this._timer);
        }
        this._timer = null;
    }

    _cleanup(prefix, ttl) {
        const resolvedTTL = normalizeTTL(ttl) ?? 0;
        let clear = false;
        const now = Date.now();
        Object.entries(this.resourceCache).forEach((entry) => {
            const [id, cached] = entry;
            const shouldDelete =
                !cached.time || cached.time < now + resolvedTTL;
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
    }

    _persist() {
        $.write(JSON.stringify(this.resourceCache), SCRIPT_RESOURCE_CACHE_KEY);
    }

    _writeThrough() {
        this._clearTimer();
        this._dirty = false;
        this._writesSinceFlush = 0;
        this._persist();
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

    flush() {
        if (this._flushing) return;
        this._flushing = true;
        try {
            this._clearTimer();
            this._writesSinceFlush = 0;
            if (!this._dirty) return;
            this._dirty = false;
            this._persist();
        } finally {
            this._flushing = false;
        }
    }

    gettime(id) {
        const time = this.resourceCache[id] && this.resourceCache[id].time;
        if (time && new Date().getTime() <= time) {
            return this.resourceCache[id].time;
        }
        return null;
    }

    get(id, ttl, remove) {
        const resolvedTTL = normalizeTTL(ttl) ?? 0;
        const cached = this.resourceCache[id];
        const time = cached && cached.time;
        if (time) {
            if (Date.now() + resolvedTTL <= time) return cached.data;
            if (remove) {
                delete this.resourceCache[id];
                this._writeThrough();
            }
        }
        return null;
    }

    set(id, value, ttl) {
        const resolvedTTL = normalizeTTL(ttl) ?? getTTL();
        this.resourceCache[id] = {
            time: Date.now() + resolvedTTL,
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
    const settings = $.read(SETTINGS_KEY) || {};
    let ttl = settings?.scriptCacheTtl;
    if (ttl) {
        ttl = Number(ttl);
        if (isFinite(ttl) && ttl > 0) {
            return ttl * 1000;
        }
    }
    return DEFAULT_SCRIPT_CACHE_TTL;
}

const cache = new ResourceCache();

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
