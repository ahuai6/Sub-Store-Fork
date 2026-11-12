#!/usr/bin/env bash
# Choose which Sub-Store-Front-End commit to build.
#
# The published dist.zip uses Vite base `/`, so this repo always builds from
# source. The latest GitHub release is the commit to build when it is master,
# or when master is behind that release. Master is used when it has commits
# the latest release does not: upstream's release workflow only runs when
# package.json changes, so master can sit ahead of the newest tag.
#
# Writes shell-compatible KEY=VALUE lines to stdout and, when GITHUB_OUTPUT
# is set, the same keys there. GH_TOKEN / GITHUB_TOKEN is optional; the
# upstream repository is public.

set -euo pipefail

REPO=${FRONTEND_REPO:-sub-store-org/Sub-Store-Front-End}
token=${GH_TOKEN:-${GITHUB_TOKEN:-}}

api() {
  local url="https://api.github.com/repos/${REPO}/$1"
  if [[ -n "$token" ]]; then
    curl -fsSL -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github+json" "$url"
  else
    curl -fsSL -H "Accept: application/vnd.github+json" "$url"
  fi
}

json_get() {
  python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

release_json=$(api releases/latest)
release_tag=$(printf '%s' "$release_json" | json_get tag_name)
release_sha=$(api "commits/${release_tag}" | json_get sha)
master_sha=$(api commits/master | json_get sha)
compare_status=$(api "compare/${release_sha}...${master_sha}" | json_get status)

case "$compare_status" in
  identical)
    track=release
    sha=$release_sha
    reason="latest release ${release_tag} is master"
    ;;
  ahead|diverged)
    track=master
    sha=$master_sha
    reason="master is ${compare_status} of release ${release_tag}; releases lag"
    ;;
  behind)
    track=release
    sha=$release_sha
    reason="master is behind release ${release_tag}; building the release"
    ;;
  *)
    echo "unexpected compare status: ${compare_status}" >&2
    exit 1
    ;;
esac

emit() {
  printf '%s\n' "$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_OUTPUT"
  fi
}

emit "sha=${sha}"
emit "track=${track}"
emit "release_tag=${release_tag}"
emit "release_sha=${release_sha}"
emit "master_sha=${master_sha}"
echo "${reason}" >&2
