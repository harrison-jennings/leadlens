#!/usr/bin/env bash
# A quick check that a deployed copy of the website works and keeps what search engines rely on: pages,
# one address per page, the 404, robots.txt and the sitemap, canonical and social tags, and the security
# headers. The "Deployed version" workflow runs it after each deploy of main against that exact version's
# address on workers.dev, with the Cloudflare Access service token in CF_ACCESS_CLIENT_ID and
# CF_ACCESS_CLIENT_SECRET. Also handy by hand:
#
#   bash site/scripts/smoke-test.sh https://leadlens.harrisonjennings.au   # from a home network: Bot Fight
#                                                                         # Mode challenges data centres
#   bash site/scripts/smoke-test.sh http://127.0.0.1:8787                  # cd site && npx wrangler dev
set -uo pipefail

base="${1:?usage: smoke-test.sh <base URL>}"
base="${base%/}"
site=https://leadlens.harrisonjennings.au
failures=0

auth=()
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  auth=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
fi
# A browser's Accept header, so Cloudflare treats the request as a page view.
get() { curl -s --max-time 20 -H 'Accept: text/html,*/*;q=0.8' ${auth[@]+"${auth[@]}"} "$@"; }

check() {
  local name=$1
  shift
  if "$@"; then
    echo "✓ $name"
  else
    echo "✗ $name"
    failures=$((failures + 1))
  fi
}
status() { get -o /dev/null -w '%{http_code}' "$base$1"; }
location() { get -o /dev/null -w '%{redirect_url}' "$base$1"; }
has() { grep -q -- "$1" <<<"$2"; }

home=$(get "$base/")
docs=$(get "$base/docs/linting/")
headers=$(get -D - -o /dev/null "$base/" | tr -d '\r' | tr '[:upper:]' '[:lower:]')
robots=$(get "$base/robots.txt")

check 'home page answers 200' [ "$(status /)" = 200 ]
check 'and carries the trademark notice' has 'not authorized, endorsed or sponsored by Adobe' "$home"
check 'and its canonical address' has "<link rel=\"canonical\" href=\"$site/\"" "$home"
check 'and its structured data' has '"@type":"SoftwareApplication"' "$home"
check 'a docs page answers 200' [ "$(status /docs/linting/)" = 200 ]
check 'and its canonical address' has "<link rel=\"canonical\" href=\"$site/docs/linting/\"" "$docs"
check 'and shares its search title with link previews' has '<meta property="og:title" content="Lint HTML email' "$docs"
check 'the changelog answers 200' [ "$(status /changelog/)" = 200 ]
check 'the privacy page answers 200' [ "$(status /privacy/)" = 200 ]
check 'the social card answers 200' [ "$(status /generated/og.png)" = 200 ]
check 'a page without its trailing slash redirects' [ "$(status /docs/linting)" = 307 ]
check 'to the address with it' [ "$(location /docs/linting)" = "$base/docs/linting/" ]
check 'index.html redirects to the folder' [ "$(location /docs/linting/index.html)" = "$base/docs/linting/" ]
check 'an unknown page answers 404' [ "$(status /this-page-does-not-exist/)" = 404 ]
check 'Content-Security-Policy header' has 'content-security-policy:' "$headers"
check 'which allows the analytics script' has 'https://static.cloudflareinsights.com' "$headers"
check 'and no other hosts to connect' has "connect-src 'self';" "$headers"
check 'HSTS header' has 'strict-transport-security:' "$headers"
check 'nosniff header' has 'x-content-type-options: nosniff' "$headers"
check 'frame header' has 'x-frame-options: deny' "$headers"
check 'nothing asks search engines to skip the page' bash -c '! grep -q "x-robots-tag" <<<"$1" && ! grep -q "noindex" <<<"$2"' _ "$headers" "$home"
check 'robots.txt names the sitemap' has "Sitemap: $site/sitemap-index.xml" "$robots"
check 'the sitemap answers 200' [ "$(status /sitemap-index.xml)" = 200 ]

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed at $base"
  exit 1
fi
echo "All checks passed at $base"
