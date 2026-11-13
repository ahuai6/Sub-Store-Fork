#!/usr/bin/env bash
# Publish the Surge beta module and backend bundles to a PUBLIC repo.
#
# The source repository stays private. Surge can fetch raw.githubusercontent.com
# and GitHub release assets only when the destination repo is public, so this
# script never writes back to the source repo.
#
# Required env:
#   PUBLIC_DIST_TOKEN   contents:write on the public repo only
#   PUBLIC_DIST_REPO    owner/name (default: ahuai6/Sub-Store-Fork-Dist)
#   GITHUB_SHA          commit that was built
#   GITHUB_REPOSITORY   source repo (used only to refuse publishing into it)
#
# Argument: directory produced by the build job, containing the bundles,
# Surge-Beta.sgmodule, version.txt, and source-sha.txt.

set -euo pipefail

DIST_DIR=${1:?dist directory required}
REPO=${PUBLIC_DIST_REPO:-ahuai6/Sub-Store-Fork-Dist}
TOKEN=${PUBLIC_DIST_TOKEN:-}
SOURCE_REPO=${GITHUB_REPOSITORY:-ahuai6/Sub-Store-Fork}
SOURCE_ROOT=${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/../.." && pwd)}

if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "::error::PUBLIC_DIST_REPO must look like owner/name, got: ${REPO}"
  exit 1
fi
if [[ "$REPO" == "$SOURCE_REPO" ]]; then
  echo "::error::Refusing to publish artifacts into the source repo (${SOURCE_REPO})."
  exit 1
fi
if [[ -z "$TOKEN" ]]; then
  cat <<EOF
::error title=PUBLIC_DIST_TOKEN is not set::Surge cannot fetch files from the private source repo. Create public repo ${REPO} and add Actions secret PUBLIC_DIST_TOKEN (fine-grained PAT, contents write on that repo only), then re-run publish-dist.
EOF
  {
    echo "### Public dist repo is not configured"
    echo ""
    echo "The Surge beta module was built, but it was not published."
    echo ""
    echo "1. Create a **public** repository \`${REPO}\` (empty, default branch \`main\`)."
    echo "2. Create a fine-grained PAT with **Contents: Read and write** on that repo only."
    echo "3. Add it to this private repo as Actions secret \`PUBLIC_DIST_TOKEN\`."
    echo "4. Re-run this workflow."
    echo ""
    echo "Module URL once that succeeds:"
    echo ""
    echo "https://raw.githubusercontent.com/${REPO}/main/Surge-Beta.sgmodule"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
fi

for required in \
  Surge-Beta.sgmodule \
  geo.js \
  GEO-LICENSE.txt \
  GEO-NOTICE.md \
  sub-store.min.js \
  sub-store-0.min.js \
  sub-store-1.min.js \
  sub-store-parser.loon.min.js \
  cron-sync-artifacts.min.js \
  proxy-utils.esm.mjs \
  sub-store.bundle.js \
  runtime-manifest.json \
  version.txt \
  source-sha.txt
do
  if [[ ! -s "${DIST_DIR}/${required}" ]]; then
    echo "::error::Missing build output ${DIST_DIR}/${required}"
    exit 1
  fi
done

# Fine-grained PATs are accepted by git as Basic x-access-token, not as a bearer header.
TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
TOKEN=${TOKEN#Bearer}
TOKEN=${TOKEN#bearer}
basic=$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')
export GIT_TERMINAL_PROMPT=0
export GH_TOKEN="$TOKEN"
# actions/checkout@v6 keeps the job token in an includeIf file as
# http.https://github.com/.extraheader. That key is multi-valued, so adding
# another -c extraheader sends both and GitHub returns 400 Duplicate header.
# An empty value clears the inherited list. Keep this in sync with
# publish_frontend_pages.sh. Commands here already use -C outside the source
# checkout; the reset still matters if one of them runs inside it.
git_auth() {
  git \
    -c credential.helper= \
    -c http.extraheader= \
    -c "http.https://github.com/.extraheader=" \
    -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}" \
    "$@"
}

VERSION=$(tr -d '[:space:]' < "${DIST_DIR}/version.txt")
SOURCE_SHA=$(tr -d '[:space:]' < "${DIST_DIR}/source-sha.txt")
UPSTREAM_SHA=""
if [[ -s "${DIST_DIR}/upstream-sha.txt" ]]; then
  UPSTREAM_SHA=$(tr -d '[:space:]' < "${DIST_DIR}/upstream-sha.txt")
fi
SHORT_SHA=${SOURCE_SHA:0:12}
MODULE_URL="https://raw.githubusercontent.com/${REPO}/main/Surge-Beta.sgmodule"
RELEASE_MODULE_URL="https://github.com/${REPO}/releases/latest/download/Surge-Beta.sgmodule"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

echo "Cloning ${REPO}"
# Clone outside the source checkout so this command does not load that repo's credentials.
if ! git_auth -C "${workdir}" clone --depth 1 "https://github.com/${REPO}.git" "${workdir}/repo"; then
  echo "::error title=Could not clone ${REPO}::The public repo exists, but git rejected PUBLIC_DIST_TOKEN. Use a fine-grained PAT with Contents: Read and write on ${REPO} only, with no extra whitespace, and do not make ${SOURCE_REPO} public."
  exit 1
fi

git -C "${workdir}/repo" config user.name "github-actions[bot]"
git -C "${workdir}/repo" config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if git -C "${workdir}/repo" rev-parse --verify HEAD >/dev/null 2>&1; then
  branch=$(git -C "${workdir}/repo" symbolic-ref --short HEAD)
else
  git -C "${workdir}/repo" checkout -b main
  branch=main
fi

# The owner explicitly requested geo.js publication on 2026-11-13.
# Publish only this requested script with its upstream license and attribution;
# other private source files are not copied to the public artifact repo.
for file in geo.js GEO-LICENSE.txt GEO-NOTICE.md; do
  cp "${DIST_DIR}/${file}" "${workdir}/repo/${file}"
done
# Copy LICENSE from the source checkout unchanged.
cp "${SOURCE_ROOT}/LICENSE" "${workdir}/repo/LICENSE"
cp "${DIST_DIR}/Surge-Beta.sgmodule" "${workdir}/repo/Surge-Beta.sgmodule"

cat > "${workdir}/repo/README.md" <<EOF
# Sub-Store public build artifacts

This repository publishes build artifacts so Surge can download them.
The source repository (\`${SOURCE_REPO}\`) is private. Only the explicitly requested geo.js operator source and its notices are published here alongside artifacts.

| | |
| --- | --- |
| Version | \`${VERSION}\` |
| Built from | \`${SOURCE_SHA}\` |
| Upstream tree | \`${UPSTREAM_SHA:-"(not recorded)"}\` |
| Upstream project | https://github.com/sub-store-org/Sub-Store |

## Surge beta module

\`\`\`
${MODULE_URL}
\`\`\`

The same file is also attached to each release:

\`\`\`
${RELEASE_MODULE_URL}
\`\`\`

Script paths inside the module use \`releases/latest/download\` on **this** repo.
Compared with [upstream's beta module](https://raw.githubusercontent.com/sub-store-org/Sub-Store/master/config/Surge-Beta.sgmodule), those artifact URLs differ and the default \`cors\` list also includes \`https://ahuai6.github.io\`.

Scheduled Gist sync, produce and prefetch tasks default to off. Installation
requires no prefetch input: all parameters have defaults; unused prefetch target
lists stay \`off\`. Existing saved module settings may persist on update, so
check task names or reinstall to apply new defaults.

## Frontend

https://ahuai6.github.io/Sub-Store-Fork-Dist/

The \`/\` redirect targets that site. It is the upstream front end (GPL-3.0), built for this subpath. License and corresponding source are on the \`gh-pages\` branch.

## Geo check operator

[geo.js](./geo.js) is also published as readable JavaScript at:

https://raw.githubusercontent.com/${REPO}/main/geo.js

Add that URL as a Sub-Store Script Operator. It is a modified xream/scripts
operator; see [GEO-NOTICE.md](./GEO-NOTICE.md) for attribution, upstream terms,
changes and optional arguments, and [GEO-LICENSE.txt](./GEO-LICENSE.txt) for the
upstream GPL-3.0 license. It is separate from the backend's AGPL license.

## License

Sub-Store is licensed under the GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).

Corresponding source for this build is upstream commit \`${UPSTREAM_SHA:-unknown}\` (https://github.com/sub-store-org/Sub-Store/tree/${UPSTREAM_SHA:-master}) plus whatever else is in the private source repo at \`${SOURCE_SHA}\`. The release build also pins the mihomo User-Agent the same way upstream's release workflow does. AGPL-3.0 requires modified versions that are distributed to make their corresponding source available.
EOF

git -C "${workdir}/repo" add LICENSE README.md Surge-Beta.sgmodule geo.js GEO-LICENSE.txt GEO-NOTICE.md
if git -C "${workdir}/repo" diff --cached --quiet; then
  echo "Module, LICENSE, and README are already current."
else
  git -C "${workdir}/repo" commit -m "publish: Sub-Store ${VERSION} (${SHORT_SHA})"
  git_auth -C "${workdir}/repo" push origin "HEAD:${branch}"
fi

notes=$(mktemp)
cat > "$notes" <<EOF
Sub-Store ${VERSION}

- Built from \`${SOURCE_REPO}@${SOURCE_SHA}\`
- Upstream tree: \`${UPSTREAM_SHA:-unknown}\`
- Upstream project: https://github.com/sub-store-org/Sub-Store
- License: AGPL-3.0 (LICENSE in this repo)

Surge beta module: ${MODULE_URL}
EOF

assets=(
  "${DIST_DIR}/sub-store.min.js"
  "${DIST_DIR}/sub-store-0.min.js"
  "${DIST_DIR}/sub-store-1.min.js"
  "${DIST_DIR}/sub-store-parser.loon.min.js"
  "${DIST_DIR}/cron-sync-artifacts.min.js"
  "${DIST_DIR}/proxy-utils.esm.mjs"
  "${DIST_DIR}/sub-store.bundle.js"
  "${DIST_DIR}/runtime-manifest.json"
  "${DIST_DIR}/Surge-Beta.sgmodule"
  "${DIST_DIR}/geo.js"
  "${DIST_DIR}/GEO-LICENSE.txt"
  "${DIST_DIR}/GEO-NOTICE.md"
)

if gh release view "$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$VERSION" --repo "$REPO" --clobber "${assets[@]}"
  gh release edit "$VERSION" --repo "$REPO" --notes-file "$notes"
else
  gh release create "$VERSION" --repo "$REPO" --title "$VERSION" --notes-file "$notes" "${assets[@]}"
fi

{
  echo "### Surge beta module"
  echo ""
  echo "${MODULE_URL}"
  echo ""
  echo "Release asset (same file): ${RELEASE_MODULE_URL}"
  echo ""
  echo "Version \`${VERSION}\` on \`${REPO}\`."
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo "Published ${MODULE_URL}"
