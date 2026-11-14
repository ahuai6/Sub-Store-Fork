import { expect } from 'chai';
import { describe, it } from 'mocha';

import { getFlag, getFlagTables, getISO, removeFlag } from '@/utils/geo';

// The original scan, kept here so a compiled matcher cannot drift.
function referenceGetFlag(name, flags, iso) {
    let flag =
        name.match(/[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]/)?.[0] ||
        '🏴‍☠️';
    for (const candidate of Object.keys(flags)) {
        const keywords = flags[candidate];
        if (keywords.some((keyword) => RegExp(`${keyword}`, 'i').test(name))) {
            if (/内蒙古/.test(name) && ['🇲🇳'].includes(candidate)) {
                return '🇨🇳';
            }
            return candidate;
        }
    }
    for (const candidate of Object.keys(iso)) {
        const keywords = iso[candidate];
        if (
            keywords.some((keyword) =>
                RegExp(`(^|[^a-zA-Z])${keyword}([^a-zA-Z]|$)`).test(name),
            )
        ) {
            const isCN2 =
                candidate == '🇨🇳' &&
                RegExp(`(^|[^a-zA-Z])CN2([^a-zA-Z]|$)`).test(name);
            if (!isCN2) return candidate;
        }
    }
    return flag;
}

const CASES = [
    ['香港 01', '🇭🇰'],
    ['Hong Kong', '🇭🇰'],
    ['hOnGkOnG', '🇭🇰'],
    ['US 1', '🇺🇸'],
    ['USA-1', '🇺🇸'],
    ['CN2', '🏴‍☠️'],
    ['BACK CN2', '🏴‍☠️'],
    ['内蒙古', '🇨🇳'],
    ['蒙古', '🇲🇳'],
    ['东京 美国', '🇯🇵'],
    ['美国 东京', '🇯🇵'],
    ['random node', '🏴‍☠️'],
    ['🇺🇸 LAX', '🇺🇸'],
    ['xxLAXxx', '🏴‍☠️'],
    [' LAX', '🇺🇸'],
    ['Germany', '🇩🇪'],
    ['流量剩余', '🏳️‍🌈'],
    ['CN2-US', '🇺🇸'],
    ['美国本土外小岛屿', '🇺🇲'],
    ['🏳️‍🌈', '🏴‍☠️'],
    ['', '🏴‍☠️'],
    ['xUSx', '🏴‍☠️'],
    ['(US)', '🇺🇸'],
    ['港', '🇭🇰'],
    ['美', '🇺🇸'],
];

describe('getFlag compiled matchers', function () {
    const tables = getFlagTables();

    it('matches the original per-keyword scan on representative names', function () {
        for (const [name, flag] of CASES) {
            expect(getFlag(name), name).to.equal(flag);
            expect(referenceGetFlag(name, tables.flags, tables.iso), name).to.equal(
                flag,
            );
        }
    });

    it('matches the original scan for every keyword and its boundaries', function () {
        this.timeout(20000);
        const names = new Set();
        const collect = (groups) => {
            for (const keywords of Object.values(groups)) {
                for (const keyword of keywords) {
                    names.add(keyword);
                    names.add(` ${keyword}`);
                    names.add(`${keyword} `);
                    names.add(`x${keyword}`);
                    names.add(`${keyword}x`);
                    names.add(`(${keyword})`);
                    names.add(`节点-${keyword}-1`);
                }
            }
        };
        collect(tables.flags);
        collect(tables.iso);
        expect(names.size).to.be.above(1000);
        for (const name of names) {
            expect(getFlag(name), name).to.equal(
                referenceGetFlag(name, tables.flags, tables.iso),
            );
        }
    });

    it('keeps getISO and removeFlag on the same names', function () {
        expect(getISO('US 1')).to.equal('US');
        expect(getISO('CN2')).to.equal(undefined);
        expect(getISO('流量剩余')).to.equal('EXP');
        expect(removeFlag('🇺🇸 LAX')).to.equal('LAX');
        expect(removeFlag('🏳️‍🌈')).to.equal('');
    });
});
