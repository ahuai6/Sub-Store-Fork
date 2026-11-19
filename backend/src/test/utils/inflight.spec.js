import { expect } from 'chai';
import { afterEach, describe, it } from 'mocha';

import {
    heavyRequestKey,
    inflightSize,
    resetInflight,
    shareResponse,
} from '@/utils/inflight';

function createResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        method: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        set(key, value) {
            this.headers[key] = value;
            return this;
        },
        removeHeader(key) {
            delete this.headers[key];
            return this;
        },
        json(data) {
            this.method = 'json';
            this.body = data;
            return this;
        },
        send(body) {
            this.method = 'send';
            this.body = body;
            return this;
        },
    };
}

describe('in-flight request dedup', function () {
    afterEach(function () {
        resetInflight();
    });

    it('builds the same key for the same sub, params, and target', function () {
        const left = heavyRequestKey('preview-sub', {
            params: { name: 'a' },
            query: { target: 'Surge' },
            body: { name: 'a', process: [{ type: 'Flag Operator' }] },
        });
        const right = heavyRequestKey('preview-sub', {
            params: { name: 'a' },
            query: { target: 'Surge' },
            body: { process: [{ type: 'Flag Operator' }], name: 'a' },
        });
        const otherTarget = heavyRequestKey('preview-sub', {
            params: { name: 'a' },
            query: { target: 'Clash' },
            body: { name: 'a', process: [{ type: 'Flag Operator' }] },
        });

        expect(left).to.equal(right);
        expect(left).to.not.equal(otherTarget);
    });

    it('includes the user agent only when the platform can depend on it', function () {
        const req = {
            params: { name: 'a' },
            query: {},
            headers: { 'user-agent': 'Surge iOS/3000' },
            body: null,
        };
        expect(heavyRequestKey('download-sub', req)).to.equal(
            heavyRequestKey('download-sub', {
                ...req,
                headers: { 'user-agent': 'Clash' },
            }),
        );
        expect(
            heavyRequestKey('download-sub', req, { includeUserAgent: true }),
        ).to.not.equal(
            heavyRequestKey(
                'download-sub',
                { ...req, headers: { 'user-agent': 'Clash' } },
                { includeUserAgent: true },
            ),
        );
    });

    it('runs one handler for two identical in-flight calls and replies to both', async function () {
        let runs = 0;
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const key = 'same-work';

        const first = shareResponse(key, createResponse(), async (res) => {
            runs += 1;
            await gate;
            res.status(200).json({ status: 'success', data: { n: runs } });
        });
        const secondRes = createResponse();
        const second = shareResponse(key, secondRes, async () => {
            runs += 1;
        });

        expect(inflightSize()).to.equal(1);
        release();
        const [leader, follower] = await Promise.all([first, second]);

        expect(runs).to.equal(1);
        expect(leader.body).to.deep.equal({
            status: 'success',
            data: { n: 1 },
        });
        expect(secondRes.body).to.deep.equal(leader.body);
        expect(secondRes.statusCode).to.equal(200);
        expect(follower.body).to.deep.equal(leader.body);
        expect(inflightSize()).to.equal(0);
    });

    it('does not reuse a settled result for a later request', async function () {
        let runs = 0;
        const key = 'again';
        const run = () =>
            shareResponse(key, createResponse(), async (res) => {
                runs += 1;
                res.send(String(runs));
            });

        await run();
        await run();
        expect(runs).to.equal(2);
    });

    it('shares a failure when the leader sends an error response', async function () {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const first = shareResponse('fail', createResponse(), async (res) => {
            await gate;
            res.status(500).json({ status: 'failed' });
        });
        const secondRes = createResponse();
        const second = shareResponse('fail', secondRes, async () => {});
        release();
        await Promise.all([first, second]);
        expect(secondRes.statusCode).to.equal(500);
        expect(secondRes.body).to.deep.equal({ status: 'failed' });
    });

    it('separates keys by path, method, share age header, and conditional headers', function () {
        const base = {
            method: 'GET',
            path: '/download/demo',
            params: { name: 'demo' },
            query: { target: 'Surge' },
            headers: { 'user-agent': 'Surge' },
            body: null,
        };
        const share = { ...base, path: '/share/sub/demo' };
        const head = { ...base, method: 'HEAD' };
        const ageA = {
            ...share,
            headers: {
                ...share.headers,
                'X-Sub-Store-Share-Age-Public-Key': 'age1alpha',
            },
        };
        const ageB = {
            ...share,
            headers: {
                ...share.headers,
                'x-sub-store-share-age-public-key': 'age1beta',
            },
        };
        const conditional = {
            ...base,
            headers: { ...base.headers, 'If-None-Match': 'W/"123"' },
        };

        const keys = [base, share, head, ageA, ageB, conditional].map((req) =>
            heavyRequestKey('download-sub', req, { includeUserAgent: true }),
        );
        expect(new Set(keys).size).to.equal(keys.length);
    });

    it('replays real Express json responses without corrupting nested send/end calls', async function () {
        const express = require('express');
        const http = require('http');
        const app = express();
        let runs = 0;
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });

        app.get('/preview/:name', (req, res) => {
            const key = heavyRequestKey('express-json', req);
            shareResponse(key, res, async (targetRes) => {
                runs += 1;
                await gate;
                targetRes
                    .set('X-Test', 'ok')
                    .status(201)
                    .json({ status: 'success', runs });
            });
        });

        const server = await new Promise((resolve) => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });
        const fetchOnce = () =>
            new Promise((resolve, reject) => {
                http.get(
                    `http://127.0.0.1:${server.address().port}/preview/demo`,
                    (res) => {
                        let body = '';
                        res.setEncoding('utf8');
                        res.on('data', (chunk) => {
                            body += chunk;
                        });
                        res.on('end', () =>
                            resolve({
                                statusCode: res.statusCode,
                                headers: res.headers,
                                body: JSON.parse(body),
                            }),
                        );
                    },
                ).on('error', reject);
            });

        try {
            const p1 = fetchOnce();
            const p2 = fetchOnce();
            await new Promise((r) => setTimeout(r, 30));
            release();
            const [r1, r2] = await Promise.all([p1, p2]);
            expect(runs).to.equal(1);
            for (const r of [r1, r2]) {
                expect(r.statusCode).to.equal(201);
                expect(r.headers['x-test']).to.equal('ok');
                expect(r.headers['content-type']).to.include(
                    'application/json',
                );
                expect(r.body).to.deep.equal({ status: 'success', runs: 1 });
            }
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('preserves end() encoding and callback arguments', async function () {
        let endArgs;
        let cbCalled = false;
        const leaderRes = {
            statusCode: 202,
            end(...args) {
                endArgs = args;
                const cb = args.find((arg) => typeof arg === 'function');
                if (cb) cb();
                return this;
            },
        };
        const snap = await shareResponse('end-args', leaderRes, async (res) => {
            res.end('hello', 'latin1', () => {
                cbCalled = true;
            });
        });
        expect(cbCalled).to.equal(true);
        expect(endArgs.slice(0, 2)).to.deep.equal(['hello', 'latin1']);
        expect(snap.statusCode).to.equal(202);
        expect(snap.encoding).to.equal('latin1');
    });
});
