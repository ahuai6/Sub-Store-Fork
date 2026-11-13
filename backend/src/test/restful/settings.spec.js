import { expect } from 'chai';
import { afterEach, describe, it } from 'mocha';

import $ from '@/core/app';
import {
    DEFAULT_CACHE_TTL,
    DEFAULT_HEADERS_CACHE_TTL,
    DEFAULT_SCRIPT_CACHE_TTL,
    SETTINGS_KEY,
} from '@/constants';
import registerSettingsRoutes, {
    getGithubAvatarApiUrl,
    shouldRefreshArtifactStoreForSettingsPatch,
} from '@/restful/settings';
import { AGE_SECRET_KEY, generateKeyPair } from '@/utils/age';
import { ttlFromSetting } from '@/utils/bounded-cache';
import { scriptCheckTtlMs } from '@/utils/check-result-cache';
import Gist from '@/utils/gist';
import headersCache from '@/utils/headers-resource-cache';
import { resourceOutputTtlMs } from '@/utils/output-cache';
import resourceCache from '@/utils/resource-cache';
import scriptCache from '@/utils/script-resource-cache';

function createRouteApp() {
    const handlers = new Map();
    const app = {
        handlers,
        route(pattern) {
            const chain = {};
            chain.get = (handler) => {
                handlers.set(`GET ${pattern}`, handler);
                return chain;
            };
            chain.patch = (handler) => {
                handlers.set(`PATCH ${pattern}`, handler);
                return chain;
            };
            return chain;
        },
    };

    return app;
}

function createResponse(routePath) {
    return {
        body: null,
        req: {
            route: {
                path: routePath,
            },
        },
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
}

describe('settings routes', function () {
    describe('artifact store refresh detection', function () {
        it('refreshes when GitHub API URL changes', function () {
            expect(
                shouldRefreshArtifactStoreForSettingsPatch({
                    githubApiUrl: 'https://litegist.example.com/api',
                }),
            ).to.equal(true);
        });

        it('refreshes when a Gist-affecting setting is cleared', function () {
            expect(
                shouldRefreshArtifactStoreForSettingsPatch({
                    githubProxy: '',
                }),
            ).to.equal(true);
        });

        it('does not refresh for unrelated settings', function () {
            expect(
                shouldRefreshArtifactStoreForSettingsPatch({
                    logsMaxCount: 100,
                }),
            ).to.equal(false);
        });

        it('does not refresh when only GitHub username changes', function () {
            expect(
                shouldRefreshArtifactStoreForSettingsPatch({
                    githubUser: 'xream',
                }),
            ).to.equal(false);
        });
    });

    describe('GitHub avatar API URL', function () {
        it('uses the default GitHub users API when no custom API URL is set', function () {
            expect(
                getGithubAvatarApiUrl({
                    username: 'xream',
                }),
            ).to.equal('https://api.github.com/users/xream');
        });

        it('applies GitHub proxy only to the default GitHub users API', function () {
            expect(
                getGithubAvatarApiUrl({
                    username: 'xream',
                    githubProxy: 'https://proxy.example.com/',
                }),
            ).to.equal(
                'https://proxy.example.com/https://api.github.com/users/xream',
            );
        });

        it('does not apply GitHub proxy to a custom GitHub users API', function () {
            expect(
                getGithubAvatarApiUrl({
                    username: 'xream',
                    githubApiUrl: 'https://litegist.example.com/api/',
                    githubProxy: 'https://proxy.example.com/',
                }),
            ).to.equal('https://litegist.example.com/api/users/xream');
        });
    });

    describe('validated settings', function () {
        const originalRead = $.read.bind($);
        const originalWrite = $.write.bind($);
        const originalLocate = Gist.prototype.locate;

        afterEach(function () {
            $.read = originalRead;
            $.write = originalWrite;
            Gist.prototype.locate = originalLocate;
        });

        async function patchSettings(initialSettings, body) {
            const state = {
                [SETTINGS_KEY]: initialSettings,
            };
            $.read = (key) => state[key];
            $.write = (data, key) => {
                state[key] = data;
                return true;
            };

            const app = createRouteApp();
            registerSettingsRoutes(app);
            const patchHandler = app.handlers.get('PATCH /api/settings');
            const res = createResponse('/api/settings');

            await patchHandler({ body }, res);

            return {
                res,
                settings: state[SETTINGS_KEY],
            };
        }

        it('trims GitHub credentials before saving and refreshing the artifact store', async function () {
            let authorization;
            Gist.prototype.locate = async function () {
                authorization = this.headers.Authorization;
                return { html_url: 'https://gist.example.com/artifacts' };
            };

            const { res, settings } = await patchSettings(
                {},
                {
                    githubUser: ' \t\nexample-user\u3000 ',
                    gistToken: ' \r\nexample-token\t\u00a0',
                },
            );

            expect(res.body.status).to.equal('success');
            expect(settings.githubUser).to.equal('example-user');
            expect(settings.gistToken).to.equal('example-token');
            expect(res.body.data.githubUser).to.equal('example-user');
            expect(res.body.data.gistToken).to.equal('example-token');
            expect(authorization).to.equal('token example-token');
        });

        it('saves whitespace-only GitHub credentials as empty without a Gist request', async function () {
            let locateCalls = 0;
            Gist.prototype.locate = async () => {
                locateCalls++;
            };

            const { res, settings } = await patchSettings(
                { githubUser: 'old-user', gistToken: 'old-token' },
                { githubUser: ' \t\n\u3000', gistToken: '\r\n \u00a0' },
            );

            expect(res.body.status).to.equal('success');
            expect(settings.githubUser).to.equal('');
            expect(settings.gistToken).to.equal('');
            expect(locateCalls).to.equal(0);
        });

        it('does not add omitted GitHub credentials on unrelated patches', async function () {
            const { res, settings } = await patchSettings(
                {},
                { logsMaxCount: 2 },
            );

            expect(res.body.status).to.equal('success');
            expect(settings).not.to.have.property('githubUser');
            expect(settings).not.to.have.property('gistToken');
        });

        it('does not validate existing age-secret-key on unrelated patches', async function () {
            const { res, settings } = await patchSettings(
                {
                    gistUpload: 'age',
                    [AGE_SECRET_KEY]: '恢复后请重新设置 age 解密私钥',
                    logsMaxCount: 1,
                },
                { logsMaxCount: 2 },
            );

            expect(res.body.status).to.equal('success');
            expect(settings.logsMaxCount).to.equal(2);
            expect(settings[AGE_SECRET_KEY]).to.equal(
                '恢复后请重新设置 age 解密私钥',
            );
        });

        it('does not validate submitted age secret key outside age mode', async function () {
            const { res, settings } = await patchSettings(
                {},
                {
                    gistUpload: 'base64',
                    [AGE_SECRET_KEY]: 'invalid-secret-key',
                },
            );

            expect(res.body.status).to.equal('success');
            expect(settings[AGE_SECRET_KEY]).to.equal('invalid-secret-key');
        });

        it('accepts valid age secret key in age mode', async function () {
            const pair = await generateKeyPair();
            const { res, settings } = await patchSettings(
                {},
                {
                    gistUpload: 'age',
                    [AGE_SECRET_KEY]: ` ${pair[AGE_SECRET_KEY]} `,
                },
            );

            expect(res.body.status).to.equal('success');
            expect(settings[AGE_SECRET_KEY]).to.equal(pair[AGE_SECRET_KEY]);
        });

        it('requires age secret key in age mode', async function () {
            const { res } = await patchSettings({}, { gistUpload: 'age' });

            expect(res.body.status).to.equal('failed');
            expect(res.body.error.message).to.contain(
                'age 加密模式需要配置 age-secret-key',
            );
        });

        it('rejects invalid submitted age secret key in age mode', async function () {
            const { res } = await patchSettings(
                {},
                {
                    gistUpload: 'age',
                    [AGE_SECRET_KEY]: 'invalid-secret-key',
                },
            );

            expect(res.body.status).to.equal('failed');
            expect(res.body.error.message).to.contain(
                'age-secret-key 仅支持',
            );
        });

        it('rejects an invalid Gist download token strategy', async function () {
            const { res } = await patchSettings(
                {},
                { gistDownloadTokenStrategy: 'invalid' },
            );

            expect(res.body.status).to.equal('failed');
            expect(res.body.error.message).to.contain('Token 处理方式');
        });
    });

    describe('appearance settings', function () {
        const originalRead = $.read.bind($);
        const originalWrite = $.write.bind($);

        afterEach(function () {
            $.read = originalRead;
            $.write = originalWrite;
        });

        async function patchSettings(initialSettings, body) {
            const state = {
                [SETTINGS_KEY]: initialSettings,
            };
            $.read = (key) => state[key];
            $.write = (data, key) => {
                state[key] = data;
                return true;
            };

            const app = createRouteApp();
            registerSettingsRoutes(app);
            const patchHandler = app.handlers.get('PATCH /api/settings');
            const res = createResponse('/api/settings');

            await patchHandler({ body }, res);

            expect(res.body.status).to.equal('success');
            return state[SETTINGS_KEY];
        }

        it('merges appearanceSetting patches without dropping unrelated fields', async function () {
            const settings = await patchSettings(
                {
                    appearanceSetting: {
                        isSimpleMode: false,
                        editorGroupingMode: 'always',
                        editorCommonDisplayMode: 'collapsed',
                    },
                },
                {
                    appearanceSetting: {
                        isSimpleMode: true,
                    },
                },
            );

            expect(settings.appearanceSetting).to.deep.equal({
                isSimpleMode: true,
                editorGroupingMode: 'always',
                editorCommonDisplayMode: 'collapsed',
            });
        });
    });

    describe('backend request concurrency settings', function () {
        const originalRead = $.read.bind($);
        const originalWrite = $.write.bind($);

        afterEach(function () {
            $.read = originalRead;
            $.write = originalWrite;
        });

        async function patchSettings(initialSettings, body) {
            const state = {
                [SETTINGS_KEY]: initialSettings,
            };
            $.read = (key) => state[key];
            $.write = (data, key) => {
                state[key] = data;
                return true;
            };

            const app = createRouteApp();
            registerSettingsRoutes(app);
            const patchHandler = app.handlers.get('PATCH /api/settings');
            const res = createResponse('/api/settings');

            await patchHandler({ body }, res);

            expect(res.body.status).to.equal('success');
            return state[SETTINGS_KEY];
        }

        it('persists positive integer backend request concurrency', async function () {
            const settings = await patchSettings(
                {},
                { backendRequestConcurrency: '15' },
            );

            expect(settings).to.deep.include({
                backendRequestConcurrency: '15',
            });
        });

        it('allows backend request concurrency above proxy app guidance', async function () {
            const settings = await patchSettings(
                {},
                { backendRequestConcurrency: 21 },
            );

            expect(settings).to.deep.include({
                backendRequestConcurrency: 21,
            });
        });

        it('clears invalid backend request concurrency values', async function () {
            const invalidValues = ['', 'abc', '1.5', 0, -1, null];

            for (const value of invalidValues) {
                const settings = await patchSettings(
                    { backendRequestConcurrency: 8 },
                    { backendRequestConcurrency: value },
                );

                expect(settings).to.not.have.property(
                    'backendRequestConcurrency',
                );
            }
        });

        it('persists backend request concurrency wait time values', async function () {
            const zeroWaitSettings = await patchSettings(
                {},
                { backendRequestConcurrencyWaitTime: 0 },
            );
            const positiveWaitSettings = await patchSettings(
                {},
                { backendRequestConcurrencyWaitTime: '50' },
            );

            expect(zeroWaitSettings).to.deep.include({
                backendRequestConcurrencyWaitTime: 0,
            });
            expect(positiveWaitSettings).to.deep.include({
                backendRequestConcurrencyWaitTime: '50',
            });
        });

        it('clears invalid backend request concurrency wait time values', async function () {
            const invalidValues = ['', 'abc', '1.5', -1, null];

            for (const value of invalidValues) {
                const settings = await patchSettings(
                    { backendRequestConcurrencyWaitTime: 8 },
                    { backendRequestConcurrencyWaitTime: value },
                );

                expect(settings).to.not.have.property(
                    'backendRequestConcurrencyWaitTime',
                );
            }
        });
    });

    describe('cache TTL settings', function () {
        const originalRead = $.read.bind($);
        const originalWrite = $.write.bind($);
        const caches = [
            ['resourceCacheTtl', resourceCache, DEFAULT_CACHE_TTL],
            ['headersCacheTtl', headersCache, DEFAULT_HEADERS_CACHE_TTL],
            ['scriptCacheTtl', scriptCache, DEFAULT_SCRIPT_CACHE_TTL],
        ];

        afterEach(function () {
            $.read = originalRead;
            $.write = originalWrite;
            resourceCache.revokeAll();
            headersCache.revokeAll();
            scriptCache.revokeAll();
        });

        async function patchSettings(initialSettings, body) {
            const state = {
                [SETTINGS_KEY]: initialSettings,
            };
            $.read = (key) => state[key];
            $.write = (data, key) => {
                state[key] = data;
                return true;
            };

            const app = createRouteApp();
            registerSettingsRoutes(app);
            const patchHandler = app.handlers.get('PATCH /api/settings');
            const res = createResponse('/api/settings');

            await patchHandler({ body }, res);

            expect(res.body.status).to.equal('success');
            return state[SETTINGS_KEY];
        }

        function expectCacheDisabled(cache) {
            cache.set('ttl-probe', 'cached', 9999999);
            expect(cache.resourceCache['ttl-probe']).to.equal(undefined);
            expect(cache.get('ttl-probe')).to.equal(null);
            expect(cache.gettime('ttl-probe')).to.equal(null);
        }

        function expectCacheUsesDefault(cache) {
            cache.set('ttl-probe', 'cached');
            expect(cache.get('ttl-probe')).to.equal('cached');
        }

        it('stores numeric 0 and disables each cache', async function () {
            const settings = await patchSettings(
                {},
                {
                    resourceCacheTtl: 0,
                    headersCacheTtl: 0,
                    scriptCacheTtl: 0,
                },
            );

            expect(settings).to.deep.include({
                resourceCacheTtl: 0,
                headersCacheTtl: 0,
                scriptCacheTtl: 0,
            });
            for (const [key, cache, fallback] of caches) {
                expect(ttlFromSetting(() => settings, key, fallback)).to.equal(
                    0,
                );
                expectCacheDisabled(cache);
            }
            expect(resourceOutputTtlMs()).to.equal(0);
            expect(scriptCheckTtlMs()).to.equal(0);
        });

        it('stores the string 0 sent by the settings UI and disables each cache', async function () {
            const settings = await patchSettings(
                {},
                {
                    resourceCacheTtl: '0',
                    headersCacheTtl: ' 0 ',
                    scriptCacheTtl: '0.0',
                },
            );

            expect(settings).to.deep.include({
                resourceCacheTtl: '0',
                headersCacheTtl: '0',
                scriptCacheTtl: '0',
            });
            for (const [key, cache, fallback] of caches) {
                expect(ttlFromSetting(() => settings, key, fallback)).to.equal(
                    0,
                );
                expectCacheDisabled(cache);
            }
            expect(resourceOutputTtlMs()).to.equal(0);
            expect(scriptCheckTtlMs()).to.equal(0);
        });

        it('drops empty TTL values so the default cache is used', async function () {
            const settings = await patchSettings(
                {
                    resourceCacheTtl: 0,
                    headersCacheTtl: '0',
                    scriptCacheTtl: 30,
                },
                {
                    resourceCacheTtl: '',
                    headersCacheTtl: '   ',
                    scriptCacheTtl: null,
                },
            );

            expect(settings).to.not.have.property('resourceCacheTtl');
            expect(settings).to.not.have.property('headersCacheTtl');
            expect(settings).to.not.have.property('scriptCacheTtl');
            for (const [key, cache, fallback] of caches) {
                expect(ttlFromSetting(() => settings, key, fallback)).to.equal(
                    fallback,
                );
                expectCacheUsesDefault(cache);
                cache.revokeAll();
            }
            expect(resourceOutputTtlMs()).to.equal(DEFAULT_CACHE_TTL);
            expect(scriptCheckTtlMs()).to.equal(DEFAULT_SCRIPT_CACHE_TTL);
        });

        it('leaves positive TTL values unchanged', async function () {
            const settings = await patchSettings(
                { resourceCacheTtl: 1, headersCacheTtl: '1' },
                {
                    resourceCacheTtl: 3600,
                    headersCacheTtl: '120',
                    scriptCacheTtl: ' 48 ',
                },
            );

            expect(settings).to.deep.include({
                resourceCacheTtl: 3600,
                headersCacheTtl: '120',
                scriptCacheTtl: ' 48 ',
            });
            expect(
                ttlFromSetting(
                    () => settings,
                    'resourceCacheTtl',
                    DEFAULT_CACHE_TTL,
                ),
            ).to.equal(3600 * 1000);
            expect(
                ttlFromSetting(
                    () => settings,
                    'headersCacheTtl',
                    DEFAULT_HEADERS_CACHE_TTL,
                ),
            ).to.equal(120 * 1000);
            expect(
                ttlFromSetting(
                    () => settings,
                    'scriptCacheTtl',
                    DEFAULT_SCRIPT_CACHE_TTL,
                ),
            ).to.equal(48 * 1000);
            expectCacheUsesDefault(resourceCache);
        });

        it('stores a negative TTL as zero and drops non-numeric values', async function () {
            const negative = await patchSettings(
                {},
                {
                    resourceCacheTtl: -5,
                    headersCacheTtl: '-3',
                    scriptCacheTtl: -0,
                },
            );

            expect(negative).to.deep.include({
                resourceCacheTtl: 0,
                headersCacheTtl: '0',
                scriptCacheTtl: 0,
            });
            expectCacheDisabled(resourceCache);
            expectCacheDisabled(headersCache);
            expectCacheDisabled(scriptCache);

            const invalid = await patchSettings(
                {
                    resourceCacheTtl: 0,
                    headersCacheTtl: '0',
                    scriptCacheTtl: 15,
                },
                {
                    resourceCacheTtl: 'abc',
                    headersCacheTtl: Number.NaN,
                    scriptCacheTtl: Number.POSITIVE_INFINITY,
                },
            );

            expect(invalid).to.not.have.property('resourceCacheTtl');
            expect(invalid).to.not.have.property('headersCacheTtl');
            expect(invalid).to.not.have.property('scriptCacheTtl');
            expect(
                ttlFromSetting(
                    () => invalid,
                    'scriptCacheTtl',
                    DEFAULT_SCRIPT_CACHE_TTL,
                ),
            ).to.equal(DEFAULT_SCRIPT_CACHE_TTL);
        });

        it('keeps a stored zero when a later patch omits the TTL keys', async function () {
            const settings = await patchSettings(
                {
                    resourceCacheTtl: 0,
                    headersCacheTtl: '0',
                    scriptCacheTtl: 15,
                },
                { logsMaxCount: 2 },
            );

            expect(settings).to.deep.include({
                resourceCacheTtl: 0,
                headersCacheTtl: '0',
                scriptCacheTtl: 15,
                logsMaxCount: 2,
            });
            expectCacheDisabled(resourceCache);
        });

        it('still drops non-positive timeout and cache threshold values', async function () {
            const settings = await patchSettings(
                {
                    defaultTimeout: 8000,
                    cacheThreshold: 1024,
                    resourceCacheTtl: 30,
                },
                {
                    defaultTimeout: 0,
                    cacheThreshold: '',
                    resourceCacheTtl: 0,
                },
            );

            expect(settings).to.not.have.property('defaultTimeout');
            expect(settings).to.not.have.property('cacheThreshold');
            expect(settings.resourceCacheTtl).to.equal(0);
            expectCacheDisabled(resourceCache);
        });
    });
});
