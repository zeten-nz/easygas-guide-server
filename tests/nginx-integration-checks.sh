#!/usr/bin/env bash
# Nginx BROWSER/HTTP integration checks against a running Nginx (serving the built
# client dist) in front of a running API. This is a real integration test — not
# `nginx -t`. Run by the CI nginx-integration job, which starts the disposable
# services. Usage: nginx-integration-checks.sh <base-url> [admin_phone] [admin_password]
set -uo pipefail
BASE="${1:?usage: nginx-integration-checks.sh <base-url> [phone] [password]}"
ADMIN_PHONE="${2:-+998901000005}"
ADMIN_PW="${3:-EasyGasDev2026!}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CURL=(curl -sk --max-time 20)   # -k: self-signed test cert
PASS=0; FAIL=0
chk(){ if [ "$1" = 1 ]; then echo "PASS: $2"; PASS=$((PASS+1)); else echo "FAIL: $2 -- ${3:-}"; FAIL=$((FAIL+1)); fi; }
code_of(){ "${CURL[@]}" -o "$2" -w '%{http_code}' "$1"; }
ct_of(){ "${CURL[@]}" -I "$1" | tr -d '\r' | awk 'tolower($1)=="content-type:"{print tolower($2)}'; }
cc_of(){ "${CURL[@]}" -I "$1" | tr -d '\r' | awk 'tolower($1)=="cache-control:"{$1=""; print tolower($0)}'; }

# 1. Deep-link reload → SPA index.html (200, text/html)
c=$(code_of "$BASE/app/catalog/products" "$TMP/dl.html"); ct=$(ct_of "$BASE/app/catalog/products")
res=0; { [ "$c" = 200 ] && echo "$ct" | grep -q text/html && grep -q 'id="root"' "$TMP/dl.html"; } && res=1
chk "$res" "deep-link reload serves SPA index.html" "code=$c ct=$ct"

# 2. JS/CSS assets: real content types, 200
JS=$(grep -oE '/assets/[^"]+\.js' "$TMP/dl.html" | head -1)
CSS=$(grep -oE '/assets/[^"]+\.css' "$TMP/dl.html" | head -1)
jct=$(ct_of "$BASE$JS"); jc=$(code_of "$BASE$JS" /dev/null)
res=0; { [ "$jc" = 200 ] && echo "$jct" | grep -qE 'javascript'; } && res=1
chk "$res" "JS asset 200 + javascript content-type" "code=$jc ct=$jct path=$JS"
if [ -n "$CSS" ]; then
  cct=$(ct_of "$BASE$CSS"); cc=$(code_of "$BASE$CSS" /dev/null)
  res=0; { [ "$cc" = 200 ] && echo "$cct" | grep -q 'text/css'; } && res=1
  chk "$res" "CSS asset 200 + text/css" "code=$cc ct=$cct"
fi

# 3. API errors remain API responses (JSON 404, NOT index.html)
c=$(code_of "$BASE/api/v1/definitely-not-a-route" "$TMP/apierr"); ct=$(ct_of "$BASE/api/v1/definitely-not-a-route")
res=0; { [ "$c" = 404 ] && echo "$ct" | grep -q json && ! grep -q 'id="root"' "$TMP/apierr"; } && res=1
chk "$res" "API 404 stays an API JSON response (no index.html fallback)" "code=$c ct=$ct"

# 4. Missing hashed asset → 404 (not index.html)
c=$(code_of "$BASE/assets/does-not-exist-00000000.js" "$TMP/miss")
res=0; { [ "$c" = 404 ] && ! grep -q 'id="root"' "$TMP/miss"; } && res=1
chk "$res" "missing asset returns 404 (not index.html)" "code=$c"

# 5. Metrics blocked on the public proxy — including variants the backend accepts
mfail=0
for p in "/api/v1/metrics" "/api/v1/metrics/" "/API/V1/METRICS" "/api/v1/metrics?probe=1"; do
  c=$(code_of "$BASE$p" "$TMP/m")
  if grep -qE '^easygas_|# HELP easygas' "$TMP/m"; then echo "  LEAK at $p (code $c)"; mfail=1; fi
done
res=0; [ "$mfail" = 0 ] && res=1
chk "$res" "metrics endpoint + variants are not exposed by the public proxy"

# 6. Cache headers: index.html revalidated; hashed assets immutable
icc=$(cc_of "$BASE/index.html"); acc=$(cc_of "$BASE$JS")
res=0; echo "$icc" | grep -q 'no-cache' && res=1; chk "$res" "index.html Cache-Control no-cache" "$icc"
res=0; echo "$acc" | grep -q 'immutable' && res=1; chk "$res" "hashed asset Cache-Control immutable" "$acc"

# 7. login / session / CSRF through Nginx
lc=$("${CURL[@]}" -c "$TMP/cj" -o "$TMP/login.json" -w '%{http_code}' \
      -X POST "$BASE/api/v1/auth/login" -H 'content-type: application/json' \
      -d "{\"phone\":\"$ADMIN_PHONE\",\"password\":\"$ADMIN_PW\",\"rememberMe\":false}")
res=0; { [ "$lc" = 200 ] && grep -qi 'eg_session' "$TMP/cj"; } && res=1
chk "$res" "login through Nginx sets a session cookie (200)" "code=$lc"
me=$("${CURL[@]}" -b "$TMP/cj" -o "$TMP/me.json" -w '%{http_code}' "$BASE/api/v1/auth/me")
res=0; { [ "$me" = 200 ] && grep -qiE 'ADMIN' "$TMP/me.json"; } && res=1
chk "$res" "authenticated /auth/me works through Nginx (session cookie proxied)" "code=$me"
# CSRF enforced: a mutation WITH the session cookie but NO x-csrf-token must be refused
cc=$("${CURL[@]}" -b "$TMP/cj" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/auth/logout")
res=0; [ "$cc" = 403 ] && res=1
chk "$res" "CSRF enforced through Nginx (cookie'd mutation without token -> 403)" "got=$cc"

echo ""
echo "nginx integration: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
