/**
 * 路由拆分 - 本文件仅包含使用到解析器的 RESTFul API
 *
 * fork: file routes are registered here so sub-store-0 does not import
 * sync.js or ProxyUtils. The published Surge core pattern matches them.
 */

import { version } from '../../package.json';
import migrate from '@/utils/migration';
import express from '@/vendor/express';
import $ from '@/core/app';
import registerDownloadRoutes from '@/restful/download';
import registerFileRoutes from '@/restful/file';
import registerPreviewRoutes from '@/restful/preview';
import registerSyncRoutes from '@/restful/sync';
import registerNodeInfoRoutes from '@/restful/node-info';

console.log(
    `
┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅
     Sub-Store -- v${version}
┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅
`,
);

migrate();
serve();

function serve() {
    const $app = express({ substore: $ });

    // register routes
    registerDownloadRoutes($app);
    registerFileRoutes($app);
    registerPreviewRoutes($app);
    registerSyncRoutes($app);
    registerNodeInfoRoutes($app);

    $app.options('/', (req, res) => {
        res.status(200).end();
    });

    $app.start();
}
