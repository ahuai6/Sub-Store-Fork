import path from 'path';
import { builtinModules } from 'module';

import { expect } from 'chai';
import { build } from 'esbuild';
import { describe, it } from 'mocha';

const backendRoot = path.resolve(__dirname, '../../..');
const builtinModuleNames = new Set(
    builtinModules.map((name) => name.replace(/^node:/, '')),
);

const nodeBuiltinExternalPlugin = {
    name: 'node-builtin-external',
    setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
            const normalized = args.path.replace(/^node:/, '');
            if (args.path !== 'buffer' && builtinModuleNames.has(normalized)) {
                return { path: args.path, external: true };
            }
        });
    },
};

async function inputsFor(entry) {
    const result = await build({
        absWorkingDir: backendRoot,
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        metafile: true,
        logLevel: 'silent',
        plugins: [nodeBuiltinExternalPlugin],
    });
    return Object.keys(result.metafile.inputs).map((item) =>
        item.split(path.sep).join('/'),
    );
}

function includes(inputs, fragment) {
    return inputs.some((item) => item.includes(fragment));
}

describe('sub-store bundle graph', function () {
    this.timeout(60000);

    it('keeps ProxyUtils out of sub-store-0 and in sub-store-1', async function () {
        const simple = await inputsFor('src/products/sub-store-0.js');
        const core = await inputsFor('src/products/sub-store-1.js');

        expect(includes(simple, 'core/proxy-utils/index.js')).to.equal(false);
        expect(includes(simple, 'restful/sync.js')).to.equal(false);
        expect(includes(simple, 'restful/file.js')).to.equal(false);
        expect(includes(simple, 'parsers/peggy/surge.js')).to.equal(false);
        expect(includes(simple, 'node_modules/peggy/')).to.equal(false);

        expect(includes(core, 'core/proxy-utils/index.js')).to.equal(true);
        expect(includes(core, 'restful/file.js')).to.equal(true);
        expect(includes(core, 'restful/sync.js')).to.equal(true);
        expect(includes(core, 'parsers/peggy/generated/surge.js')).to.equal(
            true,
        );
        expect(includes(core, 'node_modules/peggy/')).to.equal(false);
        expect(includes(core, 'jsrsasign')).to.equal(false);
    });
});
