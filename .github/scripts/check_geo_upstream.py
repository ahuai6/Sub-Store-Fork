#!/usr/bin/env python3
"""Check whether upstream xream/scripts geo.js has drifted from GEO-NOTICE.md.

Designed to run as a non-blocking monitor step inside sync-upstream.yml.
Repository Issues stay disabled: when drift is detected, this script emits a
GitHub Actions ::notice:: annotation and appends a report to GITHUB_STEP_SUMMARY.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

UPSTREAM_REPO = "xream/scripts"
UPSTREAM_PATH = "surge/modules/sub-store-scripts/check/geo.js"
UPSTREAM_REF = "main"
DEFAULT_NOTICE = Path("scripts/check/GEO-NOTICE.md")

BLOB_SHA_RE = re.compile(
    r"Upstream file blob SHA[^\n]*:\s*\n?`([0-9a-f]{40})`",
    re.IGNORECASE,
)


def extract_recorded_blob_sha(notice_text: str) -> str:
    match = BLOB_SHA_RE.search(notice_text)
    if not match:
        raise ValueError("GEO-NOTICE.md is missing 'Upstream file blob SHA' entry")
    return match.group(1).lower()


def fetch_upstream_blob_info(
    repo: str = UPSTREAM_REPO,
    file_path: str = UPSTREAM_PATH,
    ref: str = UPSTREAM_REF,
    token: str | None = None,
    timeout: int = 15,
) -> dict[str, str]:
    api_url = f"https://api.github.com/repos/{repo}/contents/{file_path}?ref={ref}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "ahuai6-Sub-Store-Fork-geo-monitor",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(api_url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    sha = str(payload.get("sha") or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError(f"unexpected GitHub contents response sha: {sha!r}")
    return {
        "sha": sha,
        "html_url": str(
            payload.get("html_url")
            or f"https://github.com/{repo}/blob/{ref}/{file_path}"
        ),
        "download_url": str(
            payload.get("download_url")
            or f"https://raw.githubusercontent.com/{repo}/{ref}/{file_path}"
        ),
    }


def evaluate_drift(recorded_sha: str, upstream: dict[str, str]) -> tuple[bool, str]:
    upstream_sha = upstream["sha"].lower()
    if upstream_sha == recorded_sha.lower():
        return (
            False,
            f"ok: {UPSTREAM_REPO} {UPSTREAM_PATH} unchanged (blob {recorded_sha})",
        )
    report = "\n".join(
        [
            "### geo.js upstream drift detected",
            "",
            f"Upstream `{UPSTREAM_REPO}` (`{UPSTREAM_PATH}` on `{UPSTREAM_REF}`) changed since the snapshot recorded in `scripts/check/GEO-NOTICE.md`.",
            "",
            f"- Recorded blob SHA: `{recorded_sha}`",
            f"- Upstream blob SHA: `{upstream_sha}`",
            f"- Upstream file: {upstream['html_url']}",
            "",
            "Review the upstream diff, port any desired changes into `scripts/check/geo.js`, update `backend/src/test/fixtures/geo.upstream.js`, and record the new revision and blob SHA in `scripts/check/GEO-NOTICE.md`.",
            "",
        ]
    )
    return True, report


def append_summary(summary_path: Path | None, markdown: str) -> None:
    if not summary_path:
        return
    with summary_path.open("a", encoding="utf-8") as fh:
        fh.write(markdown)
        if not markdown.endswith("\n"):
            fh.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--notice", type=Path, default=DEFAULT_NOTICE)
    parser.add_argument("--fail-on-drift", action="store_true")
    args = parser.parse_args()

    try:
        recorded_sha = extract_recorded_blob_sha(
            args.notice.read_text(encoding="utf-8")
        )
    except Exception as exc:
        print(f"::warning title=geo.js monitor config error::{exc}")
        return 0

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or None
    try:
        upstream = fetch_upstream_blob_info(token=token)
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        print(f"::warning title=geo.js upstream check skipped::{exc}")
        return 0

    drifted, message = evaluate_drift(recorded_sha, upstream)
    if not drifted:
        print(message)
        return 0

    print(message)
    print(
        f"::notice title=geo.js upstream updated::"
        f"{UPSTREAM_REPO} {UPSTREAM_PATH} blob changed {recorded_sha[:12]} -> {upstream['sha'][:12]}"
    )
    summary_env = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_env:
        append_summary(Path(summary_env), message)
    return 1 if args.fail_on_drift else 0


if __name__ == "__main__":
    sys.exit(main())
