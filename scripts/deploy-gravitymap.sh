#!/usr/bin/env bash
# MyGravityMap (../MyGravityMap, sister repo) を最新化してビルドし、
# gravitymap/ (Caddy が file_server で配信する静的ディレクトリ) に反映する。
#
# 前提: ../MyGravityMap が git clone 済み (このホストに node/npm は無いので
# node:22-bookworm-slim コンテナ内でビルドする)。
#
# 実行後、新規サイトブロック追加時のみ `docker compose restart caddy` が要る。
# 中身の更新だけなら gravitymap/ は bind-mount なので即反映 (再起動不要)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$(cd "$REPO_ROOT/../MyGravityMap" && pwd)"
DEST_DIR="$REPO_ROOT/gravitymap"
NODE_IMAGE="node:22-bookworm-slim"

echo "[deploy-gravitymap] pulling latest from $SRC_DIR"
git -C "$SRC_DIR" pull --ff-only

echo "[deploy-gravitymap] building with $NODE_IMAGE"
docker run --rm -v "$SRC_DIR":/app -w /app "$NODE_IMAGE" sh -c "npm ci && npm run build"

echo "[deploy-gravitymap] syncing dist/ -> $DEST_DIR"
mkdir -p "$DEST_DIR"
rsync -a --delete "$SRC_DIR/dist/" "$DEST_DIR/"

echo "[deploy-gravitymap] done. $(git -C "$SRC_DIR" log -1 --format='deployed %h: %s')"
echo "[deploy-gravitymap] gravitymap/ is bind-mounted into caddy — no restart needed for content-only updates."
