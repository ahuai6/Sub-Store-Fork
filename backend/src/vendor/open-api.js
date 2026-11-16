/* eslint-disable no-undef */
import { installConsoleLogCapture } from '@/utils/debug-logs';
import getFs from '@/runtime/fs';
import { SURGE_ONLY } from '@/runtime/build-flags';

// Surge bundles fold these to constants. Other builds fold SURGE_ONLY to
// false and keep the original runtime tests. Regions marked @non-surge are
// deleted from the Surge bundles only; they stay in every other build.
const isQX = SURGE_ONLY ? false : typeof $task !== 'undefined';
const isLoon = SURGE_ONLY ? false : typeof $loon !== 'undefined';
const isEgern = SURGE_ONLY ? false : 'undefined' !== typeof Egern;
const isNode = SURGE_ONLY
    ? false
    : eval(`typeof process !== "undefined"`); // eval is needed in order to avoid browserify processing
const isStash = SURGE_ONLY
    ? false
    : 'undefined' !== typeof $environment && $environment['stash-version'];
const isShadowRocket = SURGE_ONLY ? false : 'undefined' !== typeof $rocket;
const isLanceX = SURGE_ONLY ? false : 'undefined' != typeof $native;
const isGUIforCores = SURGE_ONLY ? false : typeof $Plugins !== 'undefined';
// 可能有一些兼容环境依赖于这个, 先不改成 $environment.surge-version
const isSurge = SURGE_ONLY
    ? true
    : typeof $httpClient !== 'undefined' && !isLoon && !isEgern;
const isSubsCheckPro = SURGE_ONLY
    ? false
    : isLoon &&
      typeof $loon === 'object' &&
      $loon !== null &&
      $loon.isSubsCheckPro === true;
import { Base64 } from 'js-base64';

function isPlainObject(obj) {
    return (
        obj !== null &&
        typeof obj === 'object' &&
        [null, Object.prototype].includes(Object.getPrototypeOf(obj))
    );
}

function parseSocks5Uri(uri) {
    // eslint-disable-next-line no-unused-vars
    let [__, username, password, server, port, query, name] = uri.match(
        /^socks5:\/\/(?:(.*?):(.*?)@)?(.*?)(?::(\d+?))?(\?.*?)?(?:#(.*?))?$/,
    );
    if (port) {
        port = parseInt(port, 10);
    } else {
        $.error(`port is not present in line: ${uri}`);
        throw new Error(`port is not present in line: ${uri}`);
    }
    return {
        type: 5,
        host: server,
        port,

        userId: username != null ? decodeURIComponent(username) : undefined,
        password: password != null ? decodeURIComponent(password) : undefined,
    };
}

function normalizeNodeRequestHeaders(headers) {
    const normalized = [];
    let hasAccept = false;

    for (const [key, value] of Object.entries(headers || {})) {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey === 'accept') {
            hasAccept = true;
            if (value == null) continue;
        }
        normalized.push([normalizedKey, value]);
    }

    if (!hasAccept) {
        normalized.push(['accept', '*/*']);
    }

    return Object.fromEntries(normalized);
}

export class OpenAPI {
    constructor(name = 'untitled', debug = false) {
        this.name = name;
        this.debug = debug;

        this.http = HTTP();
        this.env = ENV();

        if (isNode) {
            /* @non-surge-start */
            const dotenv = eval(`require("dotenv")`);
            dotenv.config();
            /* @non-surge-end */
        }
        this.node = (() => {
            if (isNode) {
                /* @non-surge-start */
                const fs = getFs();

                return {
                    fs,
                };
                /* @non-surge-end */
            } else {
                return null;
            }
        })();
        this.initCache();
        installConsoleLogCapture(this);

        const delay = (t, v) =>
            new Promise(function (resolve) {
                setTimeout(resolve.bind(null, v), t);
            });

        Promise.prototype.delay = async function (t) {
            const v = await this;
            return await delay(t, v);
        };
    }

    // persistence
    // initialize cache
    initCache() {
        if (isQX) {
            /* @non-surge-start */
            this.cache = JSON.parse($prefs.valueForKey(this.name) || '{}');
            /* @non-surge-end */
        }
        if (isLoon || isSurge || isEgern)
            this.cache = JSON.parse($persistentStore.read(this.name) || '{}');
        if (isGUIforCores) {
            /* @non-surge-start */
            this.cache = JSON.parse(
                $Plugins.SubStoreCache.get(this.name) || '{}',
            );
            /* @non-surge-end */
        }
        if (isNode) {
            /* @non-surge-start */
            // create a json for root cache
            const basePath =
                eval('process.env.SUB_STORE_DATA_BASE_PATH') || '.';
            let rootPath = `${basePath}/root.json`;
            const backupRootPath = `${basePath}/root_${Date.now()}.json`;

            this.log(`Root path: ${rootPath}`);
            if (this.node.fs.existsSync(rootPath)) {
                try {
                    this.root = JSON.parse(
                        this.node.fs.readFileSync(`${rootPath}`),
                    );
                } catch (e) {
                    this.node.fs.copyFileSync(rootPath, backupRootPath);
                    this.error(
                        `Failed to parse ${rootPath}: ${e.message}. Backup created at ${backupRootPath}`,
                    );
                }
            }
            if (!isPlainObject(this.root)) {
                this.node.fs.writeFileSync(rootPath, JSON.stringify({}), {
                    flag: 'w',
                });
                this.root = {};
            }

            // create a json file with the given name if not exists
            let fpath = `${basePath}/${this.name}.json`;
            const backupPath = `${basePath}/${this.name}_${Date.now()}.json`;

            this.log(`Data path: ${fpath}`);
            if (this.node.fs.existsSync(fpath)) {
                try {
                    this.cache = JSON.parse(
                        this.node.fs.readFileSync(`${fpath}`, 'utf-8'),
                    );
                    if (!isPlainObject(this.cache))
                        throw new Error('Invalid Data');
                } catch (e) {
                    try {
                        const str = Base64.decode(
                            this.node.fs.readFileSync(`${fpath}`, 'utf-8'),
                        );
                        this.cache = JSON.parse(str);
                        this.node.fs.writeFileSync(fpath, str, {
                            flag: 'w',
                        });
                        if (!isPlainObject(this.cache))
                            throw new Error('Invalid Data');
                    } catch (e) {
                        this.node.fs.copyFileSync(fpath, backupPath);
                        this.error(
                            `Failed to parse ${fpath}: ${e.message}. Backup created at ${backupPath}`,
                        );
                    }
                }
            }
            if (!isPlainObject(this.cache)) {
                this.node.fs.writeFileSync(fpath, JSON.stringify({}), {
                    flag: 'w',
                });
                this.cache = {};
            }
            /* @non-surge-end */
        }
        this._rememberPersisted();
    }

    _rememberPersisted() {
        if (isPlainObject(this.cache)) {
            this._persistedCache = JSON.stringify(this.cache, null, 2);
        }
        if (isNode && isPlainObject(this.root)) {
            this._persistedRoot = JSON.stringify(this.root, null, 2);
        }
    }

    // store cache
    // fork: skip unchanged store writes. A top-level key still lives in the
    // same JSON object. Only the file that changed is rewritten, and a write
    // whose pretty JSON matches the last one is skipped. Debouncing is not
    // used: $done() cancels timers, and a user script can read the host store
    // immediately after $.write().
    persistCache(target = 'both') {
        const writeCache = target === 'both' || target === 'cache';
        const writeRoot = (target === 'both' || target === 'root') && isNode;
        if (writeCache) {
            const data = JSON.stringify(this.cache, null, 2);
            if (data !== this._persistedCache) {
                if (isQX) {
                    /* @non-surge-start */
                    $prefs.setValueForKey(data, this.name);
                    /* @non-surge-end */
                }
                if (isLoon || isSurge || isEgern)
                    $persistentStore.write(data, this.name);
                if (isGUIforCores) {
                    /* @non-surge-start */
                    $Plugins.SubStoreCache.set(this.name, data);
                    /* @non-surge-end */
                }
                if (isNode) {
                    /* @non-surge-start */
                    const basePath =
                        eval('process.env.SUB_STORE_DATA_BASE_PATH') || '.';
                    this.node.fs.writeFileSync(
                        `${basePath}/${this.name}.json`,
                        data,
                        { flag: 'w' },
                        (err) => console.log(err),
                    );
                    /* @non-surge-end */
                }
                this._persistedCache = data;
            }
        }
        if (writeRoot) {
            /* @non-surge-start */
            const data = JSON.stringify(this.root, null, 2);
            if (data !== this._persistedRoot) {
                const basePath =
                    eval('process.env.SUB_STORE_DATA_BASE_PATH') || '.';
                this.node.fs.writeFileSync(
                    `${basePath}/root.json`,
                    data,
                    { flag: 'w' },
                    (err) => console.log(err),
                );
                this._persistedRoot = data;
            }
            /* @non-surge-end */
        }
    }

    write(data, key) {
        this.log(`SET ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            if (isSurge || isLoon || isEgern) {
                return $persistentStore.write(data, key);
            }
            if (isQX) {
                /* @non-surge-start */
                if (data == null) return $prefs.removeValueForKey(key);
                return $prefs.setValueForKey(data, key);
                /* @non-surge-end */
            }
            if (isNode) {
                /* @non-surge-start */
                if (data == null) {
                    delete this.root[key];
                } else {
                    this.root[key] = data;
                }
                /* @non-surge-end */
            }
            if (isGUIforCores) {
                /* @non-surge-start */
                if (data == null) return $Plugins.SubStoreCache.remove(key);
                return $Plugins.SubStoreCache.set(key, data);
                /* @non-surge-end */
            }
            this.persistCache('root');
            return;
        }
        this.cache[key] = data;
        this.persistCache('cache');
    }

    read(key) {
        this.log(`READ ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            if (isSurge || isLoon || isEgern) {
                return $persistentStore.read(key);
            }
            if (isQX) {
                /* @non-surge-start */
                return $prefs.valueForKey(key);
                /* @non-surge-end */
            }
            if (isNode) {
                /* @non-surge-start */
                return this.root[key];
                /* @non-surge-end */
            }
            if (isGUIforCores) {
                /* @non-surge-start */
                return $Plugins.SubStoreCache.get(key);
                /* @non-surge-end */
            }
        } else {
            return this.cache[key];
        }
    }

    delete(key) {
        this.log(`DELETE ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            if (isSurge || isLoon || isEgern) {
                return $persistentStore.write(null, key);
            }
            if (isQX) {
                /* @non-surge-start */
                return $prefs.removeValueForKey(key);
                /* @non-surge-end */
            }
            if (isNode) {
                /* @non-surge-start */
                delete this.root[key];
                /* @non-surge-end */
            }
            if (isGUIforCores) {
                /* @non-surge-start */
                return $Plugins.SubStoreCache.remove(key);
                /* @non-surge-end */
            }
            this.persistCache('root');
            return;
        }
        delete this.cache[key];
        this.persistCache('cache');
    }

    // notification
    notify(title, subtitle = '', content = '', options = {}) {
        const openURL = options['open-url'];
        const mediaURL = options['media-url'];

        if (isQX) {
            /* @non-surge-start */
            $notify(title, subtitle, content, options);
            /* @non-surge-end */
        }
        if (isSurge || isEgern) {
            $notification.post(
                title,
                subtitle,
                content + `${mediaURL ? '\n多媒体:' + mediaURL : ''}`,
                {
                    url: openURL,
                },
            );
        }
        if (isLoon) {
            /* @non-surge-start */
            let opts = {};
            if (openURL) opts['openUrl'] = openURL;
            if (mediaURL) opts['mediaUrl'] = mediaURL;
            if (JSON.stringify(opts) === '{}') {
                $notification.post(title, subtitle, content);
            } else {
                $notification.post(title, subtitle, content, opts);
            }
            /* @non-surge-end */
        }
        if (isNode) {
            /* @non-surge-start */
            const content_ =
                content +
                (openURL ? `\n点击跳转: ${openURL}` : '') +
                (mediaURL ? `\n多媒体: ${mediaURL}` : '');
            console.log(`[Notify] ${title}\n${subtitle}\n${content_}\n\n`);

            let push = eval('process.env.SUB_STORE_PUSH_SERVICE');
            if (push) {
                if (/^https?:\/\//.test(push)) {
                    // 处理 HTTP/HTTPS URL
                    const url = push
                        .replace(
                            '[推送标题]',
                            encodeURIComponent(title || 'Sub-Store'),
                        )
                        .replace(
                            '[推送内容]',
                            encodeURIComponent(
                                [subtitle, content_].map((i) => i).join('\n'),
                            ),
                        );
                    const $http = HTTP();
                    $http
                        .get({ url })
                        .then((resp) => {
                            console.log(
                                `[Push Service] URL: ${url}\nRES: ${resp.statusCode} ${resp.body}`,
                            );
                        })
                        .catch((e) => {
                            console.log(
                                `[Push Service] URL: ${url}\nERROR: ${e}`,
                            );
                        });
                } else {
                    // Keep the ESM package out of browser artifacts; the Node bundle
                    // replaces this evaluated import with a bundled dynamic import.
                    eval('import("shoutrrr-ts")')
                        .then(({ send }) =>
                            send(push, `${title}\n${subtitle}\n${content_}`, {
                                transport: createNotificationTransport(HTTP()),
                            }).then(
                                () => console.log('[Push Service] RES: sent'),
                                (error) =>
                                    console.log(
                                        `[Push Service] ERROR: ${error.message}`,
                                    ),
                            ),
                        )
                        .catch(() =>
                            console.log(
                                '[Push Service] ERROR: notification delivery failed',
                            ),
                        );
                }
            }
            /* @non-surge-end */
        }
        if (isGUIforCores) {
            /* @non-surge-start */
            $Plugins.Notify(title, subtitle + '\n' + content);
            /* @non-surge-end */
        }
    }

    // other helper functions
    log(msg) {
        if (this.debug) console.log(`[${this.name}] LOG: ${msg}`);
    }

    info(msg) {
        console.log(`[${this.name}] INFO: ${msg}`);
    }

    warn(msg) {
        console.log(`[${this.name}] WARN: ${msg}`);
    }

    error(msg) {
        console.log(`[${this.name}] ERROR: ${msg}`);
    }

    wait(millisec) {
        return new Promise((resolve) => setTimeout(resolve, millisec));
    }

    done(value = {}) {
        if (isQX || isLoon || isSurge || isGUIforCores || isEgern) {
            $done(value);
        } else if (isNode) {
            /* @non-surge-start */
            if (typeof $context !== 'undefined') {
                $context.headers = value.headers;
                $context.statusCode = value.statusCode;
                $context.body = value.body;
            }
            /* @non-surge-end */
        }
    }
}

export function ENV() {
    return {
        isQX,
        isLoon,
        isSurge,
        isNode,
        isStash,
        isShadowRocket,
        isEgern,
        isLanceX,
        isGUIforCores,
        isSubsCheckPro,
    };
}

// Keep notification requests on the same proxy/timeout policy as other Node HTTP calls.
// HTTP() follows redirects with Undici's redirect interceptor, which strips
// authorization/cookie headers on cross-origin redirects. Its timeout bounds
// the observed outcome but does not prove the underlying request was aborted.
function createNotificationTransport(client) {
    return async (url, init = {}) => {
        const body = init.body;
        if (
            body != null &&
            typeof body !== 'string' &&
            !(body instanceof Uint8Array) &&
            !(body instanceof ArrayBuffer)
        ) {
            throw new Error('unsupported notification request body');
        }
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        const response = await client.request({
            url,
            method: init.method || 'GET',
            headers,
            body: body instanceof ArrayBuffer ? new Uint8Array(body) : body,
            encoding: null,
            timeout: 8000,
        });
        return new Response(
            [204, 205, 304].includes(response.statusCode)
                ? null
                : response.body,
            { status: response.statusCode },
        );
    };
}

export function HTTP(defaultOptions = { baseURL: '' }) {
    const { isQX, isLoon, isSurge, isNode, isGUIforCores, isEgern } = ENV();
    const methods = [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'HEAD',
        'OPTIONS',
        'PATCH',
    ];
    const URL_REGEX =
        /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;

    let requestIdCounter = 0;

    function generateRequestId() {
        return `${Date.now()}-${++requestIdCounter}`;
    }

    async function send(method, options) {
        options = typeof options === 'string' ? { url: options } : options;
        const baseURL = defaultOptions.baseURL;
        if (baseURL && !URL_REGEX.test(options.url || '')) {
            options.url = baseURL ? baseURL + options.url : options.url;
        }
        options = { ...defaultOptions, ...options };
        const timeout = options.timeout;
        const requestId = options.requestId || generateRequestId();
        const events = {
            ...{
                onRequest: () => {},
                onResponse: (resp) => resp,
                onTimeout: () => {},
            },
            ...options.events,
        };

        events.onRequest(method, options);

        if (options.node) {
            // Surge & Loon allow connecting to a server using a specified proxy node
            if (isSurge) {
                const build = $environment['surge-build'];
                if (build && parseInt(build) >= 2407) {
                    options['policy-descriptor'] = options.node;
                    delete options.node;
                }
            }
        }

        let worker;
        if (isQX) {
            /* @non-surge-start */
            worker = $task.fetch({
                method,
                url: options.url,
                headers: options.headers,
                body: options.body,
                opts: options.opts,
            });
            /* @non-surge-end */
        } else if (isLoon || isSurge || isNode || isEgern) {
            worker = new Promise((resolve, reject) => {
                const body = options.body;
                const opts = JSON.parse(JSON.stringify(options));

                opts.body = body;
                opts.timeout = Number(opts.timeout) || 8000;
                if (isNode) {
                    /* @non-surge-start */
                    const undici = eval("require('undici')");
                    const { socksDispatcher } = eval("require('fetch-socks')");
                    const defaultMaxHeaderSize = 32 * 1024;
                    const parsedMaxHeaderSize = Number.parseInt(
                        eval('process.env.SUB_STORE_MAX_HEADER_SIZE'),
                        10,
                    );
                    const maxHeaderSize =
                        Number.isInteger(parsedMaxHeaderSize) &&
                        parsedMaxHeaderSize > 0
                            ? parsedMaxHeaderSize
                            : defaultMaxHeaderSize;
                    const {
                        ProxyAgent,
                        EnvHttpProxyAgent,
                        request,
                        interceptors,
                    } = undici;
                    const allowH2 = opts.allowH2 !== false;
                    const agentOpts = {
                        connect: {
                            rejectUnauthorized:
                                opts.strictSSL === false ||
                                opts.insecure === true ||
                                opts.rejectUnauthorized === false
                                    ? false
                                    : true,
                            allowH2,
                        },
                        bodyTimeout: opts.timeout,
                        headersTimeout: opts.timeout,
                        maxHeaderSize,
                        allowH2,
                    };
                    const tlsOptions = {
                        rejectUnauthorized:
                            agentOpts.connect.rejectUnauthorized,
                        allowH2,
                    };
                    opts.tls = {
                        ...(opts.tls || {}),
                        ...tlsOptions,
                    };
                    try {
                        const url = new URL(opts.url);
                        if (url.username || url.password) {
                            opts.headers = {
                                ...(opts.headers || {}),
                                Authorization: `Basic ${Buffer.from(
                                    `${decodeURIComponent(
                                        url.username,
                                    )}:${decodeURIComponent(url.password)}`,
                                ).toString('base64')}`,
                            };
                        }
                        opts.headers = normalizeNodeRequestHeaders(
                            opts.headers,
                        );
                        let dispatcher;
                        if (!opts.proxy) {
                            const allProxy =
                                eval('process.env.all_proxy') ||
                                eval('process.env.ALL_PROXY');
                            if (allProxy && /^socks5:\/\//.test(allProxy)) {
                                opts.proxy = allProxy;
                            }
                        }
                        if (opts.proxy) {
                            if (/^socks5:\/\//.test(opts.proxy)) {
                                dispatcher = socksDispatcher(
                                    parseSocks5Uri(opts.proxy),
                                    {
                                        ...agentOpts,
                                        requestTls: tlsOptions,
                                    },
                                );
                            } else {
                                dispatcher = new ProxyAgent({
                                    ...agentOpts,
                                    uri: opts.proxy,
                                    requestTls: tlsOptions,
                                    proxyTunnel: opts.proxyTunnel,
                                });
                            }
                        } else {
                            dispatcher = new EnvHttpProxyAgent({
                                ...agentOpts,
                                requestTls: tlsOptions,
                                proxyTunnel: opts.proxyTunnel,
                            });
                        }
                        request(opts.url, {
                            ...opts,
                            method: method.toUpperCase(),
                            dispatcher: dispatcher.compose(
                                interceptors.redirect({
                                    maxRedirections: 3,
                                    throwOnMaxRedirect: true,
                                }),
                                interceptors.decompress({
                                    skipErrorResponses: false,
                                }),
                            ),
                        })
                            .then(async (response) => {
                                const responseBody =
                                    opts.encoding === null
                                        ? await response.body.arrayBuffer()
                                        : await response.body.text();

                                resolve({
                                    statusCode: response.statusCode,
                                    headers: response.headers,
                                    body: responseBody,
                                    requestId,
                                });
                            })
                            .catch(reject);
                    } catch (e) {
                        reject(e);
                    }
                    /* @non-surge-end */
                } else {
                    if (isSurge || isEgern || isStash || isShadowRocket) {
                        opts.timeout = Math.ceil(opts.timeout / 1000);
                    }

                    // $.info(`🍉 [${requestId}] before http`);
                    // $.info(
                    //     `🍉 [${requestId}] opts.timeout =`,
                    //     opts.timeout,
                    // );

                    // $.info(
                    //     `🍉 [${requestId}] method =`,
                    //     method.toUpperCase(),
                    // );
                    // const httpClientTs = Date.now();
                    try {
                        $httpClient[method.toLowerCase()](
                            opts,
                            (err, response, body) => {
                                // $.info(
                                //     ` [${requestId}] callback ${
                                //         Date.now() - httpClientTs
                                //     }ms`,
                                // );

                                if (err) {
                                    reject(err);
                                    return;
                                }

                                resolve({
                                    statusCode:
                                        response?.status ||
                                        response?.statusCode,
                                    headers: response?.headers || {},
                                    body,
                                    requestId,
                                });
                            },
                        );
                    } catch (e) {
                        reject(e);
                    }
                }
            });
        } else if (isGUIforCores) {
            /* @non-surge-start */
            worker = new Promise(async (resolve, reject) => {
                try {
                    const response = await $Plugins.Requests({
                        method,
                        url: options.url,
                        headers: options.headers,
                        body: options.body,
                        autoTransformBody: false,
                        options: {
                            Proxy: options.proxy,
                            Timeout: options.timeout
                                ? options.timeout / 1000
                                : 15,
                        },
                    });
                    resolve({
                        statusCode: response.status,
                        headers: response.headers,
                        body: response.body,
                        requestId,
                    });
                } catch (error) {
                    reject(error);
                }
            });
            /* @non-surge-end */
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let settling = false;
            let timeoutid = null;

            const cleanup = () => {
                if (timeoutid !== null) {
                    clearTimeout(timeoutid);
                    timeoutid = null;
                }
            };

            const resolveOnce = async (value) => {
                if (settled || settling) return;
                settling = true;

                try {
                    await Promise.resolve(events.onResponse(value));
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve({ ...value, requestId });
                } catch (error) {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(error);
                }
            };

            const rejectOnce = (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };

            worker.then(
                async (value) => {
                    // $.info(`🍉 [${requestId}] worker resolved`);
                    await resolveOnce(value);
                },
                (error) => {
                    rejectOnce(error);
                },
            );

            if (timeout) {
                timeoutid = setTimeout(() => {
                    if (settled) {
                        return;
                    }

                    try {
                        events.onTimeout();
                    } catch (e) {}

                    rejectOnce(
                        new Error(
                            `${method} URL: ${options.url} exceeds the timeout ${timeout} ms`,
                        ),
                    );
                }, timeout);
            }
        });
    }

    const http = {
        request: (options) => send(options.method || 'GET', options),
    };
    methods.forEach(
        (method) =>
            (http[method.toLowerCase()] = (options) => send(method, options)),
    );
    return http;
}
