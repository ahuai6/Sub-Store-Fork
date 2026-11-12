# Sub-Store rewrite and Surge performance audit

**Date:** 2026-11-12  
**Tree:** backend `package.json` version `2.44.8`  
**Scope:** backend only. The Vue frontend (GitHub Pages) is out of scope except for the HTTP API it calls.  
**Method:** read of `backend/src` and `config/`, `pnpm bundle:esbuild`, Node 22.23.4 / V8 timings in `docs/audit-bench/`. Surge behavior is from the current manual (https://manual.nssurge.com/scripting/), not from an on-device run. This VM cannot host Surge iOS or Surge Mac.

## Verdict

Do not rewrite Sub-Store in another language if the product still has to run inside Surge and still has to execute user JavaScript.

Surge's script host is JavaScript only. There is no native addon, and WebAssembly is not a documented Surge script feature. `engine=jsc` runs in the Network Extension process, where iOS does not give you JIT, and Apple has disabled WebAssembly in JavaScriptCore on iOS. `engine=webview` is WKWebView: it has JIT and, as a web view, WebAssembly, but the script is still JavaScript, user scripts are still `new Function`, and every request still starts from a cold context. A Rust or Go core compiled to Wasm would sit behind that JS host, copy every proxy object across the boundary, and make the daily upstream merge impossible.

The work that actually hurts is visible in the current JS, and it is patchable without a rewrite:

1. `getFlag()` rebuilds a large dictionary and compiles a new `RegExp` per keyword per node. On 5,000 SS nodes that is ~276 ms for the flag operator and ~267 ms for the region filter (V8). The rest of a six-operator chain is tens of milliseconds.
2. Peggy grammars are compiled with `peggy.generate()` on first use. That is ~127 ms on V8 (Surge 75 ms, Loon 30 ms, QX 22 ms), and Surge throws the module away after `$done()`, so it is paid on every request that touches those parsers. The Peggy compiler is also inside every 1.3 MB bundle.
3. The `sub-store-0` / `sub-store-1` split does not shrink the program. Both official bundles are ~1.3 MB because `file.js` statically imports `produceArtifact`, which imports `ProxyUtils`. Cold eval of either bundle in a fresh V8 context is ~60–70 ms before any subscription is parsed.
4. Clash YAML is parsed twice (preprocessor, then per line). 5,000 Clash nodes took ~745 ms. 5,000 SS URIs took ~19 ms.
5. On Surge, `$persistentStore` values are capped at 4 MB on iOS and 32 MB on Mac. Resource caches are one JSON value per key. That cap is a hard product limit, not something a faster language removes.

Keep tracking upstream in JavaScript. Land a small patch set (flag/region regex cache, bundle-time Peggy, a real split of the simple script, less whole-store rewriting). Use `engine=auto` / webview, which the module already defaults to. Use the existing produce cron so interactive fetches hit cache.

## 1. Architecture

### What the process actually is

One JavaScript program. `esbuild` bundles it to an IIFE for proxy apps and to CommonJS for Node (`backend/bundle-esbuild.js`). There is no separate native component in the app builds. Node-only libraries (`express`, `undici`, `cron`, `dotenv`, `@maxmind/geoip2-node`, `shoutrrr-ts`) are pulled through `eval('require(...)')` or `eval('import(...)')` so the browser build leaves them external. The Node bundle then re-bundles `dist/sub-store.no-bundle.js`.

Runtime platform detection is in `backend/src/vendor/open-api.js` (`ENV()`):

| Signal | Treated as |
| --- | --- |
| `typeof process !== "undefined"` (via `eval`, so the bundler does not inline it) | Node |
| `typeof $task !== "undefined"` | Quantumult X |
| `typeof $loon !== "undefined"` | Loon |
| `'undefined' !== typeof Egern` | Egern |
| `typeof $httpClient !== "undefined"` and not Loon/Egern | Surge |
| `$environment['stash-version']` | Stash |
| `typeof $rocket !== "undefined"` | Shadowrocket |
| `typeof $native !== "undefined"` | LanceX |
| `typeof $Plugins !== "undefined"` | GUI.for.Cores |

`backend/src/utils/env.js` maps that to the string the API returns (`Node`, `QX`, `Loon`, `Stash`, `Shadowrocket`, `Egern`, `Surge`, `LanceX`, `GUI.for.Cores`).

### Entrypoints

| Product | Source | Runs on | What it registers |
| --- | --- | --- | --- |
| Node server | `backend/src/main.js` → `backend/src/restful/index.js` | Node, long-lived process | Every route, including `/api/proxy/parse` and `/api/rule/parse`, optional cron, optional static frontend |
| Simple script | `backend/src/products/sub-store-0.js` | First matching `http-request` for `^https?:\/\/sub\.store` | CRUD: subs, collections, files, artifacts, modules, tokens, archives, settings, sort, logs, env, backup, age keys |
| Core script | `backend/src/products/sub-store-1.js` | First matching `http-request` for `download`, `api/preview`, `api/sync`, `api/utils/node-info` | Download, share, preview, sync, node info |
| Cron | `backend/src/products/cron-sync-artifacts.js` | `type=cron` | Gist sync, or produce named subs/collections to refresh cache |
| Loon resource parser | `backend/src/products/resource-parser.loon.js` | Loon resource parser (`$resource`, `$resourceType`, `$resourceUrl`) | Parse nodes/rules with `ProxyUtils` / `RuleUtils` |
| Library | `backend/src/products/proxy-utils.esm.js` | Not a Surge script | Re-exports `parse` / `produce` |

App wiring:

- Surge: `config/Surge.sgmodule`, `config/Surge-Beta.sgmodule` (same script list; Beta is the parameterised module the README points at for current TestFlight), `config/Surge-ability.sgmodule`, `config/Surge-Noability.sgmodule`.
- Loon: `config/Loon.plugin`, plus `config/Loon-parser.plugin`.
- Quantumult X: `config/QX.snippet` (rewrite) and `config/QX-Task.json` (cron).
- Stash: `config/Stash.stoverride`.
- Shadowrocket: the README tells users to install `config/Surge-Noability.sgmodule`.
- Egern: `config/Egern.yaml`. The file notes Egern's script timeout is fixed at 900 s in that module.

Surge runs **at most one** `http-request` script per request: the first enabled script whose pattern matches (https://manual.nssurge.com/scripting/http-request.html). Core is listed first and its pattern is narrower, so download/preview/sync/node-info stay on `sub-store-1`. Everything else under `sub.store` stays on `sub-store-0`. The two scripts do not both execute.

`/api/proxy/parse` and `/api/rule/parse` are registered only from `backend/src/restful/index.js`. On a Surge module those paths hit `sub-store-0` and 404. They exist for the Node server.

### Bundle sizes

Built with `pnpm bundle:esbuild` on this tree. Gzip is `zlib.gzipSync` of the file.

| Artifact | Raw | Gzip |
| --- | ---: | ---: |
| `backend/dist/sub-store-0.min.js` | 1,338,153 (1.28 MiB) | 396,065 |
| `backend/dist/sub-store-1.min.js` | 1,327,056 (1.27 MiB) | 392,244 |
| `backend/dist/cron-sync-artifacts.min.js` | 1,288,527 (1.23 MiB) | 381,324 |
| `backend/dist/sub-store-parser.loon.min.js` | 1,281,277 (1.22 MiB) | 379,409 |
| `backend/dist/proxy-utils.esm.mjs` | 1,279,104 (1.22 MiB) | 378,864 |
| `backend/sub-store.min.js` (browser IIFE of `src/main.js`) | 1,385,212 (1.32 MiB) | 411,927 |
| `backend/dist/sub-store.bundle.js` (Node) | 3,351,668 (3.20 MiB) | 1,049,215 |

`sub-store-0` is **larger** than `sub-store-1`. The comment at the top of `sub-store-0.js` says it does not include parsers. The import graph does: `backend/src/restful/file.js` imports `produceArtifact` from `backend/src/restful/sync.js`, and `sync.js` imports `ProxyUtils` and `RuleUtils`. esbuild therefore ships parsers, producers, Peggy, lodash, and the age stack in both scripts. A fresh esbuild metafile (same browser/IIFE settings, `write: false`, no `Object.hasOwn` inject) puts unminified input at about 3.6 MB for `sub-store-0` and 3.6 MB for `sub-store-1`. Largest inputs:

| Input | Bytes |
| --- | ---: |
| `lodash/lodash.js` | 545,945 |
| `jsrsasign/lib/jsrsasign.js` | 345,321 |
| `yaml` (package) | 279,703 |
| `peggy` (package, including its own parser) | 223,178 |
| `@noble/curves` | 505,254 |
| `@noble/hashes` | 129,681 |
| `@noble/ciphers` | 82,624 |
| `ip-address` | 106,752 |
| `src/core/proxy-utils/parsers/index.js` | 116,254 |
| `src/core/proxy-utils/producers/sing-box.js` | 68,237 |
| `src/core/proxy-utils/producers/uri.js` | 63,374 |
| `src/core/proxy-utils/processors/index.js` | 59,062 |

`@noble/*` and `age-encryption` come from `backend/src/utils/age.js`. `jsrsasign` comes from `backend/src/utils/rs.js` (CA fingerprint). Peggy is imported by `parsers/peggy/surge.js`, `loon.js`, and `qx.js`. `source-map-generator` is pulled in because the Peggy compiler emits source maps. None of that is needed to answer `GET /api/utils/env`.

Non-test `backend/src` is 33,206 lines. The heavy files are `parsers/index.js` (3,214), `processors/index.js` (1,838), `producers/sing-box.js` (1,712), `producers/uri.js` (1,631), `producers/surge.js` (1,415), `proxy-utils/index.js` (1,209).

`dist/runtime-manifest.json` records the Node bundle's external builtins (`fs`, `worker_threads`, `child_process`, …), `requiresEval: true`, and tested Node `24.22.1` (from `.node-version`). This audit ran the benchmarks on Node 22.23.4.

esbuild is not given a `target`. It emits modern syntax and minifies. The bundle injects `core-js/actual/object/has-own`. It does not downlevel to ES5. That is the right direction for current JSC; forcing an older target would make Surge slower.

### How a request runs

On a proxy app, `backend/src/vendor/express.js` is not Express. `app.start()` calls `dispatch($request)`, picks the longest matching route, and the handler finishes with `$.done({ response })`. On Node, the same route table is mounted on real Express (`eval('require("express")')`).

User scripts are not a sandbox. `createDynamicFunction` in `backend/src/core/proxy-utils/processors/index.js` builds `new Function(...)` whose body is the user source plus `return operator` / `return filter` / `return transformFunction`. On failure it retries with the shortcut form (`$server` / `$res` inlined into a loop). There is no `vm`, no frozen global, no CSP. `require` is passed through on Node (`eval('typeof require !== "undefined"') ? require : undefined`) and is `undefined` on Surge. A user script can read host globals (`$request`, `$persistentStore`, `$httpClient`, `$done`) because `new Function` runs against the global environment.

Peggy is not precompiled. `getParser()` in `parsers/peggy/surge.js` (and the Loon/QX twins) calls `peggy.generate(grammars)` once per process and caches the result on a module-level `let`. Surge starts a new process per script run, so the cache does not survive `$done()`.

### Storage

`OpenAPI.initCache()` / `persistCache()` / `read` / `write` / `delete` in `backend/src/vendor/open-api.js`:

- Surge, Loon, Egern: one `$persistentStore` string under the key `sub-store`, pretty-printed (`JSON.stringify(cache, null, 2)`).
- Keys passed by Sub-Store with a `#` prefix are a different store key (the `#` is stripped). That is how resource bodies, header cache, script cache, and logs stay out of the main document. Constants in `backend/src/constants.js`: `#sub-store-cached-resource`, `#sub-store-cached-headers-resource`, `#sub-store-cached-script-resource`, `#sub-store-logs`.
- QX uses `$prefs`. GUI.for.Cores uses `$Plugins.SubStoreCache`. Node uses `sub-store.json` and `root.json` under `SUB_STORE_DATA_BASE_PATH` (default `.`). `#` keys on Node live in `root.json`.

Main document keys include `subs`, `collections`, `files`, `modules`, `artifacts`, `settings`, `tokens`, `archives`, `schemaVersion`.

Every non-`#` `write()` rewrites the whole document. Every `#` `write()` rewrites that entire cache value (`ResourceCache._persist`). Constructors also `JSON.parse` the cache on startup, and if a cache key is missing they write `{}` immediately. A sandbox eval of `sub-store-0.min.js` for `GET /api/utils/env` created all four keys before returning.

Surge's current manual: `$persistentStore.write` accepts a string, max **4 MB on iOS and 32 MB on Mac**. Download caching (`backend/src/utils/download.js`) stores the raw body in the single resource-cache value. Default `cacheThreshold` is 1024, compared as **KB** (`body.length / 1024`). One resource may be cached up to ~1 MB, but many resources share one value, so a handful of subscriptions can hit the 4 MB iOS cap. Writes then fail or truncate. A faster parser does not raise that cap.

### Dependencies that matter

Runtime `dependencies` in `backend/package.json`: `@maxmind/geoip2-node` (Node, `eval`), `age-encryption`, `body-parser`, `buffer`, `connect-history-api-fallback`, `core-js`, `cron` (Node), `dns-packet`, `dotenv`, `express`, `fastestsmallesttextencoderdecoder`, `fetch-socks`, `http-proxy-middleware`, `ip-address`, `js-base64`, `json5`, `jsrsasign`, `lodash`, `mime-types`, `ms`, `nanoid`, `semver`, `shoutrrr-ts`, `undici`, `yaml`. Peggy is a devDependency but it is imported by runtime parser files, so it is inside the app bundles. The app does not use the old `js-yaml` package; YAML goes through `yaml` via `backend/src/utils/yaml.js`.

## 2. Compatibility surface a rewrite must keep

### User script API

Built in `createDynamicFunction`. The function parameters, in order, are:

`$arguments`, `$options`, `$substore`, `lodash`, and on Loon also `$persistentStore`, `$httpClient`, `$notification`, then `ProxyUtils`, `yaml`, `Buffer`, `b64d`, `b64e`, `DOMAIN_RESOLVERS`, `scriptResourceCache`, `flowUtils`, `produceArtifact`, `require`.

`lodash` is the full library (`import lodash from 'lodash'`). Scripts call whatever they want on it. Replacing it with `lodash.get` only will break real scripts.

`$substore` is the `OpenAPI` instance (`backend/src/core/app.js`): `.read` / `.write` / `.delete`, `.http`, `.notify`, `.log` / `.info` / `.warn` / `.error`, `.env`, `.node` (Node only), `.cache`, `.done`, `.wait`.

`ProxyUtils` (`backend/src/core/proxy-utils/index.js`) is:

`parse`, `process`, `processResponse`, `produce`, `age` (`encrypt` / `decrypt` / `derivePublicKey`), `ipAddress`, `getRandomPort`, `isIPv4`, `isIPv6`, `isIP`, `yaml`, `getFlag`, `removeFlag`, `getISO`, `MMDB`, `Gist`, `download`, `downloadFile`, `isValidUUID`, `doh`, `Buffer`, `Base64`, `JSON5`, `hex_md5`.

`flowUtils` is `getFlowField`, `getFlowHeaders`, `parseFlowHeaders`, `flowTransfer`, `validCheck`, `getRmainingDays`, `normalizeFlowHeader`.

`yaml` is `ProxyUtils.yaml` (`safeLoad` / `load` / `safeDump` / `dump` / `parse` / `stringify`). `b64d` / `b64e` are `ProxyUtils.Base64.decode` / `.encode`.

Required shapes, from the comments and the fallback templates in `processors/index.js`:

- Script operator: `function operator(proxies, targetPlatform, context) { return proxies }`, or a shortcut that assigns `$server` inside an implicit per-node loop. For mihomo profile files the same script may be a YAML merge patch, or define `async function main(config)`.
- Script filter: `function filter(proxies, targetPlatform, context)` returning a boolean array, or a shortcut that returns a boolean for `$server`.
- Response transformer: `function transformFunction(res, context)`, or a shortcut using `$res`.

`context` gets `source`, `env` (backend name, version, meta), and for collections `raw` keyed by subscription. A script may set `context.process = { type: 'disable'|'enable', customNames }` to skip later operators (`shouldSkipByContext`).

Scripts are loaded by `loadScriptItem`: inline `args.content`, `mode: 'link'` to `/api/file/...`, `/api/module/...`, an absolute path (Node), or an HTTP URL via `download()`. On Node, script operators throw unless `SUB_STORE_FRONTEND_BACKEND_PATH` is set (or `SUB_STORE_BACKEND_CUSTOM_NAME`).

Host globals that scripts also use, because they are real Surge/Loon/QX globals, not Sub-Store injections: `$persistentStore`, `$httpClient`, `$notification`, `$done`, `$request`, `$environment`, `$argument`. On Surge those are the manual's API, including `$httpClient` options `policy`, `policy-descriptor`, `timeout`, `insecure`, `auto-redirect`, `auto-cookie`, `binary-mode`. Sub-Store's own HTTP wrapper passes `policy-descriptor` when `$environment['surge-build'] >= 2407`.

`config/README.md` says current Surge removed the `ability: http-client-policy` script parameter and that the module line is left as-is because landing-node tests still work. The manual's replacement is the per-request `policy` / `policy-descriptor` fields.

### Operators and filters (names are the API)

From the default export of `processors/index.js`:

Filters: `Useless Filter`, `Region Filter`, `Regex Filter`, `Type Filter`, `Script Filter`, `Conditional Filter`.

Operators: `Quick Setting Operator`, `Flag Operator`, `Sort Operator`, `Regex Sort Operator`, `Regex Rename Operator`, `Regex Delete Operator`, `Script Operator`, `Add Proxies From Subscription Operator`, `Handle Duplicate Operator`, `Resolve Domain Operator`.

Plus the response transformer type used by `processResponse`.

`ApplyOperator` deep-clones with `JSON.parse(JSON.stringify(object))` before every operator.

### Internal proxy object

There is no JSON Schema file. The internal node is the object parsers return and `lastParse()` normalizes (`proxy-utils/index.js`). It is Clash-shaped:

- Identity: `name`, `type`, `server`, `port`, `udp` (defaulted on unless explicitly false).
- Common: `username`, `password`, `cipher`, `uuid`, `sni`, `tls`, `alpn`, `skip-cert-verify`, `tfo`, `network`, `plugin`, `plugin-opts`, `ports`, `interface-name`.
- Transport bags, keys lowercased when they end in `-opts`: `ws-opts`, `grpc-opts`, `h2-opts`, `http-opts`, `reality-opts`, `ech-opts`, `xhttp-opts`, `obfs-opts`, `shadow-tls` folded into `plugin: 'shadow-tls'`.
- Protocol-specific fields kept as parsed (`hop-interval`, `obfs-password`, WireGuard keys, Hysteria bandwidth, and so on).

`type` values the Clash parser accepts include `ss`, `ssr`, `vmess`, `vless`, `trojan`, `http`, `socks5`, `snell`, `tuic`, `hysteria`, `hysteria2`, `wireguard`, `ssh`, `direct`, `anytls`, `mieru`, `masque`, `masque-surge`, `sudoku`, `juicity`, `h2-connect`, `naive`, `trusttunnel`, `tailscale`, `zerotier`, `shadowquic`, `gost-relay`, `openvpn`, `easytier`. URI and platform parsers cover the subsets listed in the root `README.md`. Producers then drop or rewrite what the target cannot represent (`supported[target] === false`, root `headers` checks, SS-over-TLS, Reality public key).

Targets in `producers/index.js`: QX / QuantumultX, Surge, SurgeMac, Loon, Clash (deprecated path, still present), Clash.Meta / mihomo (several aliases), URI, V2Ray, JSON, Stash, Shadowrocket, Surfboard, sing-box, Egern.

Input detection is a preprocessor chain then a line loop (`preprocessors/index.js`, `parsers/index.js`): HTML discard, Clash YAML (`proxies:` / `proxy-groups:` → one JSON line per proxy), Base64 and fallback Base64, SSD, full Surge/QX config section extract, then per-line URI and platform parsers. The line loop remembers the last successful parser.

Rule files are a second, smaller pipeline: `backend/src/core/rule-utils/` (Clash provider preprocess, one parser, producers for QX filter, Surge rule set, Loon rules, Clash rule provider).

### REST API the frontend calls

Response shape is `{ status, data }` or `{ status: 'failed', error }` via `backend/src/restful/response.js`.

| Method | Path | Script |
| --- | --- | --- |
| GET, PATCH, DELETE | `/api/sub/:name` | 0 |
| GET | `/api/sub/flow/:name` | 0 |
| GET, POST, PUT | `/api/subs` | 0 |
| GET, PATCH, DELETE | `/api/collection/:name` | 0 |
| GET, POST, PUT | `/api/collections` | 0 |
| GET, PATCH, DELETE | `/api/file/:name` | 0 |
| GET | `/api/wholeFile/:name`, `/api/wholeFiles` | 0 |
| GET, POST, PUT | `/api/files` | 0 |
| GET | `/share/file/:name` | 0 |
| GET, POST, PUT | `/api/artifacts` | 0 |
| GET | `/api/artifacts/restore` | 0 |
| GET, PATCH, DELETE | `/api/artifact/:name` | 0 |
| GET, PATCH, DELETE | `/api/module/:name` | 0 |
| GET, POST, PUT | `/api/modules` | 0 |
| GET, PATCH | `/api/settings` | 0 |
| POST | `/api/sort/subs`, `/collections`, `/artifacts`, `/files`, `/tokens`, `/archives` | 0 |
| GET | `/api/archives` | 0 |
| GET, DELETE | `/api/archives/:id` | 0 |
| POST | `/api/archives/:id/restore` | 0 |
| POST | `/api/token` | 0 |
| GET | `/api/tokens` | 0 |
| DELETE | `/api/token/:token` | 0 |
| GET, DELETE | `/api/logs` | 0 |
| GET | `/api/utils/env`, `/api/utils/backup`, `/api/utils/refresh` | 0 |
| GET, and the storage route's other verbs | `/api/storage` | 0 |
| POST | `/api/utils/age/key-pair`, `/api/utils/age/public-key` | 0 |
| GET | `/download/:name`, `/download/:name/:target` | 1 |
| GET | `/download/collection/:name`, `/download/collection/:name/:target` | 1 |
| GET | `/share/sub/...`, `/share/col/...` (same shapes) | 1 |
| POST | `/api/preview/sub`, `/api/preview/collection`, `/api/preview/file` | 1 |
| GET | `/api/sync/artifacts`, `/api/sync/artifact/:name` | 1 |
| POST | `/api/utils/node-info` | 1 |
| POST | `/api/proxy/parse`, `/api/rule/parse` | Node only |

Download query/path selects the producer (`target` / `platform`), with User-Agent fallback in `backend/src/utils/user-agent.js` (`Surge`, `SurgeMac`, `QX`, `Loon`, `Shadowrocket`, `Stash`, `Egern`). SurgeMac options: `mihomoExternal`, `mihomoMerge`, `mihomoMergeName`, `mihomoLocalPort`.

Other behavior that is part of the product, not an internal detail: Gist backup and artifact sync (`utils/gist.js`, `restful/sync.js`, `restful/artifacts.js`), share tokens, age-encrypted subscription bodies and age-encrypted output, flow headers, ignore-failed-remote-sub, resource cache TTL (`resourceCacheTtl`, default 1 hour), script cache TTL default 48 hours, header cache default 1 minute, optimistic `cacheKey` refresh, GitHub proxy prefix, `backendRequestConcurrency` default 10, archives of deleted entities, cron produce of named subs/collections.

A rewrite that only reimplements `parse` / `produce` drops more than half of this.

## 3. Rewrite by language

### Inside Surge: JavaScript, or it does not run

From the manual (fetched 2026-11-12):

- Script types include `http-request`, `http-response`, `cron`, `event`, `dns`, `rule`, `generic`. Sub-Store uses `http-request` and `cron`.
- `engine=jsc`: fast to start, runs inside the NE process on iOS, raises NE memory, at most 2 concurrent JSC sessions. No JIT. The manual does not list WebAPI here.
- `engine=webview`: separate process, JIT, WebAPI (`fetch`, `crypto`, `TextDecoder`, …), at most 3 concurrent sessions, higher startup, large bodies cross a process boundary. `auto` means webview wherever it exists. iOS has both. macOS 11+ has both. macOS 10.15 and below, and tvOS, are JSC only.
- `timeout` default is 5 seconds. The module sets 900. JSC can abort a stuck synchronous loop; webview is a wall clock only.
- `requires-body` buffers the whole body. `max-size` default is 1 MB iOS / 10 MB Mac. The module sets `-1` (uncapped, with a documented hard cap, 32 MB for request bodies).
- `$httpClient`: at most 20 concurrent requests per run; bodies capped at 32 MB iOS / 256 MB Mac.
- `script-update-interval` default 86400 s. The module does not override it.
- `clearTimeout` exists only on webview. Pending timers are cancelled when the run ends.

WebAssembly, checked against that manual and against JSC's iOS history:

- The Surge manual never mentions `WebAssembly`. It says WebAPI is a webview feature.
- Wasmer's JSC notes: Apple disabled WebAssembly in JavaScriptCore on iOS 16.4. App-process JSC and WKWebView are different. WKWebView has had `WebAssembly.instantiate` for years.
- This audit did not run a Wasm module on a device. The practical conclusion is still strong enough to reject a Wasm port: it is not available on `engine=jsc`, it is only plausible on `engine=webview`, and even there the host that must keep working is the JS `new Function` sandbox. Proxy arrays would be copied in and out. The 1.3 MB JS startup would remain, plus the Wasm bytes. Peggy-class wins (tens to hundreds of milliseconds) are smaller than that tax once the flag-operator bug is fixed. Shipping Wasm also fights the "scripts are a cached JS file" model (`script-path` is one JS URL).

So:

| Option | Speed | User-script risk | Effort | Upstream |
| --- | --- | --- | --- | --- |
| TypeScript, same bundles | None. It is the same JS after emit. | Low if the emit stays a single IIFE and the runtime API is unchanged. | High. ~33k lines, plus Peggy strings and `eval`/`new Function`, which types do not make safe. | Daily merges become conflicts on almost every upstream parser/producer commit. |
| Rust/Go → Wasm, called from the existing JS | Maybe 2–5× on Clash YAML and the flag scan **after** the JS shell is already up, on webview only. Cold start gets worse. `engine=jsc` and tvOS/old macOS cannot run it. | The shell must stay JS. Any drift in the proxy object or in `operator()` semantics is a user-visible break. | A second implementation of every parser and producer, plus a JS FFI, plus a way to load the `.wasm`. | Effectively a fork. Upstream patches no longer apply. |
| Rust/Go native, Node/server only | Real on the server: YAML and the flag loop would drop from hundreds of milliseconds to a few. Node is already fast enough that this is not the outage (5,000 SS URIs parse in 19 ms on V8; Clash 5,000 in 745 ms). | The Surge build is untouched only if you keep the JS engine for scripts. A native core that "supports scripts" still has to embed a JS engine and re-create `$substore` / `ProxyUtils`. Two backends will diverge the first week a protocol field is added upstream. | Large, and it does not fix iOS memory or the 4 MB store. | Node and app builds stop sharing `parsers/` and `producers/`. |
| Stay on JS, change the hot spots below | The flag/region path should fall from ~270 ms to the same order as the other operators (a few milliseconds on V8) if the regex table is built once. Peggy's ~127 ms and a chunk of the 1.3 MB leave the request if grammars are generated at bundle time. A real `sub-store-0` split cuts CRUD memory. | Low when the patch does not change operator names, proxy fields, or the `new Function` parameters. | Small compared with a rewrite. Conflicts are limited to `geo.js`, the bundler, and the `file.js` → `sync.js` edge. | You can keep merging upstream daily and rebase these patches. |

**Clear verdict:** a rewrite is not worth it, and a non-JS core is not viable for the Surge product. TypeScript does not make Surge faster. Native code helps only the long-lived Node process, which is not where the memory kills happen, and it splits the code from upstream.

## 4. Performance, measured

Host: Node v22.23.4, Linux x64, Intel Xeon (this cloud VM), V8 with JIT. Numbers are medians of 3 runs after one warmup unless noted. `console` was silenced during timed sections because `$.info` / `$.error` write a lot and `prependConsoleTimestamp` in `backend/src/utils/debug-logs.js` prefixes Node logs. **Surge `engine=jsc` is an interpreter in the NE process; treat these as a lower bound. `engine=webview` has JIT, so CPU time is closer, but startup and large bodies pay for IPC.** No device factor was measured. Do not multiply these by a constant and call it an iPhone result.

Raw data: `docs/audit-bench/results.json`, `docs/audit-bench/bundle-meta.json`. Reproduce from `backend/`:

```
SUB_STORE_FRONTEND_BACKEND_PATH=/ node -r @babel/register ../docs/audit-bench/hotpath.js
node ../docs/audit-bench/bundle-meta.js
```

### Cold start

`vm.Script` on the real minified files, fresh process (compile only, no execute):

| File | Compile |
| --- | ---: |
| `sub-store-0.min.js` | 25.0 ms |
| `sub-store-1.min.js` | 21.4 ms |
| `cron-sync-artifacts.min.js` | 20.9 ms |

Execute in a fresh V8 context with stub `$persistentStore`, `$httpClient`, `$notification`, `$done`, `$request`, `$environment` (Surge-like, `process` absent so `isNode` is false):

| Run | Compile | Execute | Total | Result |
| --- | ---: | ---: | ---: | --- |
| `sub-store-0` `GET /api/utils/env` | 26.4 ms | 45.0 ms | 71.4 ms | HTTP 200 |
| `sub-store-1` `GET /download/not-exist` | 23.2 ms | 39.2 ms | 62.4 ms | HTTP 404 `RESOURCE_NOT_FOUND` |

That 60–70 ms is a trivial request. It does not parse a subscription and does not compile Peggy. On every Surge hit you pay this again, then the work below, then `$persistentStore` reads of the whole JSON. Babel-register import of `ProxyUtils` was 2.8 s and is **not** a product number; it includes transpiling the source graph.

Peggy `generate()`, first call, before any parse (the cache is then free):

| Grammar | First `generate` |
| --- | ---: |
| Surge | 75.3 ms |
| Loon | 29.9 ms |
| QX | 22.1 ms |

Sum ≈ 127 ms if a request needs all three. URI-only and Clash-only paths do not call them, but the compiler is still parsed as part of the 1.3 MB. The Surge-line timings below were taken **after** this warmup, so they do not include the 75 ms. On device, add it.

### Parse

Inputs are synthetic but use real encodings: mixed `ss://`, `vmess://` (base64 JSON), `vless://`, `trojan://`; SS-only URIs; Surge `name = ss, host, port, encrypt-method=...` lines; Clash `proxies:` YAML; base64 of the mixed URI list. All counts came back equal to the input size (nothing was dropped).

| Workload | 1,000 nodes | 5,000 nodes | 5,000 input size |
| --- | ---: | ---: | ---: |
| SS URI | 6.6 ms | 18.8 ms | 399 KB |
| Surge SS lines (Peggy already warm) | 16.5 ms | 52.1 ms | 409 KB |
| Mixed URI | 49.8 ms | 127.7 ms | 831 KB |
| Base64 of mixed URI | 53.0 ms | 154.4 ms | 1.06 MB |
| Clash YAML | 130.9 ms | 745.0 ms | 564 KB |

Clash is the outlier because `Clash()` in `preprocessors/index.js` `safeLoad`s the whole document (and `test()` has already `safeLoad`ed it once), then `JSON.stringify`s every proxy onto its own line, then `Clash_All` `JSON5.parse`s or `YAML.parse`s every line again. `yaml.js` `toSerializable()` is `JSON.parse(JSON.stringify(content))` on the way in, including when `content` is already a string.

SS URIs stay on one regex parser after the first hit (`lastParser` in `parse()`). That path is fine.

### Operators

5,000 already-parsed SS proxies, each operator alone (median of 3):

| Operator | Median |
| --- | ---: |
| Type Filter | 0.5 ms |
| Regex Filter (`香港\|日本\|...`) | 2.6 ms |
| Script operator (`function operator` mapping `udp`) | 4.4 ms |
| Sort asc | 5.2 ms |
| Regex rename | 6.1 ms |
| JSON clone of the array | 6.2 ms |
| **Flag operator** | **275.9 ms** |
| **Region filter** | **267.3 ms** |

The combined chain used by the bench (regex filter, type filter, regex rename, flag, sort, script operator) was 57.5 ms at 1,000 nodes and 333.8 ms at 5,000. Flag is almost all of that. Region was not in the chain; it is the same `getFlag` cost.

`getFlag` in `backend/src/utils/geo.js` builds the `Flags` and `ISOFlags` objects on every call, then for every keyword does `RegExp(\`${keyword}\`, 'i')` and `.test(name)`. Region filter calls `getFlag` per node (`processors/index.js`, the comment there already says "this would be high memory usage"). Flag operator calls `getFlag` and `removeFlag` per node. `removeFlag` is one regex and is cheap. The dictionary rebuild is the bug.

Shortcut scripts (`$server.name = ...`, the fallback loop) were 1.2 ms at 1,000 and 6.4 ms at 5,000, similar to one clone plus a tight loop. The function form is not the problem. `new Function` once per operator is noise next to `getFlag`.

`ApplyOperator` still clones before each operator. Six operators are six full clones (~6 ms each at 5,000 on V8). Worth removing once, not worth a rewrite.

### Produce

After the chain, 5,000 SS nodes:

| Target | 1,000 | 5,000 | 5,000 output |
| --- | ---: | ---: | ---: |
| Surge text | 2.6 ms | 14.8 ms | 494 KB |
| Clash.Meta YAML | 3.3 ms | 13.8 ms | 799 KB |

Producing is cheap next to Clash parse and `getFlag`. `producers/surge.js` is a big per-node string builder, but V8 handles it.

### JSON, store, lodash, regex

| Operation | Median |
| --- | ---: |
| `JSON.stringify` 1,000 SS proxies (148 KB) | 0.57 ms |
| `JSON.parse` that string | 0.35 ms |
| pretty `JSON.stringify(..., null, 2)` (201 KB) | 0.73 ms |
| `JSON.stringify` a 3.5 MB string value (near the iOS store cap) | 11.4 ms |
| `JSON.parse` that 3.5 MB JSON | 3.0 ms |

Pretty-printing the main store is not the CPU problem at config size. Doing it on every mutation, and doing `JSON.parse` of the whole store at the start of every Surge run, is a latency and write-amp problem. Crossing 4 MB is a correctness problem.

lodash is not hot as a call (`lodash.get` is only the duplicate-name operator; parsers use `_.set` a handful of times). It is hot as bytes: 546 KB of source in every bundle, because user scripts receive the namespace.

Regex elsewhere is ordinary (URI tests, `buildRegex` per rename). The pathological one is `getFlag`.

### Network

Not load-tested against the network. From the code:

- App HTTP is `$httpClient` through `HTTP()` in `open-api.js`. Surge allows 20 concurrent client requests per script run. Sub-Store's limiter defaults to 10 (`backend/src/utils/request-concurrency.js`, `backendRequestConcurrency`). A collection that pulls many URLs queues on that.
- Default request timeout is 8 s unless settings override (`download.js`). The script timeout is 900 s, so the script can outlive a single fetch, but a collection of slow URLs still stacks.
- In-process de-dupe: `tasks` Map in `download.js` shares an in-flight promise on non-Node hosts.
- Cache: MD5 of UA+URL, TTL default 1 hour, skip when body is larger than `cacheThreshold` KB. Optimistic `cacheKey` may fire a background `download()` without awaiting it (`download.js` around the `cacheKey` branch). On Surge, `$done()` ends the run and cancels timers. That background refresh is not something to rely on. The produce cron (`config/Surge.sgmodule`, `produce` / `produce_cronexp`) is the path that actually warms cache, and it is off unless the module argument is changed (the default name is `# Sub-Store Produce`, which the README treats as disabled).
- Node uses undici, with `fetch-socks` when a proxy is set. That path is irrelevant to Surge memory.

## 5. Surge-specific changes, ranked

Manual versions this was checked against: scripting overview, HTTP request script, JavaScript API. Release context: Surge Mac 6.10.0 and Surge iOS 5.23.0 shipped together; iOS TestFlight around this date is the 5.102.0 / 5.23 line, not an iOS 6. There is no new script host in those notes (a scripting-engine compatibility fix, HTTP API helpers, `$httpClient` percent-encoding and body-decode fixes). Nothing in that set adds native code, Wasm, or a persistent JS heap across requests.

| # | Change | Impact | Effort | Risk | Keep as a small patch on upstream? |
| --- | --- | --- | --- | --- | --- |
| 1 | Build the flag/ISO regex tables once in `geo.js`. Stop `new RegExp` per keyword per node. | ~270 ms → a few ms per 5,000 nodes on V8 for both Flag and Region. Largest CPU win in the repo. | Small | Medium. Matching order and case rules must stay. Needs the existing flag fixtures plus a few names that hit ISO codes. | Yes. One file. Rebase when upstream edits `geo.js`. |
| 2 | Precompile Surge/Loon/QX grammars in `bundle-esbuild.js` and do not bundle the Peggy compiler. | Drops ~127 ms of `generate` on every cold request that uses those parsers, and removes `peggy` (~223 KB source) plus `source-map-generator` from every app bundle. | Medium | Low if the generated parse functions are checked against `backend/src/test/proxy-parsers`. | Yes, if it stays in the bundler. Do not commit a second copy of the grammar. |
| 3 | Break the static edge from `sub-store-0` to `ProxyUtils` so the simple script does not contain parsers, producers, Peggy, or lodash. | CRUD and the env page stop paying a 1.3 MB parse. This is the memory win the split was supposed to be. File share and any path that produces content must stay on `sub-store-1` or a third script. | Medium | Medium. Route ownership has to match the module patterns. | Yes, but it is a structural patch, not a one-line fix. |
| 4 | Leave `engine=auto` (webview). Do not suggest `engine=jsc` for these bundles. | Avoids NE jetsam. The module comment already says JSC runs out of memory. Webview JIT is also why the CPU patches show up. | Trivial | Low. tvOS and macOS 10.15 have no webview; those stay on JSC and must keep the bundles small (items 2–3). | Already the default. Don't "optimize" it back to JSC. |
| 5 | One `$persistentStore` read of `sub-store` per run, compact stringify, and do not `write` the main document when only a `#` cache changed. Cap or shard the resource cache so one value stays under 4 MB on iOS. | Cuts write amplification and stops silent cache loss on iOS. CPU of the 3.5 MB parse itself was only 3 ms on V8; the cap and the IPC are the issue. | Medium | Medium. Pretty JSON in `sub-store.json` is handy on Node; gate compact mode on `$.env.isSurge`. | Yes, with a Node-vs-Surge branch so the server files stay readable. |
| 6 | Parse Clash YAML once and hand the objects to the rest of the pipeline. Remove `toSerializable` on strings. | The 745 ms / 5,000 Clash case. Several times faster is plausible because the second parse is pure overhead. | Medium | Medium. Anchors, `!<str>`, and `short-id` quoting are why `normalizeClashYaml` exists. | Only with the preprocessor tests. Easy to get wrong. Still a JS patch, not a rewrite. |
| 7 | Clone once per operator chain, not once per operator. | ~6 ms × (n−1) at 5,000 nodes on V8. Small next to item 1. | Small | Low if scripts that mutate and also need the previous array are checked. | Yes. |
| 8 | Set a finite `max-size` instead of `-1`, and keep `requires-body` only where POST/PUT bodies exist. Narrow the MITM host if it is ever widened; today it is only `sub.store`, which is already right. | Less chance of a huge body landing in the script process. `pattern` is already a single host. | Small | Medium if a local subscription body is larger than the cap. | Module-only. Safe if the cap stays multi-megabyte. |
| 9 | Turn on the produce cron for heavy subs (`produce` / `produce_sub` / `produce_col`) so the interactive download reads cache. | Avoids doing the 745 ms Clash parse on the request Surge is trying to answer. The feature is already implemented. | Config | Low. Uses the same 900 s cron timeout and the same store cap. | No code. Document it. |
| 10 | `esbuild` `target: 'es2022'` explicitly, and do not add `core-js` beyond the `hasOwn` inject. | Little speed. Protects against someone later turning on `@babel/preset-env` for the bundle. | Small | Low. | Yes, bundler only. |
| 11 | Retire passing full lodash into scripts. | Would delete the biggest dependency (~546 KB source). | Large in compatibility terms. | High. Unknown scripts call unknown methods. | No, unless you version the script API. |

Do not do these as "optimizations":

- Moving the hot path to Wasm or to a native Node addon.
- Setting `engine=jsc` to "start faster". Startup is already ~20 ms of compile on V8; JSC's win on startup is real for tiny scripts and actively harmful for a 1.3 MB program with a 270 ms regex loop and no JIT.
- Raising `timeout` further. 900 s is already far above the 5 s default. The failures people see are memory and the 4 MB store, not the timer.
- Caching parsed JS across requests. Surge does not offer that. The script file is cached on disk (`script-update-interval`); the heap is not.

`http-request` is the correct type. Sub-Store is answering `sub.store` with a mock response (`$done({ response })`), which is what that type is for. `cron` is the correct type for gist sync and cache warming. A `generic` script would not see the subscription URL.

## 6. Roadmap

**Phase 0 — stop the rewrite.** Stay on the JS tree that upstream diffs against. The Surge module keeps `engine=auto`. Users with multi-thousand-node Clash subs should enable the produce cron and a cache TTL, and should not expect the iOS persistent store to hold many megabytes of raw subscriptions.

**Phase 1 — one patch series, still JS.** In order:

1. `getFlag` / region filter: one compiled matcher, same results.
2. Bundler: generate Peggy parsers, externalize `peggy`.
3. Make `sub-store-0.js` actually free of `ProxyUtils`. Re-measure the two bundles; the simple one should fall well below 1.3 MB. Re-run the sandbox eval and confirm `/api/utils/env` still returns 200.
4. Surge-only: compact `persistCache`, no redundant writes, resource-cache size guard under 4 MB with a visible log when a body is not stored.

Re-run `docs/audit-bench/hotpath.js` and the sandbox snippet. The success test is: flag and region on 5,000 nodes in the same band as regex rename, Peggy `generate` absent from the request, `sub-store-0` raw size down by the parser/lodash/Peggy share, existing `backend/src/test` green.

**Phase 2 — Clash parse, only if Phase 1 is not enough.** Single YAML parse, no per-line reparse, no `JSON.parse(JSON.stringify)` on strings in `yaml.js`. This is the one change that moves the 745 ms number. Keep it behind the preprocessor tests (`backend/src/test/proxy-preprocessors`, `proxy-parsers`).

**Phase 3 — do not start.** No TypeScript conversion, no Wasm, no second backend in Rust/Go. If a Node deployment is ever CPU-bound after Phase 2, profile that process on its own. The Surge product still has to ship the JS bundle, so a native core cannot replace it.

## What this audit did not do

- No iPhone or Mac Surge process. JSC-vs-V8 ratios are not measured.
- No Wasm probe inside Surge. The recommendation does not depend on a negative experiment; it depends on the manual and on the fact that user scripts must remain JS.
- Network concurrency was read from the code and the manual, not timed against live subscriptions.
- The frontend was not exercised. Route ownership was taken from the registrars in `backend/src/restful/` and the product entry files.
