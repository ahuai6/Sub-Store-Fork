import { SETTINGS_KEY, FILES_KEY, MODULES_KEY } from '@/constants';
import { HTTP, ENV } from '@/vendor/open-api';
import { hex_md5 } from '@/vendor/md5';
import { getPolicyDescriptor } from '@/utils';
import resourceCache from '@/utils/resource-cache';
import headersResourceCache from '@/utils/headers-resource-cache';
import {
    getFlowField,
    getFlowHeaders,
    parseFlowHeaders,
    validCheck,
} from '@/utils/flow';
import $ from '@/core/app';
import { findByName } from '@/utils/database';
import { produceArtifact } from '@/restful/sync';
import PROXY_PREPROCESSORS from '@/core/proxy-utils/preprocessors';
import { ProxyUtils } from '@/core/proxy-utils';
import { runBackendRequestTask } from '@/utils/request-concurrency';
import getFs from '@/runtime/fs';
import getStreamPromises from '@/runtime/stream-promises';
import {
    AGE_SECRET_KEY,
    decryptArmorIfPresent,
    maskAgeSecretInUrl,
} from '@/utils/age';

const clashPreprocessor = PROXY_PREPROCESSORS.find(
    (processor) => processor.name === 'Clash Pre-processor',
);

const tasks = new Map();

function buildDownloadRegex(pattern = '') {
    const trimmed = `${pattern}`.trim();
    if (!trimmed) return null;
    return new RegExp(trimmed, 'i');
}

function maybePrefixGithubProxyUrl(url, githubProxy, githubProxyRegex) {
    if (!githubProxy || !githubProxyRegex || typeof url !== 'string') {
        return url;
    }

    if (!/^https?:\/\//i.test(url)) {
        return url;
    }

    const prefix = `${githubProxy}/`;
    if (url.startsWith(prefix)) {
        return url;
    }

    let regex;
    try {
        regex = buildDownloadRegex(githubProxyRegex);
    } catch (e) {
        $.error(`GitHub 加速代理匹配正则无效: ${e.message ?? e}`);
        return url;
    }

    if (!regex?.test(url)) {
        return url;
    }

    $.info(`GitHub 加速代理命中下载链接: ${url}`);
    return `${githubProxy}/${url}`;
}

function maskDownloadUrl(url) {
    return maskAgeSecretInUrl(url);
}

async function finalizeDownloadedBody(
    body,
    {
        ageSecretKey,
        preprocess,
        validateProxies = true,
        deferPreprocess = false,
        url,
    },
) {
    let result = ageSecretKey
        ? await decryptArmorIfPresent(body, ageSecretKey)
        : body;
    const raw = result;

    if (preprocess && deferPreprocess) {
        return {
            result,
            raw,
            proxies: null,
            shouldCache: true,
        };
    }

    if (preprocess) {
        try {
            if (clashPreprocessor.test(result)) {
                result = clashPreprocessor.parse(result, true);
            }
        } catch (e) {
            $.error(`Clash Pre-processor error: ${e}`);
        }
    }

    let proxies = null;
    if (preprocess && validateProxies) {
        try {
            proxies = ProxyUtils.parse(result);
            if (!Array.isArray(proxies) || proxies.length === 0) {
                return {
                    result,
                    raw,
                    proxies: null,
                    shouldCache: false,
                    cacheReason: `URL ${url} 不包含有效节点, 不缓存`,
                };
            }
        } catch (e) {
            return {
                result,
                raw,
                proxies: null,
                shouldCache: false,
                cacheReason: `URL ${url} 尝试解析节点失败 ${
                    e.message ?? e
                }, 不缓存`,
            };
        }
    }

    return {
        result,
        raw,
        proxies,
        shouldCache: true,
    };
}

function formatDownloadResult(finalized, returnRawOrOptions) {
    const returnRaw =
        typeof returnRawOrOptions === 'boolean'
            ? returnRawOrOptions
            : Boolean(returnRawOrOptions?.returnRaw);
    const returnParsed =
        typeof returnRawOrOptions === 'object' &&
        Boolean(returnRawOrOptions?.returnParsed);
    if (returnRaw || returnParsed) {
        const out = { result: finalized.result, raw: finalized.raw };
        if (returnParsed) {
            out.proxies = finalized.proxies ?? null;
        }
        return out;
    }
    return finalized.result;
}

function formatPlainDownloadResult(result, returnRawOrOptions) {
    const returnRaw =
        typeof returnRawOrOptions === 'boolean'
            ? returnRawOrOptions
            : Boolean(returnRawOrOptions?.returnRaw);
    const returnParsed =
        typeof returnRawOrOptions === 'object' &&
        Boolean(returnRawOrOptions?.returnParsed);
    if (returnRaw || returnParsed) {
        const out = { result, raw: result };
        if (returnParsed) {
            out.proxies = null;
        }
        return out;
    }
    return result;
}

export default async function download(
    rawUrl = '',
    ua,
    timeout,
    customProxy,
    skipCustomCache,
    awaitCustomCache,
    noCache,
    preprocess,
    options = {},
) {
    let $arguments = {};
    let url = rawUrl.replace(/#noFlow$/, '');
    const rawArgs = url.split('#');
    url = url.split('#')[0];
    if (rawArgs.length > 1) {
        try {
            // 支持 `#${encodeURIComponent(JSON.stringify({arg1: "1"}))}`
            $arguments = JSON.parse(decodeURIComponent(rawArgs[1]));
        } catch (e) {
            for (const pair of rawArgs[1].split('&')) {
                const key = pair.split('=')[0];
                const value = pair.split('=')[1];
                // 部分兼容之前的逻辑 const value = pair.split('=')[1] || true;
                $arguments[key] =
                    value == null || value === ''
                        ? true
                        : decodeURIComponent(value);
            }
        }
    }
    const explicitAgeSecretKey =
        options && typeof options === 'object'
            ? options?.[AGE_SECRET_KEY] || options?.ageSecretKey
            : undefined;
    const returnRaw =
        options && typeof options === 'object' && options.returnRaw;
    const returnParsed =
        options && typeof options === 'object' && Boolean(options.returnParsed);
    const deferPreprocess =
        options &&
        typeof options === 'object' &&
        Boolean(options.deferPreprocess);
    const formatOptions = { returnRaw, returnParsed };
    const ageSecretKey = explicitAgeSecretKey || $arguments?.[AGE_SECRET_KEY];
    const { isNode, isStash, isLoon, isShadowRocket, isQX } = ENV();
    const {
        githubProxy,
        githubProxyRegex,
        defaultProxy,
        defaultUserAgent,
        defaultFlowUserAgent,
        defaultTimeout,
        cacheThreshold: defaultCacheThreshold,
    } = $.read(SETTINGS_KEY) || {};
    const cacheThreshold = defaultCacheThreshold || 1024;
    let proxy = customProxy || defaultProxy;
    if ($.env.isNode) {
        /* @non-surge-start */
        proxy = proxy || eval('process.env.SUB_STORE_BACKEND_DEFAULT_PROXY');
        /* @non-surge-end */
    }
    const userAgent = ua || defaultUserAgent || 'clash.meta/v1.19.23';
    let customHeaders;
    if ($arguments?.headers) {
        try {
            const parsed = JSON.parse($arguments?.headers);
            if (
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed) &&
                Object.keys(parsed).length > 0
            ) {
                const lowerCaseHeaders = { 'user-agent': userAgent };
                for (const key in parsed) {
                    lowerCaseHeaders[key.toLowerCase()] = parsed[key];
                }
                customHeaders = lowerCaseHeaders;
            }
        } catch (e) {
            $.error(`解析自定义 headers 失败: ${e}`);
        }
    }

    const requestTimeout = timeout || defaultTimeout || 8000;
    const originalUrl = url;
    url = maybePrefixGithubProxyUrl(url, githubProxy, githubProxyRegex);
    const safeUrl = maskDownloadUrl(url);
    const id = hex_md5(
        `${customHeaders ? JSON.stringify(customHeaders) : userAgent}${url}`,
    );

    if ($arguments?.cacheKey === true) {
        $.error(`使用自定义缓存时 cacheKey 的值不能为空`);
        $arguments.cacheKey = undefined;
    }

    const customCacheKey = $arguments?.cacheKey
        ? `#sub-store-cached-custom-${$arguments?.cacheKey}`
        : undefined;

    if (customCacheKey && !skipCustomCache) {
        const customCached = $.read(customCacheKey);
        const cached = resourceCache.get(id);
        if (!noCache && !$arguments?.noCache && cached) {
            $.info(
                `乐观缓存: URL ${safeUrl}\n存在有效的常规缓存\n使用常规缓存以避免重复请求`,
            );
            return formatDownloadResult(
                await finalizeDownloadedBody(cached, {
                    ageSecretKey,
                    preprocess,
                    validateProxies: false,
                    deferPreprocess,
                    url: safeUrl,
                }),
                formatOptions,
            );
        }
        if (customCached) {
            if (awaitCustomCache) {
                $.info(`乐观缓存: URL ${safeUrl}\n本次进行请求 尝试更新缓存`);
                try {
                    await download(
                        rawUrl.replace(/(\?|&)cacheKey=.*?(&|$)/, ''),
                        ua,
                        timeout,
                        proxy,
                        true,
                        undefined,
                        undefined,
                        preprocess,
                        options,
                    );
                } catch (e) {
                    $.error(
                        `乐观缓存: URL ${safeUrl} 更新缓存发生错误 ${
                            e.message ?? e
                        }`,
                    );
                    $.info('使用乐观缓存的数据刷新缓存, 防止后续请求');
                    resourceCache.set(id, customCached);
                }
            } else {
                $.info(
                    `乐观缓存: URL ${safeUrl}\n本次返回自定义缓存 ${$arguments?.cacheKey}\n并进行请求 尝试异步更新缓存`,
                );
                download(
                    rawUrl.replace(/(\?|&)cacheKey=.*?(&|$)/, ''),
                    ua,
                    timeout,
                    proxy,
                    true,
                    undefined,
                    undefined,
                    preprocess,
                    options,
                ).catch((e) => {
                    $.error(
                        `乐观缓存: URL ${safeUrl} 异步更新缓存发生错误 ${
                            e.message ?? e
                        }`,
                    );
                });
            }
            return formatDownloadResult(
                await finalizeDownloadedBody(customCached, {
                    ageSecretKey,
                    preprocess,
                    validateProxies: false,
                    deferPreprocess,
                    url: safeUrl,
                }),
                formatOptions,
            );
        }
    }

    const downloadUrlMatch = url
        .split('#')[0]
        .match(/^\/api\/(file|module)\/(.+)/);
    if (downloadUrlMatch) {
        let type = '';
        try {
            type = downloadUrlMatch?.[1];
            let name = downloadUrlMatch?.[2];
            if (name == null) {
                throw new Error(`本地 ${type} URL 无效: ${url}`);
            }
            name = decodeURIComponent(name);
            const key = type === 'module' ? MODULES_KEY : FILES_KEY;
            const item = findByName($.read(key), name);
            if (!item) {
                throw new Error(`找不到 ${type}: ${name}`);
            }

            if (type === 'module') {
                return formatPlainDownloadResult(item.content, formatOptions);
            } else {
                return formatPlainDownloadResult(
                    await produceArtifact({
                        type: 'file',
                        name,
                        noFlow: options?.noFlow,
                    }),
                    formatOptions,
                );
            }
        } catch (err) {
            $.error(
                `Error when loading ${type}: ${
                    url.split('#')[0]
                }.\n Reason: ${err}`,
            );
            throw new Error(`无法加载 ${type}: ${url}`);
        }
    } else if (url?.startsWith('/')) {
        /* @non-surge-start */
        try {
            const fs = getFs();
            return formatPlainDownloadResult(
                fs.readFileSync(url.split('#')[0], 'utf8'),
                formatOptions,
            );
        } catch (err) {
            $.error(
                `Error when reading local file: ${
                    url.split('#')[0]
                }.\n Reason: ${err}`,
            );
            throw new Error(`无法从该路径读取文本内容: ${url}`);
        }
        /* @non-surge-end */
    }

    if (!isNode && tasks.has(id)) {
        return formatDownloadResult(
            await finalizeDownloadedBody(await tasks.get(id), {
                ageSecretKey,
                preprocess,
                validateProxies: false,
                deferPreprocess,
                url: safeUrl,
            }),
            formatOptions,
        );
    }

    const http = HTTP({
        headers: {
            ...(customHeaders || { 'User-Agent': userAgent }),
            ...(isStash && proxy
                ? { 'X-Stash-Selected-Proxy': encodeURIComponent(proxy) }
                : {}),
            ...(isShadowRocket && proxy ? { 'X-Surge-Policy': proxy } : {}),
        },
        timeout: requestTimeout,
    });

    let result;
    let rawResult;

    // try to find in app cache
    const cached = resourceCache.get(id);
    if (!noCache && !$arguments?.noCache && cached) {
        $.info(
            `使用缓存: ${safeUrl}, ${
                customHeaders ? JSON.stringify(customHeaders) : userAgent
            }`,
        );
        rawResult = cached;
        result = await finalizeDownloadedBody(cached, {
            ageSecretKey,
            preprocess,
            validateProxies: false,
            deferPreprocess,
            url: safeUrl,
        });
        if (customCacheKey) {
            $.info(`URL ${safeUrl}\n写入自定义缓存 ${$arguments?.cacheKey}`);
            $.write(cached, customCacheKey);
        }
    } else {
        const insecure = $arguments?.insecure
            ? isNode
                ? { strictSSL: false }
                : { insecure: true }
            : undefined;
        $.info(
            `Downloading...\n${
                customHeaders
                    ? JSON.stringify(customHeaders)
                    : `User-Agent: ${userAgent}`
            }\nTimeout: ${requestTimeout}\nProxy: ${proxy}\nInsecure: ${!!insecure}\nPreprocess: ${preprocess}\nURL: ${safeUrl}`,
        );
        try {
            let { body, headers, statusCode } = await runBackendRequestTask(
                () =>
                    http.get({
                        url,
                        ...(proxy ? { proxy } : {}),
                        ...(isLoon && proxy ? { node: proxy } : {}),
                        ...(isQX && proxy ? { opts: { policy: proxy } } : {}),
                        ...(proxy ? getPolicyDescriptor(proxy) : {}),
                        ...(insecure ? insecure : {}),
                    }),
                'download',
            );
            $.info(`statusCode: ${statusCode}`);
            if (statusCode < 200 || statusCode >= 400) {
                throw new Error(`statusCode: ${statusCode}`);
            }

            if (headers) {
                const flowInfo = getFlowField(headers);
                if (flowInfo) {
                    const flowTtl = $arguments?.headersCacheTtl
                        ? $arguments?.headersCacheTtl * 1000
                        : undefined;
                    headersResourceCache.set(id, flowInfo, flowTtl);
                    if (
                        !customHeaders &&
                        !$arguments?.flowUserAgent &&
                        !$arguments?.flowUrl &&
                        !$arguments?.flowHeaders
                    ) {
                        const flowUserAgent =
                            defaultFlowUserAgent || 'clash.meta/v1.19.23';
                        const defaultFlowId = hex_md5(
                            `${flowUserAgent}${originalUrl}`,
                        );
                        if (defaultFlowId !== id) {
                            headersResourceCache.set(
                                defaultFlowId,
                                flowInfo,
                                flowTtl,
                            );
                        }
                    }
                }
            }
            if (body.replace(/\s/g, '').length === 0)
                throw new Error(new Error('远程资源内容为空'));
            result = await finalizeDownloadedBody(body, {
                ageSecretKey,
                preprocess,
                validateProxies: true,
                deferPreprocess: false,
                url: safeUrl,
            });
            let shouldCache = true;
            if (cacheThreshold) {
                const size = body.length / 1024;
                if (size > cacheThreshold) {
                    $.info(
                        `资源大小 ${size.toFixed(
                            2,
                        )} KB 超过了 ${cacheThreshold} KB, 不缓存`,
                    );
                    shouldCache = false;
                }
            }
            if (!result.shouldCache) {
                $.error(result.cacheReason);
                shouldCache = false;
            }
            if (shouldCache) {
                resourceCache.set(
                    id,
                    body,
                    $arguments?.cacheTtl
                        ? $arguments?.cacheTtl * 1000
                        : undefined,
                );
                if (customCacheKey) {
                    $.info(
                        `URL ${safeUrl}\n写入自定义缓存 ${$arguments?.cacheKey}`,
                    );
                    $.write(body, customCacheKey);
                }
            }

            rawResult = body;
        } catch (e) {
            if (customCacheKey) {
                const cached = $.read(customCacheKey);
                if (cached) {
                    $.info(
                        `无法下载 URL ${safeUrl}: ${
                            e.message ?? e
                        }\n使用自定义缓存 ${$arguments?.cacheKey}`,
                    );
                    return formatDownloadResult(
                        await finalizeDownloadedBody(cached, {
                            ageSecretKey,
                            preprocess,
                            validateProxies: false,
                            deferPreprocess,
                            url: safeUrl,
                        }),
                        formatOptions,
                    );
                }
            }
            const message = `无法下载 URL ${safeUrl}: ${e.message ?? e}`;
            $.error(message);
            throw new Error(message);
        }
    }

    // 检查订阅有效性

    if ($arguments?.validCheck && !$arguments?.noFlow && !options?.noFlow) {
        await validCheck(
            parseFlowHeaders(
                await getFlowHeaders(
                    url,
                    $arguments.flowUserAgent,
                    undefined,
                    proxy,
                    $arguments.flowUrl,
                    $arguments.flowHeaders,
                ),
            ),
        );
    }

    if (!isNode) {
        tasks.set(id, rawResult);
    }
    return formatDownloadResult(result, formatOptions);
}

export async function downloadFile(url, file) {
    /* @non-surge-start */
    const undici = eval("require('undici')");
    const fs = getFs();
    const { pipeline } = getStreamPromises();
    const { Agent, interceptors, request } = undici;
    $.info(`Downloading file...\nURL: ${url}\nFile: ${file}`);
    const { body, statusCode } = await request(url, {
        dispatcher: new Agent().compose(
            interceptors.redirect({
                maxRedirections: 3,
                throwOnMaxRedirect: true,
            }),
        ),
    });
    if (statusCode !== 200)
        throw new Error(`Failed to download file from ${url}`);
    const fileStream = fs.createWriteStream(file);
    await pipeline(body, fileStream);
    $.info(`File downloaded from ${url} to ${file}`);
    return file;
    /* @non-surge-end */
}
