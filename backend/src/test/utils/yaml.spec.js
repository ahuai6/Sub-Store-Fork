import { expect } from 'chai';
import { describe, it } from 'mocha';

import { dump, load, safeDump, safeLoad } from '@/utils/yaml';

describe('YAML helper without redundant copies', function () {
    it('parses strings directly and preserves !<str> fallback', function () {
        expect(safeLoad('a: 1\nb: hello\n')).to.deep.equal({
            a: 1,
            b: 'hello',
        });
        expect(load('tag: !<str> 123\n')).to.deep.equal({ tag: '123' });
    });

    it('matches JSON normalization semantics when dumping', function () {
        const shared = { host: 'example.com' };
        const date = new Date('2026-11-16T00:00:00.000Z');
        const out = safeDump(
            {
                a: shared,
                b: shared,
                omitted: undefined,
                fn: () => 'ignored',
                sym: Symbol('ignored'),
                nanVal: NaN,
                infVal: Infinity,
                when: date,
                arr: [1, undefined, () => {}, NaN],
            },
            { lineWidth: -1 },
        );

        expect(out).to.not.include('&a');
        expect(out).to.not.include('*a');
        expect(out).to.not.include('omitted');
        expect(out).to.not.include('fn:');
        expect(out).to.not.include('sym:');
        expect(safeLoad(out)).to.deep.equal({
            a: { host: 'example.com' },
            b: { host: 'example.com' },
            nanVal: null,
            infVal: null,
            when: '2026-11-16T00:00:00.000Z',
            arr: [1, null, null, null],
        });
        expect(dump({ x: 'ok' })).to.equal('x: ok\n');
    });
});
