import fs from 'fs';
import { builtinModules } from 'module';
import os from 'os';
import path from 'path';
import vm from 'vm';

import { expect } from 'chai';
import { build } from 'esbuild';
import { after, before, describe, it } from 'mocha';

import { OpenAPI } from '@/vendor/open-api';
import { stripNonSurgeRegions } from '../../../surge-only-strip';

describe('persistent store writes', function () {
    let dir;
    let previousBase;
    let api;
    let writes;

    before(function () {
        previousBase = process.env.SUB_STORE_DATA_BASE_PATH;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'substore-persist-'));
        fs.writeFileSync(
            path.join(dir, 'persist-spec.json'),
            '{"subs":[{"name":"old"}]}',
        );
        fs.writeFileSync(path.join(dir, 'root.json'), '{"cached":"1"}');
        process.env.SUB_STORE_DATA_BASE_PATH = dir;
        api = new OpenAPI('persist-spec');
        const original = api.node.fs.writeFileSync.bind(api.node.fs);
        writes = [];
        api.node.fs.writeFileSync = (file, data, ...rest) => {
            writes.push({
                file: path.basename(String(file)),
                data: String(data),
            });
            return original(file, data, ...rest);
        };
    });

    after(function () {
        if (previousBase == null) delete process.env.SUB_STORE_DATA_BASE_PATH;
        else process.env.SUB_STORE_DATA_BASE_PATH = previousBase;
    });

    it('reads the existing single-document files', function () {
        expect(api.read('subs')).to.deep.equal([{ name: 'old' }]);
        expect(api.read('#cached')).to.equal('1');
    });

    it('rewrites only the main document when a top-level key changes', function () {
        writes.length = 0;
        const next = [{ name: 'old' }, { name: 'new' }];
        api.write(next, 'subs');
        expect(writes.map((item) => item.file)).to.deep.equal([
            'persist-spec.json',
        ]);
        expect(JSON.parse(writes[0].data).subs).to.deep.equal(next);
        expect(writes[0].data).to.include('\n  ');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'root.json'), 'utf8'))).to.deep.equal({
            cached: '1',
        });
    });

    it('skips a write when the pretty JSON is unchanged', function () {
        writes.length = 0;
        api.write(api.read('subs'), 'subs');
        expect(writes).to.deep.equal([]);
    });

    it('still persists an in-place edit of the same array', function () {
        const subs = api.read('subs');
        subs.push({ name: 'edited' });
        writes.length = 0;
        api.write(subs, 'subs');
        expect(writes).to.have.length(1);
        expect(JSON.parse(writes[0].data).subs.map((item) => item.name)).to.deep.equal([
            'old',
            'new',
            'edited',
        ]);
    });

    it('rewrites only root.json for a hash key and keeps that value', function () {
        writes.length = 0;
        api.write('{"body":1}', '#cached');
        expect(writes.map((item) => item.file)).to.deep.equal(['root.json']);
        expect(api.read('#cached')).to.equal('{"body":1}');
        writes.length = 0;
        api.write('{"body":1}', '#cached');
        expect(writes).to.deep.equal([]);
        api.delete('#cached');
        expect(api.read('#cached')).to.equal(undefined);
        expect(api.read('subs').map((item) => item.name)).to.include('edited');
    });

    it('removes a hash key from root.json when write(null, key) is called', function () {
        api.write('{"shard":1}', '#shard-key');
        expect(api.read('#shard-key')).to.equal('{"shard":1}');
        api.write(null, '#shard-key');
        expect(api.read('#shard-key')).to.equal(undefined);
        const savedRoot = JSON.parse(
            fs.readFileSync(path.join(dir, 'root.json'), 'utf8'),
        );
        expect(savedRoot).to.not.have.property('shard-key');
    });

    it('writes compact JSON in Surge and skips stringify baseline on read-only boots', async function () {
        this.timeout(15000);
        const backendRoot = path.resolve(__dirname, '../../..');
        const bundled = await build({
            absWorkingDir: backendRoot,
            entryPoints: ['src/vendor/open-api.js'],
            bundle: true,
            write: false,
            format: 'cjs',
            platform: 'browser',
            define: {
                __SURGE_ONLY__: 'true',
                $platform: '"Surge"',
            },
            plugins: [
                {
                    name: 'node-builtin-external',
                    setup(b) {
                        const builtins = new Set(
                            builtinModules.map((n) => n.replace(/^node:/, '')),
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
                            if (!args.path.split(path.sep).includes('src'))
                                return;
                            const contents = await fs.promises.readFile(
                                args.path,
                                'utf8',
                            );
                            if (!contents.includes('@non-surge-')) return;
                            return {
                                contents: stripNonSurgeRegions(
                                    contents,
                                    args.path,
                                ),
                                loader: 'js',
                            };
                        });
                    },
                },
            ],
        });
        const code = bundled.outputFiles[0].text;
        const backing = {
            'sub-store': JSON.stringify({ subs: [{ name: 's1' }] }),
        };
        const storeWrites = [];
        let stringifyCalls = 0;

        function runSurge(fn) {
            const mod = { exports: {} };
            const context = {
                module: mod,
                exports: mod.exports,
                console,
                JSON: {
                    parse: JSON.parse,
                    stringify: (...args) => {
                        stringifyCalls += 1;
                        return JSON.stringify(...args);
                    },
                },
                TextEncoder,
                TextDecoder,
                URL,
                Headers,
                $httpClient: {},
                $notification: {},
                $persistentStore: {
                    read: (k) => backing[k],
                    write: (v, k) => {
                        storeWrites.push({ key: k, value: v });
                        backing[k] = v;
                        return true;
                    },
                },
                $done: () => {},
            };
            vm.runInNewContext(code, context);
            const SurgeOpenAPI = mod.exports.OpenAPI;
            return fn(new SurgeOpenAPI('sub-store'));
        }

        // Read-only boot must not stringify or write.
        runSurge((instance) => {
            expect(instance.read('subs')).to.deep.equal([{ name: 's1' }]);
        });
        expect(stringifyCalls).to.equal(0);
        expect(storeWrites).to.deep.equal([]);

        // Pretty-printed on-disk JSON still skips an unchanged rewrite.
        backing['sub-store'] = JSON.stringify(
            { subs: [{ name: 's1' }] },
            null,
            2,
        );
        storeWrites.length = 0;
        stringifyCalls = 0;
        runSurge((instance) => {
            instance.write([{ name: 's1' }], 'subs');
        });
        expect(storeWrites).to.deep.equal([]);

        // Unchanged write on compact store skips $persistentStore.write.
        backing['sub-store'] = JSON.stringify({ subs: [{ name: 's1' }] });
        storeWrites.length = 0;
        runSurge((instance) => {
            instance.write([{ name: 's1' }], 'subs');
        });
        expect(storeWrites).to.deep.equal([]);

        // Modified write persists compact JSON (no pretty 2-space indent).
        runSurge((instance) => {
            instance.write([{ name: 's1' }, { name: 's2' }], 'subs');
        });
        expect(storeWrites).to.have.length(1);
        expect(storeWrites[0].value).to.not.include('\n  ');
        expect(JSON.parse(backing['sub-store']).subs).to.have.length(2);
    });
});
