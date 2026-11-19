import crypto from 'crypto';

import { expect } from 'chai';
import { describe, it } from 'mocha';

import { generateFingerprint } from '@/utils/rs';

function expectedFingerprint(bytes) {
    return crypto
        .createHash('sha256')
        .update(bytes)
        .digest('hex')
        .match(/.{2}/g)
        .join(':')
        .toUpperCase();
}

function wrapPem(bytes, { eol = '\n', prefix = '', chunkSize = 64 } = {}) {
    const b64 = Buffer.from(bytes).toString('base64');
    const lines = [];
    for (let i = 0; i < b64.length; i += chunkSize) {
        lines.push(b64.slice(i, i + chunkSize));
    }
    return `${prefix}-----BEGIN CERTIFICATE-----${eol}${lines.join(eol)}${eol}-----END CERTIFICATE-----${eol}`;
}

describe('certificate fingerprint helper', function () {
    it('matches SHA-256 across SHA-256 block-padding boundaries', function () {
        for (const length of [0, 1, 3, 55, 56, 63, 64, 65, 512, 1024]) {
            const bytes = Uint8Array.from(
                { length },
                (_, idx) => (idx * 73 + 19) & 0xff,
            );
            const pem = wrapPem(bytes, {
                eol: '\r\n',
                prefix: 'comment before pem\r\n',
            });
            expect(generateFingerprint(pem)).to.equal(
                expectedFingerprint(bytes),
            );
        }
    });

    it('throws when PEM header is missing', function () {
        expect(() => generateFingerprint('not a pem')).to.throw(
            "can't find PEM header",
        );
    });

    it('hashes the first certificate in a multi-certificate PEM chain', function () {
        const leaf = Uint8Array.from(Buffer.from('leaf-certificate-der-bytes'));
        const ca = Uint8Array.from(
            Buffer.from('intermediate-ca-certificate-der-bytes'),
        );
        const chain = `${wrapPem(leaf)}${wrapPem(ca)}`;
        expect(generateFingerprint(chain)).to.equal(expectedFingerprint(leaf));
        expect(generateFingerprint(chain)).to.not.equal(
            expectedFingerprint(ca),
        );
    });

    it('throws when PEM footer is missing or mismatched', function () {
        const truncated =
            '-----BEGIN CERTIFICATE-----\nQUJD\ntrailing-garbage';
        const mismatched =
            '-----BEGIN CERTIFICATE-----\nQUJD\n-----END PUBLIC KEY-----';
        expect(() => generateFingerprint(truncated)).to.throw(
            "can't find PEM footer",
        );
        expect(() => generateFingerprint(mismatched)).to.throw(
            "can't find PEM footer",
        );
    });
});
