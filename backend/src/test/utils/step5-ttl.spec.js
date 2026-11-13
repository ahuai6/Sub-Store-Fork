import { expect } from 'chai';
import $ from '@/core/app';
import scriptCache from '@/utils/script-resource-cache';
import checks from '@/utils/check-result-cache';
import {
    CHECK_RESULT_CACHE_KEY,
    LAST_GOOD_CACHE_KEY,
    SCRIPT_RESOURCE_CACHE_KEY,
    SETTINGS_KEY,
} from '@/constants';

describe('step 5 TTL and refresh edges', function () {
    const read = $.read.bind($);
    afterEach(function () {
        scriptCache.revokeAll();
        $.read = read;
    });
    it('turning scriptCacheTtl off also hides preexisting entries', function () {
        let ttl = 60;
        $.read = (key) =>
            key === SETTINGS_KEY ? { scriptCacheTtl: ttl } : read(key);
        scriptCache.set('old', { ok: 1 });
        checks.set('old', { ok: 1 });
        ttl = 0;
        expect(scriptCache.get('old')).to.equal(null);
        expect(scriptCache.gettime('old')).to.equal(null);
        expect(checks.get('old')).to.equal(null);
        scriptCache.set('new', 1, 999999);
        expect(scriptCache.resourceCache.new).to.equal(undefined);
    });
    it('flushes script resources beyond 4MB to separate values and clears every shard', function () {
        const write = $.write.bind($);
        const store = {};
        $.read = (key) =>
            key === SETTINGS_KEY ? { scriptCacheTtl: 60 } : store[key];
        $.write = (value, key) => {
            if (value == null) delete store[key];
            else store[key] = value;
            return true;
        };
        try {
            for (let i = 0; i < 6; i++)
                scriptCache.set(`subscription-${i}`, 'x'.repeat(800000));
            scriptCache.flush();
            expect(
                JSON.parse(store[SCRIPT_RESOURCE_CACHE_KEY]).keys,
            ).to.have.length(6);
            expect(scriptCache.get('subscription-0')).to.have.length(800000);
            scriptCache.revokeAll();
            expect(store[SCRIPT_RESOURCE_CACHE_KEY]).to.equal('{}');
            expect(store[CHECK_RESULT_CACHE_KEY]).to.equal('{}');
            expect(store[LAST_GOOD_CACHE_KEY]).to.equal('{}');
            expect(
                Object.keys(store).filter(
                    (key) =>
                        key !== SCRIPT_RESOURCE_CACHE_KEY &&
                        key !== CHECK_RESULT_CACHE_KEY &&
                        key !== LAST_GOOD_CACHE_KEY,
                ),
            ).to.deep.equal([]);
        } finally {
            scriptCache.revokeAll();
            $.write = write;
        }
    });

    it('refresh during a pending shared check prevents late persistence', async function () {
        let release;
        const pending = checks.sharedCheck(
            { node: { server: 'x' } },
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        scriptCache.revokeAll();
        release({ api: 1 });
        await pending;
        expect(checks.entries).to.deep.equal({});
    });
    it('does not cache shared producer failures or leave rejected promises unhandled', async function () {
        try {
            await checks.sharedCheck({ node: { server: 'x' } }, async () => {
                throw new Error('failed');
            });
        } catch (e) {
            expect(e.message).to.equal('failed');
        }
        expect(checks._inflight.size).to.equal(0);
        expect(checks.entries).to.deep.equal({});
    });
});
