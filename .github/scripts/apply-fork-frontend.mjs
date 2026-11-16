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
// Upstream 2.44.11 points `/` at this template instead of the Vercel URL.
const UPSTREAM_REDIRECT_TEMPLATE = '`${DEFAULT_FRONTEND_URL}/`';
export const FORK_REDIRECT = 'https://ahuai6.github.io/Sub-Store-Fork/';
const REDIRECT_MARKER = "res.set('location',";

const UPSTREAM_ORIGINS =
    'https://sub-store.vercel.app,http://substore.stash,https://substore.stash';
const FORK_ORIGIN = 'https://ahuai6.github.io';

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
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
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
    let updated = null;
    if (line.includes(UPSTREAM_REDIRECT)) {
        updated = line.replace(UPSTREAM_REDIRECT, FORK_REDIRECT);
    } else if (line.includes(UPSTREAM_REDIRECT_TEMPLATE)) {
        updated = line.replace(
            UPSTREAM_REDIRECT_TEMPLATE,
            `'${FORK_REDIRECT}'`,
        );
    }
    if (updated == null) {
        fail(
            `${REDIRECT_FILE} redirect is neither ${UPSTREAM_REDIRECT}, ${UPSTREAM_REDIRECT_TEMPLATE}, nor ${FORK_REDIRECT}.`,
        );
        return;
    }
    if (checkOnly) {
        fail(`${REDIRECT_FILE} still uses an upstream redirect.`);
        return;
    }
    lines[index] = updated;
    write(REDIRECT_FILE, lines.join(eol));
    console.log(`updated ${REDIRECT_FILE}`);
}

function patchCors() {
    const text = read(CORS_FILE);
    const match = text.match(
        /export const NON_NODE_CORS_DEFAULT =(\r?\n)    '([^']*)';/,
    );
    if (!match) {
        fail(
            `${CORS_FILE} is missing the NON_NODE_CORS_DEFAULT assignment, so the fork origin was not applied.`,
        );
        return;
    }
    const eol = match[1];
    const current = match[2];
    const origins = current.split(',');
    const keepsUpstreamPrefix =
        current === UPSTREAM_ORIGINS ||
        current.startsWith(`${UPSTREAM_ORIGINS},`);
    if (!keepsUpstreamPrefix) {
        fail(
            `${CORS_FILE} default origins are '${current}', which does not start with '${UPSTREAM_ORIGINS}'.`,
        );
        return;
    }
    if (origins.includes(FORK_ORIGIN)) {
        console.log(`${CORS_FILE} already allows ${FORK_ORIGIN}`);
        return;
    }
    if (checkOnly) {
        fail(`${CORS_FILE} does not allow ${FORK_ORIGIN}.`);
        return;
    }
    // Keep origins upstream added (for example https://sub.xream.eu.org) and
    // append the fork origin. Replacing the whole list would drop them.
    const needle = `export const NON_NODE_CORS_DEFAULT =${eol}    '${current}';`;
    const replacement = `export const NON_NODE_CORS_DEFAULT =${eol}    '${current},${FORK_ORIGIN}';`;
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
