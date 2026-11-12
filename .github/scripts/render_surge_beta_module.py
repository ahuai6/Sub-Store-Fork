#!/usr/bin/env python3
"""Rewrite Surge-Beta.sgmodule so its script paths point at our artifacts.

Upstream's beta module is config/Surge-Beta.sgmodule. Its script-path URLs
use GitHub Releases on sub-store-org/Sub-Store. This source repo is private,
so those URLs are rewritten to the same path on a public artifact repo.

The output is otherwise byte-for-byte identical to the upstream module.
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
    if b"sub-store-org/Sub-Store" in updated:
        raise SystemExit(
            "rewritten module still references sub-store-org/Sub-Store"
        )
    return updated


def assert_url_only_diff(original: bytes, updated: bytes, public_repo: str) -> str:
    """Fail unless swapping the prefix back restores the original bytes."""
    old = UPSTREAM_PREFIX.encode()
    new = artifact_prefix(public_repo).encode()
    if updated.replace(new, old) != original:
        raise SystemExit("diff is not limited to the artifact URL prefix")

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
        raise SystemExit("expected the artifact URLs to change")
    for line in changed:
        if UPSTREAM_PREFIX not in line and artifact_prefix(public_repo) not in line:
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
        help="Require the diff to be only the artifact URL prefix (always enforced).",
    )
    args = parser.parse_args()

    original = args.source.read_bytes()
    updated = render(original, args.public_repo)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(updated)
    sys.stdout.write(assert_url_only_diff(original, updated, args.public_repo))
    count = original.count(UPSTREAM_PREFIX.encode())
    print(
        f"ok: replaced {count} artifact URL prefix(es) -> {artifact_prefix(args.public_repo)}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
