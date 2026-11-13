import { expect } from 'chai';
import { CacheShards, jsonBytes, SHARD_BYTES } from '@/utils/cache-shards';
import { BoundedCache } from '@/utils/bounded-cache';

function storage(initial = {}) {
    const store = { ...initial };
    const io = {
        read: (key) => store[key],
        write(value, key) {
            expect(
                value == null || jsonBytes(JSON.parse(value)) <= SHARD_BYTES,
            ).to.equal(true);
            if (value === null) delete store[key];
            else store[key] = value;
            return true;
        },
    };
    return { store, io };
}

describe('per-key cache shards', function () {
    it('migrates legacy entries without extending TTL and isolates more than 4MB', function () {
        const old = { old: { time: 10000, data: 'legacy' } };
        const { store, io } = storage({ '#test': JSON.stringify(old) });
        const shards = new CacheShards('#test', io);
        const entries = shards.load();
        for (let i = 0; i < 6; i++)
            entries[`sub-${i}`] = { time: 12000, data: '中'.repeat(300000) };
        expect(shards.save(entries)).to.equal(true);
        expect(JSON.parse(store['#test']).cacheShardsVersion).to.equal(1);
        expect(new CacheShards('#test', io).load()).to.deep.equal(entries);
        expect(entries.old.time).to.equal(10000);
        expect(Object.keys(store)).to.have.length(8);
        expect(shards.save({})).to.equal(true);
        expect(store).to.deep.equal({ '#test': '{}' });
    });

    it('keeps old entries readable across an interrupted migration', function () {
        const old = { a: { time: 1234, data: 'old' } };
        const { store, io } = storage({ '#test': JSON.stringify(old) });
        const shards = new CacheShards('#test', {
            ...io,
            write: (v, k) => (k.includes(':v1:') ? false : io.write(v, k)),
        });
        shards.load();
        expect(
            shards.save({ ...old, b: { time: 5678, data: 'x'.repeat(70000) } }),
        ).to.equal(false);
        const reloaded = new CacheShards('#test', io);
        expect(reloaded.load().a).to.deep.equal(old.a);
        reloaded.save({});
        expect(store).to.deep.equal({ '#test': '{}' });
    });

    it('expires migrated entries at the boundary and never evicts another key', function () {
        const { store, io } = storage();
        const make = () =>
            new BoundedCache({
                storeKey: '#test',
                sharded: true,
                resolveTtl: () => 1000,
                ...io,
            });
        const cache = make();
        let now = Date.now();
        cache.now = () => now;
        for (let i = 0; i < 6; i++)
            expect(cache.set(`sub-${i}`, 'x'.repeat(800000))).to.equal(true);
        expect(cache.get('sub-0')).to.have.length(800000);
        now += 1000;
        expect(cache.get('sub-0')).to.equal(null);
        cache.revokeAll();
        expect(store).to.deep.equal({ '#test': '{}' });
        expect(make().get('sub-1')).to.equal(null);
    });

    it('retains the legacy absolute expiry after migration and reload', function () {
        const deadline = Date.now() + 10000;
        const { io } = storage({
            '#test': JSON.stringify({
                node: { time: deadline, data: 'old' },
            }),
        });
        const shards = new CacheShards('#test', io);
        const entries = shards.load();
        entries.other = { time: deadline, data: 'x'.repeat(70000) };
        shards.save(entries);
        const cache = new BoundedCache({
            storeKey: '#test',
            sharded: true,
            resolveTtl: () => 100000,
            ...io,
        });
        expect(cache.get('node')).to.equal('old');
        cache.now = () => deadline;
        expect(cache.get('node')).to.equal(null);
        expect(new CacheShards('#test', io).load().node).to.equal(undefined);
    });

    it('counts UTF-8 bytes, including emoji and JSON escaping', function () {
        expect(jsonBytes('😀')).to.equal(6);
        const { store, io } = storage();
        const shards = new CacheShards('#test', io);
        shards.load();
        shards.save({ a: { time: 1, data: '😀'.repeat(20000) } });
        expect(JSON.parse(store['#test']).cacheShardsVersion).to.equal(1);
    });
});
