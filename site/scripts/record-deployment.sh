#!/usr/bin/env bash
# Records a GitHub deployment for a commit Cloudflare built, so it shows in the repository's
# Deployments panel and on its pull request. The "Deployed version" workflow runs on Cloudflare's checks
# (check_run events), where a job's own commit is main's latest, not the one built, so deployments are
# recorded here, against the built commit's branch, rather than with a job's `environment`.
#
#   start <environment> <branch> <sha>   prints the deployment's id, or nothing if <branch> has moved
#                                        past <sha> (a newer push, which records itself)
#   finish <id> <success|failure> [url]  marks it done, with the address it's at
#
#   GH_TOKEN=… REPO=owner/name [RUN_URL=…] bash site/scripts/record-deployment.sh start Preview my-branch <sha>
set -euo pipefail

: "${REPO:?set REPO to owner/name}"
mode="${1:?usage: record-deployment.sh start|finish …}"

case "$mode" in
  start)
    environment="${2:?environment}"
    branch="${3:?branch}"
    sha="${4:?sha}"
    # Recorded against the branch, as GitHub shows deployments on a pull request by its branch; only
    # while the branch is still at the commit that was built, so the record is of the right commit.
    # (gh prints the error body on a missing branch, so anything that isn't a SHA counts as none)
    head=$(gh api "repos/$REPO/git/ref/heads/$branch" --jq .object.sha 2>/dev/null || true)
    [[ "$head" =~ ^[0-9a-f]{40}$ ]] || head=
    if [ "$head" != "$sha" ]; then
      echo "$branch is at ${head:-nothing} now, not $sha: its own build records it" >&2
      exit 0
    fi
    id=$(jq -n --arg ref "$branch" --arg env "$environment" \
      '{ref: $ref, environment: $env, auto_merge: false, required_contexts: [], description: "Cloudflare Workers Builds"}' |
      gh api "repos/$REPO/deployments" --input - --jq .id)
    gh api "repos/$REPO/deployments/$id/statuses" -f state=in_progress -f log_url="${RUN_URL:-}" >/dev/null
    echo "$id"
    ;;
  finish)
    id="${2:?deployment id}"
    state="${3:?success or failure}"
    url="${4:-}"
    gh api "repos/$REPO/deployments/$id/statuses" -f state="$state" -f environment_url="$url" \
      -f log_url="${RUN_URL:-}" >/dev/null
    ;;
  *)
    echo "usage: record-deployment.sh start|finish …" >&2
    exit 2
    ;;
esac
