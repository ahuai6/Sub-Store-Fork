import $ from '@/core/app';
import { ttlFromSetting } from '@/utils/bounded-cache';
import {
    HEADERS_RESOURCE_CACHE_KEY,
    DEFAULT_HEADERS_CACHE_TTL,
    SETTINGS_KEY,
} from '@/constants';

class ResourceCache {
    constructor() {
        this._loaded = false;
        this._resourceCache = {};
    }

    get resourceCache() {
        this._ensureLoaded();
        return this._resourceCache;
    }

    set resourceCache(value) {
        this._loaded = true;
        this._resourceCache = value;
    }

    _ensureLoaded() {
        if (this._loaded) return;
        this._loaded = true;
        const raw = $.read(HEADERS_RESOURCE_CACHE_KEY);
        if (!raw) {
            this._resourceCache = {};
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            this._resourceCache =
                parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? parsed
                    : {};
        } catch (e) {
            $.error(
                `解析持久化缓存中的 ${HEADERS_RESOURCE_CACHE_KEY} 失败, 重置为 {}, 错误: ${
                    e?.message ?? e
                }`,
            );
            this._resourceCache = {};
            $.write('{}', HEADERS_RESOURCE_CACHE_KEY);
        }
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
        this._loaded = true;
        this._resourceCache = {};
        this._persist();
    }

    _persist() {
        $.write(JSON.stringify(this._resourceCache), HEADERS_RESOURCE_CACHE_KEY);
    }

    gettime(id) {
        if (!(getTTL() > 0)) return null;
        this._ensureLoaded();
        const cached = this._resourceCache[id];
        const time = effectiveExpiry(cached);
        if (time && Date.now() < time) {
            return time;
        }
        return null;
    }

    get(id, ttl, remove) {
        if (!(getTTL() > 0)) return null;
        this._ensureLoaded();
        const resolvedTTL = normalizeTTL(ttl) ?? 0;
        const cached = this._resourceCache[id];
        const time = effectiveExpiry(cached);
        if (time) {
            if (Date.now() + resolvedTTL < time) return cached.data;
            if (remove) {
                delete this._resourceCache[id];
                this._persist();
            }
        }
        return null;
    }

    set(id, value, ttl) {
        if (!(getTTL() > 0)) return;
        this._ensureLoaded();
        const resolvedTTL = Math.min(normalizeTTL(ttl) ?? getTTL(), getTTL());
        this._resourceCache[id] = {
            time: Date.now() + resolvedTTL,
            created: Date.now(),
            data: value,
        };
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
        'headersCacheTtl',
        DEFAULT_HEADERS_CACHE_TTL,
    );
}

function effectiveExpiry(cached) {
    if (!cached) return null;
    return cached.created != null
        ? Math.min(cached.time, cached.created + getTTL())
        : cached.time;
}

export default new ResourceCache();
