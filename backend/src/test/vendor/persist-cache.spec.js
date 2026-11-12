import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';

import { OpenAPI } from '@/vendor/open-api';

describe('persistent store writes', function () {
    let dir;
    let previousBase;
    let api;
    let writes;

    before(function () {
        previousBase = process.env.SUB_STORE_DATA_BASE_PATH;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'substore-persist-'));
        fs.writeFileSync(
            path.join(dir, 'persist-spec.json'),
            '{"subs":[{"name":"old"}]}',
        );
        fs.writeFileSync(path.join(dir, 'root.json'), '{"cached":"1"}');
        process.env.SUB_STORE_DATA_BASE_PATH = dir;
        api = new OpenAPI('persist-spec');
        const original = api.node.fs.writeFileSync.bind(api.node.fs);
        writes = [];
        api.node.fs.writeFileSync = (file, data, ...rest) => {
            writes.push({
                file: path.basename(String(file)),
                data: String(data),
            });
            return original(file, data, ...rest);
        };
    });

    after(function () {
        if (previousBase == null) delete process.env.SUB_STORE_DATA_BASE_PATH;
        else process.env.SUB_STORE_DATA_BASE_PATH = previousBase;
    });

    it('reads the existing single-document files', function () {
        expect(api.read('subs')).to.deep.equal([{ name: 'old' }]);
        expect(api.read('#cached')).to.equal('1');
    });

    it('rewrites only the main document when a top-level key changes', function () {
        writes.length = 0;
        const next = [{ name: 'old' }, { name: 'new' }];
        api.write(next, 'subs');
        expect(writes.map((item) => item.file)).to.deep.equal([
            'persist-spec.json',
        ]);
        expect(JSON.parse(writes[0].data).subs).to.deep.equal(next);
        expect(writes[0].data).to.include('\n  ');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'root.json'), 'utf8'))).to.deep.equal({
            cached: '1',
        });
    });

    it('skips a write when the pretty JSON is unchanged', function () {
        writes.length = 0;
        api.write(api.read('subs'), 'subs');
        expect(writes).to.deep.equal([]);
    });

    it('still persists an in-place edit of the same array', function () {
        const subs = api.read('subs');
        subs.push({ name: 'edited' });
        writes.length = 0;
        api.write(subs, 'subs');
        expect(writes).to.have.length(1);
        expect(JSON.parse(writes[0].data).subs.map((item) => item.name)).to.deep.equal([
            'old',
            'new',
            'edited',
        ]);
    });

    it('rewrites only root.json for a hash key and keeps that value', function () {
        writes.length = 0;
        api.write('{"body":1}', '#cached');
        expect(writes.map((item) => item.file)).to.deep.equal(['root.json']);
        expect(api.read('#cached')).to.equal('{"body":1}');
        writes.length = 0;
        api.write('{"body":1}', '#cached');
        expect(writes).to.deep.equal([]);
        api.delete('#cached');
        expect(api.read('#cached')).to.equal(undefined);
        expect(api.read('subs').map((item) => item.name)).to.include('edited');
    });
});
