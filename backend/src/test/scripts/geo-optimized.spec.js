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

    it('reuses a shared check for the same node under a different name', async function () {
        const { default: checkCache, checkKey } = require('@/utils/check-result-cache');
        checkCache.revokeAll();
        const env = createEnv({ settings: { scriptCacheTtl: 3600 } });
        env.cache.sharedCheckGet = (identity) => checkCache.get(checkKey(identity));
        env.cache.sharedCheckSet = (identity, value) =>
            checkCache.set(checkKey(identity), value);
        env.cache.sharedCheckClaim = (identity) => checkCache.claim(identity);
        const input = [
            { name: 'one', type: 'ss', server: 'a.example', port: 1, password: 'p' },
            { name: 'two', type: 'ss', server: 'a.example', port: 1, password: 'p' },
        ];
        const output = await runOptimized(clone(input), { cache: true, geo: true }, env);
        expect(env.httpCalls).to.have.length(1);
        expect(output[0].name).to.include('one');
        expect(output[1].name).to.include('two');
        expect(output[0]._geo).to.deep.equal(output[1]._geo);
        checkCache.revokeAll();
    });

    it('shares concurrent target requests only when opted in and releases them after the run', async function () {
        const input = [
            { name: 'one', type: 'ss', server: 'a.example', port: 1, password: 'one' },
            { name: 'two', type: 'ss', server: 'a.example', port: 1, password: 'two' },
        ];
        const env = createEnv({ delayMs: 5 });
        await runOptimized(clone(input), { dedup_target: true }, env);
        expect(env.httpCalls).to.have.length(1);
        await runOptimized(clone(input), { dedup_target: true }, env);
        expect(env.httpCalls).to.have.length(2);
        const safe = createEnv({ delayMs: 5 });
        await runOptimized(clone(input), {}, safe);
        expect(safe.httpCalls).to.have.length(2);
    });

    it('probes first with short timeout and only does geo on reachable nodes', async function () {
        const env = createEnv();
        const input = nodes().slice(0, 3);
        const result = await runOptimized(clone(input), { two_phase: true, geo: true, retries: 0 }, env);
        expect(env.httpCalls.filter(c => c.url.includes('generate_204'))).to.have.length(3);
        expect(env.httpCalls.filter(c => c.url.includes('ip-api.com'))).to.have.length(2);
        expect(env.httpCalls.filter(c => c.url.includes('generate_204')).every(c => c.timeout <= 1500)).to.equal(true);
        expect(result[2]._geo).to.equal(undefined);
    });

    it('does not launch geo or cache a failure when the budget ends during phase one', async function () {
        const env = createEnv({ delayMs: 25, deferPersist: true });
        const result = await runOptimized(clone(nodes().slice(0, 1)),
            { two_phase: true, cache: true, geo: true, time_budget: 10 }, env);
        expect(env.httpCalls).to.have.length(1);
        expect(result[0].name).to.equal('ok-a');
        expect(env.cache.resourceCache).to.deep.equal({});
    });

    it('disables every geo cache path at explicit scriptCacheTtl zero', async function () {
        const env = createEnv({ settings: { scriptCacheTtl: 0 } });
        await runOptimized(clone(nodes().slice(0, 1)), { cache: true }, env);
        await runOptimized(clone(nodes().slice(0, 1)), { cache: true }, env);
        expect(env.httpCalls).to.have.length(2);
        expect(env.cache.resourceCache).to.deep.equal({});
    });

    it('writes the whole batch once when the cache has no flush helper', async function () {
        const env = createEnv({ omitFlush: true, deferPersist: true });
        await runOptimized(clone(nodes()), { cache: true, geo: true }, env);
        expect(env.cache.persists.length).to.equal(1);
        expect(Object.keys(env.cache.resourceCache)[0]).to.match(/^geo:[0-9a-f]{32}$/);
    });

    function wireLastGood(env, { reset = true } = {}) {
        const lastGood = require('@/utils/last-good-cache').default;
        if (reset) lastGood.revokeAll();
        env.cache.lastGoodGet = (id) => lastGood.get(id);
        env.cache.lastGoodSet = (id, value) => lastGood.set(id, value);
        env.cache.lastGoodFlush = () => lastGood.flush();
        return lastGood;
    }

    function measuredBody(country) {
        return {
            status: 200,
            body: JSON.stringify({ country, isp: 'Example' }),
        };
    }

    it('matches the original output when keep_last is off', async function () {
        const cases = [
            { cache: true, geo: true, incompatible: true },
            { keep_last: false, cache: true, geo: true },
            { keep_last: 'false', geo: true, remove_failed: true, incompatible: true },
        ];
        for (const args of cases) {
            const input = nodes();
            const originalEnv = createEnv();
            const env = createEnv();
            const lastGood = wireLastGood(env);
            const original = await runOriginal(clone(input), args, originalEnv);
            const optimized = await runOptimized(clone(input), args, env);
            expect(optimized).to.deep.equal(original);
            expect(lastGood.entries).to.deep.equal({});
            expect(env.httpCalls).to.have.length(originalEnv.httpCalls.length);
        }
    });

    it('overwrites the stored success with the new measurement', async function () {
        let country = '日本';
        const env = createEnv({
            bodyFor: () => measuredBody(country),
        });
        const lastGood = wireLastGood(env);
        const node = [{ name: 'ok-a', type: 'ss', server: 'a.example', port: 1 }];
        const first = await runOptimized(
            clone(node),
            { keep_last: true, geo: true },
            env,
        );
        expect(first[0].name).to.equal('日本 Example - ok-a');
        country = '美国';
        const second = await runOptimized(
            clone(node),
            { keep_last: 'true', geo: true },
            env,
        );
        expect(second[0]).to.deep.equal({
            name: '美国 Example - ok-a',
            type: 'ss',
            server: 'a.example',
            port: 1,
            _geo: { country: '美国', isp: 'Example' },
        });
        expect(Object.values(lastGood.entries)).to.have.length(1);
        expect(Object.values(lastGood.entries)[0].api.country).to.equal('美国');
    });

    it('renders the last success when a later test fails or times out', async function () {
        let mode = 'ok';
        const env = createEnv({
            bodyFor: () => {
                if (mode === 'fail') return { status: 500, body: '{}' };
                if (mode === 'throw') throw new Error('timeout');
                return measuredBody('日本');
            },
        });
        const lastGood = wireLastGood(env);
        const node = [{ name: 'ok-a', type: 'ss', server: 'a.example', port: 1 }];
        const args = { keep_last: true, geo: true, remove_failed: true };
        const ok = await runOptimized(clone(node), args, env);
        mode = 'fail';
        const failed = await runOptimized(clone(node), args, env);
        expect(failed).to.deep.equal(ok);
        expect(JSON.stringify(failed)).to.not.include('last-good');
        expect(JSON.stringify(failed)).to.not.include('keep_last');
        mode = 'throw';
        const thrown = await runOptimized(clone(node), args, env);
        expect(thrown).to.deep.equal(ok);
        expect(Object.values(lastGood.entries)[0].api).to.deep.equal({
            country: '日本',
            isp: 'Example',
        });
    });

    it('keeps the existing failure result when that node has no last success', async function () {
        const input = [
            { name: 'FAIL', type: 'ss', server: 'c.example', port: 3 },
            { name: 'BOOM', type: 'ss', server: 'd.example', port: 4 },
        ];
        const args = { keep_last: true, geo: true, incompatible: true, remove_failed: true };
        const originalEnv = createEnv();
        const env = createEnv();
        const lastGood = wireLastGood(env);
        const original = await runOriginal(clone(input), args, originalEnv);
        const optimized = await runOptimized(clone(input), args, env);
        expect(optimized).to.deep.equal(original);
        expect(optimized).to.have.length(0);
        expect(lastGood.entries).to.deep.equal({});
    });

    it('does not expire last-good when scriptCacheTtl elapses or is zero', async function () {
        realNow = Date.now;
        let now = 1_700_000_000_000;
        Date.now = () => now;
        let fail = false;
        const env = createEnv({
            settings: { scriptCacheTtl: 60 },
            bodyFor: () => (fail ? { status: 500, body: '{}' } : measuredBody('日本')),
        });
        const lastGood = wireLastGood(env);
        const node = [{ name: 'ok-a', type: 'ss', server: 'a.example', port: 1 }];
        const ok = await runOptimized(
            clone(node),
            { cache: true, keep_last: true, geo: true },
            env,
        );
        fail = true;
        now += 60 * 1000 + 1;
        const calls = env.httpCalls.length;
        const again = await runOptimized(
            clone(node),
            { cache: true, keep_last: true, geo: true },
            env,
        );
        expect(env.httpCalls.length).to.be.greaterThan(calls);
        expect(again).to.deep.equal(ok);

        const isolated = createEnv({
            settings: { scriptCacheTtl: 0 },
            bodyFor: () => (fail ? { status: 500, body: '{}' } : measuredBody('日本')),
        });
        wireLastGood(isolated, { reset: false });
        fail = false;
        const fresh = await runOptimized(
            clone(node),
            { cache: true, keep_last: true, geo: true },
            isolated,
        );
        const callsAfter = isolated.httpCalls.length;
        fail = true;
        const reused = await runOptimized(
            clone(node),
            { cache: true, keep_last: true, geo: true },
            isolated,
        );
        expect(isolated.httpCalls.length).to.equal(callsAfter + 1);
        expect(reused).to.deep.equal(fresh);
        expect(Object.values(lastGood.entries)[0].api.country).to.equal('日本');

        const callsAfterFailure = env.httpCalls.length;
        const cachedFailure = await runOptimized(
            clone(node),
            { cache: true, keep_last: true, geo: true },
            env,
        );
        expect(env.httpCalls.length).to.equal(callsAfterFailure);
        expect(cachedFailure).to.deep.equal(ok);
    });

    it('does not use a last success older than keep_last_max_age', async function () {
        realNow = Date.now;
        let now = 1_700_000_000_000;
        Date.now = () => now;
        let fail = false;
        const env = createEnv({
            bodyFor: () => (fail ? { status: 500, body: '{}' } : measuredBody('日本')),
        });
        const lastGood = wireLastGood(env);
        const node = [{ name: 'ok-a', type: 'ss', server: 'a.example', port: 1 }];
        const ok = await runOptimized(clone(node), { keep_last: true, geo: true }, env);
        fail = true;
        now += 1000;
        const atBoundary = await runOptimized(
            clone(node),
            { keep_last: true, keep_last_max_age: 1000, geo: true },
            env,
        );
        expect(atBoundary).to.deep.equal(ok);
        now += 1;
        const expired = await runOptimized(
            clone(node),
            { keep_last: true, keep_last_max_age: '1s', geo: true },
            env,
        );
        expect(expired[0].name).to.equal('ok-a');
        expect(expired[0]._geo).to.equal(undefined);
        expect(Object.values(lastGood.entries)[0].api.country).to.equal('日本');
        now = 1_700_000_000_000 + 6 * 24 * 3600 * 1000;
        const withinWeek = await runOptimized(
            clone(node),
            { keep_last: true, keep_last_max_age: '7d', geo: true },
            env,
        );
        expect(withinWeek).to.deep.equal(ok);
        now = 1_700_000_000_000 + 8 * 24 * 3600 * 1000;
        const pastWeek = await runOptimized(
            clone(node),
            { keep_last: true, keep_last_max_age: '7d', geo: true },
            env,
        );
        expect(pastWeek[0].name).to.equal('ok-a');
        expect(pastWeek[0]._geo).to.equal(undefined);
        const kept = await runOptimized(clone(node), { keep_last: true, geo: true }, env);
        expect(kept).to.deep.equal(ok);
    });

    it('isolates last-good results with the script cache identity', async function () {
        let fail = false;
        const env = createEnv({
            bodyFor: () => (fail ? { status: 500, body: '{}' } : measuredBody('日本')),
        });
        const lastGood = wireLastGood(env);
        const base = {
            name: 'a',
            type: 'ss',
            server: 'a.example',
            port: 1,
            password: 'p',
        };
        await runOptimized(
            [{ ...base, collectionName: 'c1' }],
            { keep_last: true, geo: true, dedup_target: true },
            env,
        );
        expect(Object.keys(lastGood.entries)).to.have.length(1);
        fail = true;
        const result = await runOptimized(
            [
                { ...base, collectionName: 'c2', subName: 's', id: 9, _extra: 1 },
                { ...base, name: 'b' },
                { ...base, password: 'other' },
            ],
            { keep_last: true, geo: true, dedup_target: true },
            env,
        );
        expect(result[0].name).to.equal('日本 Example - a');
        expect(result[0]._geo.country).to.equal('日本');
        expect(result[1]).to.include({ name: 'b', type: 'ss' });
        expect(result[1]._geo).to.equal(undefined);
        expect(result[2].name).to.equal('a');
        expect(result[2]._geo).to.equal(undefined);
        expect(Object.keys(lastGood.entries)).to.have.length(1);
    });

    it('uses last-good when the budget ends during phase one and does not cache that failure', async function () {
        const node = nodes().slice(0, 1);
        const seedEnv = createEnv();
        wireLastGood(seedEnv);
        const ok = await runOptimized(
            clone(node),
            { two_phase: true, keep_last: true, geo: true },
            seedEnv,
        );
        const env = createEnv({ delayMs: 25, deferPersist: true });
        const lastGood = wireLastGood(env, { reset: false });
        const result = await runOptimized(
            clone(node),
            {
                two_phase: true,
                cache: true,
                keep_last: true,
                geo: true,
                time_budget: 10,
            },
            env,
        );
        expect(env.httpCalls).to.have.length(1);
        expect(env.httpCalls[0].url).to.include('generate_204');
        expect(result).to.deep.equal(ok);
        expect(env.cache.resourceCache).to.deep.equal({});
        expect(Object.values(lastGood.entries)[0].api.country).to.equal('日本');
    });

    it('reuses last-good for nodes skipped by time_budget and leaves unknown nodes unchanged', async function () {
        this.timeout(10000);
        const input = [0, 1, 2, 3].map((index) => ({
            name: `n${index}`,
            type: 'ss',
            server: `${index}.example`,
            port: index + 1,
        }));
        let country = '日本';
        const seedEnv = createEnv({
            bodyFor: () => measuredBody(country),
        });
        wireLastGood(seedEnv);
        await runOptimized(clone(input), { keep_last: true, geo: true }, seedEnv);
        country = '美国';
        const env = createEnv({
            delayMs: 40,
            bodyFor: () => measuredBody(country),
        });
        wireLastGood(env, { reset: false });
        const output = await runOptimized(
            clone(input),
            { keep_last: true, geo: true, concurrency: 1, time_budget: 30 },
            env,
        );
        const fresh = output.filter((proxy) => proxy.name.includes('美国'));
        const reused = output.filter((proxy) => proxy.name.includes('日本'));
        expect(fresh.length).to.be.at.least(1);
        expect(reused.length).to.be.at.least(1);
        expect(fresh.every((proxy) => proxy._geo.country === '美国')).to.equal(true);
        expect(reused.every((proxy) => proxy._geo.country === '日本')).to.equal(true);
        expect(output.some((proxy) => proxy.name.startsWith('n'))).to.equal(false);

        const unseen = createEnv({ delayMs: 40 });
        wireLastGood(unseen);
        const skipped = await runOptimized(
            clone(input),
            { keep_last: true, geo: true, concurrency: 1, time_budget: 30 },
            unseen,
        );
        const untouched = skipped.filter((proxy) => !proxy._geo);
        expect(untouched.length).to.be.at.least(1);
        expect(untouched.every((proxy) => /^n\d$/.test(proxy.name))).to.equal(true);
    });

    it('flushes last-good in batches rather than once per node', async function () {
        const { default: $ } = require('@/core/app');
        const env = createEnv();
        const lastGood = wireLastGood(env);
        const originalWrite = $.write.bind($);
        const writes = [];
        $.write = (value, key) => {
            if (String(key).includes('last-good')) writes.push(String(key));
            return originalWrite(value, key);
        };
        try {
            const input = Array.from({ length: 30 }, (_, index) => ({
                name: `n${index}`,
                type: 'ss',
                server: `${index}.example`,
                port: index + 1,
            }));
            await runOptimized(input, { keep_last: true, geo: true }, env);
            expect(Object.keys(lastGood.entries)).to.have.length(30);
            expect(writes.length).to.be.at.least(1);
            expect(writes.length).to.be.below(30);
        } finally {
            $.write = originalWrite;
        }
    });
});
