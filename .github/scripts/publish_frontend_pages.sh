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
# actions/checkout@v6 keeps the job token in an includeIf file as
# http.https://github.com/.extraheader. That key is multi-valued, so adding
# another -c extraheader sends both and GitHub returns 400 Duplicate header.
# An empty value clears the inherited list. Keep this in sync with
# publish_public_dist.sh. The result is exactly one Authorization header.
git_auth() {
  git \
    -c credential.helper= \
    -c http.extraheader= \
    -c "http.https://github.com/.extraheader=" \
    -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}" \
    "$@"
}

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

remote="https://github.com/${REPO}.git"
# Run outside the source checkout. Its includeIf credentials apply only when
# gitdir matches that repo; ls-remote from inside it was what duplicated the
# header. Exit 2 from ls-remote --exit-code means the branch is absent. Any
# other failure must stop the job. Treating it as "no branch" creates a root
# commit whose push is then rejected, or would need a force-push.
creating_branch=0
if remote_branch=$(git_auth -C "$workdir" ls-remote --exit-code --heads "$remote" "$BRANCH"); then
  if [[ -z "$remote_branch" ]]; then
    echo "::error::ls-remote succeeded but did not return ${BRANCH} on ${REPO}."
    exit 1
  fi
  echo "Cloning ${REPO} branch ${BRANCH}"
  git_auth -C "$workdir" clone --depth 1 --branch "$BRANCH" "$remote" "${workdir}/repo"
else
  probe_status=$?
  if [[ "$probe_status" -ne 2 ]]; then
    echo "::error::Could not list ${BRANCH} on ${REPO} (git ls-remote exit ${probe_status}). Refusing to create a new root commit."
    exit 1
  fi
  creating_branch=1
  echo "${BRANCH} does not exist on ${REPO}. Creating it."
  git_auth -C "$workdir" clone --depth 1 "$remote" "${workdir}/repo"
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
  # A root commit is only valid when this script just created the branch.
  # Pushing one onto an existing gh-pages is not a fast-forward.
  if [[ "$creating_branch" != "1" ]] && ! git -C "${workdir}/repo" rev-parse --verify --quiet HEAD^ >/dev/null; then
    echo "::error::Refusing to push a root commit onto existing ${BRANCH}."
    exit 1
  fi
  # Normal push. Do not add --force. The commit sits on the cloned tip.
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
