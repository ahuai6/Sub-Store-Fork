import json
import tempfile
import unittest
from pathlib import Path

from prepare_frontend_pages import (
    API,
    BASE,
    PATCH_STAMP,
    assert_built_paths,
    check_dist,
    patch_checkout,
)


def create_minimal_frontend(root: Path) -> None:
    (root / "public").mkdir(parents=True, exist_ok=True)
    (root / "src" / "router").mkdir(parents=True, exist_ok=True)
    (root / "src" / "store").mkdir(parents=True, exist_ok=True)
    (root / "src" / "api" / "subs").mkdir(parents=True, exist_ok=True)
    (root / "src" / "utils").mkdir(parents=True, exist_ok=True)
    (root / "src" / "components").mkdir(parents=True, exist_ok=True)
    (root / "src" / "views" / "settings").mkdir(parents=True, exist_ok=True)

    (root / ".env").write_text("VITE_PUBLIC_PATH = '/'\n", encoding="utf-8")
    (root / ".env.production").write_text(
        "VITE_API_URL = 'https://sub.store'\n", encoding="utf-8"
    )
    (root / "vite.config.ts").write_text(
        """export default {
  plugins: [VitePWA({
    registerType: "prompt",
    manifest: {
      id: "/",
      start_url: "/",
      scope: "/",
    },
    workbox: {
      navigateFallback: "/index.html",
    },
  })]
};
""",
        encoding="utf-8",
    )
    (root / "src" / "router" / "index.ts").write_text(
        "const history = createWebHistory();\n", encoding="utf-8"
    )
    (root / "index.html").write_text(
        """<!DOCTYPE html>
<html>
<head>
  <meta name="version" content="__SUB_STORE_FRONT_END_VERSION__">
  <link rel="icon" href="/favicon.svg" />
  <link rel="manifest" href="/manifests.json" />
</head>
<body><script type="module" src="/src/main.ts"></script></body>
</html>
""",
        encoding="utf-8",
    )
    (root / "public" / "manifests.json").write_text(
        json.dumps({"id": "/", "start_url": "/", "scope": "/"}),
        encoding="utf-8",
    )
    (root / "src" / "api" / "index.ts").write_text(
        """import axios from 'axios';
import { getApiRequestTimeout } from '@/utils/requestTimeout';
const service = axios.create({
  baseURL: getHostAPIUrl(),
  timeout: getApiRequestTimeout(),
  headers: { 'Content-Type': 'application/json' },
});
export default service;
""",
        encoding="utf-8",
    )
    (root / "src" / "api" / "subs" / "index.ts").write_text(
        """import request from '@/api';
import { AxiosPromise } from 'axios';
export function preview(type: string, data: any): AxiosPromise {
      return request({
        url: `/api/preview/${type}`,
        method: 'post',
        data,
      });
}
""",
        encoding="utf-8",
    )
    (root / "src" / "utils" / "requestConcurrency.ts").write_text(
        """export const DEFAULT_FRONTEND_REQUEST_CONCURRENCY = 2;
export const getFrontendRequestConcurrency = () => {
  const storedConcurrency = localStorage.getItem('concurrency')?.trim();
  const concurrency = storedConcurrency ? Number(storedConcurrency) : DEFAULT_FRONTEND_REQUEST_CONCURRENCY;

  return Number.isInteger(concurrency) && concurrency >= 1
    ? concurrency
    : DEFAULT_FRONTEND_REQUEST_CONCURRENCY;
};
""",
        encoding="utf-8",
    )
    (root / "src" / "store" / "subs.ts").write_text(
        "const canFetchFlowsForCurrentPage = () => window.location.pathname === '/subs';\n",
        encoding="utf-8",
    )
    (root / "src" / "views" / "Sub.vue").write_text(
        """<template>
            <a
              href="/aboutUs"
              style="color: var(--primary-color)"
            >
              {{ $t(`subPage.loadFailed.about`) }}
            </a>
</template>
""",
        encoding="utf-8",
    )
    (root / "src" / "views" / "settings" / "APISetting.vue").write_text(
        """<script setup>
function copy(api) {
  const url = new URL(window.location.origin);
  url.searchParams.set('api', api.url);
}
</script>
""",
        encoding="utf-8",
    )
    (root / "src" / "components" / "PreviewPanel.vue").write_text(
        """<script setup>
function getUrl(previewQuery) {
    return buildUrlWithQuery('/preview', previewQuery);
}
</script>
""",
        encoding="utf-8",
    )
    (root / "src" / "views" / "FilePreview.vue").write_text(
        """<script lang="ts" setup>
import axios from 'axios';
async function load(url: unknown) {
      const response = await axios.get(url as string, {
        responseType: 'text',
        transformResponse: [(data) => data],
      })
      return response.data;
}
</script>
""",
        encoding="utf-8",
    )


def create_minimal_dist(dist: Path, *, sw_body: str | None = None, js_body: str | None = None) -> None:
    dist.mkdir(parents=True, exist_ok=True)
    (dist / "index.html").write_text(
        f"""<!DOCTYPE html>
<html>
<head>
  <meta name="sub-store-fork" content="api-cap-2 skip-restored-preview" />
  <link rel="preconnect" href="{API}" crossorigin />
  <style>.compare-table-body .compare-table-row{{content-visibility:auto;contain-intrinsic-size:auto 56px;}}</style>
  <link rel="manifest" href="{BASE}manifests.json" />
  <script type="module" src="{BASE}assets/app.js"></script>
</head>
</html>
""",
        encoding="utf-8",
    )
    manifest = json.dumps({"id": BASE, "start_url": BASE, "scope": BASE})
    (dist / "manifest.webmanifest").write_text(manifest, encoding="utf-8")
    (dist / "manifests.json").write_text(manifest, encoding="utf-8")
    (dist / "registerSW.js").write_text(
        f"navigator.serviceWorker.register('{BASE}sw.js', {{ scope: '{BASE}' }});\n",
        encoding="utf-8",
    )
    (dist / "sw.js").write_text(
        sw_body
        if sw_body is not None
        else "self.skipWaiting();clientsClaim();precache(['index.html']);\n",
        encoding="utf-8",
    )
    (dist / "assets").mkdir(parents=True, exist_ok=True)
    (dist / "assets" / "app.js").write_text(
        js_body
        if js_body is not None
        else f'const b="{BASE}",a="{API}",m="sub-store-fork-api-cap:2",s="sub-store-fork-skip-restored-preview",r={{path:"/preview"}};\n',
        encoding="utf-8",
    )
    (dist / "frontend-version.txt").write_text(
        f"patches={PATCH_STAMP}\n", encoding="utf-8"
    )


class PrepareFrontendPagesTests(unittest.TestCase):
    def test_patch_checkout_applies_all_fork_patches_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp:
            frontend = Path(tmp) / "frontend"
            create_minimal_frontend(frontend)

            patch_checkout(frontend, BASE, API)
            # Second invocation must be idempotent.
            patch_checkout(frontend, BASE, API)

            vite = (frontend / "vite.config.ts").read_text(encoding="utf-8")
            self.assertIn('registerType: "autoUpdate",', vite)
            self.assertNotIn('registerType: "prompt",', vite)

            preview_panel = (frontend / "src/components/PreviewPanel.vue").read_text(
                encoding="utf-8"
            )
            self.assertIn("buildUrlWithQuery(`${base}/preview`, previewQuery)", preview_panel)
            self.assertNotIn("buildUrlWithQuery('/preview'", preview_panel)

            file_preview = (frontend / "src/views/FilePreview.vue").read_text(
                encoding="utf-8"
            )
            self.assertIn("import { queuedPreviewGet } from '@/utils/forkRequestGuard';", file_preview)
            self.assertIn("await queuedPreviewGet(axios, url as string,", file_preview)

            index_html = (frontend / "index.html").read_text(encoding="utf-8")
            self.assertIn('<link rel="preconnect" href="https://sub.store" crossorigin />', index_html)
            self.assertIn("content-visibility:auto", index_html)

            guard = (frontend / "src/utils/forkRequestGuard.ts").read_text(encoding="utf-8")
            self.assertIn("resolveApiPriority", guard)
            self.assertIn("queuedPreviewGet", guard)

    def test_check_dist_validates_autoupdate_sw_preconnect_and_preview_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            dist = Path(tmp) / "dist"
            create_minimal_dist(dist)
            check_dist(dist, BASE, API)

    def test_check_dist_rejects_prompt_sw_without_skip_waiting(self):
        with tempfile.TemporaryDirectory() as tmp:
            dist = Path(tmp) / "dist"
            create_minimal_dist(dist, sw_body="precache(['index.html']);\n")
            with self.assertRaises(SystemExit):
                check_dist(dist, BASE, API)

    def test_assert_built_paths_catches_unpatched_preview_call_and_allows_router_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            dist = Path(tmp) / "dist"
            create_minimal_dist(
                dist,
                js_body='const r={path:"/preview"};if(route.path.startsWith("/preview")){}\n',
            )
            assert_built_paths(dist)

            (dist / "assets" / "app.js").write_text(
                'function f(q){return buildUrlWithQuery("/preview",q);}\n',
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                assert_built_paths(dist)


if __name__ == "__main__":
    unittest.main()
