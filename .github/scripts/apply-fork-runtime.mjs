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

need('backend/package.json', '"bench"');
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
need('backend/scripts/bench.js', 'outputCacheHit5000');
need('backend/src/vendor/express.js', 'scriptResourceCache.flush');
need('scripts/check/geo.js', 'time_budget');
need(
    '.github/scripts/publish_public_dist.sh',
    'not copied to the public artifact repo',
);
need('.github/scripts/prepare_frontend_pages.py', 'patch_surge_session_guard');
need(
    '.github/scripts/fork-frontend/forkRequestGuard.ts',
    'sub-store-fork-api-cap:2',
);

if (failures.length > 0) {
    for (const message of failures) console.error(`::error::${message}`);
    process.exit(1);
}

console.log('fork runtime patches are present');
