// Surge webview allows 3 concurrent script sessions. A refresh does not
// stop a script that is already running, so this page keeps at most 2 API
// calls in flight, prioritizes interactive actions over background traffic
// queries, pauses queued background flow fetches while the page is hidden,
// and does not start a heavy preview until the user acts on a reloaded or
// restored page.

const MARKER = 'sub-store-fork-api-cap:2';
const SKIP = 'sub-store-fork-skip-restored-preview';
const DEFAULT_PREVIEW_TIMEOUT = 50000;

export type ForkApiPriority = 0 | 1 | 2;

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
  method?: string;
  url?: string;
  timeout?: number;
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

interface ApiWaiter {
  priority: ForkApiPriority;
  seq: number;
  deferWhileHidden: boolean;
  grant: () => void;
}

let activeApiRequests = 0;
let waiterSeq = 0;
const apiWaiters: ApiWaiter[] = [];

const HIGH_PRIORITY_PATH_RE =
  /\/(?:api\/(?:preview\/|sync\/|utils\/(?:refresh|backup)|storage|sort\/|age\/|file\/)|download\/|share\/)/i;
const LOW_PRIORITY_FLOW_RE = /\/api\/sub\/flow(?:\/|\?|#|$)/i;

export function resolveApiPriority(config?: Pick<ForkConfig, 'method' | 'url'>): ForkApiPriority {
  const method = String(config?.method || 'GET').toUpperCase();
  const url = String(config?.url || '');
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    return 2;
  }
  if (HIGH_PRIORITY_PATH_RE.test(url)) {
    return 2;
  }
  if (LOW_PRIORITY_FLOW_RE.test(url)) {
    return 0;
  }
  return 1;
}

function isPageHidden(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.visibilityState === 'hidden'
  );
}

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

if (
  typeof document !== 'undefined' &&
  typeof document.addEventListener === 'function'
) {
  document.addEventListener('visibilitychange', () => {
    if (!isPageHidden()) {
      drainApiWaiters();
    }
  });
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

function pickNextWaiterIndex(): number {
  const hidden = isPageHidden();
  let bestIndex = -1;
  for (let i = 0; i < apiWaiters.length; i++) {
    const waiter = apiWaiters[i];
    if (hidden && waiter.deferWhileHidden) continue;
    if (
      bestIndex === -1 ||
      waiter.priority > apiWaiters[bestIndex].priority ||
      (waiter.priority === apiWaiters[bestIndex].priority &&
        waiter.seq < apiWaiters[bestIndex].seq)
    ) {
      bestIndex = i;
    }
  }
  return bestIndex;
}

export function drainApiWaiters() {
  while (activeApiRequests < forkApiCap()) {
    const index = pickNextWaiterIndex();
    if (index === -1) break;
    const [next] = apiWaiters.splice(index, 1);
    next.grant();
  }
}

function releaseSlotCount() {
  activeApiRequests = Math.max(0, activeApiRequests - 1);
  drainApiWaiters();
}

function acquireApiSlot(
  signal?: AbortSignal,
  cancelToken?: CancelTokenLike,
  options?: { priority?: ForkApiPriority; deferWhileHidden?: boolean },
) {
  if (signal?.aborted) {
    return Promise.reject(canceledError(signal.reason));
  }
  if (cancelToken?.reason) {
    return Promise.reject(canceledError(cancelToken.reason));
  }
  const priority = options?.priority ?? 1;
  const deferWhileHidden = Boolean(options?.deferWhileHidden);
  if (
    activeApiRequests < forkApiCap() &&
    !(deferWhileHidden && isPageHidden())
  ) {
    activeApiRequests += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    const waiter: ApiWaiter = {
      priority,
      seq: ++waiterSeq,
      deferWhileHidden,
      grant: () => {
        if (settled) return;
        settled = true;
        cleanup();
        activeApiRequests += 1;
        resolve();
      },
    };
    const onCancel = (reason?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      const index = apiWaiters.indexOf(waiter);
      if (index !== -1) apiWaiters.splice(index, 1);
      reject(canceledError(reason));
    };
    const onAbort = () => onCancel(signal?.reason);
    apiWaiters.push(waiter);
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

function resolvePreviewTimeout(explicitTimeout?: number): number {
  if (
    typeof explicitTimeout === 'number' &&
    Number.isFinite(explicitTimeout) &&
    explicitTimeout > 0
  ) {
    return explicitTimeout;
  }
  try {
    const stored = Number(globalThis.localStorage?.getItem('apiRequestTimeout'));
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch {
    // localStorage may be unavailable in restricted webviews.
  }
  return DEFAULT_PREVIEW_TIMEOUT;
}

export async function queuedPreviewGet(
  client: { get: (url: string, config?: any) => Promise<any> },
  url: string,
  config: ForkConfig & Record<string, any> = {},
): Promise<any> {
  await acquireApiSlot(config.signal, config.cancelToken, {
    priority: 2,
    deferWhileHidden: false,
  });
  try {
    return await client.get(url, {
      ...config,
      timeout: resolvePreviewTimeout(
        typeof config.timeout === 'number' ? config.timeout : undefined,
      ),
    });
  } finally {
    releaseSlotCount();
  }
}

export function installForkApiQueue(service: Queueable) {
  service.interceptors.request.use(async (config: ForkConfig) => {
    const baseAdapter = resolveAdapter(config, service);
    if (baseAdapter) {
      if (!config.__forkAdapterWrapped) {
        config.__forkAdapterWrapped = true;
        config.adapter = async (cfg: ForkConfig) => {
          const priority = resolveApiPriority(cfg);
          await acquireApiSlot(cfg.signal, cfg.cancelToken, {
            priority,
            deferWhileHidden: priority === 0,
          });
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

    const priority = resolveApiPriority(config);
    await acquireApiSlot(config.signal, config.cancelToken, {
      priority,
      deferWhileHidden: priority === 0,
    });
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
