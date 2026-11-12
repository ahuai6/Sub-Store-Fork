import { expect } from 'chai';
import { EventEmitter } from 'events';
import { afterEach, before, describe, it } from 'mocha';

import { SCRIPT_RESOURCE_CACHE_KEY, SETTINGS_KEY } from '@/constants';

let $;
let cache;
let bindScriptCacheFlush;
let originalRead;
let originalWrite;
let originalDone;
let writes;

describe('script resource cache batching', function () {
    before(function () {
        ({ default: $ } = require('@/core/app'));
        ({
            default: cache,
            bindScriptCacheFlush,
        } = require('@/utils/script-resource-cache'));
        originalRead = $.read.bind($);
        originalWrite = $.write.bind($);
        originalDone = $.done;
    });

    afterEach(function () {
        cache.flush();
        cache.resourceCache = {};
        $.read = originalRead;
        $.write = originalWrite;
        $.done = originalDone;
    });

    function installWriteSpy() {
        writes = [];
        $.write = (value, key) => {
            if (key === SCRIPT_RESOURCE_CACHE_KEY) writes.push(value);
            return true;
        };
    }

    it('keeps set values in memory and persists once on flush', function () {
        installWriteSpy();
        cache.set('a', { ok: 1 });
        cache.set('b', { ok: 2 });
        cache.set('c', { ok: 3 });
        expect(writes).to.deep.equal([]);
        expect(cache.get('b')).to.deep.equal({ ok: 2 });
        cache.flush();
        expect(writes).to.have.length(1);
        expect(JSON.parse(writes[0]).b.data).to.deep.equal({ ok: 2 });
    });

    it('flushes every 25 sets without waiting for the request to end', function () {
        installWriteSpy();
        for (let i = 0; i < 30; i++) cache.set(`k${i}`, i);
        expect(writes).to.have.length(1);
        cache.flush();
        expect(writes).to.have.length(2);
        expect(cache.get('k29')).to.equal(29);
    });

    it('expires with scriptCacheTtl and drops the entry on clear-cache', function () {
        const now = Date.now();
        $.read = (key) => {
            if (key === SETTINGS_KEY) return { scriptCacheTtl: 15 };
            return originalRead(key);
        };
        installWriteSpy();
        cache.set('geo', { api: { country: 'JP' } });
        expect(cache.resourceCache.geo.time).to.be.at.least(now + 15000);
        expect(cache.resourceCache.geo.time).to.be.at.most(now + 15000 + 50);
        cache.revokeAll();
        expect(cache.resourceCache).to.deep.equal({});
        expect(writes.length).to.be.at.least(1);
        expect(JSON.parse(writes[writes.length - 1])).to.deep.equal({});
    });

    it('flushes when the Node response finishes and when $.done runs', function () {
        installWriteSpy();
        cache.set('pending', 1);
        const res = new EventEmitter();
        bindScriptCacheFlush(res);
        res.emit('finish');
        expect(JSON.parse(writes[0]).pending.data).to.equal(1);

        cache.set('cron', 2);
        $.done({});
        expect(JSON.parse(writes[writes.length - 1]).cron.data).to.equal(2);
    });
});
