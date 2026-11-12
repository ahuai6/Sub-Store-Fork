import { expect } from 'chai';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, it } from 'mocha';

const root = path.resolve(__dirname, '../../../..');
const originalSource = fs.readFileSync(
    path.join(root, 'backend/src/test/fixtures/geo.upstream.js'),
    'utf8',
);
const optimizedSource = fs.readFileSync(
    path.join(root, 'scripts/check/geo.js'),
    'utf8',
);

function loadOperator(source) {
    const factory = new Function(
        '$substore',
        '$arguments',
        'scriptResourceCache',
        'ProxyUtils',
        'lodash',
        '$utils',
        `${source}\nreturn operator;`,
    );
    return (proxies, args, env) =>
        factory(
            env.$,
            args,
            env.cache,
            env.ProxyUtils,
            null,
            env.$utils,
        )(proxies, 'Surge', {});
}

function createEnv(options = {}) {
    const logs = [];
    const persists = [];
    const httpCalls = [];
    let inflight = 0;
    let maxInflight = 0;
    const settings = options.settings || { scriptCacheTtl: 3600 };
    const resourceCache = {};
    const cache = {
        resourceCache,
        persists,
        set(id, value, ttl) {
            const explicit = Number(ttl);
            const resolved =
                Number.isFinite(explicit) && explicit > 0
                    ? explicit
                    : Number(settings.scriptCacheTtl) > 0
                      ? Number(settings.scriptCacheTtl) * 1000
                      : 48 * 3600 * 1000;
            resourceCache[id] = {
                time: Date.now() + resolved,
                data: value,
            };
            this._dirty = true;
            if (!options.deferPersist) this._persist();
        },
        get(id) {
            const cached = resourceCache[id];
            if (!cached || !cached.time) return null;
            if (Date.now() <= cached.time) return cached.data;
            return null;
        },
        flush() {
            if (!this._dirty) return;
            this._dirty = false;
            this._persist();
        },
        _persist() {
            persists.push(JSON.stringify(resourceCache));
        },
        revokeAll() {
            for (const key of Object.keys(resourceCache)) {
                delete resourceCache[key];
            }
            this._dirty = true;
            this.flush();
        },
    };
    if (options.omitFlush) delete cache.flush;

    const $ = {
        env: {
            isLoon: false,
            isSurge: true,
            isNode: false,
            isEgern: false,
        },
        error(message) {
            logs.push(String(message));
        },
        info() {},
        log() {},
        read(key) {
            if (key === 'settings') return settings;
            return null;
        },
        wait() {
            return Promise.resolve();
        },
        http: {
            async get(opt) {
                inflight += 1;
                maxInflight = Math.max(maxInflight, inflight);
                httpCalls.push(opt);
                try {
                    if (options.gate) await options.gate;
                    if (options.delayMs) {
                        await new Promise((resolve) =>
                            setTimeout(resolve, options.delayMs),
                        );
                    }
                    const node = String(opt.node || '');
                    if (node.includes('FAIL')) {
                        return { status: 500, body: '{}' };
                    }
                    if (node.includes('BOOM')) {
                        throw new Error('boom');
                    }
                    if (options.bodyFor) return options.bodyFor(node);
                    return {
                        status: 200,
                        body: JSON.stringify({
                            country: '日本',
                            isp: 'Example',
                            query: '203.0.113.5',
                        }),
                    };
                } finally {
                    inflight -= 1;
                }
            },
            post() {
                throw new Error('unexpected post');
            },
        },
    };

    return {
        $,
        cache,
        logs,
        httpCalls,
        maxInflight: () => maxInflight,
        ProxyUtils: {
            produce(proxies) {
                const proxy = proxies[0];
                if (proxy.type === 'bad') return '';
                return `NODE ${proxy.name}`;
            },
            hex_md5(value) {
                return crypto.createHash('md5').update(value).digest('hex');
            },
        },
        $utils: {
            geoip: () => 'JP',
            ipaso: () => 'Example',
            ipasn: () => '64500',
        },
    };
}

function nodes() {
    return [
        { name: 'ok-a', type: 'ss', server: 'a.example', port: 1 },
        { name: 'ok-b', type: 'ss', server: 'b.example', port: 2 },
        { name: 'FAIL', type: 'ss', server: 'c.example', port: 3 },
        { name: 'BOOM', type: 'ss', server: 'd.example', port: 4 },
        { name: 'bad', type: 'bad', server: 'e.example', port: 5 },
    ];
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function summarize(list) {
    return list.map((proxy) => ({
        name: proxy.name,
        type: proxy.type,
        _geo: proxy._geo,
        _incompatible: proxy._incompatible,
    }));
}

const runOriginal = loadOperator(originalSource);
const runOptimized = loadOperator(optimizedSource);

describe('optimized geo.js', function () {
    let realNow;

    afterEach(function () {
        if (realNow) {
            Date.now = realNow;
            realNow = null;
        }
    });

    async function compare(args, envOptions) {
        const input = nodes();
        const originalEnv = createEnv(envOptions);
        const optimizedEnv = createEnv(envOptions);
        const original = await runOriginal(
            clone(input),
            args,
            originalEnv,
        );
        const optimized = await runOptimized(
            clone(input),
            args,
            optimizedEnv,
        );
        expect(summarize(optimized)).to.deep.equal(summarize(original));
        return { original, optimized, originalEnv, optimizedEnv };
    }

    it('matches the original output for success, failure, throw, and incompatible nodes', async function () {
        await compare({ cache: true, geo: true, incompatible: true });
    });

    it('matches remove_failed and remove_incompatible', async function () {
        await compare({
            cache: true,
            remove_failed: true,
            remove_incompatible: true,
            incompatible: true,
        });
    });

    it('matches a regex format template', async function () {
        await compare(
            {
                format: '{{api.code}} {{proxy.name}}',
                regex: 'code:(\\w+)',
                geo: true,
            },
            {
                bodyFor: () => ({
                    status: 200,
                    body: 'prefix code:JP suffix',
                }),
            },
        );
    });

    it('uses a short hash key and one persist, and expires with scriptCacheTtl', async function () {
        realNow = Date.now;
        let now = 1_700_000_000_000;
        Date.now = () => now;
        const env = createEnv({ deferPersist: true, settings: { scriptCacheTtl: 3600 } });
        const first = await runOptimized(clone(nodes()), { cache: true, geo: true }, env);
        expect(first.find((proxy) => proxy.name.startsWith('日本'))).to.not.equal(
            undefined,
        );
        const keys = Object.keys(env.cache.resourceCache);
        expect(keys.length).to.be.greaterThan(0);
        for (const key of keys) {
            expect(key).to.match(/^geo:[0-9a-f]{32}$/);
            expect(env.cache.resourceCache[key].time).to.be.at.least(now + 3600 * 1000);
            expect(env.cache.resourceCache[key].time).to.be.at.most(
                now + 3600 * 1000 + 5,
            );
        }
        expect(env.cache.persists.length).to.equal(1);

        const callsAfterFirst = env.httpCalls.length;
        await runOptimized(clone(nodes()), { cache: true, geo: true }, env);
        expect(env.httpCalls.length).to.equal(callsAfterFirst);

        now += 3600 * 1000 + 1;
        await runOptimized(clone(nodes()), { cache: true, geo: true }, env);
        expect(env.httpCalls.length).to.be.greaterThan(callsAfterFirst);
    });

    it('still rechecks after expiry when the node config is unchanged', async function () {
        realNow = Date.now;
        let now = 1_700_000_000_000;
        Date.now = () => now;
        const { optimizedEnv } = await compare({ cache: true });
        const before = optimizedEnv.httpCalls.length;
        now += 48 * 3600 * 1000;
        await runOptimized(
            clone(nodes()),
            { cache: true },
            optimizedEnv,
        );
        expect(optimizedEnv.httpCalls.length).to.be.greaterThan(before);
    });

    it('does not change output when time_budget is omitted', async function () {
        await compare({});
    });

    it('returns finished nodes and leaves the rest unchanged when time_budget is set', async function () {
        this.timeout(10000);
        const input = [
            { name: 'n0', type: 'ss', server: 'a.example', port: 1 },
            { name: 'n1', type: 'ss', server: 'b.example', port: 2 },
            { name: 'n2', type: 'ss', server: 'c.example', port: 3 },
            { name: 'n3', type: 'ss', server: 'd.example', port: 4 },
            { name: 'n4', type: 'ss', server: 'e.example', port: 5 },
            { name: 'n5', type: 'ss', server: 'f.example', port: 6 },
        ];
        const env = createEnv({ delayMs: 40 });
        const output = await runOptimized(
            clone(input),
            { concurrency: 1, time_budget: 70 },
            env,
        );
        const finished = output.filter((proxy) => proxy.name !== input.find((item) => item.server === proxy.server).name);
        const unfinished = output.filter((proxy) =>
            input.some((item) => item.name === proxy.name),
        );
        expect(finished.length).to.be.at.least(1);
        expect(unfinished.length).to.be.at.least(1);
        expect(finished.every((proxy) => proxy.name.includes('日本'))).to.equal(true);
        expect(unfinished.every((proxy) => !proxy._geo)).to.equal(true);
        expect(env.httpCalls.length).to.equal(finished.length);
    });

    it('caps concurrency at Surge $httpClient limit of 20', async function () {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const input = Array.from({ length: 30 }, (_, index) => ({
            name: `n${index}`,
            type: 'ss',
            server: `${index}.example`,
            port: index + 1,
        }));
        const env = createEnv({ gate });
        const pending = runOptimized(
            input,
            { concurrency: 100 },
            env,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(env.maxInflight()).to.equal(20);
        release();
        await pending;

        const limited = createEnv({ gate: Promise.resolve() });
        await runOptimized(
            input.slice(0, 8),
            { concurrency: 3 },
            limited,
        );
        expect(limited.maxInflight()).to.be.at.most(3);
    });

    it('writes the whole batch once when the cache has no flush helper', async function () {
        const env = createEnv({ omitFlush: true, deferPersist: true });
        await runOptimized(clone(nodes()), { cache: true, geo: true }, env);
        expect(env.cache.persists.length).to.equal(1);
        expect(Object.keys(env.cache.resourceCache)[0]).to.match(/^geo:[0-9a-f]{32}$/);
    });
});
