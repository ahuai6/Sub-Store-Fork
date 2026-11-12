/**
 * esbuild metafile byte breakdown for the Surge-facing bundles.
 * Run from backend/: node ../docs/audit-bench/bundle-meta.js
 */
const path = require('path');
const { build } = require(path.join(__dirname, '../../backend/node_modules/esbuild'));

const entries = [
    'src/products/sub-store-0.js',
    'src/products/sub-store-1.js',
    'src/products/cron-sync-artifacts.js',
];

function topInputs(metafile, limit = 25) {
    const inputs = Object.entries(metafile.inputs)
        .map(([file, info]) => ({
            file: file.replace(/.*node_modules\//, 'node_modules/'),
            bytes: info.bytes,
        }))
        .sort((a, b) => b.bytes - a.bytes);
    const total = inputs.reduce((sum, item) => sum + item.bytes, 0);
    const groups = {};
    for (const item of inputs) {
        const match = item.file.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);
        const key = match ? match[1] : item.file.startsWith('node_modules/') ? item.file : 'src';
        groups[key] = (groups[key] || 0) + item.bytes;
    }
    const grouped = Object.entries(groups)
        .map(([name, bytes]) => ({ name, bytes }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, limit);
    return { totalInputBytes: total, grouped, largestFiles: inputs.slice(0, 15) };
}

!(async () => {
    const result = {};
    for (const entry of entries) {
        const built = await build({
            absWorkingDir: path.join(__dirname, '../../backend'),
            entryPoints: [entry],
            bundle: true,
            minify: true,
            write: false,
            platform: 'browser',
            format: 'iife',
            metafile: true,
            plugins: [
                {
                    name: 'node-builtin-external',
                    setup(b) {
                        const builtins = new Set(require('module').builtinModules);
                        b.onResolve({ filter: /.*/ }, (args) => {
                            const name = args.path.replace(/^node:/, '');
                            if (args.path !== 'buffer' && builtins.has(name)) {
                                return { path: args.path, external: true };
                            }
                        });
                    },
                },
            ],
        });
        const output = Object.values(built.metafile.outputs)[0];
        result[entry] = {
            outputBytes: output.bytes,
            ...topInputs(built.metafile),
        };
    }
    console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
