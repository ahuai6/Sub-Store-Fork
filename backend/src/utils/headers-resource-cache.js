import $ from '@/core/app';
import { ttlFromSetting } from '@/utils/bounded-cache';
import {
    HEADERS_RESOURCE_CACHE_KEY,
    DEFAULT_HEADERS_CACHE_TTL,
    SETTINGS_KEY,
} from '@/constants';

class ResourceCache {
    constructor() {
        if (!$.read(HEADERS_RESOURCE_CACHE_KEY)) {
            $.write('{}', HEADERS_RESOURCE_CACHE_KEY);
        }
        try {
            this.resourceCache = JSON.parse($.read(HEADERS_RESOURCE_CACHE_KEY));
        } catch (e) {
            $.error(
                `解析持久化缓存中的 ${HEADERS_RESOURCE_CACHE_KEY} 失败, 重置为 {}, 错误: ${
                    e?.message ?? e
                }`,
            );
            this.resourceCache = {};
            $.write('{}', HEADERS_RESOURCE_CACHE_KEY);
        }
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
        if (clear) this._persist();
    }

    revokeAll() {
        this.resourceCache = {};
        this._persist();
    }

    _persist() {
        $.write(JSON.stringify(this.resourceCache), HEADERS_RESOURCE_CACHE_KEY);
    }

    gettime(id) {
        const cached = this.resourceCache[id];
        const time = effectiveExpiry(cached);
        if (getTTL() > 0 && time && Date.now() < time) {
            return time;
        }
        return null;
    }

    get(id, ttl, remove) {
        if (!(getTTL() > 0)) return null;
        const resolvedTTL = normalizeTTL(ttl) ?? 0;
        const cached = this.resourceCache[id];
        const time = effectiveExpiry(cached);
        if (time) {
            if (Date.now() + resolvedTTL < time) return cached.data;
            if (remove) {
                delete this.resourceCache[id];
                this._persist();
            }
        }
        return null;
    }

    set(id, value, ttl) {
        if (!(getTTL() > 0)) return;
        const resolvedTTL = Math.min(normalizeTTL(ttl) ?? getTTL(), getTTL());
        this.resourceCache[id] = {
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
