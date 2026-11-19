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

    it('distinguishes preview-file cache keys when file metadata changes', function () {
        const base = buildOutputMaterial({
            kind: 'preview-file',
            raw: 'proxies:\n  - name: hk',
            name: 'demo',
            displayName: 'Demo A',
            produceType: 'mihomoProfile',
            produceOpts: { mode: 'proxy', source: 'local' },
            process: [{ type: 'Script Operator' }],
        });
        const renamedDisplay = buildOutputMaterial({
            kind: 'preview-file',
            raw: 'proxies:\n  - name: hk',
            name: 'demo',
            displayName: 'Demo B',
            produceType: 'mihomoProfile',
            produceOpts: { mode: 'proxy', source: 'local' },
            process: [{ type: 'Script Operator' }],
        });
        const otherType = buildOutputMaterial({
            kind: 'preview-file',
            raw: 'proxies:\n  - name: hk',
            name: 'demo',
            displayName: 'Demo A',
            produceType: 'file',
            produceOpts: { mode: 'file', source: 'local' },
            process: [{ type: 'Script Operator' }],
        });
        expect(outputMaterialKey(base)).to.not.equal(
            outputMaterialKey(renamedDisplay),
        );
        expect(outputMaterialKey(base)).to.not.equal(
            outputMaterialKey(otherType),
        );
    });

    it('bypasses preview output cache for collections when a child subscription sets noCache', async function () {
        const registerPreview = require('@/restful/preview').default;
        const handlers = {};
        registerPreview({
            post(route, fn) {
                handlers[route] = fn;
            },
        });
        let scriptRuns = 0;
        global.__previewNoCacheCounter = () => {
            scriptRuns += 1;
            return scriptRuns;
        };
        const subs = [
            {
                name: 'child-nocache',
                source: 'local',
                content: NODE,
                noCache: true,
                process: [
                    {
                        type: 'Script Operator',
                        args: {
                            mode: 'script',
                            content:
                                'function operator(proxies){ const n = global.__previewNoCacheCounter(); return proxies.map(p => ({ ...p, name: `${p.name}-${n}` })); }',
                        },
                    },
                ],
            },
        ];
        $.read = (key) => {
            if (key === SUBS_KEY) return subs;
            if (key === SETTINGS_KEY) return { resourceCacheTtl: 3600 };
            return originalRead(key);
        };
        const runPreview = async () => {
            let payload;
            const res = {
                status() {
                    return this;
                },
                set() {
                    return this;
                },
                json(data) {
                    payload = data;
                    return this;
                },
                send(data) {
                    payload = data;
                    return this;
                },
            };
            await handlers['/api/preview/collection'](
                {
                    method: 'POST',
                    path: '/api/preview/collection',
                    params: {},
                    query: {},
                    headers: {},
                    body: {
                        name: 'col-with-nocache-child',
                        subscriptions: ['child-nocache'],
                        process: [],
                    },
                },
                res,
            );
            return payload;
        };
        try {
            const first = await runPreview();
            const second = await runPreview();
            expect(scriptRuns).to.equal(2);
            expect(first.data.processed[0].name).to.equal('HK-1');
            expect(second.data.processed[0].name).to.equal('HK-2');
        } finally {
            delete global.__previewNoCacheCounter;
        }
    });

    it('ignores UI, sync, and log settings in the output cache key', function () {
        const baseSettings = {
            resourceCacheTtl: 3600,
            syncTime: 1000,
            theme: { auto: true },
            appearanceSetting: { isSimpleMode: false },
            logsMaxCount: 0,
            githubUser: 'alice',
            artifactSyncBatchSize: 5,
        };
        const changedSettings = {
            ...baseSettings,
            syncTime: 999999,
            theme: { auto: false },
            appearanceSetting: { isSimpleMode: true },
            logsMaxCount: 500,
            githubUser: 'bob',
            artifactSyncBatchSize: 20,
        };
        const state = { [SETTINGS_KEY]: baseSettings };
        $.read = (key) => state[key];
        const keyA = outputMaterialKey(material(NODE));
        state[SETTINGS_KEY] = changedSettings;
        const keyB = outputMaterialKey(material(NODE));
        expect(keyB).to.equal(keyA);

        // Changing a setting that affects proxy output still invalidates the key.
        state[SETTINGS_KEY] = { ...changedSettings, defaultProxy: 'DIRECT' };
        const keyC = outputMaterialKey(material(NODE));
        expect(keyC).to.not.equal(keyA);
    });

    it('skips ProxyUtils.parse on outputCache hit and parses once on fresh network fetch', async function () {
        const { ProxyUtils } = require('@/core/proxy-utils');
        const resourceCache = require('@/utils/resource-cache').default;
        const headersResourceCache =
            require('@/utils/headers-resource-cache').default;
        const { getFlowHeaders } = require('@/utils/flow');
        const http = require('http');

        const clashYaml = `proxies:\n  - { name: HK-1, type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: secret }\n`;
        let httpHits = 0;
        const server = http.createServer((req, res) => {
            httpHits += 1;
            res.writeHead(200, {
                'Content-Type': 'text/yaml',
                'subscription-userinfo':
                    'upload=10; download=20; total=100; expire=4102444800',
            });
            res.end(clashYaml);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const url = `http://127.0.0.1:${port}/sub.yaml`;

        const state = {
            [SETTINGS_KEY]: {
                resourceCacheTtl: 3600,
                headersCacheTtl: 3600,
                defaultFlowUserAgent: 'FlowUA/1.0',
            },
            [SUBS_KEY]: [
                {
                    name: 'remote-clash',
                    source: 'remote',
                    url,
                    ua: 'CustomSubUA/2.0',
                    process: [],
                },
            ],
        };
        $.read = (key) =>
            Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
        $.write = (val, key) => {
            state[key] = val;
            return true;
        };

        let parseCalls = 0;
        const originalParse = ProxyUtils.parse;
        ProxyUtils.parse = function (...args) {
            parseCalls += 1;
            return originalParse.apply(this, args);
        };
        try {
            resourceCache.revokeAll();
            headersResourceCache.revokeAll();

            // Cold miss: fetches once and parses proxies only ONCE (reused from download validation).
            const first = await produceArtifact({
                type: 'subscription',
                name: 'remote-clash',
                platform: 'Surge',
            });
            expect(httpHits).to.equal(1);
            expect(parseCalls).to.equal(1);
            expect(first).to.include('HK-1');

            // Warm hit: resourceCache + outputCache hit -> ZERO HTTP, ZERO ProxyUtils.parse.
            const second = await produceArtifact({
                type: 'subscription',
                name: 'remote-clash',
                platform: 'Surge',
            });
            expect(second).to.equal(first);
            expect(httpHits).to.equal(1);
            expect(parseCalls).to.equal(1);

            // P9: download backfilled headersResourceCache under defaultFlowUserAgent, so
            // getFlowHeaders hits cache with ZERO additional HTTP requests.
            const flow = await getFlowHeaders(url);
            expect(flow).to.include('total=100');
            expect(httpHits).to.equal(1);
        } finally {
            ProxyUtils.parse = originalParse;
            resourceCache.revokeAll();
            headersResourceCache.revokeAll();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
