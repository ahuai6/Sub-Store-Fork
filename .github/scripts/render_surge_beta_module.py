#!/usr/bin/env python3
"""Rewrite Surge-Beta.sgmodule for the public artifact repo.

Upstream's beta module is config/Surge-Beta.sgmodule. Its script-path URLs
use GitHub Releases on sub-store-org/Sub-Store. This source repo is private,
so those URLs are rewritten to the same path on a public artifact repo.

The published copy also appends the self-hosted frontend origin to the
default `cors` argument. config/Surge-Beta.sgmodule in this repo stays
identical to upstream. Restoring the artifact prefix and the upstream CORS
list must reproduce that file byte for byte.
"""

from __future__ import annotations

import argparse
import difflib
import sys
from pathlib import Path

UPSTREAM_PREFIX = (
    "https://github.com/sub-store-org/Sub-Store/releases/latest/download"
)
DEFAULT_PUBLIC_REPO = "ahuai6/Sub-Store-Fork-Dist"
UPSTREAM_CORS_ORIGINS = (
    "https://sub-store.vercel.app,http://substore.stash,https://substore.stash"
)
FORK_CORS_ORIGIN = "https://ahuai6.github.io"
FORK_CORS_ORIGINS = f"{UPSTREAM_CORS_ORIGINS},{FORK_CORS_ORIGIN}"


def artifact_prefix(public_repo: str) -> str:
    return f"https://github.com/{public_repo}/releases/latest/download"


def render(source: bytes, public_repo: str) -> bytes:
    old = UPSTREAM_PREFIX.encode()
    new = artifact_prefix(public_repo).encode()
    if old not in source:
        raise SystemExit(f"upstream artifact prefix not found: {UPSTREAM_PREFIX}")
    updated = source.replace(old, new)
    if updated == source:
        raise SystemExit("replacement produced no changes")
    cors_old = UPSTREAM_CORS_ORIGINS.encode()
    cors_new = FORK_CORS_ORIGINS.encode()
    if cors_new not in updated:
        if cors_old not in updated:
            raise SystemExit(
                f"upstream CORS default not found: {UPSTREAM_CORS_ORIGINS}"
            )
        updated = updated.replace(cors_old, cors_new)
    if FORK_CORS_ORIGIN.encode() not in updated:
        raise SystemExit(f"fork CORS origin missing: {FORK_CORS_ORIGIN}")
    if b"sub-store-org/Sub-Store" in updated:
        raise SystemExit(
            "rewritten module still references sub-store-org/Sub-Store"
        )
    return updated


def assert_expected_diff(original: bytes, updated: bytes, public_repo: str) -> str:
    """Fail unless reversing the prefix and CORS origin restores the source."""
    old = UPSTREAM_PREFIX.encode()
    new = artifact_prefix(public_repo).encode()
    # Replace the longer CORS list first. It starts with the upstream list.
    restored = updated.replace(new, old).replace(
        FORK_CORS_ORIGINS.encode(), UPSTREAM_CORS_ORIGINS.encode()
    )
    if restored != original:
        raise SystemExit(
            "diff is not limited to the artifact URL prefix and the fork CORS origin"
        )

    diff = "".join(
        difflib.unified_diff(
            original.decode("utf-8").splitlines(keepends=True),
            updated.decode("utf-8").splitlines(keepends=True),
            fromfile="upstream config/Surge-Beta.sgmodule",
            tofile="Surge-Beta.sgmodule",
        )
    )
    changed = [
        line[1:]
        for line in diff.splitlines()
        if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))
    ]
    if not changed:
        raise SystemExit("expected the artifact URLs and CORS origin to change")
    allowed = (
        UPSTREAM_PREFIX,
        artifact_prefix(public_repo),
        UPSTREAM_CORS_ORIGINS,
        FORK_CORS_ORIGIN,
    )
    for line in changed:
        if not any(token in line for token in allowed):
            raise SystemExit(f"unexpected differing line:\n{line}")
    return diff


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("config/Surge-Beta.sgmodule"),
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--public-repo", default=DEFAULT_PUBLIC_REPO)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Require the diff to be only the artifact URL prefix and fork CORS origin (always enforced).",
    )
    args = parser.parse_args()

    original = args.source.read_bytes()
    updated = render(original, args.public_repo)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(updated)
    sys.stdout.write(assert_expected_diff(original, updated, args.public_repo))
    count = original.count(UPSTREAM_PREFIX.encode())
    print(
        f"ok: replaced {count} artifact URL prefix(es) -> {artifact_prefix(args.public_repo)}; "
        f"cors += {FORK_CORS_ORIGIN}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
