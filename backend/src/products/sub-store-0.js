/**
 * 路由拆分 - 本文件只包含不涉及到解析器的 RESTFul API
 *
 * fork: sub-store-0 does not import ProxyUtils. Pure file metadata routes
 * (/api/files, /api/wholeFiles, /api/wholeFile/:name) run here, while
 * /api/file/:name and /share/file/:name stay on sub-store-1.
 */

import { version } from '../../package.json';
console.log(
    `
┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅
     Sub-Store -- v${version}
┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅
`,
);

import migrate from '@/utils/migration';
import express from '@/vendor/express';
import $ from '@/core/app';
import registerCollectionRoutes from '@/restful/collections';
import registerSubscriptionRoutes from '@/restful/subscriptions';
import registerArtifactRoutes from '@/restful/artifacts';
import registerSettingRoutes from '@/restful/settings';
import registerMiscRoutes from '@/restful/miscs';
import registerSortRoutes from '@/restful/sort';
import registerTokenRoutes from '@/restful/token';
import registerArchiveRoutes from '@/restful/archives';
import registerModuleRoutes from '@/restful/module';
import registerLogRoutes from '@/restful/logs';
import registerAgeRoutes from '@/restful/age';
import registerFileMetadataRoutes from '@/restful/file-metadata';

migrate();
serve();

function serve() {
    const $app = express({ substore: $ });

    // register routes
    registerCollectionRoutes($app);
    registerSubscriptionRoutes($app);
    registerTokenRoutes($app);
    registerModuleRoutes($app);
    registerFileMetadataRoutes($app);
    registerArtifactRoutes($app);
    registerSettingRoutes($app);
    registerSortRoutes($app);
    registerArchiveRoutes($app);
    registerMiscRoutes($app);
    registerLogRoutes($app);
    registerAgeRoutes($app);

    $app.start();
}
