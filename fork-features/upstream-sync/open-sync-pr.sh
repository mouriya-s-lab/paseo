#!/usr/bin/env bash
# Opens (or reuses) the labeled sync PR for HEAD_BRANCH -> BASE_BRANCH and
# prints its number. Used by .github/workflows/sync-upstream.yml.
#
# GitHub allows one open PR per (head, base) pair; the fixed sync branch names
# are the uniqueness key, so a duplicate create is treated as "already there".
# Diagnostics go to stderr; stdout is only the PR number.
#
# Usage: open-sync-pr.sh <head-branch> <base-branch> <title> <body>
# Env: GH_TOKEN, REPO (owner/name), OWNER, SYNC_LABEL
set -euo pipefail

head="$1"
base="$2"
title="$3"
body="$4"

existing() {
  gh api "repos/$REPO/pulls?head=$OWNER:$head&base=$base&state=open" --jq '.[0].number // empty'
}

number="$(existing)"
if [[ -z "$number" ]]; then
  number="$(gh api "repos/$REPO/pulls" -X POST \
    -f title="$title" -f head="$head" -f base="$base" -f body="$body" \
    --jq '.number' 2>/dev/null)" || number="$(existing)"
fi
if [[ -z "$number" ]]; then
  echo "Could not open or find a PR for $head -> $base" >&2
  exit 1
fi
gh pr edit "$number" --repo "$REPO" --add-label "$SYNC_LABEL" >/dev/null
echo "$number"
