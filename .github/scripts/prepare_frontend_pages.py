#!/usr/bin/env python3
"""Build-configuration patches for hosting Sub-Store-Front-End on GitHub Pages.

Upstream release dist.zip is produced with Vite base `/` and VitePWA
scope/start_url `/`. This repo's Pages site is a project site:

    https://ahuai6.github.io/Sub-Store-Fork/

Asset URLs, the PWA scope, and the Vue Router history base have to live
under that subpath. A few application checks also assume the site is mounted
at `/`. The script patches a checkout of sub-store-org/Sub-Store-Front-End
(it does not vendor the frontend) and checks the built files before they
are pushed. Each source edit is anchored on the upstream text and the build
fails if that anchor is gone.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

BASE = "/Sub-Store-Fork/"
API = "https://sub.store"
PAGES_URL = "https://ahuai6.github.io/Sub-Store-Fork/"
UPSTREAM_REPO = "sub-store-org/Sub-Store-Front-End"
# Bump when a source patch changes behavior. publish-frontend compares this
# with gh-pages frontend-version.txt and rebuilds even if the upstream sha,
# base, and API URL are unchanged.
PATCH_STAMP = "subpath-routes-1-surge-session-2-repo-pages-1"

# subs.ts decides whether to load traffic/expiry by comparing the browser
# pathname to the router path. Under a project-site base that pathname is
# /Sub-Store-Fork/subs, so the check never passes and the row stays
# on "加载中".
FLOW_PAGE_ANCHOR = (
    "const canFetchFlowsForCurrentPage = () => "
    "window.location.pathname === '/subs';"
)
FLOW_PAGE_REPLACEMENT = """const canFetchFlowsForCurrentPage = () => {
  // Pages serves the app below Vite's base. Compare the route, not the raw pathname.
  const base = import.meta.env.BASE_URL.replace(/\\/$/, '');
  const pathname = window.location.pathname.replace(/\\/$/, '') || '/';
  const routePath = base && (pathname === base || pathname.startsWith(`${base}/`))
    ? pathname.slice(base.length) || '/'
    : pathname;
  return routePath === '/subs';
};"""
FLOW_PAGE_MARKER = "pathname.slice(base.length)"

# These are real <a href> navigations. router.push('/aboutUs') is already
# base-aware; a root-absolute href leaves the project site.
ABOUT_LINK_ANCHOR = """            <a
              href="/aboutUs"
              style="color: var(--primary-color)"
            >
              {{ $t(`subPage.loadFailed.about`) }}
            </a>"""
ABOUT_LINK_REPLACEMENT = """            <router-link
              to="/aboutUs"
              style="color: var(--primary-color)"
            >
              {{ $t(`subPage.loadFailed.about`) }}
            </router-link>"""

# Copying an API link builds a URL back to this frontend. new URL(origin)
# drops the project-site path.
COPY_API_LINK_ANCHOR = (
    "  const url = new URL(window.location.origin);\n"
    "  url.searchParams.set('api', api.url);"
)
COPY_API_LINK_REPLACEMENT = (
    "  const url = new URL(import.meta.env.BASE_URL, window.location.origin);\n"
    "  url.searchParams.set('api', api.url);"
)
COPY_API_LINK_MARKER = "new URL(import.meta.env.BASE_URL, window.location.origin)"

# Terser turns `pathname === '/subs'` into `"/subs"===window.location.pathname`.
# Either order is the unpatched guard. A base-stripped comparison does not
# put location.pathname on either side of that literal.
_ROOT_ROUTE = r"""/(?:subs|files|sync|shares|aboutUs|my)"""
_LOCATION_PATHNAME = r"""(?:window\.)?location\.pathname"""
ROOT_PATHNAME_EQ = re.compile(
    rf"""{_LOCATION_PATHNAME}\s*={{2,3}}\s*(['"`]){_ROOT_ROUTE}\1"""
    rf"""|(['"`]){_ROOT_ROUTE}\2\s*={{2,3}}\s*{_LOCATION_PATHNAME}\b"""
)
ROOT_ABOUT_HREF = re.compile(r"""href\s*[:=]\s*(['"`])/aboutUs\1""")
ORIGIN_ONLY_URL = re.compile(r"""new URL\(\s*(?:window\.)?location\.origin\s*\)""")


def normalize_base(base: str) -> str:
    value = base.strip()
    if not value.startswith("/"):
        value = "/" + value
    if not value.endswith("/"):
        value += "/"
    if value == "/":
        raise SystemExit("refusing to build the frontend with base /")
    return value


FORK_GUARD = "forkRequestGuard.ts"
FORK_META = (
    '<meta name="sub-store-fork" '
    'content="api-cap-2 skip-restored-preview" />'
)
CONCURRENCY_FN = """export const getFrontendRequestConcurrency = () => {
  const storedConcurrency = localStorage.getItem('concurrency')?.trim();
  const concurrency = storedConcurrency ? Number(storedConcurrency) : DEFAULT_FRONTEND_REQUEST_CONCURRENCY;

  return Number.isInteger(concurrency) && concurrency >= 1
    ? concurrency
    : DEFAULT_FRONTEND_REQUEST_CONCURRENCY;
};"""
CONCURRENCY_FN_NEXT = """export const FORK_MAX_FRONTEND_REQUEST_CONCURRENCY = 2;

export const getFrontendRequestConcurrency = () => {
  const storedConcurrency = localStorage.getItem('concurrency')?.trim();
  const concurrency = storedConcurrency ? Number(storedConcurrency) : DEFAULT_FRONTEND_REQUEST_CONCURRENCY;

  const resolved = Number.isInteger(concurrency) && concurrency >= 1
    ? concurrency
    : DEFAULT_FRONTEND_REQUEST_CONCURRENCY;
  // Leave one of Surge's 3 webview script sessions free.
  return Math.min(resolved, FORK_MAX_FRONTEND_REQUEST_CONCURRENCY);
};"""
PREVIEW_RETURN = """      return request({
        url: `/api/preview/${type}`,
        method: 'post',
        data,
      });"""
PREVIEW_RETURN_NEXT = """      if (blockRestoredHeavyPreview()) {
        return Promise.reject(restoredPreviewError());
      }
      return request({
        url: `/api/preview/${type}`,
        method: 'post',
        data,
      });"""


def _require(text: str, old: str, label: str) -> None:
    if old not in text:
        raise SystemExit(f"{label} is missing anchor:\n{old}")


def _replace_text_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    _require(text, old, label)
    return text.replace(old, new, 1)


def patch_surge_session_guard(frontend: Path) -> None:
    """Cap API concurrency and skip heavy previews after refresh/restore.

    Anchors are the upstream strings. A vanished anchor fails the build
    instead of shipping a frontend that can fill all 3 Surge script slots.
    """
    template = (
        Path(__file__).resolve().parent / "fork-frontend" / FORK_GUARD
    )
    if not template.is_file():
        raise SystemExit(f"missing frontend guard template {template}")
    target = frontend / "src" / "utils" / FORK_GUARD
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(template.read_text())

    api_path = frontend / "src" / "api" / "index.ts"
    api = api_path.read_text()
    api = _replace_text_once(
        api,
        "import { getApiRequestTimeout } from '@/utils/requestTimeout';",
        "import { getApiRequestTimeout } from '@/utils/requestTimeout';\n"
        "import { installForkApiQueue } from '@/utils/forkRequestGuard';",
        str(api_path),
    )
    api = _replace_text_once(
        api,
        "const service = axios.create({\n"
        "  baseURL: getHostAPIUrl(),\n"
        "  timeout: getApiRequestTimeout(),\n"
        "  headers: { 'Content-Type': 'application/json' },\n"
        "});",
        "const service = axios.create({\n"
        "  baseURL: getHostAPIUrl(),\n"
        "  timeout: getApiRequestTimeout(),\n"
        "  headers: { 'Content-Type': 'application/json' },\n"
        "});\n"
        "installForkApiQueue(service);",
        str(api_path),
    )
    api_path.write_text(api)

    subs_path = frontend / "src" / "api" / "subs" / "index.ts"
    subs = subs_path.read_text()
    subs = _replace_text_once(
        subs,
        "import request from '@/api';\nimport { AxiosPromise } from 'axios';",
        "import request from '@/api';\n"
        "import { AxiosPromise } from 'axios';\n"
        "import { blockRestoredHeavyPreview, restoredPreviewError } "
        "from '@/utils/forkRequestGuard';",
        str(subs_path),
    )
    subs = _replace_text_once(subs, PREVIEW_RETURN, PREVIEW_RETURN_NEXT, str(subs_path))
    subs_path.write_text(subs)

    queue_path = frontend / "src" / "utils" / "requestConcurrency.ts"
    queue = queue_path.read_text()
    queue = _replace_text_once(
        queue, CONCURRENCY_FN, CONCURRENCY_FN_NEXT, str(queue_path)
    )
    queue_path.write_text(queue)

    index_path = frontend / "index.html"
    html = index_path.read_text()
    version_meta = (
        '<meta name="version" content="__SUB_STORE_FRONT_END_VERSION__">'
    )
    html = _replace_text_once(
        html,
        version_meta,
        version_meta + "\n  " + FORK_META,
        str(index_path),
    )
    index_path.write_text(html)
    print(f"patched Surge session guard in {frontend}", file=sys.stderr)


def _replace_once(path: Path, anchor: str, replacement: str, marker: str) -> None:
    text = path.read_text()
    has_anchor = anchor in text
    has_marker = marker in text
    if has_marker and not has_anchor:
        return
    if not has_anchor:
        raise SystemExit(
            f"{path} is missing the patch anchor, so the Pages subpath fix was not applied:\n{anchor}"
        )
    count = text.count(anchor)
    if count != 1 or has_marker:
        raise SystemExit(f"{path} has {count} copies of the patch anchor; expected exactly one")
    path.write_text(text.replace(anchor, replacement, 1))


def patch_subpath_routes(frontend: Path) -> None:
    """Rewrite application paths that break when Vite base is not `/`."""
    _replace_once(
        frontend / "src/store/subs.ts",
        FLOW_PAGE_ANCHOR,
        FLOW_PAGE_REPLACEMENT,
        FLOW_PAGE_MARKER,
    )

    about_old = 0
    about_new = 0
    vue_files = sorted((frontend / "src").rglob("*.vue"))
    if not vue_files:
        raise SystemExit(f"{frontend / 'src'} has no Vue files to patch")
    for path in vue_files:
        text = path.read_text()
        old_count = text.count(ABOUT_LINK_ANCHOR)
        about_old += old_count
        about_new += text.count(ABOUT_LINK_REPLACEMENT)
        if old_count:
            path.write_text(text.replace(ABOUT_LINK_ANCHOR, ABOUT_LINK_REPLACEMENT))
    if about_old == 0 and about_new == 0:
        raise SystemExit(
            "src/**/*.vue is missing the href=\"/aboutUs\" anchor, "
            "so those links were not rewritten for the Pages base"
        )

    copy_old = 0
    copy_new = 0
    for path in (frontend / "src").rglob("*.vue"):
        text = path.read_text()
        old_count = text.count(COPY_API_LINK_ANCHOR)
        copy_old += old_count
        copy_new += text.count(COPY_API_LINK_MARKER)
        if old_count:
            if old_count != 1:
                raise SystemExit(f"{path} has {old_count} API copy-link anchors; expected one")
            path.write_text(text.replace(COPY_API_LINK_ANCHOR, COPY_API_LINK_REPLACEMENT, 1))
    if copy_old == 0 and copy_new == 0:
        raise SystemExit(
            "src is missing the `new URL(window.location.origin)` API copy-link anchor, "
            "so shared frontend links were not rewritten for the Pages base"
        )
    if copy_old > 1:
        raise SystemExit(f"expected one API copy-link anchor, found {copy_old}")


def assert_source_paths(frontend: Path, base: str) -> None:
    """Fail if a root-path assumption is still in the patched checkout."""
    base = normalize_base(base)
    problems: list[str] = []
    href_re = re.compile(r"""href\s*=\s*(['"])(/[^'"]*)\1""")
    src_re = re.compile(r"""\ssrc\s*=\s*(['"])(/[^'"]*)\1""")
    pathname_re = re.compile(
        r"""(?:window\.)?location\.pathname\s*={2,3}\s*['"]/"""
    )
    origin_url_re = re.compile(r"""new URL\(\s*window\.location\.origin\s*\)""")

    source_files = [frontend / "index.html", *(frontend / "src").rglob("*")]
    for path in source_files:
        if not path.is_file() or path.suffix not in {".vue", ".ts", ".js", ".html"}:
            continue
        text = path.read_text(errors="ignore")
        relative = path.relative_to(frontend)
        for lineno, line in enumerate(text.splitlines(), 1):
            for match in href_re.finditer(line):
                url = match.group(2)
                if url.startswith(base) or url.startswith("//"):
                    continue
                problems.append(f"{relative}:{lineno}: root href {url}")
            if path.name == "index.html":
                for match in src_re.finditer(line):
                    url = match.group(2)
                    if url.startswith("/src/") or url.startswith(base):
                        continue
                    problems.append(f"{relative}:{lineno}: root src {url}")
        for match in pathname_re.finditer(text):
            problems.append(f"{relative}: location.pathname compared to a root path ({match.group(0)})")
        for match in origin_url_re.finditer(text):
            problems.append(f"{relative}: {match.group(0)} drops the Pages base")

    subs = (frontend / "src/store/subs.ts").read_text()
    if FLOW_PAGE_MARKER not in subs or "import.meta.env.BASE_URL" not in subs:
        problems.append("src/store/subs.ts flow check does not strip BASE_URL")
    if problems:
        raise SystemExit(
            "frontend source still assumes it is served from /:\n" + "\n".join(problems)
        )


def patch_checkout(frontend: Path, base: str, api: str) -> None:
    base = normalize_base(base)
    env_path = frontend / ".env"
    env_text = env_path.read_text()
    env_next, env_count = re.subn(
        r"^VITE_PUBLIC_PATH\s*=\s*'[^']*'",
        f"VITE_PUBLIC_PATH = '{base}'",
        env_text,
        count=1,
        flags=re.M,
    )
    if env_count != 1:
        raise SystemExit(f"{env_path} has no VITE_PUBLIC_PATH assignment")
    env_path.write_text(env_next)

    prod_path = frontend / ".env.production"
    prod_text = prod_path.read_text()
    prod_next, prod_count = re.subn(
        r"^VITE_API_URL\s*=\s*'[^']*'",
        f"VITE_API_URL = '{api}'",
        prod_text,
        count=1,
        flags=re.M,
    )
    if prod_count != 1:
        raise SystemExit(f"{prod_path} has no VITE_API_URL assignment")
    prod_path.write_text(prod_next)

    vite_path = frontend / "vite.config.ts"
    vite = vite_path.read_text()
    replacements = {
        'id: "/",': f'id: "{base}",',
        'start_url: "/",': f'start_url: "{base}",',
        'scope: "/",': f'scope: "{base}",',
        # Relative fallback is resolved inside the service-worker scope.
        # "/index.html" would precache and navigate to the domain root.
        'navigateFallback: "/index.html",': 'navigateFallback: "index.html",',
    }
    for old, new in replacements.items():
        if new in vite:
            continue
        if old not in vite:
            raise SystemExit(f"{vite_path} is missing {old}")
        vite = vite.replace(old, new, 1)
    vite_path.write_text(vite)

    # vue-router 4.0.16 createWebHistory() reads a <base> tag, not
    # import.meta.env.BASE_URL. Vite does not inject that tag.
    router_path = frontend / "src/router/index.ts"
    router = router_path.read_text()
    routed = "const history = createWebHistory(import.meta.env.BASE_URL);"
    plain = "const history = createWebHistory();"
    if routed not in router:
        if plain not in router:
            raise SystemExit(f"{router_path} has no createWebHistory() anchor")
        router = router.replace(plain, routed, 1)
        router_path.write_text(router)

    index_path = frontend / "index.html"
    html = index_path.read_text()
    # Leave src="/src/..." so Vite still compiles the entry. Root-absolute
    # hrefs are copied through unchanged when base is not `/`.
    base_body = re.escape(base.lstrip("/"))
    unprefixed = re.findall(rf'href="/(?!{base_body})', html)
    if unprefixed:
        html_next, href_count = re.subn(
            rf'href="/(?!{base_body})',
            f'href="{base}',
            html,
        )
        if href_count != len(unprefixed):
            raise SystemExit(f"{index_path} root-absolute hrefs were not rewritten")
        html = html_next
    elif 'href="/' not in html:
        raise SystemExit(f"{index_path} has no root-absolute hrefs")
    index_path.write_text(html)

    manifest_path = frontend / "public" / "manifests.json"
    manifest = json.loads(manifest_path.read_text())
    for key in ("id", "start_url", "scope"):
        if key not in manifest:
            raise SystemExit(f"{manifest_path} has no {key}")
        manifest[key] = base
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    patch_surge_session_guard(frontend)
    patch_subpath_routes(frontend)
    assert_source_paths(frontend, base)
    print(f"patched {frontend} base={base} api={api} patches={PATCH_STAMP}", file=sys.stderr)


def _load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path} is not JSON: {exc}") from exc


def _assert_icons(manifest: dict, base: str, label: str) -> None:
    for icon in manifest.get("icons") or []:
        src = icon.get("src", "")
        if src.startswith(("http://", "https://", "data:")):
            continue
        if src.startswith("/") and not src.startswith(base):
            raise SystemExit(f"{label} icon {src} is outside {base}")


def check_dist(dist: Path, base: str, api: str) -> None:
    base = normalize_base(base)
    index_path = dist / "index.html"
    if not index_path.is_file():
        raise SystemExit(f"missing {index_path}")
    index = index_path.read_text()
    attrs = re.findall(r'(?:src|href)="(/[^"]*)"', index)
    if not attrs:
        raise SystemExit("index.html has no root-absolute assets")
    for url in attrs:
        if not url.startswith(base):
            raise SystemExit(f"index.html asset is not under {base}: {url}")
    if not any(url.startswith(base) and url.endswith(".js") for url in attrs):
        raise SystemExit("index.html has no script under the base path")

    for name in ("manifest.webmanifest", "manifests.json"):
        path = dist / name
        if not path.is_file():
            raise SystemExit(f"missing {path}")
        manifest = _load_json(path)
        for key in ("id", "start_url", "scope"):
            if manifest.get(key) != base:
                raise SystemExit(f"{name} {key}={manifest.get(key)!r}, want {base}")
        _assert_icons(manifest, base, name)

    register_path = dist / "registerSW.js"
    register = register_path.read_text()
    if f"scope: '{base}'" not in register and f'scope: "{base}"' not in register:
        raise SystemExit(f"registerSW.js scope is not {base}:\n{register}")
    if re.search(r"""register\(\s*['"]/sw\.js['"]""", register):
        raise SystemExit("service worker is registered at /sw.js")
    if base + "sw.js" not in register:
        raise SystemExit(f"registerSW.js does not register {base}sw.js:\n{register}")

    sw_path = dist / "sw.js"
    sw = sw_path.read_text()
    if re.search(r"""['"]/index\.html['"]""", sw):
        raise SystemExit("sw.js still navigates to /index.html")
    if "index.html" not in sw:
        raise SystemExit("sw.js has no index.html precache/fallback")

    scripts = [
        path
        for path in dist.rglob("*.js")
        if not path.name.endswith(".js.gz") and path.suffix == ".js"
    ]
    bundled = "\n".join(path.read_text(errors="ignore") for path in scripts)
    if base not in bundled:
        raise SystemExit(f"built JS does not contain the base path {base}")
    if api not in bundled:
        raise SystemExit(f"built JS does not contain {api}")
    if 'name="sub-store-fork"' not in index:
        raise SystemExit("index.html is missing the sub-store-fork marker")
    for marker in (
        "sub-store-fork-api-cap:2",
        "sub-store-fork-skip-restored-preview",
    ):
        if marker not in bundled:
            raise SystemExit(f"built JS is missing {marker}")
    assert_built_paths(dist)
    version_path = dist / "frontend-version.txt"
    if version_path.is_file():
        version_text = version_path.read_text().splitlines()
        if f"patches={PATCH_STAMP}" not in version_text:
            raise SystemExit(
                f"{version_path} is missing patches={PATCH_STAMP}, "
                "so an unchanged upstream sha would skip this rebuild"
            )
    print(
        f"ok: {index_path} assets, PWA scope, and {api} are under {base}",
        file=sys.stderr,
    )


def assert_built_paths(dist: Path) -> None:
    """Reject built assets that still treat a root route as the whole pathname.

    Terser emits either `pathname==="/subs"` or `"/subs"===location.pathname`.
    The patched guard compares a base-stripped route, so either literal means
    this bug survived the build.
    """
    problems: list[str] = []
    files = [
        path
        for path in dist.rglob("*")
        if path.is_file() and path.suffix in {".js", ".html", ".css", ".mjs"}
        and not path.name.endswith(".gz")
    ]
    if not files:
        raise SystemExit(f"{dist} has no JS or HTML to scan for root paths")
    for path in files:
        text = path.read_text(errors="ignore")
        for regex, label in (
            (ROOT_PATHNAME_EQ, "pathname compared with a root route"),
            (ROOT_ABOUT_HREF, 'href="/aboutUs"'),
            (ORIGIN_ONLY_URL, "new URL(location.origin) drops the Pages base"),
        ):
            match = regex.search(text)
            if not match:
                continue
            start = max(0, match.start() - 60)
            end = min(len(text), match.end() + 60)
            snippet = text[start:end].replace("\n", " ")
            problems.append(f"{path.relative_to(dist)}: {label}: {snippet}")
    if problems:
        raise SystemExit(
            "built files still assume the app is served from /:\n" + "\n".join(problems)
        )


def write_version(path: Path, meta: dict[str, str]) -> None:
    lines = [f"{key}={meta[key]}" for key in (
        "sha",
        "track",
        "release_tag",
        "release_sha",
        "package",
        "base",
        "api",
        "patches",
    )]
    path.write_text("\n".join(lines) + "\n")


def write_notices(dist: Path, meta: dict[str, str]) -> None:
    sha = meta["sha"]
    source = f"https://github.com/{UPSTREAM_REPO}/tree/{sha}"
    track_line = (
        f"Built from the latest release `{meta['release_tag']}`, which is `master`."
        if meta["track"] == "release"
        else (
            "Built from `master` because it has commits that are not in the "
            f"latest release `{meta['release_tag']}` "
            f"(`{meta['release_sha']}`). The upstream release workflow only "
            "runs when `package.json` changes, so `master` can move ahead of "
            "the newest tag."
        )
    )
    attribution = f"""# Sub-Store Front End

This branch is the Sub-Store front end, built so GitHub Pages can serve it at <{PAGES_URL}>.

- Project: [{UPSTREAM_REPO}](https://github.com/{UPSTREAM_REPO})
- License: GNU General Public License v3.0 only. See [LICENSE](./LICENSE).
- Corresponding source: {source}
- Package version: `{meta['package']}`
- {track_line}

The front end is GPL-3.0. Backend artifacts on the `main` branch of this repository are a separate Sub-Store build and stay under AGPL-3.0. This branch does not replace that license.

The corresponding source of the upstream project is the commit above. This build also applies the patches in `.github/scripts/prepare_frontend_pages.py` from ahuai6/Sub-Store-Fork (patch stamp `{meta['patches']}`). Those patches include the Pages subpath fixes and a Surge session guard: API calls are queued to 2, and a reloaded or restored page does not start a heavy preview until the next user action. The build configuration applied on top of that commit is:

1. Vite `base` / `VITE_PUBLIC_PATH` = `{meta['base']}`
2. `VITE_API_URL` = `{meta['api']}` (upstream `.env.production` already uses this URL)
3. VitePWA manifest `id`, `start_url`, and `scope` = `{meta['base']}`
4. Workbox `navigateFallback` = `index.html`, resolved inside the service-worker scope rather than the domain root
5. `createWebHistory(import.meta.env.BASE_URL)`, because Vue Router 4.0.16 does not read Vite's base unless a `<base>` tag is present
6. Root-absolute `href` values in `index.html`, and `id` / `start_url` / `scope` in `public/manifests.json`, rewritten to `{meta['base']}`
7. `404.html` is a copy of `index.html`, so GitHub Pages can boot the single-page app on client-side routes
8. `.nojekyll` is present so Pages publishes every file
9. `canFetchFlowsForCurrentPage` strips `import.meta.env.BASE_URL` from `window.location.pathname` before comparing it with `/subs`, so subscription traffic and expiry still load under the Pages subpath
10. The load-failed `href="/aboutUs"` links are `router-link` targets, so Vue Router resolves them inside the history base
11. The copied API link is `new URL(import.meta.env.BASE_URL, window.location.origin)`, so it opens this Pages site instead of the domain root
12. Axios requests are queued to 2 (`sub-store-fork-api-cap:2`) so a Surge webview page leaves one of the 3 script sessions free
13. `POST /api/preview/*` is skipped after a reload, back/forward restore, or bfcache `pageshow` until the next pointer, touch, or key action (`sub-store-fork-skip-restored-preview`)

Source commit: {source}
"""
    readme = f"""# Sub-Store front end

GitHub Pages site for the [Sub-Store front end](https://github.com/{UPSTREAM_REPO}).

{PAGES_URL}

This branch is GPL-3.0. See [LICENSE](./LICENSE) and [ATTRIBUTION.md](./ATTRIBUTION.md).
Corresponding source: {source}
"""
    (dist / "ATTRIBUTION.md").write_text(attribution)
    (dist / "README.md").write_text(readme)
    write_version(dist / "frontend-version.txt", meta)


def finalize_site(dist: Path, frontend: Path, meta: dict[str, str]) -> None:
    license_src = frontend / "LICENSE"
    if not license_src.is_file():
        raise SystemExit(f"missing frontend license {license_src}")
    shutil.copyfile(license_src, dist / "LICENSE")
    index = dist / "index.html"
    shutil.copyfile(index, dist / "404.html")
    (dist / ".nojekyll").write_text("")
    write_notices(dist, meta)
    if (dist / "404.html").read_bytes() != index.read_bytes():
        raise SystemExit("404.html is not a copy of index.html")
    check_dist(dist, meta["base"], meta["api"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frontend-dir", type=Path)
    parser.add_argument("--dist", type=Path)
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--api", default=API)
    parser.add_argument("--patch", action="store_true")
    parser.add_argument("--check-dist", action="store_true")
    parser.add_argument("--finalize-site", action="store_true")
    parser.add_argument("--print-patch-stamp", action="store_true")
    parser.add_argument("--print-base", action="store_true")
    parser.add_argument("--sha", default="")
    parser.add_argument("--track", default="")
    parser.add_argument("--release-tag", default="")
    parser.add_argument("--release-sha", default="")
    parser.add_argument("--package", default="")
    args = parser.parse_args()

    if args.print_patch_stamp:
        if not PATCH_STAMP or any(char in PATCH_STAMP for char in "=\n\r"):
            raise SystemExit("PATCH_STAMP must be a single non-empty line without '='")
        print(PATCH_STAMP)
    if args.print_base:
        print(normalize_base(BASE))
    if args.patch:
        if args.frontend_dir is None:
            raise SystemExit("--patch requires --frontend-dir")
        patch_checkout(args.frontend_dir, args.base, args.api)
    if args.check_dist:
        if args.dist is None:
            raise SystemExit("--check-dist requires --dist")
        check_dist(args.dist, args.base, args.api)
    if args.finalize_site:
        if args.dist is None or args.frontend_dir is None:
            raise SystemExit("--finalize-site requires --dist and --frontend-dir")
        meta = {
            "sha": args.sha,
            "track": args.track,
            "release_tag": args.release_tag,
            "release_sha": args.release_sha,
            "package": args.package,
            "base": normalize_base(args.base),
            "api": args.api,
            "patches": PATCH_STAMP,
        }
        missing = [key for key, value in meta.items() if not value]
        if missing:
            raise SystemExit(f"--finalize-site missing {', '.join(missing)}")
        finalize_site(args.dist, args.frontend_dir, meta)
    if not (
        args.patch
        or args.check_dist
        or args.finalize_site
        or args.print_patch_stamp
        or args.print_base
    ):
        raise SystemExit(
            "pass --patch, --check-dist, --finalize-site, --print-patch-stamp, and/or --print-base"
        )


if __name__ == "__main__":
    main()
