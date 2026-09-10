# FFS-LandingPage

FFS DCS コミュニティの **公開ランディング + ステータスサイト + リバースプロキシ**。

- Home / Status / Leaderboard / Replays の 4 ページ構成
- DCSServerBot (DCSSB) の RestAPI + Tracks API を参照してサーバ状況・戦績・リプレイ DL を提供
- postgres `serverstats` を読み取り専用で直接叩き、FPS/CPU/Memory の時系列グラフを SVG で描画
- Caddy を前段に立て、`freedomflight.jp` / `iyakusai.com` / `sneaker.~` / `lardoon.~` を Host ヘッダで振り分け
- `freedomflight.jp/gca/` は ../ffs-dcs-server の `dcs-web-gca` コンテナへパス振り分け (管制卓)
- Let's Encrypt で TLS 自動発行・自動更新

## スタック

- **FastAPI + Jinja2 + HTMX** (15 / 30 秒ポーリング)
- **Caddy v2** リバースプロキシ + TLS 終端 + 静的ホスト
- **psycopg 3** で postgres serverstats を async SELECT
- **in-memory cache** (`app/cache.py`) で F5 連打時の upstream 負荷を遮断
- **JA/EN 二言語** (`app/i18n.py`): `?lang=` → cookie (`ffs_lang`) → `Accept-Language` → ja の優先順で解決。UI 語句は辞書、長文はテンプレ内 `{% if lang == 'ja' %}` ブロック。HTMX polling も cookie で言語を引き継ぐ

## 公開 URL

| URL | 役割 |
|---|---|
| `https://freedomflight.jp/` | Home (intro + live stats) |
| `https://freedomflight.jp/status` | サーバ状況 + Server Load 時系列 |
| `https://freedomflight.jp/leaderboard` | 月次リーダーボード |
| `https://freedomflight.jp/tracks` | DCS リプレイ (.trk) 一覧 + ダウンロード |
| `https://freedomflight.jp/gca/` | Web GCA 管制卓 — 実体は姉妹 repo [DCSWebGCA](https://github.com/MasterMk2/DCSWebGCA) のコンテナ (`ffs-dcs-web-gca:8080`)。サブドメインではなく `handle_path /gca/*` で出しているので DNS 追加不要。WebSocket も同経路 |
| `https://iyakusai.com/` (+ `www` / `2025`) | 静的 HTML (別プロジェクト、同じ Caddy でホスト) |
| `https://sneaker.freedomflight.jp/` | Sneaker (Live Map) — 実体は姉妹 repo コンテナ |
| `https://lardoon.freedomflight.jp/` | Lardoon (Tacview Replay archive) |
| `https://gravitymap.freedomflight.jp/` | MyGravityMap — DCS とは無関係の個人ツール (姉妹 repo)、完全静的、file_server 配信 |

## トポロジ

```
 [WAN] :80/:443
   │
   ▼
 [Router NAPT]  →  192.168.3.170:30080 / :30443
                    │
                    ▼
                 [ ffs-caddy ]  :80 / :443 (TLS 終端、Host 振り分け)
                    ├─── iyakusai.com       → file_server ./iyakusai/
                    ├─── freedomflight.jp   → reverse_proxy ffs-website:8000
                    ├─── sneaker.~          → reverse_proxy ffs-sneaklardooon:7788
                    ├─── lardoon.~          → reverse_proxy ffs-sneaklardooon:3883
                    └─── gravitymap.~          → file_server ./gravitymap/

 [ ffs-website ] (本 repo FastAPI 本体)
   │
   ├─ dcs_network ── DCSSB WebService (dcs-server-1:9876)
   │                   ├─ /stats/* (RestAPI plugin)
   │                   └─ /tracks/* (Tracks endpoint)
   └─ db_network  ── postgres (ffs-postgres:5432, role=ffs_landing_ro)
                        └─ SELECT from serverstats
```

## 構成

```
FFS-LandingPage/
├── docker-compose.yml     # ffs-website + caddy、external 参加 (dcs_network, db_network)
├── Dockerfile             # python:3.12-slim + uvicorn(--forwarded-allow-ips=*)
├── requirements.txt       # fastapi / uvicorn / jinja2 / httpx / psycopg[binary]
├── .env.example
├── caddy/
│   └── Caddyfile          # iyakusai / freedomflight / sneaker / lardoon サイトブロック
├── iyakusai/              # 医学薬学祭サイトの静的 HTML (別コンテンツ、Caddy がそのまま配信)
└── app/
    ├── main.py            # FastAPI ルート / lifespan で cache 起動 / render() が lang と t() を注入
    ├── cache.py           # Fetcher[T] (周期リフレッシュ async キャッシュ)
    ├── dcssb.py           # DCSSB RestAPI + Tracks クライアント
    ├── db.py              # postgres serverstats RO クライアント + スパークライン生成
    ├── i18n.py            # JA/EN 辞書 + 言語解決 (?lang= / cookie / Accept-Language)
    ├── templates/         # Jinja2 (base + home + index + leaderboard + tracks + panels)
    └── static/style.css
```

## セットアップ

### 前提
- 姉妹リポジトリ [`ffs-dcs-server-ops`](https://github.com/KeN7879/ffs-dcs-server-ops) が同一ホストで稼働中
- DCSSB RestAPI plugin と Tracks endpoint が有効化済
- postgres に read-only role (`ffs_landing_ro`) 作成済、`serverstats` に SELECT 付与済

### 初回

1. **`.env` を用意** (姉妹 repo と同値 + DB DSN):
   ```bash
   cp .env.example .env
   # DCSSB_API_KEY=<姉妹 repo と同じ値>
   # DCSSB_DB_URL=postgresql://ffs_landing_ro:<pass>@ffs-postgres:5432/dcsserverbot
   ```

2. **起動**:
   ```bash
   docker compose up -d --build
   ```

3. **ルータ NAPT** で `WAN:80 → 192.168.3.170:30080`, `WAN:443 → 192.168.3.170:30443` を設定

4. **UFW** (既定 deny の場合):
   ```bash
   sudo ufw allow 30080/tcp comment 'Caddy HTTP (router NAPT :80)'
   sudo ufw allow 30443/tcp comment 'Caddy HTTPS (router NAPT :443)'
   ```

5. **DNS** を各 FQDN で設定:
   - `freedomflight.jp`
   - `iyakusai.com` / `www.iyakusai.com` / `2025.iyakusai.com`
   - `sneaker.freedomflight.jp`
   - `lardoon.freedomflight.jp`

6. ブラウザで `https://freedomflight.jp/` にアクセス。初回のみ Caddy が LE 発行で
   数秒 delay、以降は 60 日前後の自動更新に乗る。

### 更新

```bash
git pull
docker compose up -d --build
```

コード変更の種類に応じた影響範囲:

| 変更 | 必要な操作 |
|---|---|
| `app/` コード or テンプレ or CSS | `docker compose build ffs-website && up -d --force-recreate ffs-website` |
| `caddy/Caddyfile` のみ | `docker compose restart caddy` |
| `iyakusai/` 静的ファイル | なし (bind-mount、即反映) |
| `.env` | `docker compose up -d --force-recreate ffs-website` |
| `docker-compose.yml` (ポート / ネットワーク) | `docker compose up -d --force-recreate` |

## 動作確認

```bash
# LAN から
curl -sk --resolve freedomflight.jp:30443:192.168.3.170 https://freedomflight.jp:30443/healthz
# → {"status":"ok"}

# 外部 (スマホ 4G 等) から
curl -s https://freedomflight.jp/healthz
```

## キャッシュ

HTTP handler は upstream (DCSSB / postgres) に直接触らず、**バックグラウンドタスクが
更新する in-memory cache** から値を返します。F5 連打で upstream が過負荷にならない設計:

| cache | interval | 用途 |
|---|---|---|
| `servers_cache` | 15s | Status カード、Services バー、Home live stats |
| `load_cache` | 60s | Server Load グラフ (Monitoring の書込周期と同じ) |
| `highscore_cache` | 300s | Leaderboard |
| `tracks_cache` | 60s | Replays 一覧 + Home の Replay 総数 |

`CachedValue` は最新 1 件のみ保持。上流障害時も直近成功値を serve 続行し、復旧時に
自動で差し替わるのでダウンタイムに強い。

## TLS 自動更新

Caddy v2 の `certmagic` が 30 日前に LE 証明書を自動更新。証明書と ACME アカウントは
`caddy_data` docker volume に永続化。コンテナ再作成でも保持される。

更新の前提:
- Caddy 常時稼働 (`restart: unless-stopped`)
- ルータ NAPT 維持
- UFW で 30080/30443 open
- DNS が当ホスト IP を指し続ける

## トラブルシュート

| 症状 | 主な原因 | 対処 |
|---|---|---|
| `/status` でエラーパネル | DCSSB WebService 到達不可 or 401 | `.env` の `DCSSB_API_KEY` を姉妹 repo と揃え、bot restart |
| Server Load 空 / `DCSSB_DB_URL not configured` | DSN 未設定 | `.env` に `DCSSB_DB_URL=postgresql://...` を追加 |
| 特定サーバだけ Load 欠落 | 該当 agent の Monitoring 未稼働 (CAP_SYS_PTRACE 等) | 姉妹 repo の該当 bot コンテナに `cap_add: [SYS_PTRACE]` があるか確認 |
| ブラウザで TLS エラー | Caddyfile の `http://` 接頭が残っている / DNS 未伝播 | Caddyfile 修正 → `docker compose restart caddy` でログ確認 |
| mixed-content で CSS 読めず | uvicorn の `--forwarded-allow-ips` 未設定 | Dockerfile に `--forwarded-allow-ips=*` があるか確認 |
| 外部から繋がらない | UFW / ルータ NAPT / ISP 80 遮断 | `tcpdump -i any 'tcp port 30080'` で SYN 到達確認 |
| `network ... _network not found` | 姉妹 compose 未起動 / project 名違い | `docker network ls` で実名確認、`docker-compose.yml` の `name:` を合わせる |

より詳しい運用上の注意は [.claude/skills/ffs-landing/SKILL.md](.claude/skills/ffs-landing/SKILL.md) を参照。

## ライセンス / クレジット

- 本体コード: FFS プロジェクト内部用、ライセンス未設定
- DCSServerBot: Special-K の実装、本 repo はその consumer
- Caddy / FastAPI / htmx / psycopg: 各 OSS の原ライセンスに従う
