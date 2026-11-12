/**
 * Repeatable hot-path timings from the 2026-11-12 audit.
 *
 *   pnpm bench
 *   pnpm bench -- --write-baseline
 *
 * Prints a comparison against backend/bench/baseline.json. Numbers are V8
 * with JIT on this machine. Surge engine=jsc has no JIT. engine=webview does,
 * but each request still starts from a cold context, which is why Peggy
 * generate is measured by reloading the parser module.
 *
 * Cold bundle eval needs `pnpm bundle:esbuild` first. It is skipped, and the
 * table says so, when the minified files are absent.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const backendRoot = path.resolve(__dirname, '..');
const baselinePath = path.join(backendRoot, 'bench', 'baseline.json');
const writeBaseline = process.argv.includes('--write-baseline');

process.chdir(backendRoot);
process.env.SUB_STORE_FRONTEND_BACKEND_PATH =
    process.env.SUB_STORE_FRONTEND_BACKEND_PATH || '/';
process.env.SUB_STORE_DATA_BASE_PATH =
    process.env.SUB_STORE_DATA_BASE_PATH ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'substore-bench-'));

const { getFlag } = require(path.join(backendRoot, 'src/utils/geo.js'));
const { ProxyUtils } = require(path.join(
    backendRoot,
    'src/core/proxy-utils/index.js',
));

const REGIONS = ['香港', '日本', '美国', '新加坡', '台湾', '韩国', '德国', '英国'];
const NODE_COUNT = 5000;
const METRICS = [
    'getFlag5000',
    'peggySurgePerRequest',
    'peggyLoonPerRequest',
    'peggyQxPerRequest',
    'produceClash5000',
    'produceSurge5000',
    'produceSingBox5000',
    'coldCompileSubStore0',
    'coldCompileSubStore1',
    'coldEvalSubStore0',
    'coldEvalSubStore1',
];

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

function round(n) {
    return Math.round(n * 100) / 100;
}

function median(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function bench(fn, { runs = 3, warmup = 1 } = {}) {
    silence(() => {
        for (let i = 0; i < warmup; i++) fn();
    });
    const samples = [];
    for (let i = 0; i < runs; i++) {
        const started = performance.now();
        silence(fn);
        samples.push(performance.now() - started);
    }
    return {
        medianMs: round(median(samples)),
        minMs: round(Math.min(...samples)),
        maxMs: round(Math.max(...samples)),
        runs,
    };
}

function ssUri(i) {
    const region = REGIONS[i % REGIONS.length];
    const user = Buffer.from(`aes-128-gcm:secret-${i}`).toString('base64');
    return `ss://${user}@10.0.${(i >> 8) & 255}.${i & 255}:${
        10000 + (i % 1000)
    }#${encodeURIComponent(`${region}-${i}`)}`;
}

function dropModule(fragment) {
    for (const key of Object.keys(require.cache)) {
        if (key.split(path.sep).join('/').includes(fragment)) {
            delete require.cache[key];
        }
    }
}

function loadParser(fragment) {
    dropModule(fragment);
    const file = path.join(
        backendRoot,
        'src/core/proxy-utils/parsers/peggy',
        fragment,
    );
    const loaded = require(file);
    const getParser = loaded && loaded.__esModule ? loaded.default : loaded;
    return typeof getParser === 'function' ? getParser : getParser.default;
}

function peggyPerRequest(fragment, sample) {
    // One untimed load pays for Babel. Each measured run then reloads the
    // module, which is what a Surge request pays for peggy.generate().
    silence(() => loadParser(fragment)());
    return bench(
        () => {
            const getParser = loadParser(fragment);
            const parser = getParser();
            parser.parse(sample);
        },
        { warmup: 0, runs: 3 },
    );
}

function store() {
    const memory = Object.create(null);
    return {
        read(key) {
            return Object.prototype.hasOwnProperty.call(memory, key)
                ? memory[key]
                : null;
        },
        write(value, key) {
            if (value == null) delete memory[key];
            else memory[key] = String(value);
            return true;
        },
    };
}

function coldCompile(rel) {
    const file = path.join(backendRoot, rel);
    if (!fs.existsSync(file)) return null;
    const source = fs.readFileSync(file, 'utf8');
    // vm.Script() defers compilation. createCachedData() forces it, which is
    // the compile cost a cold Surge context pays before the script runs.
    return bench(
        () => {
            const script = new vm.Script(source, { filename: file });
            script.createCachedData();
        },
        { warmup: 0, runs: 3 },
    );
}

function coldEval(rel, request) {
    const file = path.join(backendRoot, rel);
    if (!fs.existsSync(file)) return null;
    const source = fs.readFileSync(file, 'utf8');
    const samples = [];
    let lastStatus;
    let lastError;
    for (let i = 0; i < 3; i++) {
        const persistent = store();
        let doneValue;
        const sandbox = {
            console: {
                log() {},
                info() {},
                warn() {},
                error() {},
                debug() {},
            },
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            queueMicrotask,
            Promise,
            URL,
            URLSearchParams,
            TextEncoder,
            TextDecoder,
            Buffer,
            atob,
            btoa,
            performance,
            crypto,
            structuredClone,
            $environment: {
                'surge-build': '2800',
                'surge-version': '5.23.0',
                system: 'iOS',
            },
            $httpClient: {
                get(_opts, cb) {
                    if (typeof cb === 'function') cb(null, { status: 200 }, '');
                },
                post(_opts, cb) {
                    if (typeof cb === 'function') cb(null, { status: 200 }, '');
                },
            },
            $notification: { post() {} },
            $persistentStore: persistent,
            $request: request,
            $done(value) {
                doneValue = value;
            },
        };
        vm.createContext(sandbox);
        const script = new vm.Script(source, { filename: file });
        const started = performance.now();
        try {
            script.runInContext(sandbox, { timeout: 20000 });
            samples.push(performance.now() - started);
            const response = doneValue && doneValue.response;
            lastStatus = response ? response.status : undefined;
            lastError = undefined;
        } catch (error) {
            lastError = error && error.message ? error.message : String(error);
            samples.push(performance.now() - started);
        }
    }
    return {
        medianMs: round(median(samples)),
        minMs: round(Math.min(...samples)),
        maxMs: round(Math.max(...samples)),
        runs: samples.length,
        status: lastStatus,
        error: lastError,
    };
}

function loadBaseline() {
    if (!fs.existsSync(baselinePath)) return null;
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
}

function delta(current, previous) {
    if (
        current == null ||
        previous == null ||
        !Number.isFinite(current) ||
        !Number.isFinite(previous) ||
        previous === 0
    ) {
        return 'n/a';
    }
    const pct = ((current - previous) / previous) * 100;
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
}

function cell(value) {
    if (value == null || value === '') return 'skipped';
    if (typeof value === 'number') return value.toFixed(2);
    return String(value);
}

function printTable(current, baseline) {
    const previous = baseline && baseline.metrics ? baseline.metrics : {};
    const rows = [
        ['metric', 'baseline ms', 'current ms', 'delta'],
        ...METRICS.map((name) => {
            const now = current.metrics[name];
            const then = previous[name];
            return [
                name,
                cell(then && then.medianMs),
                cell(now && now.medianMs),
                now && now.error
                    ? `error: ${now.error}`
                    : delta(
                          now && now.medianMs,
                          then && then.medianMs,
                      ),
            ];
        }),
    ];
    const widths = rows[0].map((_, index) =>
        Math.max(...rows.map((row) => row[index].length)),
    );
    const writeLine = (line = '') => {
        process.stdout.write(`${line}\n`);
    };
    writeLine('');
    writeLine(`node ${current.node}  ${current.platform}`);
    writeLine(
        baseline
            ? `baseline ${baseline.node || '?'}  recorded ${baseline.recordedAt || '?'}`
            : 'no baseline file; pass --write-baseline to store this run',
    );
    writeLine('');
    for (const row of rows) {
        writeLine(
            row.map((value, index) => value.padEnd(widths[index])).join('  '),
        );
    }
    writeLine('');
    writeLine(
        'Peggy columns are a cold module load plus one parse, which is the per-request cost on Surge. getFlag and produce are warm V8. Cold eval is a fresh vm context of the minified bundle.',
    );
}

function main() {
    const names = Array.from(
        { length: NODE_COUNT },
        (_, i) => `${REGIONS[i % REGIONS.length]}-${i}`,
    );
    const subscription = Array.from({ length: NODE_COUNT }, (_, i) =>
        ssUri(i),
    ).join('\n');
    const parsed = silence(() => ProxyUtils.parse(subscription));
    if (!Array.isArray(parsed) || parsed.length !== NODE_COUNT) {
        throw new Error(
            `expected ${NODE_COUNT} parsed nodes, got ${
                Array.isArray(parsed) ? parsed.length : typeof parsed
            }`,
        );
    }

    const metrics = {
        getFlag5000: bench(() => {
            for (let i = 0; i < names.length; i++) getFlag(names[i]);
        }),
        peggySurgePerRequest: peggyPerRequest(
            'surge.js',
            'Bench = ss, example.com, 8388, encrypt-method=aes-128-gcm, password=secret',
        ),
        peggyLoonPerRequest: peggyPerRequest(
            'loon.js',
            'Bench=shadowsocks,example.com,8388,aes-128-gcm,"secret"',
        ),
        peggyQxPerRequest: peggyPerRequest(
            'qx.js',
            'shadowsocks=example.com:8388, method=aes-128-gcm, password=secret, tag=Bench',
        ),
        produceClash5000: bench(() =>
            ProxyUtils.produce(parsed.map((proxy) => ({ ...proxy })), 'Clash', 'external'),
        ),
        produceSurge5000: bench(() =>
            ProxyUtils.produce(parsed.map((proxy) => ({ ...proxy })), 'Surge', 'external'),
        ),
        produceSingBox5000: bench(() =>
            ProxyUtils.produce(
                parsed.map((proxy) => ({ ...proxy })),
                'sing-box',
                'external',
            ),
        ),
        coldCompileSubStore0: coldCompile('dist/sub-store-0.min.js'),
        coldCompileSubStore1: coldCompile('dist/sub-store-1.min.js'),
        coldEvalSubStore0: coldEval('dist/sub-store-0.min.js', {
            method: 'GET',
            url: 'https://sub.store/api/utils/env',
            headers: { 'User-Agent': 'Surge iOS' },
        }),
        coldEvalSubStore1: coldEval('dist/sub-store-1.min.js', {
            method: 'GET',
            url: 'https://sub.store/download/not-exist',
            headers: { 'User-Agent': 'Surge iOS' },
        }),
    };

    const result = {
        recordedAt: new Date().toISOString(),
        node: process.version,
        platform: `${process.platform} ${process.arch} ${os.cpus()[0].model}`,
        note: 'V8 JIT timings. Not an on-device Surge measurement. Peggy is reloaded per sample so the compiler cost is included. Bundle rows are null until pnpm bundle:esbuild has been run.',
        metrics,
    };

    if (writeBaseline) {
        fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
        fs.writeFileSync(baselinePath, JSON.stringify(result, null, 2) + '\n');
        process.stdout.write(
            `wrote ${path.relative(backendRoot, baselinePath)}\n`,
        );
    }

    printTable(result, loadBaseline());
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
