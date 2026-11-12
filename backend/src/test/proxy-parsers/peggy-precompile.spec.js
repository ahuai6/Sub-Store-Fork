import fs from 'fs';
import path from 'path';

import { expect } from 'chai';
import peggy from 'peggy';
import { describe, it } from 'mocha';

import getLoonParser, {
    grammars as loonGrammars,
} from '@/core/proxy-utils/parsers/peggy/loon';
import getQxParser, {
    grammars as qxGrammars,
    wrapQxParser,
} from '@/core/proxy-utils/parsers/peggy/qx';
import getSurgeParser, {
    grammars as surgeGrammars,
} from '@/core/proxy-utils/parsers/peggy/surge';

const fixtureDir = path.join(__dirname);

function collectInputs(fileName) {
    const text = fs.readFileSync(path.join(fixtureDir, fileName), 'utf8');
    const inputs = [];
    const pattern =
        /input:\s*(?:`([^`]*)`|'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)")/g;
    let match;
    while ((match = pattern.exec(text))) {
        const raw = match[1] ?? match[2] ?? match[3];
        if (!raw || raw.includes('${')) continue;
        inputs.push(raw);
    }
    return inputs;
}

function run(parser, line) {
    try {
        return { ok: true, value: parser.parse(line) };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

function expectSameParse(fresh, compiled, lines, label) {
    expect(lines.length, label).to.be.above(0);
    for (const line of lines) {
        const left = run(fresh, line);
        const right = run(compiled, line);
        expect(right.ok, `${label}: ${line}`).to.equal(left.ok);
        if (left.ok) {
            expect(right.value, `${label}: ${line}`).to.deep.equal(left.value);
        } else {
            expect(right.message, `${label}: ${line}`).to.equal(left.message);
        }
    }
}

describe('precompiled peggy parsers', function () {
    const inputs = [
        ...collectInputs('v2ray-and-platforms.spec.js'),
        ...collectInputs('qx-comma-password.spec.js'),
    ];

    it('reads the existing parser fixtures', function () {
        expect(inputs.length).to.be.above(50);
    });

    it('matches peggy.generate on the Surge fixtures', function () {
        expectSameParse(
            peggy.generate(surgeGrammars),
            getSurgeParser(),
            inputs,
            'surge',
        );
    });

    it('matches peggy.generate on the Loon fixtures', function () {
        expectSameParse(
            peggy.generate(loonGrammars),
            getLoonParser(),
            inputs,
            'loon',
        );
    });

    it('matches peggy.generate on the QX fixtures', function () {
        expectSameParse(
            wrapQxParser(peggy.generate(qxGrammars)),
            getQxParser(),
            inputs,
            'qx',
        );
    });
});
