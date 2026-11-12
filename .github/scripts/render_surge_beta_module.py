#!/usr/bin/env python3
"""Rewrite Surge-Beta.sgmodule for the public artifact repo.

Upstream's beta module is config/Surge-Beta.sgmodule. Its script-path URLs
use GitHub Releases on sub-store-org/Sub-Store. This source repo is private,
so those URLs are rewritten to the same path on a public artifact repo.

The published copy also appends the self-hosted frontend origin to the
default `cors` argument, and an opt-in prefetch cron that is off while
`prefetch_cron` is empty. config/Surge-Beta.sgmodule in this repo stays
identical to upstream. Restoring the artifact prefix, the upstream CORS
list, and removing the prefetch block must reproduce that file byte for byte.
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
PREFETCH_ARGS = (
    ',prefetch:"# Sub-Store Prefetch",prefetch_cron:,prefetch_sub:,prefetch_col:,prefetch_platform:Surge'
)
PREFETCH_DESC = (
    r"\n\n1️⃣2️⃣ prefetch_cron\n\n"
    r"可选, 默认空, 不运行. 用来提前生成订阅, 写入输出缓存(resourceCacheTtl).\n"
    r"启用: 把 prefetch 从 # Sub-Store Prefetch 改成 Sub-Store Prefetch, "
    r"并把 prefetch_cron 设为 Cron 表达式, 例如 50 */6 * * *.\n"
    r"prefetch_cron 为空时, 任务直接返回, 不生成订阅, 也不走同步配置.\n"
    r"prefetch_sub / prefetch_col 是要预热的单条/组合订阅名(name), 多个用 , 连接.\n"
    r"prefetch_platform 默认 Surge. 过期后仍会完整重算, 哈希只在 TTL 内作为缓存键."
)
PREFETCH_MARK = "sub-store-fork-prefetch"


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
    return add_prefetch(updated)


def _insert_on_prefixed_line(text: str, prefix: str, suffix: str) -> str:
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.startswith(prefix):
            newline = "\n" if line.endswith("\n") else ""
            body = line[: -1] if newline else line
            lines[index] = body + suffix + newline
            return "".join(lines)
    raise SystemExit(f"missing line {prefix}")


def add_prefetch(updated: bytes) -> bytes:
    """Add an opt-in prefetch cron. Empty prefetch_cron does not schedule it."""
    text = updated.decode("utf-8")
    if PREFETCH_MARK in text:
        return updated
    cron = None
    for line in text.splitlines():
        if "cron-sync-artifacts.min.js" in line and "script-path=" in line:
            start = line.index("script-path=") + len("script-path=")
            end = line.find(",", start)
            cron = line[start:end]
            break
    if not cron:
        raise SystemExit("cron-sync-artifacts script-path not found")
    text = _insert_on_prefixed_line(text, "#!arguments=", PREFETCH_ARGS)
    text = _insert_on_prefixed_line(text, "#!arguments-desc=", PREFETCH_DESC)
    if not text.endswith("\n"):
        text += "\n"
    text += (
        "# "
        + PREFETCH_MARK
        + ": off while prefetch starts with # or prefetch_cron is empty\n"
        '{{{prefetch}}}=type=cron,cronexp="{{{prefetch_cron}}}",wake-system=1,'
        "timeout={{{timeout}}},script-path="
        + cron
        + ",engine={{{engine}}},"
        'argument="prefetch=1&cron={{{prefetch_cron}}}&platform={{{prefetch_platform}}}'
        '&sub={{{prefetch_sub}}}&col={{{prefetch_col}}}"\n'
    )
    return text.encode("utf-8")


def strip_prefetch(text: str) -> str:
    text = text.replace(PREFETCH_ARGS, "").replace(PREFETCH_DESC, "")
    kept = []
    for line in text.splitlines(keepends=True):
        if PREFETCH_MARK in line or 'argument="prefetch=1' in line:
            continue
        kept.append(line)
    return "".join(kept)


def _substitute(text: str, values: dict[str, str]) -> str:
    rendered = text
    for key, value in values.items():
        rendered = rendered.replace("{{{" + key + "}}}", value)
    return rendered


def active_prefetch_lines(text: str) -> list[str]:
    found = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("#") or "prefetch=1" not in line:
            continue
        if "type=cron" in line:
            found.append(line)
    return found


def assert_prefetch_disabled_by_default(module_text: str) -> None:
    """Empty prefetch_cron must not leave a scheduled prefetch cron."""
    if "prefetch_cron:" not in module_text:
        raise SystemExit("prefetch_cron argument missing")
    if 'prefetch:"# Sub-Store Prefetch"' not in module_text:
        raise SystemExit("prefetch name is not disabled by default")
    base = {
        "prefetch": "# Sub-Store Prefetch",
        "prefetch_cron": "",
        "prefetch_sub": "",
        "prefetch_col": "",
        "prefetch_platform": "Surge",
        "timeout": "900",
        "engine": "auto",
    }
    if active_prefetch_lines(_substitute(module_text, base)):
        raise SystemExit("default prefetch cron is active")
    named_but_empty = dict(base)
    named_but_empty["prefetch"] = "Sub-Store Prefetch"
    for line in active_prefetch_lines(_substitute(module_text, named_but_empty)):
        if 'cronexp=""' not in line:
            raise SystemExit(
                "empty prefetch_cron produced a cron expression: " + line
            )
    enabled = dict(base)
    enabled["prefetch"] = "Sub-Store Prefetch"
    enabled["prefetch_cron"] = "50 */6 * * *"
    enabled["prefetch_sub"] = "sub1"
    active = active_prefetch_lines(_substitute(module_text, enabled))
    if len(active) != 1:
        raise SystemExit(f"expected one enabled prefetch cron, got {active}")
    if 'cronexp="50 */6 * * *"' not in active[0] or "prefetch=1" not in active[0]:
        raise SystemExit("enabled prefetch cron is missing the schedule")


def assert_expected_diff(original: bytes, updated: bytes, public_repo: str) -> str:
    """Fail unless reversing the prefix and CORS origin restores the source."""
    assert_prefetch_disabled_by_default(updated.decode("utf-8"))
    comparable = strip_prefetch(updated.decode("utf-8")).encode("utf-8")
    old = UPSTREAM_PREFIX.encode()
    new = artifact_prefix(public_repo).encode()
    # Replace the longer CORS list first. It starts with the upstream list.
    restored = comparable.replace(new, old).replace(
        FORK_CORS_ORIGINS.encode(), UPSTREAM_CORS_ORIGINS.encode()
    )
    if restored != original:
        raise SystemExit(
            "diff is not limited to the artifact URL prefix, the fork CORS origin, and the prefetch cron"
        )

    # The URL/CORS check ignores the prefetch block. strip_prefetch removes it.
    diff = "".join(
        difflib.unified_diff(
            original.decode("utf-8").splitlines(keepends=True),
            comparable.decode("utf-8").splitlines(keepends=True),
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
