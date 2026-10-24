#!/usr/bin/env bash
# /updates/ の配信設定 (caddy/Caddyfile の (update_distribution)) をローカルの caddy で試す。
# 必要なもの: docker、curl。本番のサーバーには触らない (127.0.0.1 の一時コンテナだけ)。
#
#   scripts/test-update-distribution.sh [caddy のイメージ]   既定 caddy:2.11.2
#
# 確かめること: 公開の製品は認証なしで取れる / 他の製品はパスが要る (無し・違うと 401) /
# 製品のパスは他の製品に通らない (404) / dev のパスは全製品に通る / 書き込みのメソッドは 405 /
# 隠しファイルと知らない製品は 404 / 成果物は圧縮されず大きさと SHA-256 がそのまま /
# update.json は no-cache / Authorization がアクセスログに出ない / パスのファイルが 0 個でも起動する /
# Caddyfile 全体が validate を通る。
set -euo pipefail

IMAGE="${1:-caddy:2.11.2}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
NAME="ffs-update-dist-test-$$"
PORT=18080
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

pass=0
fail=0
check() { # check <説明> <期待> <実際>
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok   $1"; else fail=$((fail + 1)); echo "FAIL $1: expected [$2] got [$3]"; fi
}

hash() { printf '%s\n' "$1" | docker run --rm -i "$IMAGE" caddy hash-password; }

# --- 取り出した snippet だけで試験用のサイトを作る
awk '/^\(update_distribution\) \{/{on=1} /^# www\.freedomflight\.jp/{on=0} on' "$REPO/caddy/Caddyfile" > "$WORK/snippet.caddy"
grep -q '^(update_files) {' "$WORK/snippet.caddy"
cat > "$WORK/Caddyfile" <<EOF
{
	admin off
	auto_https off
	log {
		output file /logs/access.log
		format json
	}
}
$(cat "$WORK/snippet.caddy")
:8080 {
	encode zstd gzip
	import update_distribution
	handle {
		respond "site" 200
	}
	log {
		output file /logs/access.log
		format json
	}
}
EOF

mkdir -p "$WORK/updates/eddiepdf/files" "$WORK/updates/eddiepdf/full" "$WORK/updates/transinglater/files" \
  "$WORK/updates/dcs-mission-studio/files" "$WORK/passes" "$WORK/empty-passes" "$WORK/logs"
chmod 777 "$WORK/logs"
echo '{"format":"ffs-update/1"}' > "$WORK/updates/eddiepdf/update.json"
echo '{"format":"ffs-update/1"}' > "$WORK/updates/transinglater/update.json"
echo '{"format":"ffs-update/1"}' > "$WORK/updates/dcs-mission-studio/update.json"
mkdir -p "$WORK/updates/gunyupdf"
echo '{"format":"ffs-update/1"}' > "$WORK/updates/gunyupdf/update.json"
head -c 3000000 /dev/urandom > "$WORK/updates/eddiepdf/files/EddiePDF-setup-v9.9.9.exe"
# 圧縮が掛かれば縮む中身 (圧縮されないことを確かめる)
(set +o pipefail; yes 'compressible line' | head -c 2000000) > "$WORK/updates/eddiepdf/full/EddiePDF-setup-v9.9.9.exe"
echo '<!doctype html><title>full</title>' > "$WORK/updates/eddiepdf/full/index.html"
echo 'secret' > "$WORK/updates/eddiepdf/.hidden"
echo 'zip' > "$WORK/updates/dcs-mission-studio/files/DcsMissionStudio-9.9.9-win64.zip"
{
  echo "# test passes"
  echo "eddiepdf-alice $(hash alicepass)"
  echo "dev-bob $(hash bobpass)"
  echo "transinglater-carol $(hash carolpass)"
  echo "gunyupdf-dave $(hash davepass)"
} > "$WORK/passes/test.users"
chmod -R a+rX "$WORK"

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" \
  -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$WORK/updates:/srv/updates:ro" \
  -v "$WORK/passes:/etc/caddy/update-passes:ro" -v "$WORK/logs:/logs" "$IMAGE" >/dev/null
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.2; done

B="http://127.0.0.1:$PORT"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

check "public product without pass" 200 "$(code "$B/updates/dcs-mission-studio/update.json")"
check "public zip" 200 "$(code "$B/updates/dcs-mission-studio/files/DcsMissionStudio-9.9.9-win64.zip")"
check "protected without pass" 401 "$(code "$B/updates/eddiepdf/update.json")"
check "401 asks for basic auth" 1 "$(curl -s -D - -o /dev/null "$B/updates/eddiepdf/update.json" | grep -ci '^www-authenticate: basic')"
check "wrong password" 401 "$(code -u eddiepdf-alice:nope "$B/updates/eddiepdf/update.json")"
check "placeholder account" 401 "$(code -u ffs-placeholder:x "$B/updates/eddiepdf/update.json")"
check "product pass on own product" 200 "$(code -u eddiepdf-alice:alicepass "$B/updates/eddiepdf/update.json")"
check "product pass on own full page" 200 "$(code -u eddiepdf-alice:alicepass "$B/updates/eddiepdf/full/")"
check "product pass on other product" 404 "$(code -u eddiepdf-alice:alicepass "$B/updates/transinglater/update.json")"
check "other product pass" 404 "$(code -u transinglater-carol:carolpass "$B/updates/eddiepdf/update.json")"
check "dev pass on eddiepdf" 200 "$(code -u dev-bob:bobpass "$B/updates/eddiepdf/files/EddiePDF-setup-v9.9.9.exe")"
check "dev pass on transinglater" 200 "$(code -u dev-bob:bobpass "$B/updates/transinglater/update.json")"
check "gunyupdf without pass" 401 "$(code "$B/updates/gunyupdf/update.json")"
check "gunyupdf pass on own product" 200 "$(code -u gunyupdf-dave:davepass "$B/updates/gunyupdf/update.json")"
check "gunyupdf pass on other product" 404 "$(code -u gunyupdf-dave:davepass "$B/updates/eddiepdf/update.json")"
check "other product pass on gunyupdf" 404 "$(code -u eddiepdf-alice:alicepass "$B/updates/gunyupdf/update.json")"
check "dev pass on gunyupdf" 200 "$(code -u dev-bob:bobpass "$B/updates/gunyupdf/update.json")"
check "unknown product" 404 "$(code -u dev-bob:bobpass "$B/updates/nothing/update.json")"
check "hidden file" 404 "$(code -u dev-bob:bobpass "$B/updates/eddiepdf/.hidden")"
check "no directory listing" 404 "$(code -u dev-bob:bobpass "$B/updates/eddiepdf/files/")"
check "PUT refused" 405 "$(code -u dev-bob:bobpass -X PUT --data x "$B/updates/eddiepdf/update.json")"
check "POST on public refused" 405 "$(code -X POST --data x "$B/updates/dcs-mission-studio/update.json")"
check "rest of site untouched" 200 "$(code "$B/")"

headers="$(curl -s -D - -o "$WORK/got.bin" -u dev-bob:bobpass -H 'Accept-Encoding: gzip, zstd' "$B/updates/eddiepdf/full/EddiePDF-setup-v9.9.9.exe")"
check "full installer not compressed" 0 "$(printf '%s' "$headers" | grep -ci '^content-encoding:' || true)"
check "full installer has Content-Length" 1 "$(printf '%s' "$headers" | grep -ci '^content-length: 2000000')"
check "full installer bytes intact" "$(sha256sum < "$WORK/updates/eddiepdf/full/EddiePDF-setup-v9.9.9.exe")" "$(sha256sum < "$WORK/got.bin")"
check "installer immutable cache" 1 "$(printf '%s' "$headers" | grep -ci '^cache-control: public, max-age=31536000, immutable')"
check "noindex header" 1 "$(printf '%s' "$headers" | grep -ci '^x-robots-tag: noindex')"
curl -s -o "$WORK/got2.bin" -u eddiepdf-alice:alicepass -H 'Accept-Encoding: gzip, zstd' "$B/updates/eddiepdf/files/EddiePDF-setup-v9.9.9.exe"
check "update file bytes intact" "$(sha256sum < "$WORK/updates/eddiepdf/files/EddiePDF-setup-v9.9.9.exe")" "$(sha256sum < "$WORK/got2.bin")"
check "range request" 206 "$(code -u dev-bob:bobpass -r 0-99 "$B/updates/eddiepdf/files/EddiePDF-setup-v9.9.9.exe")"
check "update.json no-cache" 1 "$(curl -s -D - -o /dev/null -u dev-bob:bobpass "$B/updates/eddiepdf/update.json" | grep -ci '^cache-control: no-cache')"

sleep 0.5
# ログはコンテナの root が 0600 で書くので、同じイメージで読む
docker run --rm -v "$WORK/logs:/logs:ro" "$IMAGE" cat /logs/access.log > "$WORK/access.log"
check "password not in access log" 0 "$(grep -c 'alicepass\|bobpass\|ZWRkaWVwZGYtYWxpY2U6YWxpY2VwYXNz\|ZGV2LWJvYjpib2JwYXNz' "$WORK/access.log" || true)"
check "access log has authenticated requests" 1 "$(grep -q '"user_id":"dev-bob"' "$WORK/access.log" && echo 1 || echo 0)"

# --- パスのファイルが 0 個でも起動し、全部 401 になる
docker rm -f "$NAME" >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" \
  -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$WORK/updates:/srv/updates:ro" \
  -v "$WORK/empty-passes:/etc/caddy/update-passes:ro" -v "$WORK/logs:/logs" "$IMAGE" >/dev/null
for _ in $(seq 1 50); do curl -s -o /dev/null "$B/" && break; sleep 0.2; done
check "starts with no pass files" 200 "$(code "$B/")"
check "no pass files -> 401" 401 "$(code -u dev-bob:bobpass "$B/updates/eddiepdf/update.json")"

# --- Caddyfile 全体の検査 (上流の宛先はダミー)
docker run --rm -v "$REPO/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$WORK/empty-passes:/etc/caddy/update-passes:ro" \
  -e HERMES_LINE_WEBHOOK_UPSTREAM=127.0.0.1:1 -e HERMES_GCAL_WEBHOOK_UPSTREAM=127.0.0.1:2 \
  -e IYAKUSAI_LINE_WEBHOOK_UPSTREAM=127.0.0.1:3 "$IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
  > "$WORK/validate.log" 2>&1 && valid=0 || valid=$?
check "full Caddyfile validates" 0 "$valid"
[ "$valid" = 0 ] || tail -5 "$WORK/validate.log"

# --- Caddyfile 全体で起動して、/updates/ が他の経路に隠れないことと caddy/local/ の読み込みを確かめる。
# TLS を使わないよう、試験のコピーだけ freedomflight.jp を http の :8080 に置き換える。
sed -e 's/\r$//' -e 's/^\tadmin off$/\tadmin off\n\tauto_https off/' -e 's/^freedomflight\.jp {/http:\/\/freedomflight.jp:8080 {/' \
  -e 's/^\temail .*$//' "$REPO/caddy/Caddyfile" > "$WORK/full.Caddyfile"
mkdir -p "$WORK/local/freedomflight.jp" "$WORK/local/sites"
printf '\thandle /localtest/* {\n\t\trespond "local route" 200\n\t}\n' > "$WORK/local/freedomflight.jp/10-test.caddy"
printf 'http://local.test:8080 {\n\trespond "local site" 200\n}\n' > "$WORK/local/sites/10-test.caddy"
chmod -R a+rX "$WORK/local" "$WORK/full.Caddyfile"
docker rm -f "$NAME" >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" \
  -e HERMES_LINE_WEBHOOK_UPSTREAM=127.0.0.1:1 -e HERMES_GCAL_WEBHOOK_UPSTREAM=127.0.0.1:2 -e IYAKUSAI_LINE_WEBHOOK_UPSTREAM=127.0.0.1:3 \
  -v "$WORK/full.Caddyfile:/etc/caddy/Caddyfile:ro" -v "$WORK/updates:/srv/updates:ro" \
  -v "$WORK/passes:/etc/caddy/update-passes:ro" -v "$WORK/local:/etc/caddy/local:ro" "$IMAGE" >/dev/null
H=(-H 'Host: freedomflight.jp')
for _ in $(seq 1 50); do curl -s -o /dev/null "${H[@]}" "$B/updates/" && break; sleep 0.2; done
check "full: protected needs pass" 401 "$(code "${H[@]}" "$B/updates/eddiepdf/update.json")"
check "full: dev pass" 200 "$(code "${H[@]}" -u dev-bob:bobpass "$B/updates/eddiepdf/update.json")"
check "full: public product" 200 "$(code "${H[@]}" "$B/updates/dcs-mission-studio/update.json")"
check "full: unknown under /updates" 404 "$(code "${H[@]}" "$B/updates/nothing")"
check "full: site still proxies (upstream down here)" 502 "$(code "${H[@]}" "$B/")"
check "full: gca still proxies" 502 "$(code "${H[@]}" "$B/gca/")"
check "full: local route imported" "local route" "$(curl -s "${H[@]}" "$B/localtest/x")"
check "full: local site imported" "local site" "$(curl -s -H 'Host: local.test' "$B/")"
check "full: security headers on /updates" 1 "$(curl -s -D - -o /dev/null "${H[@]}" "$B/updates/dcs-mission-studio/update.json" | grep -ci '^x-content-type-options: nosniff')"

echo "passed $pass, failed $fail"
[ "$fail" = 0 ]
