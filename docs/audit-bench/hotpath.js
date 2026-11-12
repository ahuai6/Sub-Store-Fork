/**
 * Node/V8 hot-path timings for the Sub-Store audit.
 *
 * Run from backend/:
 *   SUB_STORE_FRONTEND_BACKEND_PATH=/ node -r @babel/register \
 *     ../docs/audit-bench/hotpath.js
 *
 * These numbers are V8 with JIT. Surge engine=jsc has no JIT inside the
 * Network Extension process; engine=webview does. Do not treat them as
 * on-device Surge timings.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { performance } = require('perf_hooks');

const backendRoot = path.resolve(__dirname, '../../backend');
process.chdir(backendRoot);
process.env.SUB_STORE_FRONTEND_BACKEND_PATH =
    process.env.SUB_STORE_FRONTEND_BACKEND_PATH || '/';
process.env.SUB_STORE_DATA_BASE_PATH = fs.mkdtempSync(
    path.join(os.tmpdir(), 'substore-audit-'),
);

const importStarted = performance.now();
const { ProxyUtils } = require(path.join(
    backendRoot,
    'src/core/proxy-utils/index.js',
));
function loadDefault(file) {
    const mod = require(file);
    return mod && mod.__esModule ? mod.default : mod.default || mod;
}
const getSurgeParser = loadDefault(
    path.join(backendRoot, 'src/core/proxy-utils/parsers/peggy/surge.js'),
);
const getLoonParser = loadDefault(
    path.join(backendRoot, 'src/core/proxy-utils/parsers/peggy/loon.js'),
);
const getQXParser = loadDefault(
    path.join(backendRoot, 'src/core/proxy-utils/parsers/peggy/qx.js'),
);
const importMs = performance.now() - importStarted;

const REGIONS = ['香港', '日本', '美国', '新加坡', '台湾', '韩国', '德国', '英国'];
const UUID = '12345678-1234-1234-1234-123456789abc';

function silence(fn) {
    const log = console.log;
    const info = console.info;
    const warn = console.warn;
    const error = console.error;
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
        return fn();
    } finally {
        console.log = log;
        console.info = info;
        console.warn = warn;
        console.error = error;
    }
}

function stats(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
        runs: samples.length,
        minMs: round(sorted[0]),
        medianMs: round(median),
        maxMs: round(sorted[sorted.length - 1]),
    };
}

function round(n) {
    return Math.round(n * 100) / 100;
}

function bench(fn, { runs = 3, warmup = 1 } = {}) {
    silence(() => {
        for (let i = 0; i < warmup; i++) fn();
    });
    const samples = [];
    let last;
    let heapDelta = 0;
    for (let i = 0; i < runs; i++) {
        const before = process.memoryUsage().heapUsed;
        const started = performance.now();
        last = silence(fn);
        samples.push(performance.now() - started);
        heapDelta = process.memoryUsage().heapUsed - before;
    }
    if (last && typeof last.then === 'function') {
        throw new Error('bench() received a promise; use benchAsync');
    }
    return {
        ...stats(samples),
        heapDeltaMB: round(heapDelta / (1024 * 1024)),
        outputChars: typeof last === 'string' ? last.length : undefined,
        outputCount: Array.isArray(last) ? last.length : undefined,
    };
}

async function benchAsync(fn, { runs = 3, warmup = 1 } = {}) {
    for (let i = 0; i < warmup; i++) {
        await silence(() => fn());
    }
    const samples = [];
    let last;
    let heapDelta = 0;
    for (let i = 0; i < runs; i++) {
        const before = process.memoryUsage().heapUsed;
        const started = performance.now();
        last = await silence(() => fn());
        samples.push(performance.now() - started);
        heapDelta = process.memoryUsage().heapUsed - before;
    }
    return {
        ...stats(samples),
        heapDeltaMB: round(heapDelta / (1024 * 1024)),
        outputChars: typeof last === 'string' ? last.length : undefined,
        outputCount: Array.isArray(last) ? last.length : undefined,
    };
}

function ssUri(i) {
    const region = REGIONS[i % REGIONS.length];
    const user = Buffer.from(`aes-128-gcm:secret-${i}`).toString('base64');
    return `ss://${user}@10.0.${(i >> 8) & 255}.${i & 255}:${10000 + (i % 1000)}#${encodeURIComponent(
        `${region}-${i}`,
    )}`;
}

function vmessUri(i) {
    const region = REGIONS[i % REGIONS.length];
    const body = Buffer.from(
        JSON.stringify({
            v: '2',
            ps: `${region}-vmess-${i}`,
            add: `v${i}.example.com`,
            port: '443',
            id: UUID,
            aid: '0',
            net: 'ws',
            type: 'none',
            host: 'edge.example.com',
            path: '/vmess',
            tls: 'tls',
        }),
    ).toString('base64');
    return `vmess://${body}`;
}

function vlessUri(i) {
    const region = REGIONS[i % REGIONS.length];
    return `vless://${UUID}@vless${i}.example.com:443?encryption=none&security=tls&sni=vless${i}.example.com&type=ws&path=%2Fvless#${encodeURIComponent(
        `${region}-vless-${i}`,
    )}`;
}

function trojanUri(i) {
    const region = REGIONS[i % REGIONS.length];
    return `trojan://password-${i}@trojan${i}.example.com:443?security=tls&sni=trojan${i}.example.com#${encodeURIComponent(
        `${region}-trojan-${i}`,
    )}`;
}

function mixedUri(i) {
    const kind = i % 4;
    if (kind === 0) return ssUri(i);
    if (kind === 1) return vmessUri(i);
    if (kind === 2) return vlessUri(i);
    return trojanUri(i);
}

function surgeSs(i) {
    const region = REGIONS[i % REGIONS.length];
    return `${region}-${i} = ss, 10.0.${(i >> 8) & 255}.${i & 255}, ${
        10000 + (i % 1000)
    }, encrypt-method=aes-128-gcm, password=secret-${i}`;
}

function clashYaml(n) {
    const lines = ['proxies:'];
    for (let i = 0; i < n; i++) {
        const region = REGIONS[i % REGIONS.length];
        lines.push(
            `  - { name: "${region}-${i}", type: ss, server: 10.0.${
                (i >> 8) & 255
            }.${i & 255}, port: ${10000 + (i % 1000)}, cipher: aes-128-gcm, password: "secret-${i}" }`,
        );
    }
    return lines.join('\n');
}

function bytes(n) {
    return {
        bytes: n,
        kib: round(n / 1024),
        mib: round(n / (1024 * 1024)),
    };
}

function fileStat(file) {
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    const gz = zlib.gzipSync(buf);
    return {
        file: path.relative(path.join(backendRoot, '..'), file),
        raw: bytes(buf.length),
        gzip: bytes(gz.length),
    };
}

function compileStat(file) {
    if (!fs.existsSync(file)) return null;
    const source = fs.readFileSync(file, 'utf8');
    const samples = [];
    for (let i = 0; i < 3; i++) {
        const started = performance.now();
        new vm.Script(source, { filename: file });
        samples.push(performance.now() - started);
    }
    return { file: path.basename(file), compile: stats(samples) };
}

const operators = [
    {
        type: 'Regex Filter',
        args: { regex: ['香港|日本|美国|新加坡|台湾|韩国|德国|英国'], keep: true },
    },
    {
        type: 'Type Filter',
        args: { value: ['ss', 'vmess', 'vless', 'trojan'], keep: true },
    },
    {
        type: 'Regex Rename Operator',
        args: [{ expr: '(\\d+)$', now: '#$1' }],
    },
    { type: 'Flag Operator', args: { mode: 'add' } },
    { type: 'Sort Operator', args: 'asc' },
    {
        type: 'Script Operator',
        args: {
            mode: 'script',
            content: `function operator(proxies) {
                return proxies.map((proxy) => {
                    proxy['udp'] = true;
                    return proxy;
                });
            }`,
        },
    },
];

const shortcut = [
    {
        type: 'Script Operator',
        args: {
            mode: 'script',
            content: `$server.name = $server.name + '-x';`,
        },
    },
];

function timePeggy(name, load) {
    const started = performance.now();
    const parser = silence(() => load());
    return {
        name,
        firstGenerateMs: round(performance.now() - started),
        parserType: typeof parser,
        hasParse: typeof parser?.parse,
    };
}

async function main() {
    const peggy = {
        surge: timePeggy('surge', getSurgeParser),
        loon: timePeggy('loon', getLoonParser),
        qx: timePeggy('qx', getQXParser),
    };
    for (const [name, load] of [
        ['surge', getSurgeParser],
        ['loon', getLoonParser],
        ['qx', getQXParser],
    ]) {
        peggy[name].cachedGetter = bench(() => load());
    }

    const sizes = [1000, 5000];
    const workloads = {};
    for (const n of sizes) {
        const uri = Array.from({ length: n }, (_, i) => mixedUri(i)).join('\n');
        const ss = Array.from({ length: n }, (_, i) => ssUri(i)).join('\n');
        const surge = Array.from({ length: n }, (_, i) => surgeSs(i)).join('\n');
        const yaml = clashYaml(n);
        const b64 = Buffer.from(uri).toString('base64');
        workloads[n] = {
            inputBytes: {
                mixedUri: uri.length,
                ssUri: ss.length,
                surgeSs: surge.length,
                clashYaml: yaml.length,
                base64OfMixedUri: b64.length,
            },
            parseMixedUri: bench(() => ProxyUtils.parse(uri)),
            parseSsUri: bench(() => ProxyUtils.parse(ss)),
            parseSurgeSs: bench(() => ProxyUtils.parse(surge)),
            parseClashYaml: bench(() => ProxyUtils.parse(yaml)),
            parseBase64: bench(() => ProxyUtils.parse(b64)),
        };
        const parsed = silence(() => ProxyUtils.parse(ss));
        workloads[n].operatorChain = await benchAsync(() =>
            ProxyUtils.process(parsed, operators, 'Surge'),
        );
        workloads[n].shortcutScript = await benchAsync(() =>
            ProxyUtils.process(parsed, shortcut, 'Surge'),
        );
        const processed = await silence(() =>
            ProxyUtils.process(parsed, operators, 'Surge'),
        );
        workloads[n].produceSurge = bench(() =>
            ProxyUtils.produce(processed, 'Surge', 'external'),
        );
        workloads[n].produceClashMeta = bench(() =>
            ProxyUtils.produce(processed, 'ClashMeta', 'external'),
        );
        workloads[n].jsonClone = bench(() =>
            JSON.parse(JSON.stringify(processed)),
        );
    }

    const storePayload = JSON.stringify(
        silence(() => ProxyUtils.parse(Array.from({ length: 1000 }, (_, i) => ssUri(i)).join('\n'))),
    );
    const parsed1000 = JSON.parse(storePayload);
    const pretty1000 = JSON.stringify(parsed1000, null, 2);
    const fatValue = 'x'.repeat(Math.floor(3.5 * 1024 * 1024));
    const fatJson = JSON.stringify({ blob: fatValue });

    const store = {
        stringify1000Proxies: bench(() => JSON.stringify(parsed1000)),
        parse1000Proxies: bench(() => JSON.parse(storePayload)),
        prettyStringify1000: bench(() => JSON.stringify(parsed1000, null, 2)),
        stringify3_5MiB: bench(() => JSON.stringify({ blob: fatValue })),
        parse3_5MiB: bench(() => JSON.parse(fatJson)),
        payload: {
            proxies1000: bytes(Buffer.byteLength(storePayload)),
            pretty1000: bytes(Buffer.byteLength(pretty1000)),
            fat: bytes(Buffer.byteLength(fatJson)),
        },
    };

    const bundles = [
        'dist/sub-store-0.min.js',
        'dist/sub-store-1.min.js',
        'dist/cron-sync-artifacts.min.js',
        'dist/sub-store-parser.loon.min.js',
        'dist/proxy-utils.esm.mjs',
        'dist/sub-store.bundle.js',
        'sub-store.min.js',
    ].map((rel) => fileStat(path.join(backendRoot, rel)));

    const compile = [
        'dist/sub-store-0.min.js',
        'dist/sub-store-1.min.js',
        'dist/cron-sync-artifacts.min.js',
    ].map((rel) => compileStat(path.join(backendRoot, rel)));

    const result = {
        node: process.version,
        platform: `${process.platform} ${os.arch()} ${os.cpus()[0].model}`,
        importProxyUtilsMs: round(importMs),
        note: 'console silenced during timed sections; V8 JIT; not an on-device Surge measurement',
        workloads,
        peggy,
        store,
        bundles,
        compile,
    };
    const out = path.join(__dirname, 'results.json');
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
