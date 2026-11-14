#!/usr/bin/env bash
# Attach the Surge beta module and backend bundles to this repository's
# GitHub Release.
#
# The tag is the version in backend/package.json, the same name previously
# used for public release assets. Surge fetches those assets with
# releases/latest/download. The module on main (dist/Surge-Beta.sgmodule)
# is the raw URL; this script does not commit it and does not push any branch.
#
# The upload is an explicit release asset list: the bundles, the module,
# geo.js, GEO-LICENSE.txt, and GEO-NOTICE.md. The repository tree is not
# uploaded. Nothing is uploaded as an Actions artifact. There is no force-push.
#
# Required env:
#   GITHUB_TOKEN or GH_TOKEN   contents:write on this repository
#   GITHUB_REPOSITORY          owner/name
#   GITHUB_SHA is not required; source-sha.txt in the dist directory is
#
# Argument: directory produced by the build job, containing the bundles,
# Surge-Beta.sgmodule, version.txt, and source-sha.txt.

set -euo pipefail

DIST_DIR=${1:?dist directory required}
REPO=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
TOKEN=${GITHUB_TOKEN:-${GH_TOKEN:-}}

if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "::error::GITHUB_REPOSITORY must look like owner/name, got: ${REPO}"
  exit 1
fi
if [[ -z "$TOKEN" ]]; then
  echo "::error title=GITHUB_TOKEN is not set::Release publishing uses the workflow GITHUB_TOKEN with contents: write. No separate publish token is required."
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

TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
TOKEN=${TOKEN#Bearer}
TOKEN=${TOKEN#bearer}
export GH_TOKEN="$TOKEN"

VERSION=$(tr -d '[:space:]' < "${DIST_DIR}/version.txt")
SOURCE_SHA=$(tr -d '[:space:]' < "${DIST_DIR}/source-sha.txt")
UPSTREAM_SHA=""
if [[ -s "${DIST_DIR}/upstream-sha.txt" ]]; then
  UPSTREAM_SHA=$(tr -d '[:space:]' < "${DIST_DIR}/upstream-sha.txt")
fi
if [[ ! "$VERSION" =~ ^[A-Za-z0-9._+-]+$ ]]; then
  echo "::error::Refusing release tag ${VERSION}"
  exit 1
fi
if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::source-sha.txt is not a 40-character hex SHA"
  exit 1
fi

MODULE_URL="https://raw.githubusercontent.com/${REPO}/main/dist/Surge-Beta.sgmodule"
RELEASE_MODULE_URL="https://github.com/${REPO}/releases/latest/download/Surge-Beta.sgmodule"
GEO_URL="https://raw.githubusercontent.com/${REPO}/main/scripts/check/geo.js"
PAGES_URL="https://ahuai6.github.io/Sub-Store-Fork/"

notes=$(mktemp)
cat > "$notes" <<EOF
Sub-Store ${VERSION}

| | |
| --- | --- |
| Version | \`${VERSION}\` |
| Built from | \`${SOURCE_SHA}\` |
| Upstream tree | \`${UPSTREAM_SHA:-unknown}\` |
| Upstream project | https://github.com/sub-store-org/Sub-Store |

- Repository: https://github.com/${REPO}
- License: AGPL-3.0 (\`LICENSE\` on \`main\`)
- Frontend: ${PAGES_URL}

Surge beta module (raw): ${MODULE_URL}

Surge beta module (this Release): ${RELEASE_MODULE_URL}

geo.js: ${GEO_URL}

Script paths inside the module use \`releases/latest/download\` on this repository.
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
  # Same version tag, new build. Replace the assets. Do not move the tag.
  gh release upload "$VERSION" --repo "$REPO" --clobber "${assets[@]}"
  gh release edit "$VERSION" --repo "$REPO" --notes-file "$notes"
else
  # The version tag may already exist as a mirrored upstream tag. Creating the
  # Release attaches these assets to that tag and does not move it. A missing
  # tag is created at the default branch by gh itself; this script never
  # force-updates a tag.
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

echo "Published ${RELEASE_MODULE_URL}"
