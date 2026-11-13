# Step 5: Surge checks and cache shards

Started from main `09e6d6a312efd0be5c0de38193fce173475c9efb`, including merged
PRs #5–#8. At the owner’s explicit request, `scripts/check/geo.js` is now published as
Dist `main/geo.js` and a release asset, with its upstream GPL license and notice.
Use https://raw.githubusercontent.com/ahuai6/Sub-Store-Fork-Dist/main/geo.js
as a Sub-Store Script Operator. See `scripts/check/GEO-NOTICE.md` for attribution
and the upstream README’s additional terms.

## Geo arguments

Existing arguments and output templates still work. New arguments are optional:

| Argument | Default | Meaning |
| --- | --- | --- |
| `two_phase` | false | Check reachability through the node before requesting geo. |
| `reachability_url` | `http://www.gstatic.com/generate_204` | Cheap endpoint used by phase one. |
| `reachability_timeout` | 1500 | Phase-one timeout in milliseconds, capped at 5000; no retries. |
| `dedup_target` | false | Share concurrent requests for the same server, port and proxy type within this invocation, even if credentials differ. |
| `time_budget` | existing optional argument | Milliseconds; stop starting nodes, phase two, and retries once exhausted. Requests use the remaining timeout. Safety ceiling is 880000 ms, leaving time before Surge's 900 s script limit. |

For example: `two_phase=true&reachability_timeout=1500&time_budget=120000`.
Choose a probe URL reachable in your network. A failed probe is treated like an
existing failed geo check, including `remove_failed` and failure-cache behavior.
A node skipped because of budget exhaustion keeps its original name and gets no
new failure cache entry. Checks perform phase one then phase two per node; the
worker pool is capped at 20, including retries and both phases. Invalid or zero
concurrency falls back to 10.

Identical routing identities share concurrent HTTP requests even with `cache`
disabled. The run's map holds only pending requests and is discarded when they
settle. `dedup_target=true` widens this to server + port + proxy type. Enable it
only when those nodes actually use the same forwarding policy: different users
or passwords on the same server can route to different exits. An entry server
alone cannot establish egress equivalence. Distinct targets are not merged just
because their previous geo results reported the same exit IP.

Repeated results across invocations require `cache` and the existing TTL-bound
stores. New modes have distinct cache keys. `scriptCacheTtl=0` disables reads and
writes in every geo path, including the legacy script cache. Expired node config
hashes never bypass a new test. Pending shared-check completion after refresh
cannot repopulate the shared store.

## Storage and migration

Output uses `resourceCacheTtl`; script resources and shared checks use
`scriptCacheTtl` (seconds). Existing absolute expiration timestamps survive
migration. New entries also record creation time, so reducing the global TTL
shortens their effective lifetime. Increasing it does not extend their original
deadline. Legacy records without creation time keep their existing deadline.

Maps up to 64 KiB retain the old single-key layout. Larger maps migrate to
independent per-cache-key host values. The original cache key becomes a versioned
manifest; its shard keys use the original key plus `:v1:` and an MD5 of the entry
ID. Subscription output keys already include subscription identity; check keys
can continue sharing results between subscriptions inside their TTL. A large
subscription cannot evict other cache keys. This addresses the **per-value** iOS
limit; it is not a promise of unlimited device storage or RAM.

Values are measured in UTF-8 bytes including JSON escaping, with a 3 MiB cap per
shard and manifest. Output/check entries still obey `cacheThreshold`; oversized
script-resource entries are not cached. This does not split one oversized entry
into chunks. Old unshardable values remain readable in the old layout if migration
cannot be committed; cache misses are recomputed normally.

The staging manifest retains legacy data until shard writes succeed and tracks
new shards before writing them. Interrupted migration keeps old entries readable.
Corrupt/missing shards do not hide healthy ones. Expired entries are pruned on
load/write; lookups enforce TTL too. Refresh/clear-cache calls the same revoke
methods and removes all tracked shards, then resets the old key to `{}`.
`sub-store.json` and `root.json` remain ordinary JSON objects; only cache values
change layout. Older backend versions cannot read a migrated manifest, so clear
cache before rolling back.

After merging, wait for the main publish-dist run, then refresh the backend
scripts in Surge. Refresh the beta module if the PR #7 route changes have not
already been installed. No new module arguments are required for this step.
Two-phase checks and wider target dedup remain off until explicitly enabled in
the geo script arguments. Automated tests use simulated HTTP and host
stores; actual Surge iOS latency and device storage behavior require device testing.
