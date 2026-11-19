#!/usr/bin/env python3
"""Rewrite Surge-Beta.sgmodule for the public artifact repo.

Upstream's beta module is config/Surge-Beta.sgmodule. Its script-path URLs
use GitHub Releases on sub-store-org/Sub-Store. Those URLs are rewritten to
releases/latest/download on this repository.

The published copy also appends the self-hosted frontend origin to the
default `cors` argument, an opt-in prefetch cron that is off while
`prefetch_cron` is empty, and a wider core script pattern so file routes run
in sub-store-1. config/Surge-Beta.sgmodule in this repo stays identical to
upstream. All scheduled tasks default off; every prefetch parameter has a
usable default so installation needs no user input. Restoring the sync default,
artifact prefix, the upstream CORS list, the upstream
core pattern, and removing the prefetch block must reproduce that file byte
for byte.
"""

from __future__ import annotations

import argparse
import difflib
import re
import sys
from pathlib import Path

UPSTREAM_PREFIX = (
    "https://github.com/sub-store-org/Sub-Store/releases/latest/download"
)
DEFAULT_PUBLIC_REPO = "ahuai6/Sub-Store-Fork"
UPSTREAM_CORS_ORIGINS = (
    "https://sub-store.vercel.app,http://substore.stash,https://substore.stash,https://sub.xream.eu.org"
)
FORK_CORS_ORIGIN = "https://ahuai6.github.io"
FORK_CORS_ORIGINS = f"{UPSTREAM_CORS_ORIGINS},{FORK_CORS_ORIGIN}"
PREFETCH_ARGS = (
    ',prefetch:"# Sub-Store Prefetch",prefetch_cron:"50 */6 * * *",prefetch_sub:off,prefetch_col:off,prefetch_platform:Surge'
)
PREFETCH_DESC = (
    r"\n\n1️⃣2️⃣ prefetch_cron\n\n"
    r"全部参数均有默认值, 不需要预跑时无需填写或修改. 用来提前生成订阅, 写入输出缓存(resourceCacheTtl).\n"
    r"启用: 把 prefetch 从 # Sub-Store Prefetch 改成 Sub-Store Prefetch, "
    r"按需修改 prefetch_cron(默认 50 */6 * * *), 并设置要预热的订阅名.\n"
    r"prefetch_cron 为空时, 任务直接返回, 不生成订阅, 也不走同步配置.\n"
    r"prefetch_sub / prefetch_col 默认 off(不选择), 仅填写需要的单条/组合订阅名(name), 多个用 , 连接.\n"
    r"prefetch_platform 默认 Surge. 过期后仍会完整重算, 哈希只在 TTL 内作为缓存键."
)
UPSTREAM_SYNC_DEFAULT = 'sync:"Sub-Store Sync"'
FORK_SYNC_DEFAULT = 'sync:"# Sub-Store Sync"'
SCHEDULE_DESC = (
    r"\n\n定时同步、定时处理和预跑默认全部关闭, 无需填写 prefetch 参数即可安装."
    r"按需启用时, 去掉对应任务名(sync / produce / prefetch)开头的 #, 再设置目标与时间."
)
PREFETCH_MARK = "sub-store-fork-prefetch"
UPSTREAM_CORE_PATTERN = (
    r"pattern=^https?:\/\/sub\.store\/((download)|api\/(preview|sync|(utils\/node-info)))"
)
FORK_CORE_PATTERN = (
    r"pattern=^https?:\/\/sub\.store\/((download)|share\/file(?:\/|\?|#|$)|"
    r"api\/(file(?:\/|\?|#|$)|preview|sync|(?:utils\/node-info)))"
)


def artifact_prefix(public_repo: str) -> str:
    return f"https://github.com/{public_repo}/releases/latest/download"


def render(source: bytes, public_repo: str) -> bytes:
    eol = b"\r\n" if b"\r\n" in source else b"\n"
    normalized = source.replace(b"\r\n", b"\n")
    old = UPSTREAM_PREFIX.encode()
    new = artifact_prefix(public_repo).encode()
    if old not in normalized:
        raise SystemExit(f"upstream artifact prefix not found: {UPSTREAM_PREFIX}")
    updated = normalized.replace(old, new)
    if updated == normalized:
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
    rendered = add_prefetch(widen_core_pattern(disable_sync_by_default(updated)))
    return rendered.replace(b"\n", eol) if eol != b"\n" else rendered


def _insert_on_prefixed_line(text: str, prefix: str, suffix: str) -> str:
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.startswith(prefix):
            if line.endswith("\r\n"):
                newline = "\r\n"
                body = line[:-2]
            elif line.endswith("\n"):
                newline = "\n"
                body = line[:-1]
            else:
                newline = ""
                body = line
            lines[index] = body + suffix + newline
            return "".join(lines)
    raise SystemExit(f"missing line {prefix}")


def disable_sync_by_default(updated: bytes) -> bytes:
    text = updated.decode("utf-8")
    if text.count(UPSTREAM_SYNC_DEFAULT) != 1:
        raise SystemExit("upstream sync default anchor changed")
    text = text.replace(UPSTREAM_SYNC_DEFAULT, FORK_SYNC_DEFAULT, 1)
    return _insert_on_prefixed_line(text, "#!arguments-desc=", SCHEDULE_DESC).encode()


def restore_sync_default(text: str) -> str:
    if text.count(FORK_SYNC_DEFAULT) != 1:
        raise SystemExit("fork disabled sync default missing")
    return text.replace(FORK_SYNC_DEFAULT, UPSTREAM_SYNC_DEFAULT, 1).replace(SCHEDULE_DESC, "")


def add_prefetch(updated: bytes) -> bytes:
    """Add a disabled prefetch cron with defaults for every module parameter."""
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


def widen_core_pattern(updated: bytes) -> bytes:
    """Send file URLs to sub-store-1, which is the first matching script."""
    text = updated.decode("utf-8")
    if FORK_CORE_PATTERN in text:
        return updated
    count = text.count(UPSTREAM_CORE_PATTERN)
    if count != 1:
        raise SystemExit(f"expected one upstream core pattern, found {count}")
    return text.replace(UPSTREAM_CORE_PATTERN, FORK_CORE_PATTERN, 1).encode()


def restore_core_pattern(text: str) -> str:
    if FORK_CORE_PATTERN not in text:
        raise SystemExit("fork core pattern missing")
    return text.replace(FORK_CORE_PATTERN, UPSTREAM_CORE_PATTERN, 1)


def assert_file_routes_on_core(module_text: str) -> None:
    line = next(
        (item for item in module_text.splitlines() if item.startswith("Sub-Store Core=")),
        "",
    )
    match = re.search(r"pattern=([^,]+)", line)
    if not match:
        raise SystemExit("core script pattern missing")
    pattern = re.compile(match.group(1))
    must = [
        "https://sub.store/download/a",
        "https://sub.store/api/preview/sub",
        "https://sub.store/api/sync/artifacts",
        "https://sub.store/api/utils/node-info",
        "https://sub.store/api/file/foo",
        "https://sub.store/share/file/a",
        "https://sub.store/share/file/a?x=1",
    ]
    must_not = [
        "https://sub.store/api/utils/env",
        "https://sub.store/api/subs",
        "https://sub.store/api/files",
        "https://sub.store/api/files?x=1",
        "https://sub.store/api/wholeFile/a",
        "https://sub.store/api/wholeFiles",
        "https://sub.store/api/filesomething",
        "https://sub.store/share/sub/a",
        "https://sub.store/api/artifact/a",
    ]
    for url in must:
        if pattern.search(url) is None:
            raise SystemExit(f"core pattern missed {url}")
    for url in must_not:
        if pattern.search(url) is not None:
            raise SystemExit(f"core pattern should not match {url}")


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


def parse_module_arguments(module_text: str) -> dict[str, str]:
    """Surge defaults are optional: use a bare name, never a trailing colon.

    https://manual.nssurge.com/profile/module.html#parameter-tables
    Commas in quoted defaults (e.g. cors) must stay within one declaration.
    """
    lines = [line for line in module_text.splitlines() if line.startswith("#!arguments=")]
    if len(lines) != 1:
        raise SystemExit("expected one #!arguments header")
    header = lines[0].partition("=")[2]
    if header.count('"') % 2:
        raise SystemExit("unbalanced quotes in module arguments")
    result = {}
    for field in re.split(r',(?=(?:[^"\n]*"[^"\n]*")*[^"\n]*$)', header):
        match = re.fullmatch(r'([A-Za-z0-9_]+)(?::("[^"\n]*"|[^",\n]+))?', field.strip())
        if not match:
            raise SystemExit(f"invalid module argument declaration: {field}")
        name, default = match.groups()
        if name in result:
            raise SystemExit(f"duplicate module argument: {name}")
        value = (default or '').strip()
        if default is not None and not value:
            raise SystemExit(f"empty bare module argument default: {field}")
        result[name] = value[1:-1] if value.startswith('"') else value
    return result


def assert_prefetch_disabled_by_default(module_text: str) -> None:
    """Empty prefetch_cron must not leave a scheduled prefetch cron."""
    defaults = parse_module_arguments(module_text)
    if "prefetch_cron" not in defaults:
        raise SystemExit("prefetch_cron argument missing")
    if 'prefetch:"# Sub-Store Prefetch"' not in module_text:
        raise SystemExit("prefetch name is not disabled by default")
    base = defaults
    if not all(defaults.get(key) for key in ("prefetch_cron", "prefetch_sub", "prefetch_col", "prefetch_platform")):
        raise SystemExit("prefetch parameters must have usable defaults")
    if defaults["prefetch_sub"] != "off" or defaults["prefetch_col"] != "off":
        raise SystemExit("prefetch targets must default to off")
    substituted = _substitute(module_text, defaults)
    for line in substituted.splitlines():
        if not line.lstrip().startswith("#") and "type=cron" in line:
            raise SystemExit("scheduled sync/produce/prefetch must default off: " + line)
    if active_prefetch_lines(_substitute(module_text, base)):
        raise SystemExit("default prefetch cron is active")
    named_but_empty = dict(base)
    named_but_empty["prefetch"] = "Sub-Store Prefetch"
    named_but_empty["prefetch_cron"] = ""
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
    """Reverse every supported fork patch to recover upstream byte for byte."""
    original_eol = b"\r\n" if b"\r\n" in original else b"\n"
    updated_eol = b"\r\n" if b"\r\n" in updated else b"\n"
    if original_eol != updated_eol:
        raise SystemExit("line endings changed while rendering Surge-Beta.sgmodule")
    original_lf = original.replace(b"\r\n", b"\n")
    updated_text = updated.replace(b"\r\n", b"\n").decode("utf-8")
    assert_prefetch_disabled_by_default(updated_text)
    assert_file_routes_on_core(updated_text)
    comparable = restore_sync_default(restore_core_pattern(strip_prefetch(updated_text))).encode()
    old = UPSTREAM_PREFIX.encode()
    new = artifact_prefix(public_repo).encode()
    # Replace the longer CORS list first. It starts with the upstream list.
    restored = comparable.replace(new, old).replace(
        FORK_CORS_ORIGINS.encode(), UPSTREAM_CORS_ORIGINS.encode()
    )
    if restored != original_lf:
        raise SystemExit(
            "diff is not limited to the artifact URL prefix, the fork CORS origin, the core file pattern, disabled schedule defaults, and the prefetch cron"
        )

    # The URL/CORS check ignores the prefetch block. strip_prefetch removes it.
    diff = "".join(
        difflib.unified_diff(
            original_lf.decode("utf-8").splitlines(keepends=True),
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
        help="Require reversible fork-only module changes (always enforced).",
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
