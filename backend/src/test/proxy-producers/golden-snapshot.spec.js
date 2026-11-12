import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'mocha';

import { ProxyUtils } from '@/core/proxy-utils';

const fixturePath = path.join(__dirname, 'fixtures', 'mixed-subscription.txt');
const snapshotDir = path.join(__dirname, 'snapshots');

// Every producer name the download/preview path can select, including aliases
// that share an implementation. Each name is snapshotted on its own so a
// later alias split cannot hide behind another target.
const TARGETS = [
    'Surge',
    'SurgeMac',
    'Clash',
    'ClashMeta',
    'mihomo',
    'sing-box',
    'QX',
    'QuantumultX',
    'Loon',
    'Stash',
    'Shadowrocket',
    'Egern',
    'URI',
    'JSON',
    'V2Ray',
    'Surfboard',
];

const ALIASES = {
    surge: 'Surge',
    clash: 'Clash',
    meta: 'ClashMeta',
    clashmeta: 'ClashMeta',
    'clash.meta': 'ClashMeta',
    'Clash.Meta': 'ClashMeta',
    Mihomo: 'mihomo',
    singbox: 'sing-box',
    qx: 'QX',
    uri: 'URI',
    json: 'JSON',
    v2: 'V2Ray',
    v2ray: 'V2Ray',
    stash: 'Stash',
    shadowrocket: 'Shadowrocket',
    ShadowRocket: 'Shadowrocket',
    surfboard: 'Surfboard',
    egern: 'Egern',
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function snapshotPath(target) {
    return path.join(snapshotDir, `${target}.txt`);
}

function produce(target, proxies) {
    const output = ProxyUtils.produce(clone(proxies), target, 'external');
    expect(output, target).to.be.a('string');
    return output.endsWith('\n') ? output : `${output}\n`;
}

describe('golden producer snapshots', function () {
    const raw = fs.readFileSync(fixturePath, 'utf8').replace(/\n$/, '');
    const proxies = ProxyUtils.parse(raw);

    it('parses the fixed mixed-protocol subscription', function () {
        expect(proxies.map((proxy) => proxy.type)).to.deep.equal([
            'ss',
            'vmess',
            'vless',
            'trojan',
            'hysteria2',
            'socks5',
            'http',
        ]);
    });

    for (const target of TARGETS) {
        it(`produces ${target} byte-for-byte`, function () {
            const output = produce(target, proxies);
            const file = snapshotPath(target);
            if (process.env.UPDATE_GOLDEN === '1') {
                fs.mkdirSync(snapshotDir, { recursive: true });
                fs.writeFileSync(file, output);
            }
            expect(fs.existsSync(file), `${file} missing`).to.equal(true);
            expect(output).to.equal(fs.readFileSync(file, 'utf8'));
        });
    }

    for (const [alias, canonical] of Object.entries(ALIASES)) {
        it(`produces alias ${alias} identical to ${canonical}`, function () {
            expect(produce(alias, proxies)).to.equal(produce(canonical, proxies));
        });
    }
});
