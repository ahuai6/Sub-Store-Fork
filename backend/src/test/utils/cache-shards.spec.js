import { expect } from 'chai';
import { describe, it } from 'mocha';
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

    it('lazy-loads BoundedCache and reads only the matching shard on get()', function () {
        const { store, io } = storage();
        const writer = new BoundedCache({
            storeKey: '#lazy',
            sharded: true,
            resolveTtl: () => 60000,
            ...io,
        });
        for (let i = 0; i < 6; i += 1) {
            expect(writer.set(`sub-${i}`, 'x'.repeat(200000))).to.equal(true);
        }
        expect(JSON.parse(store['#lazy']).cacheShardsVersion).to.equal(1);

        const reads = [];
        const writes = [];
        let ttl = 60000;
        const reader = new BoundedCache({
            storeKey: '#lazy',
            sharded: true,
            resolveTtl: () => ttl,
            read(key) {
                reads.push(key);
                return store[key];
            },
            write(value, key) {
                writes.push(key);
                return io.write(value, key);
            },
        });
        // Constructor must stay completely lazy.
        expect(reads).to.deep.equal([]);
        expect(writes).to.deep.equal([]);

        // Cache hit reads only manifest + that 1 shard.
        expect(reader.get('sub-2')).to.have.length(200000);
        expect(reads).to.have.length(2);
        expect(reads[0]).to.equal('#lazy');

        // Cache miss on already-loaded manifest triggers 0 additional shard reads.
        reads.length = 0;
        expect(reader.get('missing')).to.equal(null);
        expect(reads).to.deep.equal([]);

        // TTL zero never reads or writes the store.
        ttl = 0;
        reads.length = 0;
        writes.length = 0;
        const zeroReader = new BoundedCache({
            storeKey: '#lazy',
            sharded: true,
            resolveTtl: () => ttl,
            read(key) {
                reads.push(key);
                return store[key];
            },
            write(value, key) {
                writes.push(key);
                return io.write(value, key);
            },
        });
        expect(zeroReader.get('sub-2')).to.equal(null);
        expect(zeroReader.set('sub-new', 'abc')).to.equal(false);
        expect(reads).to.deep.equal([]);
        expect(writes).to.deep.equal([]);

        // revokeAll drops all shards using only the manifest keys.
        const killerReads = [];
        const killer = new BoundedCache({
            storeKey: '#lazy',
            sharded: true,
            resolveTtl: () => 60000,
            read(key) {
                killerReads.push(key);
                return store[key];
            },
            ...{ write: io.write },
        });
        killer.revokeAll();
        expect(killerReads).to.deep.equal(['#lazy']);
        expect(store).to.deep.equal({ '#lazy': '{}' });
    });

    it('persists only once when cold-start get() encounters an expired sharded entry', function () {
        const { store, io } = storage();
        let now = 1_700_000_000_000;
        const writer = new BoundedCache({
            storeKey: '#expired-once',
            sharded: true,
            resolveTtl: () => 1000,
            ...io,
        });
        writer.now = () => now;
        for (let i = 0; i < 4; i += 1) {
            expect(writer.set(`k-${i}`, 'x'.repeat(25000))).to.equal(true);
        }
        expect(JSON.parse(store['#expired-once']).cacheShardsVersion).to.equal(
            1,
        );

        let manifestWrites = 0;
        const reader = new BoundedCache({
            storeKey: '#expired-once',
            sharded: true,
            resolveTtl: () => 1000,
            read: io.read,
            write(value, key) {
                if (key === '#expired-once') manifestWrites += 1;
                return io.write(value, key);
            },
        });
        reader.now = () => now + 2000;
        expect(reader.get('k-0')).to.equal(null);
        // Single save({}) path: staging + final '{}' (2 manifest writes), not double save (4).
        expect(manifestWrites).to.equal(2);
        expect(store).to.deep.equal({ '#expired-once': '{}' });
    });

    it('keeps _keySet consistent when a shard write fails mid-save', function () {
        const { store, io } = storage();
        const shards = new CacheShards('#fail-mid', {
            read: io.read,
            write(value, key) {
                if (key.includes(':v1:')) return false;
                return io.write(value, key);
            },
        });
        const entries = {
            big: { time: 99999, data: 'x'.repeat(70000) },
        };
        expect(shards.save(entries)).to.equal(false);
        expect(shards._keySet.size).to.equal(shards.keys.length);
        for (const key of shards.keys) {
            expect(shards._keySet.has(key)).to.equal(true);
        }
        expect(JSON.parse(store['#fail-mid']).cacheShardsVersion).to.equal(1);
    });

    it('accounts for shard wrapper bytes when checking BoundedCache budget', function () {
        const { io } = storage();
        const cache = new BoundedCache({
            storeKey: '#tight-budget',
            sharded: true,
            budget: 120,
            resolveTtl: () => 60000,
            ...io,
        });
        const longId = 'k'.repeat(60);
        const value = 'v'.repeat(40);
        // entry alone fits under 120 bytes, but [longId, entry] exceeds 120 bytes.
        expect(cache.set(longId, value)).to.equal(false);
        expect(cache.get(longId)).to.equal(null);
    });
});
