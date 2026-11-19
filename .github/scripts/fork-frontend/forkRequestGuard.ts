// Surge webview allows 3 concurrent script sessions. A refresh does not
// stop a script that is already running, so this page keeps at most 2 API
// calls in flight and does not start a heavy preview until the user acts
// on a reloaded or restored page.

const MARKER = 'sub-store-fork-api-cap:2';
const SKIP = 'sub-store-fork-skip-restored-preview';

type CancelTokenLike = {
  promise?: Promise<unknown>;
  reason?: unknown;
  throwIfRequested?: () => void;
};

type AdapterFn = (config: ForkConfig) => Promise<unknown>;

type ForkConfig = {
  __forkApiSlot?: boolean;
  __forkAdapterWrapped?: boolean;
  __forkRelease?: () => void;
  signal?: AbortSignal;
  cancelToken?: CancelTokenLike;
  adapter?: AdapterFn | unknown;
};

type Queueable = {
  defaults?: {
    adapter?: AdapterFn | unknown;
  };
  interceptors: {
    request: { use: (...args: any[]) => unknown };
    response: { use: (...args: any[]) => unknown };
  };
};

let activeApiRequests = 0;
const apiWaiters: Array<() => void> = [];

function navigationType() {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type || 'navigate';
  } catch {
    return 'navigate';
  }
}

let blockHeavyPreview =
  navigationType() === 'reload' || navigationType() === 'back_forward';

function allowHeavyPreview() {
  blockHeavyPreview = false;
}

if (typeof window !== 'undefined') {
  window.__SUB_STORE_FORK_API_CAP__ = MARKER;
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) blockHeavyPreview = true;
  });
  window.addEventListener('pointerdown', allowHeavyPreview, true);
  window.addEventListener('touchstart', allowHeavyPreview, true);
  window.addEventListener('keydown', allowHeavyPreview, true);
}

export function blockRestoredHeavyPreview() {
  return blockHeavyPreview;
}

export function restoredPreviewError() {
  const error = new Error(SKIP);
  error.name = 'CanceledError';
  return Object.assign(error, { code: 'ERR_CANCELED' });
}

function canceledError(reason?: unknown) {
  if (
    reason instanceof Error ||
    (reason &&
      typeof reason === 'object' &&
      (reason as { __CANCEL__?: boolean }).__CANCEL__)
  ) {
    return reason;
  }
  const error = new Error(
    typeof reason === 'string' && reason ? reason : 'canceled',
  );
  error.name = 'CanceledError';
  return Object.assign(error, { code: 'ERR_CANCELED' });
}

function releaseSlotCount() {
  activeApiRequests = Math.max(0, activeApiRequests - 1);
  const next = apiWaiters.shift();
  if (next) next();
}

function acquireApiSlot(
  signal?: AbortSignal,
  cancelToken?: CancelTokenLike,
) {
  if (signal?.aborted) {
    return Promise.reject(canceledError(signal.reason));
  }
  if (cancelToken?.reason) {
    return Promise.reject(canceledError(cancelToken.reason));
  }
  if (activeApiRequests < forkApiCap()) {
    activeApiRequests += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    const grant = () => {
      if (settled) return;
      settled = true;
      cleanup();
      activeApiRequests += 1;
      resolve();
    };
    const onCancel = (reason?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      const index = apiWaiters.indexOf(grant);
      if (index !== -1) apiWaiters.splice(index, 1);
      reject(canceledError(reason));
    };
    const onAbort = () => onCancel(signal?.reason);
    apiWaiters.push(grant);
    signal?.addEventListener('abort', onAbort, { once: true });
    cancelToken?.promise?.then(
      (reason) => onCancel(reason),
      (reason) => onCancel(reason),
    );
  });
}

function releaseApiSlot(config?: ForkConfig) {
  if (typeof config?.__forkRelease === 'function') {
    config.__forkRelease();
    return;
  }
  if (!config?.__forkApiSlot) return;
  config.__forkApiSlot = false;
  releaseSlotCount();
}

function forkApiCap() {
  const parsed = Number(String(MARKER).split(':').pop());
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 2;
}

function resolveAdapter(config: ForkConfig, service: Queueable): AdapterFn | null {
  const raw = config.adapter ?? service.defaults?.adapter;
  return typeof raw === 'function' ? (raw as AdapterFn) : null;
}

export function installForkApiQueue(service: Queueable) {
  service.interceptors.request.use(async (config: ForkConfig) => {
    const baseAdapter = resolveAdapter(config, service);
    if (baseAdapter) {
      if (!config.__forkAdapterWrapped) {
        config.__forkAdapterWrapped = true;
        config.adapter = async (cfg: ForkConfig) => {
          await acquireApiSlot(cfg.signal, cfg.cancelToken);
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            releaseSlotCount();
          };
          try {
            return await baseAdapter(cfg);
          } finally {
            release();
          }
        };
      }
      return config;
    }

    await acquireApiSlot(config.signal, config.cancelToken);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      config.__forkApiSlot = false;
      config.signal?.removeEventListener('abort', release);
      releaseSlotCount();
    };
    config.__forkApiSlot = true;
    config.__forkRelease = release;
    config.signal?.addEventListener('abort', release, { once: true });
    config.cancelToken?.promise?.then(release, release);
    return config;
  });
  service.interceptors.response.use(
    (response: { config?: ForkConfig }) => {
      releaseApiSlot(response?.config);
      return response;
    },
    (error: { config?: ForkConfig }) => {
      releaseApiSlot(error?.config);
      return Promise.reject(error);
    },
  );
}

declare global {
  interface Window {
    __SUB_STORE_FORK_API_CAP__?: string;
  }
}
