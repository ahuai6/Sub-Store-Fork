#!/usr/bin/env node
/**
 * Reapply this fork's frontend URL and CORS origin.
 *
 * sync-upstream merges sub-store-org/Sub-Store into main. These two strings
 * are the only source edits that point the non-Node `/` redirect and the
 * default browser allowlist at the self-hosted frontend. The script is
 * idempotent. If upstream rewrites the anchors, it exits 1 without writing,
 * and sync-upstream refuses to push main.
 *
 *   node .github/scripts/apply-fork-frontend.mjs
 *   node .github/scripts/apply-fork-frontend.mjs --check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkOnly = process.argv.includes('--check');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const REDIRECT_FILE = 'backend/src/restful/miscs.js';
const CORS_FILE = 'backend/src/utils/cors.js';

const UPSTREAM_REDIRECT = 'https://sub-store.vercel.app/';
export const FORK_REDIRECT = 'https://ahuai6.github.io/Sub-Store-Fork-Dist/';
const REDIRECT_MARKER = "res.set('location',";

const UPSTREAM_ORIGINS =
    'https://sub-store.vercel.app,http://substore.stash,https://substore.stash';
const FORK_ORIGIN = 'https://ahuai6.github.io';
const FORK_ORIGINS = `${UPSTREAM_ORIGINS},${FORK_ORIGIN}`;

const failures = [];

function fail(message) {
    failures.push(message);
    console.error(`::error::${message}`);
}

function read(rel) {
    return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, text) {
    if (!checkOnly) {
        fs.writeFileSync(path.join(root, rel), text);
    }
}

function patchRedirect() {
    const text = read(REDIRECT_FILE);
    const lines = text.split('\n');
    const index = lines.findIndex((line) => line.includes(REDIRECT_MARKER));
    if (index < 0) {
        fail(
            `${REDIRECT_FILE} has no ${REDIRECT_MARKER} anchor, so the fork redirect was not applied.`,
        );
        return;
    }
    const line = lines[index];
    if (line.includes(FORK_REDIRECT)) {
        console.log(`${REDIRECT_FILE} already redirects to ${FORK_REDIRECT}`);
        return;
    }
    if (!line.includes(UPSTREAM_REDIRECT)) {
        fail(
            `${REDIRECT_FILE} redirect is neither ${UPSTREAM_REDIRECT} nor ${FORK_REDIRECT}.`,
        );
        return;
    }
    if (checkOnly) {
        fail(`${REDIRECT_FILE} still redirects to ${UPSTREAM_REDIRECT}.`);
        return;
    }
    lines[index] = line.replace(UPSTREAM_REDIRECT, FORK_REDIRECT);
    write(REDIRECT_FILE, lines.join('\n'));
    console.log(`updated ${REDIRECT_FILE}`);
}

function patchCors() {
    const text = read(CORS_FILE);
    const match = text.match(
        /export const NON_NODE_CORS_DEFAULT =\n    '([^']*)';/,
    );
    if (!match) {
        fail(
            `${CORS_FILE} is missing the NON_NODE_CORS_DEFAULT assignment, so the fork origin was not applied.`,
        );
        return;
    }
    const current = match[1];
    const origins = current.split(',');
    if (
        current.startsWith(UPSTREAM_ORIGINS) &&
        origins.includes(FORK_ORIGIN)
    ) {
        console.log(`${CORS_FILE} already allows ${FORK_ORIGIN}`);
        return;
    }
    if (current !== UPSTREAM_ORIGINS) {
        fail(
            `${CORS_FILE} default origins are '${current}', not '${UPSTREAM_ORIGINS}' or '${FORK_ORIGINS}'.`,
        );
        return;
    }
    if (checkOnly) {
        fail(`${CORS_FILE} does not allow ${FORK_ORIGIN}.`);
        return;
    }
    const needle = `export const NON_NODE_CORS_DEFAULT =\n    '${UPSTREAM_ORIGINS}';`;
    const replacement = `export const NON_NODE_CORS_DEFAULT =\n    '${FORK_ORIGINS}';`;
    if (!text.includes(needle)) {
        fail(`${CORS_FILE} replacement anchor was not found.`);
        return;
    }
    write(CORS_FILE, text.replace(needle, replacement));
    console.log(`updated ${CORS_FILE}`);
}

patchRedirect();
patchCors();
if (failures.length > 0) {
    process.exit(1);
}
