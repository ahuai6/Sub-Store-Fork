import { InternalServerError } from './errors';
import { ProxyUtils } from '@/core/proxy-utils';
import { findByName } from '@/utils/database';
import { success, failed } from './response';
import download from '@/utils/download';
import { SUBS_KEY } from '@/constants';
import $ from '@/core/app';
import {
    handleIgnoreFailedRemoteSubError,
    notifyIgnoreFailedRemoteSubFallback,
    resolveIgnoreFailedRemoteSubMode,
    shouldFallbackIgnoreFailedRemoteSub,
    shouldNotifyIgnoreFailedRemoteSub,
} from '@/restful/ignore-failed-remote-sub';
import {
    prepareMihomoProfileContent,
    resolveFileRawContent,
} from '@/restful/sync';
import { normalizeClashYaml } from '@/core/proxy-utils/preprocessors';
import { maskAgeSecretInUrl } from '@/utils/age';
import { isMihomoConfigFile, normalizeFileConfig } from '@/utils/file-type';
import { heavyRequestKey, shareResponse } from '@/utils/inflight';
import {
    buildOutputMaterial,
    readCachedPreview,
    writeCachedPreview,
} from '@/utils/output-cache';

function formatAgeSafeUrls(errors) {
    return Object.keys(errors).map(maskAgeSecretInUrl).join(', ');
}

export default function register($app) {
    $app.post('/api/preview/sub', compareSub);
    $app.post('/api/preview/collection', compareCollection);
    $app.post('/api/preview/file', previewFile);
}

async function previewFile(req, res) {
    if (req.__forkHeavy !== 'preview-file') {
        req.__forkHeavy = 'preview-file';
        return shareResponse(
            heavyRequestKey('preview-file', req),
            res,
            () => previewFile(req, res),
            'preview-file',
        );
    }
    try {
        const file = normalizeFileConfig(req.body);
        let content = '';
        if (isMihomoConfigFile(file)) {
            content = await prepareMihomoProfileContent(file, {
                notifyTitle: '🌍 Sub-Store 预览文件失败',
            });
        } else {
            content = await resolveFileRawContent(file, {
                notifyTitle: '🌍 Sub-Store 预览文件失败',
            });
        }
        // parse proxies
        const files = (Array.isArray(content) ? content : [content]).flat();
        let filesContent = files
            .filter((i) => i != null && i !== '')
            .join('\n');

        // apply processors
        const filePreview = {
            original: filesContent,
            processed: '',
        };
        const fileMaterial = buildOutputMaterial({
            kind: 'preview-file',
            raw: filesContent,
            name: file?.name,
            process: file?.process || [],
            noCache: file?.noCache || req.query.noCache,
            noOutputCache: req.query.noOutputCache,
        });
        const cachedFile = readCachedPreview(fileMaterial);
        if (cachedFile) {
            success(res, cachedFile);
            return;
        }
        const processed =
            Array.isArray(file.process) && file.process.length > 0
                ? await ProxyUtils.process(
                      { $files: files, $content: filesContent, $file: file },
                      file.process,
                  )
                : { $content: filesContent, $files: files };

        filePreview.processed = normalizeClashYaml(processed?.$content ?? '');
        writeCachedPreview(fileMaterial, filePreview);
        // produce
        success(res, filePreview);
    } catch (err) {
        $.error(err.message ?? err);
        failed(
            res,
            new InternalServerError(
                `INTERNAL_SERVER_ERROR`,
                `Failed to preview file`,
                `Reason: ${err.message ?? err}`,
            ),
        );
    }
}

async function compareSub(req, res) {
    if (req.__forkHeavy !== 'preview-sub') {
        req.__forkHeavy = 'preview-sub';
        return shareResponse(
            heavyRequestKey('preview-sub', req),
            res,
            () => compareSub(req, res),
            'preview-sub',
        );
    }
    const sub = req.body;
    const mode = resolveIgnoreFailedRemoteSubMode(sub.ignoreFailedRemoteSub);

    try {
        const target = req.query.target || 'JSON';
        let content;
        let sourceRaw;
        if (
            sub.source === 'local' &&
            !['localFirst', 'remoteFirst'].includes(sub.mergeSources)
        ) {
            content = sub.content;
            sourceRaw = sub.content;
        } else {
            const errors = {};
            const downloaded = await Promise.all(
                sub.url
                    .split(/[\r\n]+/)
                    .map((i) => i.trim())
                    .filter((i) => i.length)
                    .map(async (url) => {
                        try {
                            return await download(
                                url,
                                sub.ua,
                                undefined,
                                sub.proxy,
                                undefined,
                                undefined,
                                sub.noCache,
                                true,
                                { returnRaw: true },
                            );
                        } catch (err) {
                            errors[url] = err;
                            $.error(
                                `订阅 ${sub.name} 的远程订阅 ${maskAgeSecretInUrl(
                                    url,
                                )} 发生错误: ${err}`,
                            );
                            return '';
                        }
                    }),
            );
            content = downloaded.map((i) => i.result ?? i);
            sourceRaw = downloaded.map((i) => i.raw ?? i);

            if (Object.keys(errors).length > 0) {
                const message = `订阅 ${
                    sub.name
                } 的远程订阅 ${formatAgeSafeUrls(
                    errors,
                )} 发生错误, 请查看日志`;
                handleIgnoreFailedRemoteSubError({
                    mode,
                    message,
                    notify: () => {
                        $.notify(
                            `🌍 Sub-Store 预览订阅失败`,
                            `❌ ${sub.name}`,
                            message,
                        );
                    },
                });
            }
            if (sub.mergeSources === 'localFirst') {
                content.unshift(sub.content);
                sourceRaw.unshift(sub.content);
            } else if (sub.mergeSources === 'remoteFirst') {
                content.push(sub.content);
                sourceRaw.push(sub.content);
            }
        }
        const previewMaterial = buildOutputMaterial({
            kind: 'preview-sub',
            platform: target,
            raw: sourceRaw,
            name: sub.name,
            displayName: sub.displayName,
            process: sub.process || [],
            source: sub.source,
            mergeSources: sub.mergeSources,
            ignoreFailedRemoteSub: mode,
            noCache: sub.noCache || req.query.noCache,
            noOutputCache: req.query.noOutputCache,
            query: { target },
        });
        const cachedPreview = readCachedPreview(previewMaterial);
        if (cachedPreview) {
            success(res, cachedPreview);
            return;
        }
        // parse proxies
        const original = (Array.isArray(content) ? content : [content])
            .map((i) => ProxyUtils.parse(i))
            .flat();

        // add id
        original.forEach((proxy, i) => {
            proxy.id = i;
            proxy._subName = sub.name;
            proxy._subDisplayName = sub.displayName;
        });

        // apply processors
        const processed = await ProxyUtils.process(
            original,
            sub.process || [],
            target,
            { [sub.name]: sub },
            undefined,
            sourceRaw,
        );

        writeCachedPreview(previewMaterial, { original, processed });
        // produce
        success(res, { original, processed });
    } catch (err) {
        if (shouldFallbackIgnoreFailedRemoteSub(mode)) {
            notifyIgnoreFailedRemoteSubFallback({
                mode,
                error: err,
                notify: (error) => {
                    $.notify(
                        `🌍 Sub-Store 预览订阅失败`,
                        `❌ ${sub.name}`,
                        `🤔 原因：${error.message ?? error}`,
                    );
                },
            });
            $.error(
                `订阅 ${sub.name} 预览启用兜底后返回空结果: ${
                    err.message ?? err
                }`,
            );
            success(res, { original: [], processed: [] });
            return;
        }

        $.error(err.message ?? err);
        failed(
            res,
            new InternalServerError(
                `INTERNAL_SERVER_ERROR`,
                `Failed to preview subscription`,
                `Reason: ${err.message ?? err}`,
            ),
        );
    }
}

async function compareCollection(req, res) {
    if (req.__forkHeavy !== 'preview-collection') {
        req.__forkHeavy = 'preview-collection';
        return shareResponse(
            heavyRequestKey('preview-collection', req),
            res,
            () => compareCollection(req, res),
            'preview-collection',
        );
    }
    const collection = req.body;
    const collectionMode = resolveIgnoreFailedRemoteSubMode(
        collection.ignoreFailedRemoteSub,
    );

    try {
        const allSubs = $.read(SUBS_KEY);
        const subnames = [...collection.subscriptions];
        let subscriptionTags = collection.subscriptionTags;
        if (Array.isArray(subscriptionTags) && subscriptionTags.length > 0) {
            allSubs.forEach((sub) => {
                if (
                    Array.isArray(sub.tag) &&
                    sub.tag.length > 0 &&
                    !subnames.includes(sub.name) &&
                    sub.tag.some((tag) => subscriptionTags.includes(tag))
                ) {
                    subnames.push(sub.name);
                }
            });
        }
        const results = {};
        const errors = {};
        const rawResults = {};
        const pending = {};
        await Promise.all(
            subnames.map(async (name) => {
                const sub = findByName(allSubs, name);
                const subMode = resolveIgnoreFailedRemoteSubMode(
                    sub.ignoreFailedRemoteSub,
                );
                try {
                    let raw;
                    let sourceRaw;
                    if (
                        sub.source === 'local' &&
                        !['localFirst', 'remoteFirst'].includes(
                            sub.mergeSources,
                        )
                    ) {
                        raw = sub.content;
                        sourceRaw = sub.content;
                    } else {
                        const errors = {};
                        const downloaded = await Promise.all(
                            sub.url
                                .split(/[\r\n]+/)
                                .map((i) => i.trim())
                                .filter((i) => i.length)
                                .map(async (url) => {
                                    try {
                                        return await download(
                                            url,
                                            sub.ua,
                                            undefined,
                                            sub.proxy,
                                            undefined,
                                            undefined,
                                            sub.noCache,
                                            true,
                                            { returnRaw: true },
                                        );
                                    } catch (err) {
                                        errors[url] = err;
                                        $.error(
                                            `订阅 ${
                                                sub.name
                                            } 的远程订阅 ${maskAgeSecretInUrl(
                                                url,
                                            )} 发生错误: ${err}`,
                                        );
                                        return '';
                                    }
                                }),
                        );
                        raw = downloaded.map((i) => i.result ?? i);
                        sourceRaw = downloaded.map((i) => i.raw ?? i);

                        if (Object.keys(errors).length > 0) {
                            const message = `订阅 ${
                                sub.name
                            } 的远程订阅 ${formatAgeSafeUrls(
                                errors,
                            )} 发生错误, 请查看日志`;
                            handleIgnoreFailedRemoteSubError({
                                mode: subMode,
                                message,
                                notify: () => {
                                    $.notify(
                                        `🌍 Sub-Store 预览订阅失败`,
                                        `❌ ${sub.name}`,
                                        message,
                                    );
                                },
                            });
                        }
                        if (sub.mergeSources === 'localFirst') {
                            raw.unshift(sub.content);
                            sourceRaw.unshift(sub.content);
                        } else if (sub.mergeSources === 'remoteFirst') {
                            raw.push(sub.content);
                            sourceRaw.push(sub.content);
                        }
                    }
                    const currentRaw = Array.isArray(sourceRaw)
                        ? sourceRaw
                        : [sourceRaw];
                    pending[name] = { raw, sub };
                    rawResults[name] = currentRaw;
                } catch (err) {
                    if (shouldFallbackIgnoreFailedRemoteSub(subMode)) {
                        notifyIgnoreFailedRemoteSubFallback({
                            mode: subMode,
                            error: err,
                            notify: (error) => {
                                $.notify(
                                    `🌍 Sub-Store 预览订阅失败`,
                                    `❌ ${sub.name}`,
                                    `🤔 原因：${error.message ?? error}`,
                                );
                            },
                        });
                        $.error(
                            `订阅 ${sub.name} 在组合订阅预览中启用兜底后返回空结果: ${
                                err.message ?? err
                            }`,
                        );
                        results[name] = [];
                        rawResults[name] = [];
                        return;
                    }

                    errors[name] = err;
                    rawResults[name] = undefined;

                    $.error(
                        `❌ 处理组合订阅 ${collection.name} 中的子订阅: ${sub.name} 时出现错误：${err}！`,
                    );
                }
            }),
        );

        const previewMaterial = buildOutputMaterial({
            kind: 'preview-col',
            platform: 'JSON',
            raw: rawResults,
            name: collection.name,
            displayName: collection.displayName,
            process: collection.process || [],
            subs: subnames.map((subName) => findByName(allSubs, subName)),
            ignoreFailedRemoteSub: collectionMode,
            noCache: collection.noCache || req.query.noCache,
            noOutputCache: req.query.noOutputCache,
        });
        let previewCacheable = Object.keys(errors).length === 0;
        if (previewCacheable) {
            const cachedPreview = readCachedPreview(previewMaterial);
            if (cachedPreview) {
                success(res, cachedPreview);
                return;
            }
        }
        await Promise.all(
            Object.keys(pending).map(async (name) => {
                const { raw, sub } = pending[name];
                try {
                    let currentProxies = (Array.isArray(raw) ? raw : [raw])
                        .map((i) => ProxyUtils.parse(i))
                        .flat();
                    currentProxies.forEach((proxy) => {
                        proxy._subName = sub.name;
                        proxy._subDisplayName = sub.displayName;
                        proxy._collectionName = collection.name;
                        proxy._collectionDisplayName = collection.displayName;
                    });
                    currentProxies = await ProxyUtils.process(
                        currentProxies,
                        sub.process || [],
                        'JSON',
                        { [sub.name]: sub, _collection: collection },
                        undefined,
                        rawResults[name],
                    );
                    results[name] = currentProxies;
                } catch (err) {
                    previewCacheable = false;
                    if (shouldFallbackIgnoreFailedRemoteSub(
                        resolveIgnoreFailedRemoteSubMode(sub.ignoreFailedRemoteSub),
                    )) {
                        notifyIgnoreFailedRemoteSubFallback({
                            mode: resolveIgnoreFailedRemoteSubMode(
                                sub.ignoreFailedRemoteSub,
                            ),
                            error: err,
                            notify: (error) => {
                                $.notify(
                                    `🌍 Sub-Store 预览订阅失败`,
                                    `❌ ${sub.name}`,
                                    `🤔 原因：${error.message ?? error}`,
                                );
                            },
                        });
                        $.error(
                            `订阅 ${sub.name} 在组合订阅预览中启用兜底后返回空结果: ${
                                err.message ?? err
                            }`,
                        );
                        results[name] = [];
                        rawResults[name] = [];
                        return;
                    }
                    errors[name] = err;
                    rawResults[name] = undefined;
                    $.error(
                        `❌ 处理组合订阅 ${collection.name} 中的子订阅: ${sub.name} 时出现错误：${err}！`,
                    );
                }
            }),
        );

        if (Object.keys(errors).length > 0) {
            const message = `组合订阅 ${collection.name} 的子订阅 ${Object.keys(
                errors,
            ).join(', ')} 发生错误, 请查看日志`;
            const notify = () => {
                $.notify(
                    `🌍 Sub-Store 预览组合订阅失败`,
                    `❌ ${collection.name}`,
                    message,
                );
            };
            const hasProcessedSubscriptions = Object.keys(results).length > 0;
            if (
                hasProcessedSubscriptions &&
                shouldFallbackIgnoreFailedRemoteSub(collectionMode)
            ) {
                Object.keys(errors).forEach((name) => {
                    rawResults[name] = [];
                });
                if (shouldNotifyIgnoreFailedRemoteSub(collectionMode)) {
                    notify();
                }
            } else {
                handleIgnoreFailedRemoteSubError({
                    mode: collectionMode,
                    message,
                    notify,
                });
            }
        }
        // merge proxies with the original order
        const original = Array.prototype.concat.apply(
            [],
            subnames.map((name) => results[name] || []),
        );

        original.forEach((proxy, i) => {
            proxy.id = i;
            proxy._collectionName = collection.name;
            proxy._collectionDisplayName = collection.displayName;
        });

        const processed = await ProxyUtils.process(
            original,
            collection.process || [],
            'JSON',
            { _collection: collection },
            undefined,
            rawResults,
        );

        if (previewCacheable) {
            writeCachedPreview(previewMaterial, { original, processed });
        }
        success(res, { original, processed });
    } catch (err) {
        if (shouldFallbackIgnoreFailedRemoteSub(collectionMode)) {
            notifyIgnoreFailedRemoteSubFallback({
                mode: collectionMode,
                error: err,
                notify: (error) => {
                    $.notify(
                        `🌍 Sub-Store 预览组合订阅失败`,
                        `❌ ${collection.name}`,
                        `🤔 原因：${error.message ?? error}`,
                    );
                },
            });
            $.error(
                `组合订阅 ${collection.name} 预览启用兜底后返回空结果: ${
                    err.message ?? err
                }`,
            );
            success(res, { original: [], processed: [] });
            return;
        }

        $.error(err.message ?? err);
        failed(
            res,
            new InternalServerError(
                `INTERNAL_SERVER_ERROR`,
                `Failed to preview collection`,
                `Reason: ${err.message ?? err}`,
            ),
        );
    }
}
