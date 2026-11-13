import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect } from 'chai';
import { describe, it } from 'mocha';

import { prefetchDecision } from '@/utils/prefetch-cron';

function findRepoRoot() {
    for (const dir of [process.cwd(), path.resolve(process.cwd(), '..')]) {
        if (fs.existsSync(path.join(dir, 'config', 'Surge-Beta.sgmodule'))) {
            return dir;
        }
    }
    throw new Error('Unable to locate repository root');
}

function substitute(text, values) {
    let rendered = text;
    for (const [key, value] of Object.entries(values)) {
        rendered = rendered.split(`{{{${key}}}}`).join(value);
    }
    return rendered;
}

function activePrefetch(text) {
    return text.split(/\r?\n/).filter((line) => {
        const trimmed = line.trimStart();
        return (
            !trimmed.startsWith('#') &&
            line.includes('prefetch=1') &&
            line.includes('type=cron')
        );
    });
}

describe('Surge prefetch cron', function () {
    it('does nothing when prefetch_cron is empty and does not replace gist sync', function () {
        expect(prefetchDecision({ sub: 'a', col: 'b' })).to.deep.equal({
            handled: false,
        });
        expect(
            prefetchDecision({
                prefetch: '1',
                cron: '',
                sub: 'a',
            }),
        ).to.deep.include({
            handled: true,
            run: false,
            reason: 'prefetch_cron is empty',
        });
        expect(
            prefetchDecision({
                prefetch: '1',
                cron: '50 */6 * * *',
                platform: 'SurgeMac',
            }),
        ).to.deep.equal({
            handled: true,
            run: true,
            platform: 'SurgeMac',
            reason: '',
        });
        expect(
            prefetchDecision({ prefetch: '1', cron: '50 */6 * * *' }).platform,
        ).to.equal('Surge');
    });

    it('publishes a prefetch cron that stays off until prefetch_cron is set', function () {
        const root = findRepoRoot();
        const output = path.join(os.tmpdir(), `surge-beta-prefetch-${process.pid}.sgmodule`);
        execFileSync(
            'python3',
            [
                path.join(root, '.github/scripts/render_surge_beta_module.py'),
                '--check',
                '--output',
                output,
            ],
            { cwd: root },
        );
        const text = fs.readFileSync(output, 'utf8');
        expect(text).to.include(',prefetch_cron,prefetch_sub,prefetch_col,');
        expect(text).to.include('prefetch:"# Sub-Store Prefetch"');
        expect(text).to.not.include('sub-store-org/Sub-Store');
        const defaults = {
            prefetch: '# Sub-Store Prefetch',
            prefetch_cron: '',
            prefetch_sub: '',
            prefetch_col: '',
            prefetch_platform: 'Surge',
            timeout: '900',
            engine: 'auto',
        };
        expect(activePrefetch(substitute(text, defaults))).to.deep.equal([]);
        const enabled = substitute(text, {
            ...defaults,
            prefetch: 'Sub-Store Prefetch',
            prefetch_cron: '50 */6 * * *',
            prefetch_sub: 'sub1',
        });
        const lines = activePrefetch(enabled);
        expect(lines).to.have.length(1);
        expect(lines[0]).to.include('cronexp="50 */6 * * *"');
        expect(lines[0]).to.include('argument="prefetch=1');
        const emptySchedule = activePrefetch(
            substitute(text, {
                ...defaults,
                prefetch: 'Sub-Store Prefetch',
                prefetch_cron: '',
            }),
        );
        expect(emptySchedule.every((line) => line.includes('cronexp=""'))).to.equal(
            true,
        );
    });
});
