#!/usr/bin/env node
/**
 * Check that this fork's Surge performance patches are still present.
 *
 * sync-upstream merges sub-store-org/Sub-Store into main. These markers are
 * the fork's own edits. If a clean merge drops one, the script exits 1 and
 * sync-upstream does not push main. It does not rewrite files: the patches
 * are too large to replay from a stale anchor, and a missing marker needs a
 * person to reapply the commit.
 *
 *   node .github/scripts/apply-fork-runtime.mjs --check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const failures = [];

function read(rel) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
        failures.push(`${rel} is missing`);
        return '';
    }
    return fs.readFileSync(file, 'utf8');
}

function need(rel, marker) {
    const text = read(rel);
    if (text && !text.includes(marker)) {
        failures.push(`${rel} is missing ${marker}`);
    }
}

function forbid(rel, marker) {
    const text = read(rel);
    if (text && text.includes(marker)) {
        failures.push(`${rel} still contains ${marker}`);
    }
}

need('backend/package.json', '"bench"');
need('backend/src/utils/geo.js', 'fork: getFlag matchers are compiled once');
need('backend/src/vendor/open-api.js', 'fork: skip unchanged store writes');
need(
    'backend/src/core/proxy-utils/parsers/peggy/surge.js',
    'fork: peggy parsers are precompiled',
);
need(
    'backend/src/core/proxy-utils/parsers/peggy/loon.js',
    'fork: peggy parsers are precompiled',
);
need(
    'backend/src/core/proxy-utils/parsers/peggy/qx.js',
    'fork: peggy parsers are precompiled',
);
need('backend/scripts/precompile-peggy.js', 'precompilePeggy');
need('backend/bundle-esbuild.js', 'precompilePeggy');
need(
    'backend/src/products/sub-store-0.js',
    'fork: sub-store-0 does not import ProxyUtils',
);
need('backend/src/products/sub-store-1.js', 'registerFileRoutes');
forbid('backend/src/products/sub-store-0.js', 'registerFileRoutes');
need(
    '.github/scripts/render_surge_beta_module.py',
    'share\\/file(?:\\/|\\?|#|$)',
);
forbid(
    'backend/src/core/proxy-utils/parsers/peggy/surge.js',
    'peggy.generate',
);
forbid('backend/src/core/proxy-utils/parsers/peggy/loon.js', 'peggy.generate');
forbid('backend/src/core/proxy-utils/parsers/peggy/qx.js', 'peggy.generate');
need('backend/scripts/bench.js', 'getFlag5000');
need(
    'backend/src/test/proxy-producers/golden-snapshot.spec.js',
    'golden producer snapshots',
);
need('backend/src/utils/inflight.js', 'does not cross Surge script sessions');
need('backend/src/restful/preview.js', "'preview-sub'");
need('backend/src/restful/download.js', "'download-sub'");
need('backend/src/restful/node-info.js', "'node-info'");
need('backend/src/utils/script-resource-cache.js', 'flush()');
need('backend/src/utils/output-cache.js', 'resourceCacheTtl');
need('backend/src/utils/check-result-cache.js', 'scriptCacheTtl');
need('backend/src/utils/script-resource-cache.js', 'sharedCheck');
need('backend/src/restful/miscs.js', 'outputCache.revokeAll');
need('backend/src/restful/miscs.js', 'checkResultCache.revokeAll');
need('scripts/check/geo.js', 'sharedCheckGet');
need('.github/scripts/render_surge_beta_module.py', 'prefetch_cron');
need('backend/src/utils/prefetch-cron.js', 'prefetch_cron is empty');
need('backend/src/products/cron-sync-artifacts.js', 'prefetchDecision');
need('backend/scripts/bench.js', 'outputCacheHit5000');
need('backend/src/vendor/express.js', 'scriptResourceCache.flush');
need('backend/src/runtime/build-flags.js', '__SURGE_ONLY__');
need('backend/bundle-esbuild.js', 'surgeOnly: true');
need('backend/surge-only-strip.js', '@non-surge-start');
// Step 5 and publication/module fixes must survive an upstream merge.
need('backend/src/utils/cache-shards.js', 'cacheShardsVersion');
need('backend/src/utils/cache-shards.js', 'legacy: this.legacy');
need('backend/src/utils/bounded-cache.js', 'this.shards.save');
need('backend/src/utils/output-cache.js', 'sharded: true');
need('backend/src/utils/check-result-cache.js', 'sharded: true');
need('backend/src/utils/script-resource-cache.js', 'new CacheShards');
need('backend/src/utils/script-resource-cache.js', 'ttlFromSetting');
need('backend/src/utils/resource-cache.js', 'ttlFromSetting');
need('backend/src/utils/headers-resource-cache.js', 'ttlFromSetting');
need('scripts/check/geo.js', 'two_phase');
need('scripts/check/geo.js', 'dedup_target');
need('.github/scripts/render_surge_beta_module.py', 'parse_module_arguments');
need('.github/scripts/render_surge_beta_module.py', 'disable_sync_by_default');
need('.github/scripts/render_surge_beta_module.py', 'scheduled sync/produce/prefetch must default off');
need('backend/src/products/cron-sync-artifacts.js', 'prefetchNames');
forbid('.github/scripts/render_surge_beta_module.py', 'prefetch_cron:,');
need('scripts/check/GEO-NOTICE.md', '49248e431b1ebb3f55b6d384a25582f74cde8207');
need('scripts/check/GEO-LICENSE.txt', 'GNU GENERAL PUBLIC LICENSE');
need('.github/workflows/publish-dist.yml', 'test_render_surge_beta_module.py');
need('.github/scripts/publish_public_dist.sh', 'GEO-NOTICE.md');
need('scripts/check/geo.js', 'time_budget');
need('scripts/check/geo.js', 'keep_last');
need('backend/src/utils/last-good-cache.js', 'new CacheShards');
need('backend/src/utils/script-resource-cache.js', 'lastGoodCache.revokeAll');
need('backend/src/restful/miscs.js', 'lastGoodCache.revokeAll');
need('scripts/check/GEO-NOTICE.md', 'keep_last');
need(
    '.github/scripts/publish_public_dist.sh',
    'explicit release asset list',
);
need('.github/scripts/prepare_frontend_pages.py', 'patch_surge_session_guard');
need(
    '.github/scripts/fork-frontend/forkRequestGuard.ts',
    'sub-store-fork-api-cap:2',
);
forbid('backend/src/utils/rs.js', 'jsrsasign');
need('backend/src/utils/cache-shards.js', 'readEntry');
need('backend/src/utils/cache-shards.js', 'writeEntries');
need('backend/src/utils/cache-shards.js', 'deleteEntries');
need('backend/src/utils/bounded-cache.js', '_ensureLoaded');
need('backend/src/utils/resource-cache.js', 'new CacheShards');
need('backend/src/utils/output-cache.js', 'digestLargeString');
need('backend/src/utils/download.js', 'deferPreprocess');
need('backend/src/utils/download.js', 'defaultFlowUserAgent');
need('backend/src/restful/sync.js', 'parseRawProxyEntries');
need('backend/src/restful/preview.js', 'parseRawProxyEntries');
need('backend/src/utils/yaml.js', 'jsonYamlReplacer');
need('backend/bundle-esbuild.js', 'stripPeggyGrammarPlugin');
need('backend/bundle-esbuild.js', 'dedupeNoblePlugin');
need('backend/src/products/sub-store-0.js', 'registerFileMetadataRoutes');
need('backend/src/restful/file-metadata.js', '/api/wholeFiles');
need('backend/src/vendor/express.js', 'flushLogEntries');
need('backend/src/vendor/express.js', 'INVALID_JSON');
forbid('backend/src/vendor/express.js', '"HEAD\'"');
need('backend/src/utils/debug-logs.js', 'flushLogEntries');
need('.github/scripts/fork-frontend/forkRequestGuard.ts', 'resolveApiPriority');
need('.github/scripts/fork-frontend/forkRequestGuard.ts', 'queuedPreviewGet');
need('.github/scripts/prepare_frontend_pages.py', 'PREVIEW_ROUTE_ANCHOR');
need('.github/scripts/prepare_frontend_pages.py', 'registerType: "autoUpdate"');
need('.github/scripts/prepare_frontend_pages.py', 'FILE_PREVIEW_GET_ANCHOR');
need('.github/scripts/prepare_frontend_pages.py', 'content-visibility:auto');
need('scripts/check/geo.js', 'prioritize_stale');
need('scripts/check/GEO-NOTICE.md', 'Upstream file blob SHA');
need('.github/scripts/check_geo_upstream.py', 'extract_recorded_blob_sha');
need('.github/workflows/sync-upstream.yml', 'check_geo_upstream.py');

if (failures.length > 0) {
    for (const message of failures) console.error(`::error::${message}`);
    process.exit(1);
}

console.log('fork runtime patches are present');
