import {
    SETTINGS_KEY,
    ARTIFACT_REPOSITORY_KEY,
    GIST_DOWNLOAD_TOKEN_STRATEGIES,
} from '@/constants';
import { success, failed } from './response';
import { InternalServerError, RequestInvalidError } from '@/restful/errors';
import $ from '@/core/app';
import Gist, { getGithubGistBaseURL } from '@/utils/gist';
import { clearLogSettingsCache } from '@/utils/debug-logs';
import {
    BACKEND_REQUEST_CONCURRENCY_SETTING,
    BACKEND_REQUEST_CONCURRENCY_WAIT_TIME_SETTING,
} from '@/utils/request-concurrency';
import {
    AGE_SECRET_KEY,
    normalizeAgeSecretKeyConfig,
} from '@/utils/age';

const ARTIFACT_STORE_SETTING_KEYS = [
    'gistToken',
    'githubProxy',
    'githubApiUrl',
    'defaultProxy',
];

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
}

// Seconds. ttlFromSetting disables a cache when the key is present and the
// value is not a positive finite number, and uses the default only when the
// key is absent. Empty / invalid input drops the key (default). Zero stays
// stored so the cache stays off. A negative is stored as zero: ttlFromSetting
// already treats it as disabled, and the request is not rejected.
//
// The upstream settings page (nut-input type="number") submits strings. A
// string zero is stored as "0", not the number 0. The page reads the value
// back with `value || ""`, which turns a numeric 0 into an empty field and
// would clear the key on the next save. "0" still displays, and
// Number("0") === 0, so the cache is disabled. Positive values are kept as
// submitted, including a numeric string such as "120".
function normalizeCacheTtlSetting(raw) {
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) return undefined;
        if (raw > 0) return raw;
        return 0;
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed === '') return undefined;
        const value = Number(trimmed);
        if (!Number.isFinite(value)) return undefined;
        if (value > 0) return raw;
        return '0';
    }
    return undefined;
}

function shouldValidateGistAgeSecretKey(settings, body = {}) {
    return (
        body.gistUpload === 'age' ||
        (settings?.gistUpload === 'age' &&
            hasOwn(body, AGE_SECRET_KEY))
    );
}

async function normalizeAndValidateGistAgeSecretKey(settings) {
    await normalizeAgeSecretKeyConfig(settings);

    const ageSecretKey = settings[AGE_SECRET_KEY];
    if (!ageSecretKey) {
        throw new RequestInvalidError(
            'INVALID_GIST_AGE_KEYS',
            'age 加密模式需要配置 age-secret-key',
        );
    }
}

export function shouldRefreshArtifactStoreForSettingsPatch(body = {}) {
    return ARTIFACT_STORE_SETTING_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(body, key),
    );
}

export function getGithubAvatarApiUrl({ username, githubApiUrl, githubProxy }) {
    const githubApiBaseURL = getGithubGistBaseURL({
        githubApiUrl,
        githubProxy,
    });

    return `${githubApiBaseURL}/users/${encodeURIComponent(username)}`;
}

export default function register($app) {
    const settings = $.read(SETTINGS_KEY);
    if (!settings) $.write({}, SETTINGS_KEY);
    $app.route('/api/settings').get(getSettings).patch(updateSettings);
}

async function getSettings(req, res) {
    try {
        let settings = $.read(SETTINGS_KEY);
        if (!settings) {
            settings = {};
            $.write(settings, SETTINGS_KEY);
        }

        // await updateAvatar();
        if (!settings.artifactStore) await updateArtifactStore();

        success(res, settings);
    } catch (e) {
        $.error(`Failed to get settings: ${e.message ?? e}`);
        failed(
            res,
            new InternalServerError(
                `FAILED_TO_GET_SETTINGS`,
                `Failed to get settings`,
                `Reason: ${e.message ?? e}`,
            ),
        );
    }
}

async function updateSettings(req, res) {
    try {
        const settings = $.read(SETTINGS_KEY) || {};
        const newSettings = {
            ...settings,
            ...req.body,
        };
        for (const key of ['githubUser', 'gistToken']) {
            if (typeof newSettings[key] === 'string') {
                newSettings[key] = newSettings[key].trim();
            }
        }
        if (isPlainObject(req.body?.appearanceSetting)) {
            newSettings.appearanceSetting = {
                ...(isPlainObject(settings?.appearanceSetting)
                    ? settings.appearanceSetting
                    : {}),
                ...req.body.appearanceSetting,
            };
        }
        [
            'defaultTimeout',
            'githubApiTimeout',
            'artifactSyncBatchSize',
            'cacheThreshold',
        ].map((key) => {
            let value = Number(newSettings[key]);
            if (!isFinite(value) || value <= 0) {
                delete newSettings[key];
            }
        });
        for (const key of [
            'resourceCacheTtl',
            'headersCacheTtl',
            'scriptCacheTtl',
        ]) {
            if (!hasOwn(newSettings, key)) continue;
            const normalized = normalizeCacheTtlSetting(newSettings[key]);
            if (normalized === undefined) {
                delete newSettings[key];
            } else {
                newSettings[key] = normalized;
            }
        }
        if ('logsMaxCount' in newSettings) {
            const rawLogsMaxCount = newSettings.logsMaxCount;
            const value = Number(rawLogsMaxCount);
            if (
                rawLogsMaxCount === null ||
                rawLogsMaxCount === undefined ||
                rawLogsMaxCount === '' ||
                !isFinite(value) ||
                value < 0
            ) {
                delete newSettings.logsMaxCount;
            }
        }
        if (BACKEND_REQUEST_CONCURRENCY_SETTING in newSettings) {
            const rawConcurrency =
                newSettings[BACKEND_REQUEST_CONCURRENCY_SETTING];
            const value = Number(rawConcurrency);
            if (
                rawConcurrency === null ||
                rawConcurrency === undefined ||
                rawConcurrency === '' ||
                !Number.isInteger(value) ||
                value < 1
            ) {
                delete newSettings[BACKEND_REQUEST_CONCURRENCY_SETTING];
            }
        }
        if (BACKEND_REQUEST_CONCURRENCY_WAIT_TIME_SETTING in newSettings) {
            const rawWaitTime =
                newSettings[BACKEND_REQUEST_CONCURRENCY_WAIT_TIME_SETTING];
            const value = Number(rawWaitTime);
            if (
                rawWaitTime === null ||
                rawWaitTime === undefined ||
                rawWaitTime === '' ||
                !Number.isInteger(value) ||
                value < 0
            ) {
                delete newSettings[
                    BACKEND_REQUEST_CONCURRENCY_WAIT_TIME_SETTING
                ];
            }
        }
        if (shouldValidateGistAgeSecretKey(newSettings, req.body)) {
            await normalizeAndValidateGistAgeSecretKey(newSettings);
        }
        if (
            hasOwn(req.body, 'gistDownloadTokenStrategy') &&
            !GIST_DOWNLOAD_TOKEN_STRATEGIES.includes(
                req.body.gistDownloadTokenStrategy,
            )
        ) {
            throw new RequestInvalidError(
                'INVALID_GIST_DOWNLOAD_TOKEN_STRATEGY',
                'Token 处理方式仅支持 ask、overwrite 或 keep',
            );
        }
        $.write(newSettings, SETTINGS_KEY);
        clearLogSettingsCache();
        if (shouldRefreshArtifactStoreForSettingsPatch(req.body)) {
            // await updateAvatar();
            await updateArtifactStore();
        }
        success(res, newSettings);
    } catch (e) {
        $.error(`Failed to update settings: ${e.message ?? e}`);
        failed(
            res,
            e instanceof RequestInvalidError
                ? e
                : new InternalServerError(
                      `FAILED_TO_UPDATE_SETTINGS`,
                      `Failed to update settings`,
                      `Reason: ${e.message ?? e}`,
                  ),
        );
    }
}

export async function updateAvatar() {
    const settings = $.read(SETTINGS_KEY) || {};
    const {
        githubUser: username,
        syncPlatform,
        githubProxy,
        githubApiUrl,
        githubApiTimeout,
    } = settings;
    if (username) {
        if (syncPlatform === 'gitlab') {
            try {
                const data = await $.http
                    .get({
                        url: `https://gitlab.com/api/v4/users?username=${encodeURIComponent(
                            username,
                        )}`,
                        headers: {
                            'User-Agent':
                                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.141 Safari/537.36',
                        },
                        timeout: githubApiTimeout || 10000,
                    })
                    .then((resp) => JSON.parse(resp.body));
                settings.avatarUrl = data[0]['avatar_url'].replace(
                    /(\?|&)s=\d+(&|$)/,
                    '$1s=160$2',
                );
                $.write(settings, SETTINGS_KEY);
            } catch (err) {
                $.error(
                    `Failed to fetch GitLab avatar for User: ${username}. Reason: ${
                        err.message ?? err
                    }`,
                );
            }
        } else {
            try {
                const data = await $.http
                    .get({
                        url: getGithubAvatarApiUrl({
                            username,
                            githubApiUrl,
                            githubProxy,
                        }),
                        headers: {
                            'User-Agent':
                                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.141 Safari/537.36',
                        },
                        timeout: githubApiTimeout || 10000,
                    })
                    .then((resp) => JSON.parse(resp.body));
                settings.avatarUrl = data['avatar_url'];
                $.write(settings, SETTINGS_KEY);
            } catch (err) {
                $.error(
                    `Failed to fetch GitHub avatar for User: ${username}. Reason: ${
                        err.message ?? err
                    }`,
                );
            }
        }
    }
}

export async function updateArtifactStore() {
    $.log('Updating artifact store');
    const settings = $.read(SETTINGS_KEY) || {};
    const { gistToken, syncPlatform } = settings;
    if (gistToken) {
        const manager = new Gist({
            token: gistToken,
            key: ARTIFACT_REPOSITORY_KEY,
            syncPlatform,
        });

        try {
            const gist = await manager.locate();
            const url = gist?.html_url ?? gist?.web_url;
            if (url) {
                $.log(`找到 Sub-Store Gist: ${url}`);
                // 只需要保证 token 是对的, 现在 username 错误只会导致头像错误
                settings.artifactStore = url;
                settings.artifactStoreStatus = 'VALID';
            } else {
                $.error(`找不到 Sub-Store Gist (${ARTIFACT_REPOSITORY_KEY})`);
                settings.artifactStoreStatus = 'NOT FOUND';
            }
        } catch (err) {
            $.error(
                `查找 Sub-Store Gist (${ARTIFACT_REPOSITORY_KEY}) 时发生错误: ${
                    err.message ?? err
                }`,
            );
            settings.artifactStoreStatus = 'ERROR';
        }
        $.write(settings, SETTINGS_KEY);
    }
}
