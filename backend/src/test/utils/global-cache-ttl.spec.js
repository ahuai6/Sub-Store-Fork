import { expect } from 'chai';
import $ from '@/core/app';
import { SETTINGS_KEY } from '@/constants';
import resources from '@/utils/resource-cache';
import headers from '@/utils/headers-resource-cache';
import scripts from '@/utils/script-resource-cache';

for (const [label, cache, setting] of [
    ['resources', resources, 'resourceCacheTtl'],
    ['headers', headers, 'headersCacheTtl'],
    ['scripts', scripts, 'scriptCacheTtl'],
]) {
    describe(`global TTL for ${label}`, function () {
        let read;
        let now;
        let seconds;
        beforeEach(function () {
            read = $.read;
            now = Date.now;
            seconds = 60;
            Date.now = () => 1700000000000;
            $.read = (key) =>
                key === SETTINGS_KEY
                    ? { [setting]: seconds }
                    : read.call($, key);
            cache.revokeAll();
        });
        afterEach(function () {
            cache.revokeAll();
            $.read = read;
            Date.now = now;
        });
        it('TTL zero hides existing entries and prevents even explicitly long writes', function () {
            cache.set('existing', 'value');
            seconds = 0;
            expect(cache.get('existing')).to.equal(null);
            expect(cache.gettime('existing')).to.equal(null);
            cache.set('new', 'value', 9999999);
            expect(cache.resourceCache.new).to.equal(undefined);
        });
        it('caps a requested lifetime and expires at the boundary with unchanged identity', function () {
            cache.set('unchanged-node', 'old', 9999999);
            expect(cache.gettime('unchanged-node')).to.equal(
                Date.now() + 60000,
            );
            Date.now = () => 1700000060000;
            expect(cache.get('unchanged-node')).to.equal(null);
            expect(cache.gettime('unchanged-node')).to.equal(null);
            cache.set('unchanged-node', 'new');
            expect(cache.get('unchanged-node')).to.equal('new');
        });
        it('shortening global TTL expires new-layout records without extending the original deadline', function () {
            cache.set('entry', 'old');
            seconds = 5;
            Date.now = () => 1700000005000;
            expect(cache.get('entry')).to.equal(null);
            seconds = 600;
            Date.now = () => 1700000060000;
            expect(cache.get('entry')).to.equal(null);
        });
    });
}
