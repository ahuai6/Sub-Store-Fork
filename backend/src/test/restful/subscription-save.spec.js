import { expect } from 'chai';
import { after, before, beforeEach, describe, it } from 'mocha';

import { SUBS_KEY } from '@/constants';
import scriptResourceCache from '@/utils/script-resource-cache';

let $;
let registerSubscriptionRoutes;
let originalRead;
let originalWrite;
let originalInfo;
let state;
let mainWrites;

function createRouteApp() {
    const handlers = new Map();
    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    const app = {
        handlers,
        get(pattern, handler) {
            handlers.set(`GET ${pattern}`, handler);
            return app;
        },
        route(pattern) {
            const chain = {};
            methods.forEach((method) => {
                chain[method] = (handler) => {
                    handlers.set(`${method.toUpperCase()} ${pattern}`, handler);
                    return chain;
                };
            });
            return chain;
        },
    };
    return app;
}

function createResponse() {
    let done = false;
    return {
        statusCode: 200,
        body: null,
        req: { route: { path: '/api/sub/:name' } },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            done = true;
            return this;
        },
        sent: () => done,
    };
}

describe('subscription save', function () {
    before(function () {
        ({ default: $ } = require('@/core/app'));
        ({ default: registerSubscriptionRoutes } = require(
            '@/restful/subscriptions'
        ));
        originalRead = $.read.bind($);
        originalWrite = $.write.bind($);
        originalInfo = $.info.bind($);
    });

    beforeEach(function () {
        state = {
            [SUBS_KEY]: [
                { name: 'demo', source: 'local', url: '/', process: [] },
            ],
        };
        mainWrites = 0;
        $.read = (key) => state[key];
        $.write = (data, key) => {
            if (key === SUBS_KEY) mainWrites += 1;
            state[key] = data;
            return true;
        };
        $.info = () => {};
        scriptResourceCache.flush();
    });

    after(function () {
        if ($) {
            $.read = originalRead;
            $.write = originalWrite;
            $.info = originalInfo;
        }
    });

    it('returns PATCH success without blocking on cache flush', function () {
        const app = createRouteApp();
        registerSubscriptionRoutes(app);
        const handler = app.handlers.get('PATCH /api/sub/:name');
        const res = createResponse();
        const body = {
            ...state[SUBS_KEY][0],
            displayName: 'Renamed label',
        };

        handler({ params: { name: 'demo' }, body }, res);

        expect(res.sent()).to.equal(true);
        expect(res.statusCode).to.equal(200);
        expect(res.body.status).to.equal('success');
        expect(res.body.data.displayName).to.equal('Renamed label');
        expect(mainWrites).to.equal(1);
    });

    it('persists a renamed subscription and updates cross references', function () {
        const { COLLECTIONS_KEY, ARTIFACTS_KEY, FILES_KEY } = require(
            '@/constants',
        );
        state[COLLECTIONS_KEY] = [{ name: 'col', subscriptions: ['demo'] }];
        state[ARTIFACTS_KEY] = [
            { name: 'art', type: 'subscription', source: 'demo' },
        ];
        state[FILES_KEY] = [
            {
                name: 'file',
                sourceType: 'subscription',
                sourceName: 'demo',
            },
        ];

        const app = createRouteApp();
        registerSubscriptionRoutes(app);
        const handler = app.handlers.get('PATCH /api/sub/:name');
        const res = createResponse();

        handler(
            {
                params: { name: 'demo' },
                body: {
                    ...state[SUBS_KEY][0],
                    name: 'demo-renamed',
                },
            },
            res,
        );

        expect(res.body.status).to.equal('success');
        expect(state[SUBS_KEY][0].name).to.equal('demo-renamed');
        expect(state[COLLECTIONS_KEY][0].subscriptions[0]).to.equal(
            'demo-renamed',
        );
        expect(state[ARTIFACTS_KEY][0].source).to.equal('demo-renamed');
        expect(state[FILES_KEY][0].sourceName).to.equal('demo-renamed');
    });
});