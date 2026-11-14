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
});
