#!/usr/bin/env node
const fs = require('fs');
const { parseSync, traverse } = require('@babel/core');
const { builtinModules } = require('module');
const path = require('path');
const { build } = require('esbuild');
const { stripNonSurgeRegions } = require('./surge-only-strip');

const objectHasOwnPolyfill = require.resolve('core-js/actual/object/has-own');

function precompilePeggy() {
    // The runtime-manifest fixture symlinks src and copies this file, but not
    // scripts/. Parsers in that src tree are already generated.
    try {
        require('./scripts/precompile-peggy').precompilePeggy();
    } catch (error) {
        if (!error || error.code !== 'MODULE_NOT_FOUND') throw error;
    }
}
const builtinModuleNames = new Set(
    builtinModules.map((name) => name.replace(/^node:/, '')),
);

function normalizeSpecifier(specifier) {
    return specifier.replace(/^node:/, '');
}

function getRequireSpecifiers(content) {
    const specifiers = new Set();

    traverse(
        parseSync(content, {
            babelrc: false,
            configFile: false,
            sourceType: 'script',
        }),
        {
            CallExpression({ node }) {
                if (
                    node.callee.type === 'Identifier' &&
                    (node.callee.name === 'require' ||
                        node.callee.name === '__require') &&
                    node.arguments.length === 1 &&
                    node.arguments[0].type === 'StringLiteral'
                ) {
                    specifiers.add(node.arguments[0].value);
                }
            },
        },
    );

    return specifiers;
}

function getExternalSpecifiers(metafiles) {
    return new Set(
        metafiles.flatMap((metafile) =>
            Object.values(metafile.outputs).flatMap((output) =>
                (output.imports || [])
                    .filter((item) => item.external)
                    .map((item) => item.path),
            ),
        ),
    );
}

function createRuntimeManifest({ metafiles, content }) {
    const specifiers = new Set([
        ...getExternalSpecifiers(metafiles),
        ...getRequireSpecifiers(content),
    ]);
    const builtins = new Set();
    const npm = new Set();

    for (const specifier of specifiers) {
        const normalized = normalizeSpecifier(specifier);
        if (builtinModuleNames.has(normalized)) {
            builtins.add(normalized);
        } else if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
            npm.add(specifier);
        }
    }

    return {
        builtins: [...builtins].sort(),
        npm: [...npm].sort(),
        requiresEval: /\beval\s*\(/.test(content),
        requiresProcessGlobal: /\bprocess\b/.test(content),
        workerThreads: builtins.has('worker_threads'),
        childProcess: builtins.has('child_process'),
        externalBinary: [],
        testedNode: fs
            .readFileSync(path.join(__dirname, '..', '.node-version'), 'utf8')
            .trim(),
    };
}

const nodeBuiltinExternalPlugin = {
    name: 'node-builtin-external',
    setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
            if (
                args.path !== 'buffer' &&
                builtinModuleNames.has(normalizeSpecifier(args.path))
            ) {
                return { path: args.path, external: true };
            }
        });
    },
};

// Sub-store-0 and sub-store-1 run only inside Surge. Other artifacts keep
// runtime host detection. `__SURGE_ONLY__` is a boolean either way so the
// ternaries in src/runtime/build-flags.js fold instead of staying live.
const surgeOnlyDefine = {
    __SURGE_ONLY__: 'true',
    $platform: '"Surge"',
};
const dynamicHostDefine = {
    __SURGE_ONLY__: 'false',
};

const surgeOnlyStripPlugin = {
    name: 'surge-only-strip',
    setup(build) {
        build.onLoad({ filter: /\.js$/ }, async (args) => {
            if (!args.path.split(path.sep).includes('src')) return;
            const contents = await fs.promises.readFile(args.path, 'utf8');
            if (!contents.includes('@non-surge-')) return;
            return {
                contents: stripNonSurgeRegions(contents, args.path),
                loader: 'js',
            };
        });
    },
};

const SURGE_BUNDLE_ABSENT = [
    'undici',
    'shoutrrr',
    'dotenv',
    'geoip2',
    'fetch-socks',
    'require("express")',
    "require('express')",
    'require("body-parser")',
    '$task.fetch',
    '$prefs',
    'stash-version',
    'KJUR',
];
// sub-store-0 no longer pulls ProxyUtils. Producers stay in sub-store-1.
const SURGE_SIMPLE_PRESENT = [
    'policy-descriptor',
    'lodash',
    '$httpClient',
    '$persistentStore',
];
const SURGE_CORE_PRESENT = [
    ...SURGE_SIMPLE_PRESENT,
    'sing-box',
    'vmess',
];

function assertBundleText(file, { absent = [], present = [] }) {
    const text = fs.readFileSync(file, 'utf8');
    for (const token of absent) {
        if (text.includes(token)) {
            throw new Error(`${file} still contains ${JSON.stringify(token)}`);
        }
    }
    for (const token of present) {
        if (!text.includes(token)) {
            throw new Error(`${file} is missing ${JSON.stringify(token)}`);
        }
    }
}

function assertSurgeOnlyBundles() {
    assertBundleText(path.join(__dirname, 'dist/sub-store-0.min.js'), {
        absent: [...SURGE_BUNDLE_ABSENT, 'ProxyUtils'],
        present: SURGE_SIMPLE_PRESENT,
    });
    assertBundleText(path.join(__dirname, 'dist/sub-store-1.min.js'), {
        absent: SURGE_BUNDLE_ABSENT,
        present: SURGE_CORE_PRESENT,
    });
    assertBundleText(path.join(__dirname, 'sub-store.min.js'), {
        present: ['undici', 'dotenv', "eval('import(\"shoutrrr-ts\")')"],
    });
    assertBundleText(path.join(__dirname, 'dist/sub-store.bundle.js'), {
        present: ['undici', 'service is not supported by shoutrrr-ts'],
    });
}

!(async () => {
    precompilePeggy();
    let version;
    try {
        version = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'),
        ).version.trim();
    } catch (error) {
        throw new Error('cannot read backend package version', {
            cause: error,
        });
    }

    const artifacts = [
        { src: 'src/main.js', dest: 'sub-store.min.js' },
        {
            src: 'src/products/resource-parser.loon.js',
            dest: 'dist/sub-store-parser.loon.min.js',
        },
        {
            src: 'src/products/cron-sync-artifacts.js',
            dest: 'dist/cron-sync-artifacts.min.js',
        },
        {
            src: 'src/products/sub-store-0.js',
            dest: 'dist/sub-store-0.min.js',
            surgeOnly: true,
        },
        {
            src: 'src/products/sub-store-1.js',
            dest: 'dist/sub-store-1.min.js',
            surgeOnly: true,
        },
    ];
    const browserMetafiles = [];

    for await (const artifact of artifacts) {
        const browserBuild = await build({
            entryPoints: [artifact.src],
            bundle: true,
            minify: true,
            sourcemap: false,
            platform: 'browser',
            format: 'iife',
            outfile: artifact.dest,
            inject: [objectHasOwnPolyfill],
            define: artifact.surgeOnly ? surgeOnlyDefine : dynamicHostDefine,
            plugins: artifact.surgeOnly
                ? [nodeBuiltinExternalPlugin, surgeOnlyStripPlugin]
                : [nodeBuiltinExternalPlugin],
            metafile: true,
        });
        browserMetafiles.push(browserBuild.metafile);
    }

    const browserEsmArtifacts = [
        {
            src: 'src/products/proxy-utils.esm.js',
            dest: 'dist/proxy-utils.esm.mjs',
        },
    ];

    for await (const artifact of browserEsmArtifacts) {
        const browserBuild = await build({
            entryPoints: [artifact.src],
            bundle: true,
            minify: true,
            sourcemap: false,
            platform: 'browser',
            format: 'esm',
            outfile: artifact.dest,
            inject: [objectHasOwnPolyfill],
            define: dynamicHostDefine,
            plugins: [nodeBuiltinExternalPlugin],
            metafile: true,
        });
        browserMetafiles.push(browserBuild.metafile);
    }

    let content = fs.readFileSync(path.join(__dirname, 'sub-store.min.js'), {
        encoding: 'utf8',
    });
    content = content.replace(
        /eval\(('|")(require\(('|").*?('|")\))('|")\)/g,
        '$2',
    );
    // Browser builds retain an inert import; the Node pass resolves and bundles
    // the ESM package into its standalone CommonJS artifact.
    const shoutrrrImport = `eval('import("shoutrrr-ts")')`;
    if (!content.includes(shoutrrrImport)) {
        throw new Error('missing Shoutrrr import boundary in browser artifact');
    }
    content = content.replace(shoutrrrImport, 'import("shoutrrr-ts")');
    fs.writeFileSync(
        path.join(__dirname, 'dist/sub-store.no-bundle.js'),
        content,
        {
            encoding: 'utf8',
        },
    );

    const nodeBuild = await build({
        entryPoints: ['dist/sub-store.no-bundle.js'],
        bundle: true,
        minify: true,
        sourcemap: false,
        platform: 'node',
        format: 'cjs',
        outfile: 'dist/sub-store.bundle.js',
        // The input is already the non-Surge browser artifact. Do not pin it
        // to Surge and do not strip host adapters a second time.
        define: dynamicHostDefine,
        metafile: true,
        // `sub-store.no-bundle.js` comes from `sub-store.min.js`, which already
        // has the Object.hasOwn polyfill injected in the first build stage.
    });
    fs.writeFileSync(
        path.join(__dirname, 'dist/sub-store.bundle.js'),
        `// SUB_STORE_BACKEND_VERSION: ${version}
${fs.readFileSync(path.join(__dirname, 'dist/sub-store.bundle.js'), {
    encoding: 'utf8',
})}`,
        {
            encoding: 'utf8',
        },
    );
    const bundlePath = path.join(__dirname, 'dist/sub-store.bundle.js');
    fs.writeFileSync(
        path.join(__dirname, 'dist/runtime-manifest.json'),
        `${JSON.stringify(
            createRuntimeManifest({
                metafiles: [...browserMetafiles, nodeBuild.metafile],
                content: fs.readFileSync(bundlePath, 'utf8'),
            }),
            null,
            2,
        )}\n`,
    );
    assertSurgeOnlyBundles();
})()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => {
        console.log('done');
    });
