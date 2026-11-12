// Surge webview allows 3 concurrent script sessions. A refresh does not
// stop a script that is already running, so this page keeps at most 2 API
// calls in flight and does not start a heavy preview until the user acts
// on a reloaded or restored page.

const MARKER = 'sub-store-fork-api-cap:2';
const SKIP = 'sub-store-fork-skip-restored-preview';

type ForkConfig = {
  __forkApiSlot?: boolean;
};

type Queueable = {
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

function acquireApiSlot() {
  if (activeApiRequests < forkApiCap()) {
    activeApiRequests += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    apiWaiters.push(() => {
      activeApiRequests += 1;
      resolve();
    });
  });
}

function releaseApiSlot(config?: ForkConfig) {
  if (!config?.__forkApiSlot) return;
  config.__forkApiSlot = false;
  activeApiRequests = Math.max(0, activeApiRequests - 1);
  const next = apiWaiters.shift();
  if (next) next();
}

function forkApiCap() {
  const parsed = Number(String(MARKER).split(':').pop());
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 2;
}

export function installForkApiQueue(service: Queueable) {
  service.interceptors.request.use(async (config) => {
    await acquireApiSlot();
    config.__forkApiSlot = true;
    return config;
  });
  service.interceptors.response.use(
    (response) => {
      releaseApiSlot(response?.config);
      return response;
    },
    (error) => {
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
