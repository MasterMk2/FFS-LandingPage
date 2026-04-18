# FFS-LandingPage

FFS DCS サーバの **ランディング / ステータスサイト**。
DCSServerBot (DCSSB) の WebService + RestAPI plugin を叩いて、DCS サーバ稼働
状況 (mission / players / weather / status) を自動更新で表示する軽量 web アプリ。

- フレームワーク: **FastAPI + Jinja2 + HTMX** (15 秒ポーリング)
- Docker image: `python:3.12-slim` ベース、~100MB
- 公開ポート: **18150/tcp** (`18Sbx` 規約: S=1 b=5 x=0 singleton)

## 構成

```
FFS-LandingPage/
├── docker-compose.yml      # 外部 network (ffs-dcs-server_dcs_network) へ参加
├── Dockerfile              # python:3.12-slim
├── requirements.txt        # fastapi / uvicorn / jinja2 / httpx
├── .env.example            # DCSSB_API_KEY
└── app/
    ├── main.py             # FastAPI ルート (/, /panel/servers, /healthz)
    ├── dcssb.py            # DCSSB RestAPI クライアント
    ├── templates/          # Jinja2 (base + index + servers_panel)
    └── static/style.css
```

## データ経路

```
ブラウザ ──18150/tcp──> ffs-website (uvicorn:8000)
                         │
                         │ dcs_network 内部 (external)
                         ▼
        http://dcs-server-1:9876/stats/servers
                         │ (DCSSB master は dcs-server-1 と netns 共有)
                         ▼
                    DCSSB WebService + restapi plugin
```

DCSSB master (`dcsserverbot`) は `network_mode: service:dcs-server-1` で
dcs-server-1 と netns を共有しているため、WebService (9876) は dcs-server-1
の IP で listen される。本 compose は dcs_network に external 参加して
`dcs-server-1:9876` で到達する。ホスト経由ではないので 9876 はホスト公開不要。

## 前提

- 姉妹リポジトリ [`ffs-dcs-server`](https://github.com/MasterMk2/ffs-dcs-server) が同じホスト上に clone 済で、docker compose が動作していること。
- `ffs-dcs-server/config/dcsserverbot/main.yaml` の `opt_plugins:` に `restapi` が含まれること (ffs-dcs-server 側で設定済)。
- `ffs-dcs-server/scripts/apply-restapi-config.sh` で WebService + RestAPI の yaml を投入済であること。

## セットアップ手順

### 初回のみ

1. **サーバ側 (ffs-dcs-server) で RestAPI を有効化**:
   ```bash
   cd ../ffs-dcs-server
   # .env に DCSSB_API_KEY=<32文字以上の乱数> を追記
   ./scripts/apply-restapi-config.sh
   docker compose restart dcsserverbot
   ```

2. **当リポジトリの .env を用意**:
   ```bash
   cp .env.example .env
   # DCSSB_API_KEY に上記と同じ値を入れる
   ```

3. **起動**:
   ```bash
   docker compose up -d --build
   ```

4. ブラウザで `http://<host>:18150/` にアクセス。

### 更新時

```bash
git pull
docker compose up -d --build
```

## UFW

LAN/VPN のみに限定するなら:
```bash
sudo ufw allow from 192.168.3.0/24 to any port 18150 proto tcp \
  comment 'FFS landing site (LAN only)'
```

player-facing (public) に公開するなら NAPT で 18150/tcp を開ける + 上記の
`from ...` を外す。

## 動作確認

- `curl http://localhost:18150/healthz` → `{"status":"ok"}`
- `curl http://localhost:18150/panel/servers` → HTML フラグメント
- ブラウザで `/` を開くと 15 秒ごとに HTMX が `/panel/servers` を polling

## トラブルシュート

| 症状 | 原因候補 | 対処 |
|---|---|---|
| "DCSSB API に到達できません" | webservice.yaml / restapi.yaml 未投入 | ffs-dcs-server の `scripts/apply-restapi-config.sh` を流して bot restart |
| HTTP 401 / Forbidden | `DCSSB_API_KEY` が ffs-dcs-server 側と不一致 | 両方の `.env` を揃えて bot を restart |
| HTTP 404 | プレフィックス mismatch | `restapi.yaml` の `prefix: /stats` を確認 |
| `network ffs-dcs-server_dcs_network not found` | ffs-dcs-server compose が未起動 | `cd ../ffs-dcs-server && docker compose up -d` |
| 繋がるが空 `[]` | master ノードが DCS に未アタッチ | Discord で `/server list` を確認 |

## 将来拡張

- `/stats/highscore` でランキングページ
- `/stats/serverstats` で全体アクティビティグラフ
- WebSocket 化で HTMX polling → push
- reverse proxy (caddy/nginx) + TLS (Let's Encrypt) を前段に
