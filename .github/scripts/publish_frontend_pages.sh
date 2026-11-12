#!/usr/bin/env bash
# Push a prepared front-end directory to the public repo's gh-pages branch.
#
# GitHub Pages serves that branch at
# https://ahuai6.github.io/Sub-Store-Fork-Dist/ once Pages is enabled.
# This script never pushes main, upstream, or any other branch, and it does
# not force-push.
#
# Required env:
#   PUBLIC_DIST_TOKEN   contents:write on the public repo only
#   PUBLIC_DIST_REPO    owner/name (default: ahuai6/Sub-Store-Fork-Dist)
#
# Argument: directory produced by prepare_frontend_pages.py --finalize-site.

set -euo pipefail

SITE_DIR=${1:?site directory required}
REPO=${PUBLIC_DIST_REPO:-ahuai6/Sub-Store-Fork-Dist}
TOKEN=${PUBLIC_DIST_TOKEN:-}
SOURCE_REPO=${GITHUB_REPOSITORY:-ahuai6/Sub-Store-Fork}
SOURCE_ROOT=${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/../.." && pwd)}
BRANCH=gh-pages
PAGES_URL="https://ahuai6.github.io/Sub-Store-Fork-Dist/"

if [[ "$BRANCH" != "gh-pages" ]]; then
  echo "::error::Refusing to publish the frontend anywhere but gh-pages."
  exit 1
fi
if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "::error::PUBLIC_DIST_REPO must look like owner/name, got: ${REPO}"
  exit 1
fi
if [[ "$REPO" == "$SOURCE_REPO" ]]; then
  echo "::error::Refusing to publish the frontend into the source repo (${SOURCE_REPO})."
  exit 1
fi
if [[ -z "$TOKEN" ]]; then
  cat <<EOF
::error title=PUBLIC_DIST_TOKEN is not set::Create a fine-grained PAT with Contents: Read and write on ${REPO} only, store it as Actions secret PUBLIC_DIST_TOKEN, and re-run publish-frontend. Enabling GitHub Pages is a repository setting and does not require the Pages permission on that token.
EOF
  exit 1
fi

python3 "${SOURCE_ROOT}/.github/scripts/prepare_frontend_pages.py" \
  --check-dist \
  --dist "${SITE_DIR}"

for required in \
  index.html \
  404.html \
  .nojekyll \
  LICENSE \
  ATTRIBUTION.md \
  README.md \
  frontend-version.txt \
  manifest.webmanifest \
  manifests.json \
  registerSW.js \
  sw.js
do
  if [[ ! -e "${SITE_DIR}/${required}" ]]; then
    echo "::error::Missing site file ${SITE_DIR}/${required}"
    exit 1
  fi
done
if [[ ! -s "${SITE_DIR}/LICENSE" || ! -s "${SITE_DIR}/index.html" ]]; then
  echo "::error::LICENSE or index.html is empty"
  exit 1
fi

TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
TOKEN=${TOKEN#Bearer}
TOKEN=${TOKEN#bearer}
basic=$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')
export GIT_TERMINAL_PROMPT=0
git_auth() {
  git \
    -c credential.helper= \
    -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}" \
    "$@"
}

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

remote_branch=$(git_auth ls-remote --heads "https://github.com/${REPO}.git" "$BRANCH" || true)
echo "Cloning ${REPO}"
if [[ -n "$remote_branch" ]]; then
  git_auth clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "${workdir}/repo"
else
  git_auth clone --depth 1 "https://github.com/${REPO}.git" "${workdir}/repo"
  git -C "${workdir}/repo" checkout --orphan "$BRANCH"
fi

git -C "${workdir}/repo" config user.name "github-actions[bot]"
git -C "${workdir}/repo" config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# Replace the branch contents. An orphan branch has no HEAD yet, but the
# index still holds the default branch, so clear it in both cases. The
# following commit is a normal push of gh-pages, not a force-push, and it
# does not touch main.
git -C "${workdir}/repo" rm -rf . >/dev/null
cp -a "${SITE_DIR}/." "${workdir}/repo/"
git -C "${workdir}/repo" add -A
if git -C "${workdir}/repo" diff --cached --quiet; then
  echo "gh-pages already matches this build."
else
  version=$(awk -F= '$1=="package"{print $2}' "${SITE_DIR}/frontend-version.txt")
  sha=$(awk -F= '$1=="sha"{print $2}' "${SITE_DIR}/frontend-version.txt")
  short=${sha:0:12}
  git -C "${workdir}/repo" commit -m "frontend: Sub-Store Front End ${version} (${short})"
  git_auth -C "${workdir}/repo" push origin "HEAD:${BRANCH}"
fi

{
  echo "### Front end"
  echo ""
  echo "${PAGES_URL}"
  echo ""
  echo "Branch \`${BRANCH}\` on \`${REPO}\`."
  echo ""
  echo "Enable GitHub Pages for that repository from branch \`${BRANCH}\` and folder \`/ (root)\` if it is not already enabled."
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo "Published ${PAGES_URL}"
