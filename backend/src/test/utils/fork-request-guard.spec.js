import { expect } from 'chai';
import { describe, it } from 'mocha';
import path from 'path';
import vm from 'vm';
import { buildSync } from 'esbuild';

const guardPath = path.resolve(
    __dirname,
    '../../../../.github/scripts/fork-frontend/forkRequestGuard.ts',
);

function loadGuardModule(globals = {}) {
    const out = buildSync({
        entryPoints: [guardPath],
        bundle: false,
        format: 'cjs',
        platform: 'neutral',
        write: false,
    });
    const code = out.outputFiles[0].text;
    const mod = { exports: {} };
    const sandbox = {
        module: mod,
        exports: mod.exports,
        Promise,
        Error,
        Object,
        Array,
        Number,
        String,
        Math,
        Boolean,
        ...globals,
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);
    return mod.exports;
}

function createAxios027Stub(baseAdapter) {
    const reqInterceptors = [];
    const resInterceptors = [];
    const service = {
        defaults: { adapter: baseAdapter },
        interceptors: {
            request: {
                use(onFulfilled, onRejected) {
                    reqInterceptors.unshift([onFulfilled, onRejected]);
                },
            },
            response: {
                use(onFulfilled, onRejected) {
                    resInterceptors.push([onFulfilled, onRejected]);
                },
            },
        },
        async request(rawConfig) {
            let config = { ...rawConfig };
            for (const [onFulfilled] of reqInterceptors) {
                config = await onFulfilled(config);
            }
            const adapter =
                typeof config.adapter === 'function'
                    ? config.adapter
                    : service.defaults.adapter;
            let promise = Promise.resolve().then(() => adapter(config));
            for (const [onFulfilled, onRejected] of resInterceptors) {
                promise = promise.then(onFulfilled, onRejected);
            }
            return promise;
        },
    };
    return service;
}

describe('frontend forkRequestGuard queue', function () {
    it('caps in-flight requests at 2 and never leaks slots when canceled errors lack config', async function () {
        const { installForkApiQueue } = loadGuardModule();
        let active = 0;
        let maxActive = 0;
        const service = createAxios027Stub(async (config) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
                await new Promise((r) => setTimeout(r, 10));
                if (config.failWithoutConfig) {
                    // Simulate axios 0.27.2 CanceledError (error.config is undefined)
                    const cancelErr = new Error('canceled');
                    cancelErr.name = 'CanceledError';
                    cancelErr.code = 'ERR_CANCELED';
                    throw cancelErr;
                }
                return { status: 200, config, data: config.id };
            } finally {
                active -= 1;
            }
        });
        installForkApiQueue(service);

        // Fire 6 requests whose rejections have no `.config` — must never deadlock the 2-slot cap.
        const failed = await Promise.allSettled(
            Array.from({ length: 6 }, (_, i) =>
                service.request({ id: `cancel-${i}`, failWithoutConfig: true }),
            ),
        );
        expect(failed.every((r) => r.status === 'rejected')).to.equal(true);
        expect(maxActive).to.equal(2);

        // Subsequent requests must still acquire slots and finish cleanly.
        const ok = await Promise.all(
            Array.from({ length: 4 }, (_, i) =>
                service.request({ id: `ok-${i}` }),
            ),
        );
        expect(ok.map((r) => r.data)).to.deep.equal([
            'ok-0',
            'ok-1',
            'ok-2',
            'ok-3',
        ]);
        expect(maxActive).to.equal(2);
    });

    it('drops queued waiters aborted by AbortSignal or CancelToken without leaking slots', async function () {
        const { installForkApiQueue } = loadGuardModule();
        const gates = [];
        const started = [];
        const service = createAxios027Stub(async (config) => {
            started.push(config.id);
            await new Promise((resolve) => gates.push(resolve));
            return { status: 200, config, data: config.id };
        });
        installForkApiQueue(service);

        const r1 = service.request({ id: 'slot-1' });
        const r2 = service.request({ id: 'slot-2' });
        await new Promise((r) => setTimeout(r, 10));
        expect(started).to.deep.equal(['slot-1', 'slot-2']);

        const controller = new AbortController();
        const r3 = service.request({
            id: 'queued-abort',
            signal: controller.signal,
        });

        let cancelResolve;
        const cancelToken = {
            promise: new Promise((resolve) => {
                cancelResolve = resolve;
            }),
        };
        const r4 = service.request({
            id: 'queued-cancel-token',
            cancelToken,
        });
        const r5 = service.request({ id: 'slot-5' });

        controller.abort();
        cancelResolve({ message: 'user canceled', __CANCEL__: true });

        const [res3, res4] = await Promise.allSettled([r3, r4]);
        expect(res3.status).to.equal('rejected');
        expect(res4.status).to.equal('rejected');
        expect(res4.reason.__CANCEL__).to.equal(true);

        // Release slot-1 and slot-2; slot-5 must run and skipped waiters must never start.
        gates.shift()();
        gates.shift()();
        await new Promise((r) => setTimeout(r, 10));
        gates.shift()();

        const [o1, o2, o5] = await Promise.all([r1, r2, r5]);
        expect([o1.data, o2.data, o5.data]).to.deep.equal([
            'slot-1',
            'slot-2',
            'slot-5',
        ]);
        expect(started).to.deep.equal(['slot-1', 'slot-2', 'slot-5']);
    });

    it('prioritizes interactive/mutating requests over reads and /api/sub/flow', async function () {
        const { installForkApiQueue, resolveApiPriority } = loadGuardModule();
        expect(resolveApiPriority({ method: 'POST', url: '/api/subs' })).to.equal(2);
        expect(resolveApiPriority({ method: 'GET', url: '/api/utils/refresh' })).to.equal(2);
        expect(resolveApiPriority({ method: 'GET', url: '/api/subs' })).to.equal(1);
        expect(resolveApiPriority({ method: 'GET', url: '/api/sub/flow/demo' })).to.equal(0);

        const gates = [];
        const started = [];
        const service = createAxios027Stub(async (config) => {
            started.push(config.id);
            await new Promise((resolve) => gates.push(resolve));
            return { status: 200, config, data: config.id };
        });
        installForkApiQueue(service);

        // Fill both slots first.
        const r1 = service.request({ id: 'hold-1', method: 'GET', url: '/api/subs' });
        const r2 = service.request({ id: 'hold-2', method: 'GET', url: '/api/collections' });
        await new Promise((r) => setTimeout(r, 10));

        // Enqueue low -> normal -> high while both slots are busy.
        const low = service.request({ id: 'low-flow', method: 'GET', url: '/api/sub/flow/a' });
        const normal = service.request({ id: 'norm-files', method: 'GET', url: '/api/wholeFiles' });
        const high = service.request({ id: 'high-patch', method: 'PATCH', url: '/api/sub/a' });
        await new Promise((r) => setTimeout(r, 10));

        // Release slots one by one so priority order is deterministic.
        while (gates.length > 0 || started.length < 5) {
            if (gates.length > 0) gates.shift()();
            await new Promise((r) => setTimeout(r, 10));
        }
        await Promise.all([r1, r2, low, normal, high]);
        expect(started).to.deep.equal([
            'hold-1',
            'hold-2',
            'high-patch',
            'norm-files',
            'low-flow',
        ]);
    });

    it('defers queued /api/sub/flow while hidden and resumes when page becomes visible', async function () {
        let visibilityState = 'hidden';
        const listeners = [];
        const fakeDoc = {
            get visibilityState() {
                return visibilityState;
            },
            addEventListener(type, fn) {
                if (type === 'visibilitychange') listeners.push(fn);
            },
        };
        const { installForkApiQueue } = loadGuardModule({ document: fakeDoc });
        const started = [];
        const service = createAxios027Stub(async (config) => {
            started.push(config.id);
            return { status: 200, config, data: config.id };
        });
        installForkApiQueue(service);

        const flowPromise = service.request({
            id: 'bg-flow',
            method: 'GET',
            url: '/api/sub/flow/demo',
        });
        const corePromise = service.request({
            id: 'fg-core',
            method: 'GET',
            url: '/api/subs',
        });

        await corePromise;
        await new Promise((r) => setTimeout(r, 15));
        // Core request ran even while hidden; low-priority flow stays deferred.
        expect(started).to.deep.equal(['fg-core']);

        visibilityState = 'visible';
        listeners.forEach((fn) => fn());
        await flowPromise;
        expect(started).to.deep.equal(['fg-core', 'bg-flow']);
    });

    it('shares the 2-slot cap and applies apiRequestTimeout in queuedPreviewGet', async function () {
        const fakeStorage = {
            getItem(key) {
                return key === 'apiRequestTimeout' ? '12345' : null;
            },
        };
        const { installForkApiQueue, queuedPreviewGet } = loadGuardModule({
            localStorage: fakeStorage,
        });
        const gates = [];
        const started = [];
        const service = createAxios027Stub(async (config) => {
            started.push(config.id);
            await new Promise((resolve) => gates.push(resolve));
            return { status: 200, config, data: config.id };
        });
        installForkApiQueue(service);

        const r1 = service.request({ id: 'slot-1', method: 'GET', url: '/api/subs' });
        const r2 = service.request({ id: 'slot-2', method: 'GET', url: '/api/collections' });
        await new Promise((r) => setTimeout(r, 10));

        let seenConfig = null;
        const fakeAxios = {
            async get(url, cfg) {
                started.push(`preview:${url}`);
                seenConfig = cfg;
                return { data: 'ok' };
            },
        };
        const flowPending = service.request({
            id: 'queued-flow',
            method: 'GET',
            url: '/api/sub/flow/a',
        });
        const previewPromise = queuedPreviewGet(fakeAxios, 'https://sub.store/download/a', {
            responseType: 'text',
        });
        await new Promise((r) => setTimeout(r, 10));
        expect(started).to.deep.equal(['slot-1', 'slot-2']);

        gates.shift()();
        await previewPromise;
        expect(seenConfig.timeout).to.equal(12345);
        expect(started.slice(0, 3)).to.deep.equal([
            'slot-1',
            'slot-2',
            'preview:https://sub.store/download/a',
        ]);

        while (gates.length > 0) {
            gates.shift()();
            await new Promise((r) => setTimeout(r, 10));
        }
        await Promise.all([r1, r2, flowPending]);
        expect(started).to.deep.equal([
            'slot-1',
            'slot-2',
            'preview:https://sub.store/download/a',
            'queued-flow',
        ]);
    });
});
