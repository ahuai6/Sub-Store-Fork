# Surge beta module

Install this module in Surge:

```
https://raw.githubusercontent.com/ahuai6/Sub-Store-Fork/main/dist/Surge-Beta.sgmodule
```

The same file is attached to each GitHub Release:

```
https://github.com/ahuai6/Sub-Store-Fork/releases/latest/download/Surge-Beta.sgmodule
```

Script paths inside the module use `releases/latest/download` on this repository. `config/Surge-Beta.sgmodule` stays identical to upstream. This file is the rendered copy:

- Artifact host rewritten to `ahuai6/Sub-Store-Fork`
- CORS default origin includes `https://ahuai6.github.io`
- Core (`sub-store-1.min.js`) matches `download`, `share/file`, `api/file/`, `preview`, `sync`, and `api/utils/node-info`; Simple (`sub-store-0.min.js`) handles home-screen metadata including `/api/files`, `/api/wholeFiles`, and `/api/wholeFile/:name` (while `sub-store-1.min.js` keeps full file routes for backwards compatibility with older installed modules)
- Scheduled tasks (`sync`, `produce`, `prefetch`) all default off (prefixed with `#`), with usable defaults for every prefetch argument so installation requires no input

`scripts/check/geo.js` is the Script Operator source:

```
https://raw.githubusercontent.com/ahuai6/Sub-Store-Fork/main/scripts/check/geo.js
```

Its GPL-3.0 text is `scripts/check/GEO-LICENSE.txt`. Attribution and tracked upstream blob SHA are in `scripts/check/GEO-NOTICE.md`. The backend license is the repository root `LICENSE` (AGPL-3.0). Each Release also attaches `geo.js`, `GEO-LICENSE.txt`, and `GEO-NOTICE.md`.

Frontend: https://ahuai6.github.io/Sub-Store-Fork/
