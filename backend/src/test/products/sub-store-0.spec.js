import { expect } from 'chai';
import { readFileSync } from 'fs';
import { describe, it } from 'mocha';
import path from 'path';

describe('sub-store-0 product routes', function () {
    it('registers age utility routes in the module bundle entry', function () {
        const entry = readFileSync(
            path.resolve(__dirname, '../../products/sub-store-0.js'),
            'utf8',
        );

        expect(entry).to.include("registerAgeRoutes from '@/restful/age'");
        expect(entry).to.include('registerAgeRoutes($app);');
        expect(entry).to.not.include('registerFileRoutes');
        expect(entry).to.not.include("from '@/restful/sync'");
        expect(entry).to.not.include("from '@/core/proxy-utils'");
    });

    it('registers file routes on sub-store-1 instead of the simple script', function () {
        const core = readFileSync(
            path.resolve(__dirname, '../../products/sub-store-1.js'),
            'utf8',
        );
        expect(core).to.include("registerFileRoutes from '@/restful/file'");
        expect(core).to.include('registerFileRoutes($app);');
    });
});
