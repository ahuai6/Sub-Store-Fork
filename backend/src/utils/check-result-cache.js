import $ from '@/core/app';
import {
    CHECK_RESULT_CACHE_KEY,
    DEFAULT_SCRIPT_CACHE_TTL,
    SETTINGS_KEY,
} from '@/constants';
import { hex_md5 } from '@/vendor/md5';
import {
    BoundedCache,
    stableStringify,
    ttlFromSetting,
} from '@/utils/bounded-cache';

/**
 * Shared network-check results for script operators.
 *
 * TTL setting: scriptCacheTtl (seconds). Missing value uses the script cache
 * default of 48 hours. An explicit 0 disables storage. The key is
 * hash(node identity + check script + args). Display names and per-subscription
 * metadata are not part of the identity, so the same node in two collections
 * reuses one result inside the TTL. After expiry the check runs again even
 * when the node config is unchanged. A hash is not a reason to keep a result.
 *
 * This does not change get/set on scriptResourceCache. Scripts gain
 * sharedCheck / sharedCheckGet / sharedCheckSet / sharedCheckClaim on that
 * same object. The clear-cache action drops this store.
 *
 * Size: results over cacheThreshold (default 1024 KB) are not stored. Large maps use per-key
 * shards under 3 MB; unrelated keys are not evicted.
 */

const DISPLAY_FIELD =
    /^(name|id|subname|subdisplayname|collectionname|collectiondisplayname|_.*)$/i;

function readSettings() {
    return $.read(SETTINGS_KEY) || {};
}

export function scriptCheckTtlMs() {
    return ttlFromSetting(
        readSettings,
        'scriptCacheTtl',
        DEFAULT_SCRIPT_CACHE_TTL,
    );
}

function entryBudgetFromSettings() {
    const kb = Number(readSettings()?.cacheThreshold);
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
    return 1024 * 1024;
}

export function nodeIdentity(node) {
    if (!node || typeof node !== 'object') return node ?? null;
    const identity = {};
    for (const key of Object.keys(node).sort()) {
        if (DISPLAY_FIELD.test(key)) continue;
        identity[key] = node[key];
    }
    return identity;
}

export function checkKey(identity = {}) {
    return hex_md5(
        stableStringify({
            script: identity.script || '',
            args: identity.args ?? null,
            node: nodeIdentity(identity.node),
        }),
    );
}

function cloneData(value) {
    if (value == null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
}

class CheckResultCache extends BoundedCache {
    constructor() {
        super({
            sharded: true,
            storeKey: CHECK_RESULT_CACHE_KEY,
            label: '检查缓存',
            resolveTtl: () => scriptCheckTtlMs(),
        });
        this._inflight = new Map();
        this._generation = 0;
    }

    entryBudget() {
        return entryBudgetFromSettings();
    }

    revokeAll() {
        this._generation += 1;
        this._inflight.clear();
        super.revokeAll();
    }

    claim(identity) {
        const key = checkKey(identity);
        const cached = this.get(key);
        if (cached != null) return { cached: cloneData(cached) };
        if (this._inflight.has(key))
            return { pending: this._inflight.get(key) };
        const generation = this._generation;
        let settled = false;
        let finish;
        const pending = new Promise((resolve, reject) => {
            finish = (value, error) => {
                if (settled) return;
                settled = true;
                if (this._inflight.get(key) === pending)
                    this._inflight.delete(key);
                if (error) {
                    reject(error);
                    return;
                }
                if (
                    generation === this._generation &&
                    value != null &&
                    scriptCheckTtlMs() > 0
                ) {
                    this.set(key, cloneData(value));
                }
                resolve(cloneData(value));
            };
        });
        pending.catch(() => {}); // claim owner may have no waiters
        this._inflight.set(key, pending);
        return { finish };
    }

    async sharedCheck(identity, producer) {
        const claim = this.claim(identity);
        if (claim.cached != null) return claim.cached;
        if (claim.pending) return claim.pending;
        try {
            const value = await producer();
            claim.finish(value);
            return cloneData(value);
        } catch (error) {
            claim.finish(null, error);
            throw error;
        }
    }
}

const cache = new CheckResultCache();

export default cache;
