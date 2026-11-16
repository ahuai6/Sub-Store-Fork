import { expect } from 'chai';
import { afterEach, before, describe, it } from 'mocha';

import { CHECK_RESULT_CACHE_KEY, SETTINGS_KEY } from '@/constants';
import { BoundedCache } from '@/utils/bounded-cache';

describe('shared check cache', function () {
    let $;
    let cache;
    let scriptCache;
    let checkKey;
    let originalRead;
    let now;

    const nodeA = {
        name: 'Hong Kong 1',
        type: 'ss',
        server: 'a.example',
        port: 443,
        password: 'secret',
        _subName: 'col-a',
        id: 4,
    };
    const nodeB = {
        name: 'HK backup',
        type: 'ss',
        server: 'a.example',
        port: 443,
        password: 'secret',
        _collectionName: 'col-b',
    };
    const identity = (node, args = { api: 'http://ip-api.com' }) => ({
        node,
        script: 'geo',
        args,
    });

    before(function () {
        ({ default: $ } = require('@/core/app'));
        ({
            default: cache,
            checkKey,
        } = require('@/utils/check-result-cache'));
        ({ default: scriptCache } = require('@/utils/script-resource-cache'));
        originalRead = $.read.bind($);
        $.info = () => {};
        $.error = () => {};
    });

    afterEach(function () {
        cache.now = () => Date.now();
        cache.revokeAll();
        $.read = originalRead;
        now = null;
    });

    it('reuses one result for the same node identity, script, and args', async function () {
        let calls = 0;
        const first = await cache.sharedCheck(identity(nodeA), async () => {
            calls += 1;
            return { api: { country: 'HK' } };
        });
        const second = await cache.sharedCheck(identity(nodeB), async () => {
            calls += 1;
            return { api: { country: 'OTHER' } };
        });
        expect(calls).to.equal(1);
        expect(second).to.deep.equal(first);
        expect(checkKey(identity(nodeA))).to.equal(checkKey(identity(nodeB)));
    });

    it('does not reuse a result when the check args differ', async function () {
        let calls = 0;
        await cache.sharedCheck(identity(nodeA, { api: 'one' }), async () => {
            calls += 1;
            return { api: 1 };
        });
        await cache.sharedCheck(identity(nodeA, { api: 'two' }), async () => {
            calls += 1;
            return { api: 2 };
        });
        expect(calls).to.equal(2);
    });

    it('recomputes after scriptCacheTtl even when the node config is unchanged', async function () {
        now = 1_700_000_000_000;
        cache.now = () => now;
        $.read = (key) => {
            if (key === SETTINGS_KEY) return { scriptCacheTtl: 15 };
            return originalRead(key);
        };
        let calls = 0;
        const load = () =>
            cache.sharedCheck(identity(nodeA), async () => {
                calls += 1;
                return { api: calls };
            });
        expect(await load()).to.deep.equal({ api: 1 });
        expect(await load()).to.deep.equal({ api: 1 });
        now += 15 * 1000;
        expect(await load()).to.deep.equal({ api: 2 });
        expect(calls).to.equal(2);
    });

    it('does not store a result when scriptCacheTtl is explicitly 0', async function () {
        $.read = (key) => {
            if (key === SETTINGS_KEY) return { scriptCacheTtl: 0 };
            return originalRead(key);
        };
        let calls = 0;
        await cache.sharedCheck(identity(nodeA), async () => {
            calls += 1;
            return { api: 'x' };
        });
        await cache.sharedCheck(identity(nodeA), async () => {
            calls += 1;
            return { api: 'y' };
        });
        expect(calls).to.equal(2);
    });

    it('clears shared checks from clear-cache and from scriptResourceCache.revokeAll', async function () {
        await cache.sharedCheck(identity(nodeA), async () => ({ api: 1 }));
        expect(cache.get(checkKey(identity(nodeA)))).to.deep.equal({ api: 1 });
        scriptCache.revokeAll();
        expect(cache.get(checkKey(identity(nodeA)))).to.equal(null);
        await cache.sharedCheck(identity(nodeA), async () => ({ api: 2 }));
        cache.revokeAll();
        expect(cache.entries).to.deep.equal({});
    });

    it('shares one in-flight producer and skips oversized results', async function () {
        let calls = 0;
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const first = cache.sharedCheck(identity(nodeA), async () => {
            calls += 1;
            await gate;
            return { api: 'shared' };
        });
        const second = cache.sharedCheck(identity(nodeB), async () => {
            calls += 1;
            return { api: 'nope' };
        });
        release();
        expect(await first).to.deep.equal({ api: 'shared' });
        expect(await second).to.deep.equal({ api: 'shared' });
        expect(calls).to.equal(1);

        const store = {};
        class Tiny extends BoundedCache {
            entryBudget() {
                return 30;
            }
        }
        const tiny = new Tiny({
            storeKey: 'tiny-check',
            label: 'tiny-check',
            budget: 80,
            resolveTtl: () => 1000,
            read: (key) => store[key],
            write: (value, key) => {
                store[key] = value;
            },
        });
        expect(tiny.set('big', { blob: 'x'.repeat(80) })).to.equal(false);
        expect(tiny.get('big')).to.equal(null);
    });

    it('batches writes every 25 sets and flushes through scriptResourceCache', async function () {
        const originalWrite = $.write.bind($);
        const writes = [];
        $.write = (value, key) => {
            if (key === CHECK_RESULT_CACHE_KEY) writes.push(value);
            return originalWrite(value, key);
        };
        try {
            for (let i = 0; i < 10; i += 1) {
                await cache.sharedCheck(
                    identity({ ...nodeA, port: 1000 + i }),
                    async () => ({ api: i }),
                );
            }
            expect(writes).to.deep.equal([]);
            scriptCache.flush();
            expect(writes).to.have.length(1);

            for (let i = 10; i < 35; i += 1) {
                await cache.sharedCheck(
                    identity({ ...nodeA, port: 1000 + i }),
                    async () => ({ api: i }),
                );
            }
            expect(writes).to.have.length(2);
        } finally {
            $.write = originalWrite;
        }
    });
});
