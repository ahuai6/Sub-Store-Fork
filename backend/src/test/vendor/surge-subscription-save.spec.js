import fs from 'fs';
import { builtinModules } from 'module';
import path from 'path';
import vm from 'vm';

import { expect } from 'chai';
import { build } from 'esbuild';
import { before, describe, it } from 'mocha';

import { stripNonSurgeRegions } from '../../../surge-only-strip';

const backendRoot = path.resolve(__dirname, '../../..');

function surgePlugins() {
    return [
        {
            name: 'node-builtin-external',
            setup(b) {
                const builtins = new Set(
                    builtinModules.map((name) => name.replace(/^node:/, '')),
                );
                b.onResolve({ filter: /.*/ }, (args) => {
                    if (
                        args.path !== 'buffer' &&
                        builtins.has(args.path.replace(/^node:/, ''))
                    ) {
                        return { path: args.path, external: true };
                    }
                });
            },
        },
        {
            name: 'surge-only-strip',
            setup(b) {
                b.onLoad({ filter: /\.js$/ }, async (args) => {
                    if (!args.path.split(path.sep).includes('src')) return;
                    const contents = await fs.promises.readFile(
                        args.path,
                        'utf8',
                    );
                    if (!contents.includes('@non-surge-')) return;
                    return {
                        contents: stripNonSurgeRegions(contents, args.path),
                        loader: 'js',
                    };
                });
            },
        },
    ];
}

async function bundle(entry, define) {
    const bundled = await build({
        absWorkingDir: backendRoot,
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'browser',
        define,
        plugins: surgePlugins(),
    });
    return bundled.outputFiles[0].text;
}

function makeSubs(displayName) {
    const subs = [];
    for (let i = 0; i < 60; i += 1) {
        subs.push({
            name: i === 0 ? 'demo' : `sub-${i}`,
            displayName: i === 0 ? displayName : `label-${i}`,
            source: 'remote',
            url: `https://example.com/sub/${i}`,
            content: `payload-${i}-`.padEnd(12000, 'x'),
            process: [],
        });
    }
    return subs;
}

function seedStore(subs, { complete = true } = {}) {
    const backing = {};
    const reads = [];
    const writes = [];
    // $.read strips the leading # before $persistentStore.read. The manifest
    // still lists the logical keys, including the hash.
    const logical = '#sub-store-cached-script-resource';
    const manifestKeys = [];
    for (let i = 0; i < 12; i += 1) {
        const logicalShard = `${logical}:v1:shard${i}`;
        manifestKeys.push(logicalShard);
        backing[logicalShard.slice(1)] = JSON.stringify([
            `id-${i}`,
            { time: Date.now() + 60_000, data: 'z'.repeat(30000) },
        ]);
    }
    backing[logical.slice(1)] = JSON.stringify({
        cacheShardsVersion: 1,
        keys: manifestKeys,
    });
    const cache = {
        schemaVersion: '2.0',
        settings: { logsMaxCount: 0, defaultTimeout: 250 },
        subs,
    };
    if (complete) {
        cache.collections = [];
        cache.artifacts = {};
        cache.tokens = [];
        cache.modules = [];
        cache.archives = [];
    }
    backing['sub-store'] = JSON.stringify(cache, null, 2);
    return {
        backing,
        reads,
        writes,
        store: {
            read(key) {
                reads.push(key);
                return backing[key];
            },
            write(value, key) {
                writes.push({
                    key,
                    bytes: value == null ? 0 : String(value).length,
                });
                backing[key] = value;
                return true;
            },
        },
    };
}

function runBundle(code, { request, store, http, timers }) {
    const doneCalls = [];
    const timerCalls = [];
    const started = Date.now();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve({
                doneCalls,
                timerCalls,
                elapsed: Date.now() - started,
            });
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        const killer = setTimeout(
            () => fail(new Error('script did not call $done')),
            4000,
        );
        const context = {
            console,
            Buffer,
            URL,
            URLSearchParams,
            TextEncoder,
            TextDecoder,
            Headers,
            crypto,
            atob,
            btoa,
            Promise,
            queueMicrotask,
            setTimeout:
                timers === 'real'
                    ? setTimeout
                    : (fn, ms) => {
                          timerCalls.push(ms);
                          return 0;
                      },
            clearTimeout: timers === 'real' ? clearTimeout : () => {},
            $httpClient: http || {
                get(_opts, cb) {
                    cb(null, { status: 200, headers: {} }, '');
                },
                head(_opts, cb) {
                    cb(null, { status: 200, headers: {} }, '');
                },
            },
            $notification: { post() {} },
            $persistentStore: store,
            $environment: { 'surge-build': '2500' },
            $request: request,
            $done(value) {
                doneCalls.push(value);
                clearTimeout(killer);
                finish();
            },
        };
        context.global = context;
        context.globalThis = context;
        try {
            vm.runInNewContext(code, context);
        } catch (error) {
            clearTimeout(killer);
            fail(error);
        }
    });
}

describe('Surge subscription save', function () {
    this.timeout(120000);
    let simpleCode;
    let probeSurge;
    let probeNode;

    before(async function () {
        simpleCode = await bundle('src/products/sub-store-0.js', {
            __SURGE_ONLY__: 'true',
            $platform: '"Surge"',
        });
        probeSurge = await bundle('src/test/fixtures/batch-flush-probe.js', {
            __SURGE_ONLY__: 'true',
            $platform: '"Surge"',
        });
        probeNode = await bundle('src/test/fixtures/batch-flush-probe.js', {
            __SURGE_ONLY__: 'false',
        });
    });

    function patchRequest(body) {
        return {
            method: 'PATCH',
            url: 'http://sub.store/api/sub/demo',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        };
    }

    it('writes the main store once and does not touch script shards', async function () {
        const subs = makeSubs('before');
        const seeded = seedStore(subs, { complete: true });
        const prettyBytes = seeded.backing['sub-store'].length;
        const next = {
            ...subs[0],
            displayName: 'after-save',
        };
        const run = await runBundle(simpleCode, {
            request: patchRequest(next),
            store: seeded.store,
        });

        expect(run.doneCalls).to.have.length(1);
        const response = run.doneCalls[0].response;
        expect(response.status).to.equal(200);
        expect(JSON.parse(response.body).data.displayName).to.equal(
            'after-save',
        );
        const mainWrites = seeded.writes.filter(
            (item) => item.key === 'sub-store',
        );
        const shardWrites = seeded.writes.filter((item) =>
            String(item.key).includes('cached-script'),
        );
        const shardReads = seeded.reads.filter((key) =>
            String(key).includes('cached-script'),
        );
        expect(mainWrites).to.have.length(1);
        // 60 subs x 12KB, one compact rewrite of the main document.
        expect(mainWrites[0].bytes).to.be.above(600000);
        expect(mainWrites[0].bytes).to.be.below(prettyBytes);
        expect(JSON.parse(seeded.backing['sub-store']).subs[0].displayName).to.equal(
            'after-save',
        );
        expect(shardWrites).to.deep.equal([]);
        expect(shardReads).to.deep.equal([]);
        expect(run.timerCalls).to.deep.equal([]);
        expect(run.elapsed).to.be.below(5000);

        // Second run, same content, store already compact: no rewrite.
        seeded.writes.length = 0;
        seeded.reads.length = 0;
        const saved = JSON.parse(seeded.backing['sub-store']).subs[0];
        const again = await runBundle(simpleCode, {
            request: patchRequest(saved),
            store: seeded.store,
        });
        expect(again.doneCalls).to.have.length(1);
        expect(
            seeded.writes.filter((item) => item.key === 'sub-store'),
        ).to.deep.equal([]);
    });

    it('rewrites the whole main blob once per missing top-level key', async function () {
        const subs = makeSubs('before');
        const seeded = seedStore(subs, { complete: false });
        const run = await runBundle(simpleCode, {
            request: patchRequest({
                ...subs[0],
                displayName: 'after-save',
            }),
            store: seeded.store,
        });
        expect(run.doneCalls).to.have.length(1);
        const mainWrites = seeded.writes.filter(
            (item) => item.key === 'sub-store',
        );
        // collections, artifacts, tokens, modules, archives, then the PATCH.
        expect(mainWrites).to.have.length(6);
        for (const item of mainWrites) {
            expect(item.bytes).to.be.above(600000);
        }
    });

    it('returns a flow follow-up when the remote never answers', async function () {
        const subs = makeSubs('before');
        subs[0].source = 'remote';
        subs[0].url = 'https://example.invalid/sub';
        const seeded = seedStore(subs, { complete: true });
        const started = Date.now();
        const run = await runBundle(simpleCode, {
            request: {
                method: 'GET',
                url: 'http://sub.store/api/sub/flow/demo',
                headers: {},
                body: '',
            },
            store: seeded.store,
            timers: 'real',
            http: {
                head() {},
                get() {},
            },
        });
        expect(run.doneCalls).to.have.length(1);
        expect(Date.now() - started).to.be.below(2000);
        const shardWrites = seeded.writes.filter((item) =>
            String(item.key).includes('cached-script'),
        );
        expect(shardWrites).to.deep.equal([]);
    });

    it('flushes batched cache writes on Surge without arming a timer', function () {
        const storeStub = {
            read() {
                return undefined;
            },
            write() {
                return true;
            },
        };
        const context = {
            console,
            TextEncoder,
            $persistentStore: storeStub,
            $notification: { post() {} },
            global: null,
            globalThis: null,
        };
        context.global = context;
        context.globalThis = context;
        vm.runInNewContext(probeSurge, context);
        expect(context.__batch.timer).to.equal(null);
        expect(context.__batch.dirty).to.equal(true);
        context.__batch.flush();
        expect(context.__flushed).to.equal(1);
        expect(context.__batch.dirty).to.equal(false);

        const nodeContext = {
            console,
            TextEncoder,
            setTimeout,
            clearTimeout,
            $persistentStore: storeStub,
            $notification: { post() {} },
            global: null,
            globalThis: null,
        };
        nodeContext.global = nodeContext;
        nodeContext.globalThis = nodeContext;
        vm.runInNewContext(probeNode, nodeContext);
        expect(nodeContext.__batch.timer).to.not.equal(null);
        nodeContext.__batch.flush();
        expect(nodeContext.__flushed).to.equal(1);
    });
});
