import { hex_md5 } from '@/vendor/md5';
import $ from '@/core/app';

/**
 * Share one in-flight result for identical heavy work.
 *
 * This map lives in one JavaScript realm. That is the Node process, and it
 * is also a single Surge script run: one http-request starts cold, handles
 * one request, and exits at $done(). Duplicate work inside that run (or two
 * overlapping Node requests) awaits the same promise.
 *
 * It does not cross Surge script sessions. A persisted lock was considered
 * and not used:
 * - Waiting would occupy one of the 3 webview script slots until the owner
 *   finished or the TTL expired, which is the failure this is meant to avoid.
 * - $persistentStore is not a mutex. Two sessions can both observe an empty
 *   lock and both start.
 * - A session killed by timeout or refresh does not clear the lock. A short
 *   TTL still stalls every waiter.
 * - Handing a preview or download body back through the store can exceed the
 *   4 MB iOS value cap.
 * - $done() cancels timers, so a waiter cannot reliably poll for the body.
 *
 * The hash is only the identity of work that is already running. It is not a
 * cache and it is not kept after the promise settles.
 */

const inflight = new Map();

function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    const keys = Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort();
    return `{${keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(',')}}`;
}

function getHeader(headers, target) {
    if (!headers || typeof headers !== 'object') return '';
    if (headers[target] !== undefined) {
        return headers[target] == null ? '' : String(headers[target]);
    }
    const lower = target.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lower) {
            return headers[key] == null ? '' : String(headers[key]);
        }
    }
    return '';
}

export function heavyRequestKey(kind, req, { includeUserAgent = false } = {}) {
    const headers = req?.headers || {};
    const parts = {
        kind,
        method: String(req?.method || 'GET').toUpperCase(),
        path: req?.path || '',
        params: req?.params || {},
        query: req?.query || {},
        body: req?.body ?? null,
    };
    if (includeUserAgent) {
        parts.ua = getHeader(headers, 'user-agent');
    }
    const shareAgeKey = getHeader(headers, 'x-sub-store-share-age-public-key');
    if (shareAgeKey) {
        parts.shareAgePublicKey = shareAgeKey;
    }
    const ifNoneMatch = getHeader(headers, 'if-none-match');
    if (ifNoneMatch) {
        parts.ifNoneMatch = ifNoneMatch;
    }
    const ifModifiedSince = getHeader(headers, 'if-modified-since');
    if (ifModifiedSince) {
        parts.ifModifiedSince = ifModifiedSince;
    }
    return hex_md5(stableStringify(parts));
}

function snapshotResponse(box) {
    return {
        statusCode: box.statusCode ?? 200,
        headers: { ...box.headers },
        removed: [...box.removed],
        body: box.body,
        encoding: box.encoding,
        method: box.method,
        sent: box.sent,
    };
}

function instrument(res, box) {
    const original = {
        status: typeof res.status === 'function' ? res.status.bind(res) : null,
        set: typeof res.set === 'function' ? res.set.bind(res) : null,
        setHeader:
            typeof res.setHeader === 'function' ? res.setHeader.bind(res) : null,
        removeHeader:
            typeof res.removeHeader === 'function'
                ? res.removeHeader.bind(res)
                : null,
        send: typeof res.send === 'function' ? res.send.bind(res) : null,
        json: typeof res.json === 'function' ? res.json.bind(res) : null,
        end: typeof res.end === 'function' ? res.end.bind(res) : null,
    };

    const resolveStatus = () =>
        box.statusCode ?? (typeof res.statusCode === 'number' ? res.statusCode : 200);

    if (original.status) {
        res.status = (code) => {
            if (!box.sent) box.statusCode = code;
            original.status(code);
            return res;
        };
    }
    if (original.set) {
        res.set = (key, value) => {
            if (!box.sent) {
                if (value === undefined && key && typeof key === 'object') {
                    Object.assign(box.headers, key);
                } else {
                    box.headers[key] = value;
                }
            }
            if (value === undefined && key && typeof key === 'object') {
                original.set(key);
            } else {
                original.set(key, value);
            }
            return res;
        };
    }
    if (original.setHeader) {
        res.setHeader = (key, value) => {
            if (!box.sent) box.headers[key] = value;
            return original.setHeader(key, value);
        };
    }
    if (original.removeHeader) {
        res.removeHeader = (key) => {
            if (!box.sent) {
                delete box.headers[key];
                box.removed.push(key);
            }
            return original.removeHeader(key);
        };
    }
    if (original.send) {
        res.send = (body) => {
            if (!box.sent) {
                box.statusCode = resolveStatus();
                box.body = body;
                box.method = 'send';
                box.sent = true;
            }
            return original.send(body);
        };
    }
    if (original.json) {
        res.json = (data) => {
            if (!box.sent) {
                box.statusCode = resolveStatus();
                box.body = data;
                box.method = 'json';
                box.sent = true;
            }
            return original.json(data);
        };
    }
    if (original.end) {
        res.end = (...args) => {
            if (!box.sent) {
                box.statusCode = resolveStatus();
                if (args.length > 0 && typeof args[0] !== 'function') {
                    box.body = args[0];
                }
                if (args.length > 1 && typeof args[1] === 'string') {
                    box.encoding = args[1];
                }
                box.method = 'end';
                box.sent = true;
            }
            return original.end(...args);
        };
    }
    return res;
}

export function replayResponse(res, snap) {
    for (const key of snap.removed || []) {
        if (typeof res.removeHeader === 'function') res.removeHeader(key);
    }
    for (const [key, value] of Object.entries(snap.headers || {})) {
        if (typeof res.set === 'function') res.set(key, value);
        else if (typeof res.setHeader === 'function') res.setHeader(key, value);
    }
    if (snap.statusCode && typeof res.status === 'function') {
        res.status(snap.statusCode);
    }
    if (snap.method === 'json' && typeof res.json === 'function') {
        res.json(snap.body);
        return;
    }
    if (snap.method === 'end' && typeof res.end === 'function') {
        if (snap.encoding !== undefined) {
            res.end(snap.body, snap.encoding);
        } else {
            res.end(snap.body);
        }
        return;
    }
    if (typeof res.send === 'function') res.send(snap.body ?? '');
}

/**
 * Run `handler` once for `key`. The leader's `res` is sent by the handler.
 * A follower waits for that result and writes the same status, headers, and
 * body to its own `res`.
 */
export function shareResponse(key, res, handler, label = 'request') {
    const existing = inflight.get(key);
    if (existing) {
        $.info(`[inflight] reuse ${label}`);
        return existing.then((snap) => {
            replayResponse(res, snap);
            return snap;
        });
    }

    const box = {
        statusCode: undefined,
        headers: {},
        removed: [],
        body: undefined,
        encoding: undefined,
        method: 'send',
        sent: false,
    };
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    inflight.set(key, promise);
    instrument(res, box);

    return Promise.resolve()
        .then(() => handler(res))
        .then(() => {
            const snap = snapshotResponse(box);
            resolve(snap);
            return snap;
        })
        .catch((error) => {
            if (box.sent) {
                const snap = snapshotResponse(box);
                resolve(snap);
                return snap;
            }
            reject(error);
            throw error;
        })
        .finally(() => {
            if (inflight.get(key) === promise) inflight.delete(key);
        });
}

export function resetInflight() {
    inflight.clear();
}

export function inflightSize() {
    return inflight.size;
}
