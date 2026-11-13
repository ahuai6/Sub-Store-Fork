import { expect } from 'chai';
import http from 'http';
import { afterEach, describe, it } from 'mocha';

import { LAST_GOOD_CACHE_KEY, SETTINGS_KEY } from '@/constants';
import $ from '@/core/app';
import express from '@/vendor/express';
import registerUtils from '@/restful/miscs';
import scriptCache from '@/utils/script-resource-cache';
import lastGood, { LastGoodCache } from '@/utils/last-good-cache';

function memoryCache() {
    const store = {};
    const writes = [];
    const cache = new LastGoodCache(LAST_GOOD_CACHE_KEY, {
        read: (key) => store[key],
        write(value, key) {
            writes.push(key);
            if (value == null) delete store[key];
            else store[key] = value;
            return true;
        },
    });
    return { store, writes, cache };
}

describe('last successful geo result', function () {
    const read = $.read.bind($);

    afterEach(function () {
        lastGood.revokeAll();
        $.read = read;
    });

    it('batches writes and reloads sharded entries without a scriptCacheTtl', function () {
        const { store, writes, cache } = memoryCache();
        for (let index = 0; index < 24; index += 1) {
            expect(
                cache.set(`node-${index}`, {
                    api: { country: 'JP', index },
                    savedAt: 10,
                }),
            ).to.equal(true);
        }
        expect(writes).to.deep.equal([]);
        expect(
            cache.set('node-24', { api: { country: 'JP', index: 24 }, savedAt: 10 }),
        ).to.equal(true);
        expect(writes).to.have.length(1);
        for (let index = 0; index < 6; index += 1) {
            cache.set(`big-${index}`, {
                api: { country: '中'.repeat(300000) },
                savedAt: 20 + index,
            });
        }
        const writesBeforeFlush = writes.length;
        cache.flush();
        expect(writes.length).to.be.greaterThan(writesBeforeFlush);
        const manifest = JSON.parse(store[LAST_GOOD_CACHE_KEY]);
        expect(manifest.cacheShardsVersion).to.equal(1);
        expect(manifest.keys.length).to.be.greaterThan(6);
        const restored = new LastGoodCache(LAST_GOOD_CACHE_KEY, {
            read: (key) => store[key],
            write(value, key) {
                if (value == null) delete store[key];
                else store[key] = value;
                return true;
            },
        });
        expect(restored.get('node-3').api).to.deep.equal({
            country: 'JP',
            index: 3,
        });
        expect(restored.get('big-1').api.country).to.have.length(300000);
        expect(restored.get('big-1').savedAt).to.equal(21);
        expect(
            cache.set('too-big', {
                api: { country: 'x'.repeat(4 * 1024 * 1024) },
                savedAt: 1,
            }),
        ).to.equal(false);
        expect(cache.get('node-3').api.index).to.equal(3);

        cache.revokeAll();
        expect(store).to.deep.equal({ [LAST_GOOD_CACHE_KEY]: '{}' });
        expect(cache.get('node-3')).to.equal(null);
        const cleared = new LastGoodCache(LAST_GOOD_CACHE_KEY, {
            read: (key) => store[key],
            write(value, key) {
                if (value == null) delete store[key];
                else store[key] = value;
                return true;
            },
        });
        expect(cleared.get('node-3')).to.equal(null);
        expect(cleared.get('big-1')).to.equal(null);
    });

    it('keeps entries when scriptCacheTtl is zero and drops them on clear-cache', function () {
        $.read = (key) =>
            key === SETTINGS_KEY ? { scriptCacheTtl: 0 } : read(key);
        expect(
            lastGood.set('node-a', { api: { country: 'JP' }, savedAt: 1 }),
        ).to.equal(true);
        lastGood.flush();
        expect(lastGood.get('node-a').api).to.deep.equal({ country: 'JP' });
        scriptCache.revokeAll();
        expect(lastGood.get('node-a')).to.equal(null);
        expect($.read(LAST_GOOD_CACHE_KEY)).to.equal('{}');
    });

    it('clears the store from /api/utils/refresh', async function () {
        expect(
            lastGood.set('node-a', { api: { country: 'JP' }, savedAt: 5 }),
        ).to.equal(true);
        lastGood.flush();
        expect(lastGood.get('node-a').api.country).to.equal('JP');
        $.read = (key) => (key === SETTINGS_KEY ? {} : read(key));
        const app = express({ substore: $ });
        registerUtils(app);
        const server = await new Promise((resolve) => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        try {
            const response = await new Promise((resolve, reject) => {
                http.get(
                    `http://127.0.0.1:${server.address().port}/api/utils/refresh`,
                    (res) => {
                        const chunks = [];
                        res.on('data', (chunk) => chunks.push(chunk));
                        res.on('end', () =>
                            resolve({
                                status: res.statusCode,
                                body: Buffer.concat(chunks).toString('utf8'),
                            }),
                        );
                    },
                ).on('error', reject);
            });
            expect(response.status).to.equal(200);
            expect(JSON.parse(response.body).status).to.equal('success');
            expect(lastGood.get('node-a')).to.equal(null);
            expect($.read(LAST_GOOD_CACHE_KEY)).to.equal('{}');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
