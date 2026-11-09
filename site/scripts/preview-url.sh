#!/usr/bin/env bash
# A branch's Cloudflare Preview URL, as Workers Builds names it: the branch lowercased, anything else a
# hyphen, then the Worker's name. Prints nothing when the name is too long to predict (Cloudflare
# shortens it and adds a hash). Used for the Preview deployments the "Deployed version" workflow records.
#
#   bash site/scripts/preview-url.sh feat/new-docs-page
#   → https://feat-new-docs-page-leadlens.harrisonjennings-au.workers.dev/
set -euo pipefail

branch="${1:?usage: preview-url.sh <branch>}"
slug=$(printf '%s' "$branch" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
host="$slug-leadlens"
if [ "${#host}" -le 63 ]; then
  echo "https://$host.harrisonjennings-au.workers.dev/"
fi
