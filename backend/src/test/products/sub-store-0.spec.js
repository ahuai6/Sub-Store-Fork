import { expect } from 'chai';
import { readFileSync } from 'fs';
import { describe, it } from 'mocha';
import path from 'path';

describe('sub-store-0 product routes', function () {
    it('registers age utility and pure file metadata routes without ProxyUtils', function () {
        const entry = readFileSync(
            path.resolve(__dirname, '../../products/sub-store-0.js'),
            'utf8',
        );

        expect(entry).to.include("registerAgeRoutes from '@/restful/age'");
        expect(entry).to.include('registerAgeRoutes($app);');
        expect(entry).to.include(
            "registerFileMetadataRoutes from '@/restful/file-metadata'",
        );
        expect(entry).to.include('registerFileMetadataRoutes($app);');
        expect(entry).to.not.include('registerFileRoutes');
        expect(entry).to.not.include("from '@/restful/sync'");
        expect(entry).to.not.include("from '@/core/proxy-utils'");
    });

    it('registers full file routes on sub-store-1 for download and backwards compatibility', function () {
        const core = readFileSync(
            path.resolve(__dirname, '../../products/sub-store-1.js'),
            'utf8',
        );
        expect(core).to.include("registerFileRoutes from '@/restful/file'");
        expect(core).to.include('registerFileRoutes($app);');
    });

    it('handles pure file metadata CRUD without writing FILES_KEY at route registration', function () {
        const $ = require('@/core/app').default;
        const { FILES_KEY } = require('@/constants');
        const registerFileMetadata =
            require('@/restful/file-metadata').default;
        const originalRead = $.read.bind($);
        const originalWrite = $.write.bind($);
        const state = {};
        let writes = 0;
        $.read = (key) => state[key];
        $.write = (val, key) => {
            writes += 1;
            state[key] = val;
            return true;
        };
        const routes = {};
        const app = {
            route(pattern) {
                const chain = {};
                for (const method of ['get', 'post', 'put']) {
                    chain[method] = (fn) => {
                        routes[`${method.toUpperCase()} ${pattern}`] = fn;
                        return chain;
                    };
                }
                return chain;
            },
        };
        const makeRes = () => {
            const headers = {};
            const out = { statusCode: 200, headers, body: null };
            out.status = (c) => {
                out.statusCode = c;
                return out;
            };
            out.set = (k, v) => {
                headers[k] = v;
                return out;
            };
            out.json = (d) => {
                out.body = d;
                return out;
            };
            out.send = (d) => {
                out.body = d;
                return out;
            };
            return out;
        };
        try {
            registerFileMetadata(app);
            expect(writes).to.equal(0);

            const createRes = makeRes();
            routes['POST /api/files'](
                { body: { name: 'demo', source: 'local', content: 'abc' } },
                createRes,
            );
            expect(createRes.statusCode).to.equal(201);
            expect(state[FILES_KEY]).to.have.length(1);

            const listRes = makeRes();
            routes['GET /api/files']({}, listRes);
            expect(listRes.body.data[0].name).to.equal('demo');
            expect(listRes.body.data[0].content).to.equal(undefined);

            const wholeRes = makeRes();
            routes['GET /api/wholeFiles']({}, wholeRes);
            expect(wholeRes.body.data[0].content).to.equal('abc');

            const oneRes = makeRes();
            routes['GET /api/wholeFile/:name'](
                { params: { name: 'demo' }, query: {} },
                oneRes,
            );
            expect(oneRes.body.data.content).to.equal('abc');
        } finally {
            $.read = originalRead;
            $.write = originalWrite;
        }
    });

    it('returns 404 instead of throwing when GET /api/sub/:name is missing', function () {
        const $ = require('@/core/app').default;
        const { SUBS_KEY } = require('@/constants');
        const registerSubs = require('@/restful/subscriptions').default;
        const originalRead = $.read.bind($);
        const originalWrite = $.write.bind($);
        const state = { [SUBS_KEY]: [] };
        $.read = (key) => state[key];
        $.write = (val, key) => {
            state[key] = val;
            return true;
        };
        const routes = {};
        const app = {
            get(pattern, fn) {
                routes[`GET ${pattern}`] = fn;
            },
            route(pattern) {
                const chain = {};
                for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
                    chain[method] = (fn) => {
                        routes[`${method.toUpperCase()} ${pattern}`] = fn;
                        return chain;
                    };
                }
                return chain;
            },
        };
        try {
            registerSubs(app);
            let statusCode = 200;
            let payload = null;
            routes['GET /api/sub/:name'](
                { params: { name: 'missing-sub' }, query: {} },
                {
                    status(code) {
                        statusCode = code;
                        return this;
                    },
                    json(data) {
                        payload = data;
                        return this;
                    },
                },
            );
            expect(statusCode).to.equal(404);
            expect(payload.status).to.equal('failed');
            expect(payload.error.code).to.equal('SUBSCRIPTION_NOT_FOUND');
        } finally {
            $.read = originalRead;
            $.write = originalWrite;
        }
    });
});
