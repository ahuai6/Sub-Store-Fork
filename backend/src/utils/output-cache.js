import { version } from '../../package.json';
import $ from '@/core/app';
import {
    DEFAULT_CACHE_TTL,
    OUTPUT_CACHE_KEY,
    SETTINGS_KEY,
} from '@/constants';
import { AGE_SECRET_KEY } from '@/utils/age';
import { hex_md5 } from '@/vendor/md5';
import {
    BoundedCache,
    stableStringify,
    ttlFromSetting,
} from '@/utils/bounded-cache';

/**
 * Final output of a subscription or collection download, and of preview.
 *
 * TTL setting: resourceCacheTtl (seconds). Missing value uses the resource
 * cache default of 1 hour (DEFAULT_CACHE_TTL). An explicit 0 disables this
 * cache. The hash is only the key inside that window. When the window ends
 * the entry is ignored and the subscription is fully recomputed, even if the
 * raw content and the processing config are unchanged. Node backends can
 * change routing while the node config stays the same, and script operators
 * may do network I/O or be non-deterministic (time, random). Those results
 * are cached only while resourceCacheTtl is enabled. They are never reused
 * solely because the fingerprint still matches.
 *
 * Opt out with settings.outputCache = false, the query noOutputCache, or the
 * existing noCache flag (query, subscription, or collection). noCache keeps
 * its current meaning and also skips this cache.
 *
 * What is stored: the produced body (download / cron) or the preview JSON
 * `{ original, processed }`. Flow headers stay on headersCacheTtl. Age
 * encryption and response transformers still run on a download hit, because
 * they can change headers on that response. The produced body is the part
 * that includes script operators.
 *
 * Size: a body larger than settings.cacheThreshold KB (default 1024) is not
 * stored. The whole value stays under 3 MB so it fits the 4 MB iOS
 * $persistentStore cap. Oldest entries are evicted. The clear-cache action
 * (/api/utils/refresh) calls revokeAll().
 */

const OMITTED_SETTINGS = new Set([
    'gistToken',
    'resourceCacheTtl',
    'headersCacheTtl',
    'scriptCacheTtl',
    'cacheThreshold',
    'outputCache',
    AGE_SECRET_KEY,
]);

const OUTPUT_OFF = new Set(['false', '0', 'no', 'off']);

function readSettings() {
    return $.read(SETTINGS_KEY) || {};
}

export function resourceOutputTtlMs() {
    return ttlFromSetting(readSettings, 'resourceCacheTtl', DEFAULT_CACHE_TTL);
}

export function outputCacheEnabled() {
    const flag = readSettings()?.outputCache;
    if (flag === false || flag === 0) return false;
    if (typeof flag === 'string' && OUTPUT_OFF.has(flag.trim().toLowerCase())) {
        return false;
    }
    return resourceOutputTtlMs() > 0;
}

export function outputCacheBypassed(flags = {}) {
    if (flags.noCache) return true;
    if (flags.noOutputCache) return true;
    return !outputCacheEnabled();
}

function entryBudgetFromSettings() {
    const kb = Number(readSettings()?.cacheThreshold);
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
    return 1024 * 1024;
}

class OutputCache extends BoundedCache {
    constructor() {
        super({
            storeKey: OUTPUT_CACHE_KEY,
            label: '输出缓存',
            resolveTtl: () => resourceOutputTtlMs(),
        });
    }

    entryBudget() {
        return entryBudgetFromSettings();
    }
}

const cache = new OutputCache();

function dropEmpty(value) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        return value ?? null;
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
            out[key] = value[key];
        }
    }
    return Object.keys(out).length ? out : null;
}

function userOptions(options) {
    if (!options || typeof options !== 'object') return null;
    const copy = {};
    for (const key of Object.keys(options)) {
        if (key === '_req') continue;
        copy[key] = options[key];
    }
    return Object.keys(copy).length ? copy : null;
}

function normalizeRaw(raw) {
    if (raw == null) return null;
    if (Array.isArray(raw)) return raw.map((item) => normalizeRaw(item));
    if (typeof raw === 'object') {
        const out = {};
        for (const key of Object.keys(raw).sort()) {
            out[key] = normalizeRaw(raw[key]);
        }
        return out;
    }
    return String(raw);
}

function relevantSettings() {
    const settings = readSettings();
    if (!settings || typeof settings !== 'object') return null;
    const out = {};
    for (const key of Object.keys(settings).sort()) {
        if (OMITTED_SETTINGS.has(key)) continue;
        out[key] = settings[key];
    }
    return Object.keys(out).length ? out : null;
}

export function buildOutputMaterial(fields = {}) {
    return {
        version,
        kind: fields.kind || 'download',
        platform: fields.platform || 'JSON',
        produceType: fields.produceType || null,
        produceOpts: dropEmpty(fields.produceOpts),
        noFlow: !!fields.noFlow,
        raw: normalizeRaw(fields.raw),
        name: fields.name ?? null,
        displayName: fields.displayName ?? null,
        process: fields.process || [],
        subs: fields.subs || null,
        source: fields.source ?? null,
        mergeSources: fields.mergeSources ?? null,
        ignoreFailedRemoteSub: fields.ignoreFailedRemoteSub ?? null,
        options: userOptions(fields.$options),
        query: dropEmpty(fields.query),
        settings: relevantSettings(),
        // Bypass flags are not part of the hash. See outputMaterialKey.
        noCache: fields.noCache || false,
        noOutputCache: fields.noOutputCache || false,
    };
}

export function outputMaterialKey(material) {
    try {
        const { noCache, noOutputCache, ...identity } = material || {};
        return hex_md5(stableStringify(identity));
    } catch (e) {
        $.error(`输出缓存键计算失败: ${e?.message ?? e}`);
        return null;
    }
}

function subscriptionRaw(raw) {
    if (Array.isArray(raw)) return raw;
    return [raw];
}

export function readCachedOutput(material, { includeRaw = false, raw } = {}) {
    if (outputCacheBypassed(material)) return undefined;
    const id = outputMaterialKey(material);
    if (!id) return undefined;
    const hit = cache.get(id);
    if (typeof hit !== 'string') return undefined;
    $.info(
        `输出缓存命中: ${material.kind || ''} ${material.name || ''} (${id.slice(0, 8)})`,
    );
    if (!includeRaw) return hit;
    return { result: hit, raw };
}

export function writeCachedOutput(material, result) {
    if (outputCacheBypassed(material)) return false;
    if (typeof result !== 'string') return false;
    const id = outputMaterialKey(material);
    if (!id) return false;
    const stored = cache.set(id, result);
    if (stored) {
        $.info(
            `输出缓存已写入: ${material.kind || ''} ${material.name || ''} (${id.slice(0, 8)})`,
        );
    }
    return stored;
}

export function readCachedPreview(material) {
    const encoded = readCachedOutput(material);
    if (typeof encoded !== 'string') return undefined;
    try {
        const parsed = JSON.parse(encoded);
        if (!parsed || typeof parsed !== 'object') return undefined;
        return parsed;
    } catch (e) {
        return undefined;
    }
}

export function writeCachedPreview(material, data) {
    let encoded;
    try {
        encoded = JSON.stringify(data);
    } catch (e) {
        return false;
    }
    return writeCachedOutput(material, encoded);
}

export function subscriptionOutputMaterial(sub, fields = {}) {
    return buildOutputMaterial({
        kind: 'download-sub',
        platform: fields.platform,
        produceType: fields.produceType,
        produceOpts: fields.produceOpts,
        noFlow: fields.noFlow,
        raw: fields.raw,
        $options: fields.$options,
        query: fields.query,
        subs: fields.subs,
        name: sub?.name,
        displayName: sub?.displayName,
        process: sub?.process || [],
        source: sub?.source,
        mergeSources: fields.mergeSources || sub?.mergeSources,
        ignoreFailedRemoteSub:
            fields.ignoreFailedRemoteSub ?? sub?.ignoreFailedRemoteSub,
        noCache: fields.noCache || sub?.noCache,
        noOutputCache: fields.noOutputCache,
    });
}

export function collectionOutputMaterial(collection, subs, fields = {}) {
    const childNoCache =
        Array.isArray(subs) && subs.some((item) => item && item.noCache);
    return buildOutputMaterial({
        kind: 'download-col',
        platform: fields.platform,
        produceType: fields.produceType,
        produceOpts: fields.produceOpts,
        noFlow: fields.noFlow,
        raw: fields.raw,
        $options: fields.$options,
        query: fields.query,
        name: collection?.name,
        displayName: collection?.displayName,
        process: collection?.process || [],
        subs,
        ignoreFailedRemoteSub:
            fields.ignoreFailedRemoteSub ?? collection?.ignoreFailedRemoteSub,
        noCache: fields.noCache || collection?.noCache || childNoCache,
        noOutputCache: fields.noOutputCache,
    });
}

export { subscriptionRaw };
export default cache;
