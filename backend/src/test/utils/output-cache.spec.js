import { expect } from 'chai';
import { afterEach, before, describe, it } from 'mocha';

import { OUTPUT_CACHE_KEY, SETTINGS_KEY, SUBS_KEY } from '@/constants';
import { BoundedCache } from '@/utils/bounded-cache';

const NODE =
    'ss://YWVzLTEyOC1nY206c2VjcmV0@1.1.1.1:443#HK';

describe('final output cache', function () {
    let $;
    let cache;
    let readCachedOutput;
    let writeCachedOutput;
    let buildOutputMaterial;
    let outputMaterialKey;
    let outputCacheBypassed;
    let produceArtifact;
    let originalRead;
    let originalWrite;
    let originalInfo;
    let originalError;

    before(function () {
        ({ default: $ } = require('@/core/app'));
        ({
            default: cache,
            readCachedOutput,
            writeCachedOutput,
            buildOutputMaterial,
            outputMaterialKey,
            outputCacheBypassed,
        } = require('@/utils/output-cache'));
        ({ produceArtifact } = require('@/restful/sync'));
        originalRead = $.read.bind($);
        originalWrite = $.write.bind($);
        originalInfo = $.info.bind($);
        originalError = $.error.bind($);
        $.info = () => {};
        $.error = () => {};
    });

    after(function () {
        if (!$) return;
        $.info = originalInfo;
        $.error = originalError;
        $.read = originalRead;
        $.write = originalWrite;
    });

    afterEach(function () {
        cache.now = () => Date.now();
        cache.revokeAll();
        $.read = originalRead;
        $.write = originalWrite;
    });

    function material(raw, extra = {}) {
        return buildOutputMaterial({
            kind: 'download-sub',
            platform: 'Surge',
            raw,
            name: 'demo',
            process: [{ type: 'Flag Operator' }],
            ...extra,
        });
    }

    it('recomputes after resourceCacheTtl even when the content hash still matches', function () {
        const now = 1_700_000_000_000;
        cache.now = () => now;
        $.read = (key) => {
            if (key === SETTINGS_KEY) return { resourceCacheTtl: 60 };
            return originalRead(key);
        };
        const body = material(NODE);
        expect(writeCachedOutput(body, 'surge-a')).to.equal(true);
        expect(readCachedOutput(body)).to.equal('surge-a');

        cache.now = () => now + 60 * 1000;
        expect(readCachedOutput(body)).to.equal(undefined);
        expect(writeCachedOutput(body, 'surge-b')).to.equal(true);
        expect(readCachedOutput(body)).to.equal('surge-b');
        expect(readCachedOutput(body)).to.not.equal('surge-a');
    });

    it('does not keep an explicit resourceCacheTtl of 0', function () {
        $.read = (key) => {
            if (key === SETTINGS_KEY) return { resourceCacheTtl: 0 };
            return originalRead(key);
        };
        const body = material(NODE);
        expect(outputCacheBypassed(body)).to.equal(true);
        expect(writeCachedOutput(body, 'surge-a')).to.equal(false);
        expect(readCachedOutput(body)).to.equal(undefined);
    });

    it('bypasses on noCache, noOutputCache, and settings.outputCache = false', function () {
        const body = material(NODE);
        writeCachedOutput(body, 'surge-a');
        expect(readCachedOutput({ ...body, noCache: true })).to.equal(undefined);
        expect(readCachedOutput({ ...body, noOutputCache: true })).to.equal(
            undefined,
        );
        $.read = (key) => {
            if (key === SETTINGS_KEY) return { outputCache: false };
            if (key === OUTPUT_CACHE_KEY) return originalRead(key);
            return originalRead(key);
        };
        expect(readCachedOutput(body)).to.equal(undefined);
    });

    it('uses a different key when processing config or platform changes', function () {
        const left = material(NODE);
        const right = material(NODE, { platform: 'JSON' });
        const otherProcess = material(NODE, {
            process: [{ type: 'Script Operator', args: { content: 'return []' } }],
        });
        expect(outputMaterialKey(left)).to.not.equal(outputMaterialKey(right));
        expect(outputMaterialKey(left)).to.not.equal(
            outputMaterialKey(otherProcess),
        );
        writeCachedOutput(left, 'surge');
        expect(readCachedOutput(right)).to.equal(undefined);
    });

    it('matches a Surge download and a prefetch that share raw content and config', function () {
        const sub = {
            name: 'demo',
            displayName: 'Demo',
            process: [{ type: 'Flag Operator' }],
            source: 'local',
            content: NODE,
        };
        const download = buildOutputMaterial({
            kind: 'download-sub',
            platform: 'Surge',
            produceType: undefined,
            produceOpts: {
                'include-unsupported-proxy': undefined,
                prettyYaml: undefined,
            },
            noFlow: false,
            raw: NODE,
            name: sub.name,
            displayName: sub.displayName,
            process: sub.process,
            source: sub.source,
            $options: { _req: { url: 'https://sub.store/download/demo' } },
        });
        const prefetch = buildOutputMaterial({
            kind: 'download-sub',
            platform: 'Surge',
            produceOpts: {},
            noFlow: false,
            raw: NODE,
            name: sub.name,
            displayName: sub.displayName,
            process: sub.process,
            source: sub.source,
        });
        expect(outputMaterialKey(download)).to.equal(outputMaterialKey(prefetch));
    });

    it('drops the entry on clear-cache', function () {
        writeCachedOutput(material(NODE), 'surge-a');
        cache.revokeAll();
        expect(cache.entries).to.deep.equal({});
        expect(readCachedOutput(material(NODE))).to.equal(undefined);
    });

    it('skips an output over cacheThreshold and evicts the oldest entry', function () {
        const store = {};
        class TinyCache extends BoundedCache {
            entryBudget() {
                return 40;
            }
        }
        const tiny = new TinyCache({
            storeKey: 'tiny-output',
            label: 'tiny',
            budget: 90,
            resolveTtl: () => 1000,
            read: (key) => store[key],
            write: (value, key) => {
                store[key] = value;
            },
        });
        expect(tiny.set('big', 'x'.repeat(80))).to.equal(false);
        expect(tiny.get('big')).to.equal(null);
        expect(tiny.set('a', 'a'.repeat(20))).to.equal(true);
        expect(tiny.set('b', 'b'.repeat(20))).to.equal(true);
        expect(tiny.set('c', 'c'.repeat(20))).to.equal(true);
        expect(tiny.get('a')).to.equal(null);
        expect(tiny.get('c')).to.equal('c'.repeat(20));
    });

    it('serves one produced body inside the TTL and recomputes after expiry', async function () {
        const calls = [];
        const state = {
            [SETTINGS_KEY]: { resourceCacheTtl: 30 },
            [SUBS_KEY]: [
                {
                    name: 'cached-sub',
                    source: 'local',
                    content: NODE,
                    process: [
                        {
                            type: 'Script Operator',
                            args: {
                                mode: 'script',
                                content:
                                    'function operator(proxies) { globalThis.calls.push(proxies.length); return proxies; }',
                            },
                        },
                    ],
                },
            ],
        };
        global.calls = calls;
        $.read = (key) =>
            Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
        $.write = (value, key) => {
            state[key] = value;
            return true;
        };
        const run = () =>
            produceArtifact({
                type: 'subscription',
                name: 'cached-sub',
                platform: 'Surge',
            });
        const first = await run();
        const second = await run();
        expect(second).to.equal(first);
        expect(calls).to.deep.equal([1]);

        const id = Object.keys(cache.entries)[0];
        cache.entries[id].time = Date.now() - 1;
        const third = await run();
        expect(third).to.equal(first);
        expect(calls).to.deep.equal([1, 1]);

        const fresh = await produceArtifact({
            type: 'subscription',
            name: 'cached-sub',
            platform: 'Surge',
            noCache: true,
        });
        expect(fresh).to.equal(first);
        expect(calls).to.deep.equal([1, 1, 1]);
        delete global.calls;
    });
});
