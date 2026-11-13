# Performance plan audit — 2026-11-13

This audit covers main through PRs #5–#8 and PR #9, including the follow-up
module-header fix and the owner's request to publish the geo operator.

| Plan item | State and evidence |
| --- | --- |
| 0: fixed 5000-node benchmark | `backend/scripts/bench.js`, `backend/bench/baseline.json`; before/after table in PR #9. V8 host measurements, not Surge device timings. |
| 0: byte-identical producer safety net | `backend/src/test/proxy-producers/golden-snapshot.spec.js`; snapshots unchanged. |
| 1: identical heavy request sharing | `backend/src/utils/inflight.js`, wired into preview/download/node-info. One realm only: concurrent Node requests can share; independent Surge script sessions cannot. No persistent lock is claimed. |
| 1: frontend refresh guard + request cap | Implemented in `.github/scripts/fork-frontend/forkRequestGuard.ts`, reapplied by `prepare_frontend_pages.py`: API cap 2, block restored heavy previews until user action. **Not deployed on the live Pages site at audit time.** Live `frontend-version.txt` still says `patches=subpath-routes-1`; the required stamp is `subpath-routes-1-surge-session-1`. Owner must run `publish-frontend` after merge (or wait for its scheduled run). |
| Frontend timeout question | Published upstream frontend revision `6d13e7e257b52485d6835d1bbdbd1fc3f8270dd2`, `src/utils/requestTimeout.ts`: default API timeout **50000 ms**, overridden by positive `localStorage.apiRequestTimeout`. A browser timeout does not stop a running Surge script. Keep a geo `time_budget` below the chosen frontend timeout, allowing overhead, or raise the frontend setting for longer checks. |
| 1: geo script improvements | Batched writes, short hashed cache IDs, compiled template/regex, max 20 workers, optional time budget with 880s safety ceiling. Public upload now explicitly authorized; published with GPL license + upstream notice. |
| 2: final output cache | `output-cache.js`; expires under `resourceCacheTtl`, explicit zero/noCache/noOutputCache bypass. An unchanged fingerprint never extends expiration. |
| 2: shared node checks | `check-result-cache.js` on `scriptResourceCache` helpers; `scriptCacheTtl`, TTL zero disables persistent result reads/writes. Turning geo `cache` off forces checks again; identical pending requests may still share within the run. |
| 2: scheduled prefetch | `prefetch-cron.js`, cron product and rendered module. Opt-in, warmed output has `resourceCacheTtl`, no permanent result. The invalid bare-colon module defaults found by the screenshot are fixed in this follow-up; actual rendered header syntax is now checked. |
| 3: getFlag + precompiled parsers | Compiled matchers and Peggy-generated modules, required build/test generation; original grammars retained. |
| 3: simple bundle + writes | File routes on sub-store-1, no ProxyUtils import on sub-store-0; ordinary Node writes update one JSON document and skip unchanged strings, script resources batch writes. Core JSON object format unchanged. |
| 4: Surge build | Compile flag and adapter stripping on Surge bundles; all producers, parsers, lodash and other host source retained. |
| 5: target dedup | Identical routing identities share only pending requests. Wider server+port+type grouping requires `dedup_target=true`; it is not a proof that different credentials use the same exit. No historical exit IP bypasses TTL. |
| 5: two-phase checks | `two_phase=true` does a cheap probe before full geo per node, bounded by concurrency and remaining budget. Probe failures skip geo; budget skips do not cache failure. Default off. |
| 5: isolated store values | Output/script/check maps migrate from legacy inline maps to per-key shards above 64KiB; <=3MiB serialized UTF-8 per value. Old expiry is retained, migration interruption preserves old data, refresh removes tracked shards. One oversized item is skipped, not split into chunks. Total device storage remains finite. |
| Legacy cache TTL audit | Raw-resource and flow-header caches also treated explicit TTL zero as the default before this follow-up. They now disable reads/writes at zero, cap custom lifetimes to the global setting and honor subsequently shortened TTLs on new entries. |
| One-click clear | Existing `/api/utils/refresh` clears resource, script, headers, output and shared-check stores; shard cleanup uses the existing revoke methods. |
| Upstream synchronization | URL/CORS patch is reapplied automatically; frontend build patches are replayed against source anchors. Runtime changes survive a clean merge and are checked by `apply-fork-runtime.mjs` at sync/publish time, including the new step-5 and module fixes. A dropped runtime patch stops the sync for manual repair; the guard does not reconstruct arbitrary rewritten upstream code. |
| Publishing restrictions | No upload-artifact added, no force push, no branch deletion. PR #9 is merged only after the owner's explicit instruction and green checks. Manual workflow dispatch remains the owner's action. |
| star-history | Still active and unchanged. Stopping it was an undecided optional item, not a runtime fix. |

## Screenshot: `模块头部的参数声明格式错误: prefetch_cron:`

The published renderer introduced `prefetch_cron:,prefetch_sub:,prefetch_col:`.
Surge rejects a colon with no value. The documented syntax makes the default
optional, so unset parameters now use bare names:

```text
prefetch:"# Sub-Store Prefetch",prefetch_cron,prefetch_sub,prefetch_col,prefetch_platform:Surge
```

The default cron stays commented out and the backend returns without doing any
work if called with an empty schedule. The upstream `config/Surge-Beta.sgmodule`
remains unchanged; only the rendered public copy is patched.

A new parser/check validates the real rendered header, including quoted commas,
optional defaults, duplicate declarations and unmatched quotes. Five regression
tests run in publish-dist, including rejection of the old screenshot header.
See https://manual.nssurge.com/profile/module.html (Parameter Tables).

After main publish-dist completes, reinstall/update the public beta module.
Existing installed module parameters may persist, so use a fresh install if
Surge retains an old invalid parameter declaration. Device installation and
end-to-end checks still require Surge iOS.
