# FFS-LandingPage

FFS DCS コミュニティの **公開ランディング + ステータスサイト + リバースプロキシ**。

- Home / Status / Leaderboard / Replays の 4 ページ構成
- DCSServerBot (DCSSB) の RestAPI + Tracks API を参照してサーバ状況・戦績・リプレイ DL を提供
- postgres `serverstats` を読み取り専用で直接叩き、FPS/CPU/Memory の時系列グラフを SVG で描画
- Caddy を前段に立て、`freedomflight.jp` / `sneaker.~` / `lardoon.~` / `gravitymap.~` / `line.iyakusai.com` を Host ヘッダで振り分け
- `freedomflight.jp/gca/` は ../ffs-dcs-server の `dcs-web-gca` コンテナへパス振り分け (管制卓)
- Let's Encrypt で TLS 自動発行・自動更新
- Caddy で共通のセキュリティヘッダを付与 ([セキュリティ](#セキュリティ) 参照)

## スタック

- **FastAPI + Jinja2 + HTMX** (15 / 30 秒ポーリング)
- **Caddy v2** リバースプロキシ + TLS 終端 + 静的ホスト
- **psycopg 3** で postgres serverstats を async SELECT
- **in-memory cache** (`app/cache.py`) で F5 連打時の upstream 負荷を遮断
- **JA/EN 二言語** (`app/i18n.py`): `?lang=` → cookie (`ffs_lang`) → `Accept-Language` → ja の優先順で解決。UI 語句は辞書、長文はテンプレ内 `{% if lang == 'ja' %}` ブロック。HTMX polling も cookie で言語を引き継ぐ
- **Google Analytics 4** (任意): `.env` の `GA_MEASUREMENT_ID` を設定したときだけ `base.html` に gtag.js を出す。HTMX の `/panel/*` は base を継承しないので polling はページビューに数えない。GA 利用の開示は `/privacy`

## 公開 URL

| URL | 役割 |
|---|---|
| `https://freedomflight.jp/` | Home (intro + live stats) |
| `https://freedomflight.jp/status` | サーバ状況 + Server Load 時系列 |
| `https://freedomflight.jp/leaderboard` | 月次リーダーボード |
| `https://freedomflight.jp/tracks` | DCS リプレイ (.trk) 一覧 + ダウンロード |
| `https://freedomflight.jp/gca/` | Web GCA 管制卓 — 実体は姉妹 repo [DCSWebGCA](https://github.com/MasterMk2/DCSWebGCA) のコンテナ (`ffs-dcs-web-gca:8080`)。サブドメインではなく `handle_path /gca/*` で出しているので DNS 追加不要。WebSocket も同経路 |
| `https://line.iyakusai.com/webhook` | 医薬祭 公式LINE の Webhook 受け口 (LAN 内の別ホストへ転送、他のパスは 404)。`iyakusai.com` 本体は別ホストで配信していて、この Caddy には届かない |
| `https://sneaker.freedomflight.jp/` | Sneaker (Live Map) — 実体は姉妹 repo コンテナ |
| `https://lardoon.freedomflight.jp/` | Lardoon (Tacview Replay archive) |
| `https://gravitymap.freedomflight.jp/` | MyGravityMap — DCS とは無関係の個人ツール (姉妹 repo)、完全静的、file_server 配信 |

## トポロジ

```
 [WAN] :80/:443
   │
   ▼
 [Router NAPT]  →  <HOST_LAN_IP>:CADDY_HTTP_PORT / CADDY_HTTPS_PORT
                    │
                    ▼
                 [ ffs-caddy ]  :80 / :443 (TLS 終端、Host 振り分け)
                    ├─── freedomflight.jp   → reverse_proxy ffs-website:8000
                    ├─── sneaker.~          → reverse_proxy ffs-sneaklardooon:7788
                    ├─── lardoon.~          → reverse_proxy ffs-sneaklardooon:3883
                    ├─── gravitymap.~       → file_server ./gravitymap/
                    └─── line.iyakusai.com  → /webhook のみ LAN 内の別ホストへ

 [ ffs-website ] (本 repo FastAPI 本体)
   │
   ├─ dcs_network ── DCSSB WebService (dcs-server-1:9876)
   │                   ├─ /stats/* (RestAPI plugin)
   │                   └─ /tracks/* (Tracks endpoint)
   └─ db_network  ── postgres (ffs-postgres:5432, role=ffs_landing_ro)
                        └─ SELECT from serverstats
```

ホスト側のポート番号 (`CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT`) や LAN 内の転送先など、
内部ネットワークの構成は `.env` で与え、リポジトリには書かない (`.env.example` 参照)。

## 構成

```
FFS-LandingPage/
├── docker-compose.yml     # ffs-website + caddy、external 参加 (dcs_network, db_network)
├── Dockerfile             # python:3.12-slim + uvicorn(--forwarded-allow-ips=*)、非 root で実行
├── requirements.txt       # fastapi / uvicorn / jinja2 / httpx / psycopg[binary]
├── .env.example
├── caddy/
│   └── Caddyfile          # freedomflight / sneaker / lardoon / gravitymap / line.iyakusai サイトブロック + 共通セキュリティヘッダ
├── iyakusai/              # 医学薬学祭サイトの静的 HTML の原本 (配信は別ホスト。この Caddy では配信しない)
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
   # 必須 (未設定なら compose が起動前に止まる):
   #   CADDY_HTTP_PORT / CADDY_HTTPS_PORT            ルータが転送してくるホスト側ポート
   #   HERMES_LINE_WEBHOOK_UPSTREAM / HERMES_GCAL_WEBHOOK_UPSTREAM /
   #   IYAKUSAI_LINE_WEBHOOK_UPSTREAM                LAN 内の転送先 (host:port)
   ```

2. **`./data` の所有者を合わせる** (初回のみ)。ffs-website は非 root
   (`APP_UID:APP_GID`、既定 `10001:10001`) で動き、書けるのは `./data` だけ:
   ```bash
   mkdir -p data && sudo chown -R 10001:10001 data   # APP_UID/APP_GID を変えたらその値
   ```

3. **起動**:
   ```bash
   docker compose up -d --build
   ```

4. **ルータ NAPT** で `WAN:80 → <HOST_LAN_IP>:<CADDY_HTTP_PORT>`, `WAN:443 → <HOST_LAN_IP>:<CADDY_HTTPS_PORT>` を設定

5. **ファイアウォール** (UFW 等で既定 deny の場合): ホストで `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` (tcp) の受信を許可

6. **DNS** を各 FQDN で設定:
   - `freedomflight.jp`
   - `sneaker.freedomflight.jp`
   - `lardoon.freedomflight.jp`
   - `gravitymap.freedomflight.jp`
   - `line.iyakusai.com`

7. ブラウザで `https://freedomflight.jp/` にアクセス。初回のみ Caddy が LE 発行で
   数秒 delay、以降は 60 日前後の自動更新に乗る。

### 更新

```bash
git pull
docker compose up -d --build
```

#### 既存環境への初回反映 (非 root 化・内部アドレスの `.env` 化を取り込むとき、一度だけ)

`.env` の追記と `./data` の所有者変更をしないと、`docker compose up` が必須変数の
エラーで止まる、または Fitbit トークンを保存できない。

1. `git pull` の前に、今の `docker-compose.yml` の caddy の `ports` (ホスト側ポート) と
   `caddy/Caddyfile` の LAN 内宛て `reverse_proxy` 先 (3 か所) を控える
2. `git pull` し、`.env` に `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` と
   `HERMES_LINE_WEBHOOK_UPSTREAM` / `HERMES_GCAL_WEBHOOK_UPSTREAM` /
   `IYAKUSAI_LINE_WEBHOOK_UPSTREAM` を 1. の値で追記する
3. `docker compose config --quiet` がエラーなく終わることを確認する
4. ホスト上に uid 10001 で動くプロセスやコンテナが無いことを確認する
   (`ps -eo uid,cmd | awk '$1==10001'`。あれば `APP_UID` / `APP_GID` を別の値にする。
   同じ uid だと、ffs-website から `/host/proc` 経由でそのプロセスの環境変数などが読める)。
   続けて `mkdir -p data && sudo chown -R 10001:10001 data` (`APP_UID` / `APP_GID` を変えたらその値)
5. `docker compose up -d --build` (caddy も作り直されるので、全サイトが数秒止まる)
6. 3 つの Webhook の経路が 503 / 502 になっていないこと、`curl -sI https://freedomflight.jp/`
   にセキュリティヘッダが付くこと、リプレイのダウンロード、Status の Host Load を確認する

コード変更の種類に応じた影響範囲:

| 変更 | 必要な操作 |
|---|---|
| `app/` コード or テンプレ or CSS | `docker compose build ffs-website && up -d --force-recreate ffs-website` |
| `caddy/Caddyfile` のみ | `docker compose restart caddy` |
| `.env` | `docker compose up -d --force-recreate ffs-website` (`CADDY_*` / `*_WEBHOOK_UPSTREAM` を変えたら `caddy` も、`APP_UID` / `APP_GID` は `--build` も) |
| `docker-compose.yml` (ポート / ネットワーク) | `docker compose up -d --force-recreate` |

## 動作確認

```bash
# LAN から
curl -sk --resolve freedomflight.jp:<CADDY_HTTPS_PORT>:<HOST_LAN_IP> https://freedomflight.jp:<CADDY_HTTPS_PORT>/healthz
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
- ファイアウォールで `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` を許可
- DNS が当ホスト IP を指し続ける

## セキュリティ

- **Caddy の共通ヘッダ** (`caddy/Caddyfile` の `security_headers`、全サイトで import):
  `Strict-Transport-Security: max-age=31536000` (includeSubDomains / preload なし)、
  `X-Content-Type-Options: nosniff` / `X-Frame-Options: SAMEORIGIN` /
  `Referrer-Policy: strict-origin-when-cross-origin` (上流が返した値も上書き)、
  `Server` / `X-Powered-By` / `Via` は削除。上流が落ちているときなど Caddy 自身が返す
  エラー応答にも同じヘッダを付ける。ffs-website の応答にだけ
  `Content-Security-Policy-Report-Only` を付けている (違反はブラウザのコンソールに出るだけ)
- **ffs-website コンテナ**: 非 root (`APP_UID` / `APP_GID`、既定 10001) で動かし、
  ルート FS は read_only (書けるのは `/data` と tmpfs の `/tmp` だけ)、`cap_drop: ALL`、
  `no-new-privileges`、メモリと PID 数に上限
- **`/proxy/tracks`**: 本文をメモリに溜めずにストリーミングで中継する。同時ダウンロード数は
  全体で `TRACK_DOWNLOAD_CONCURRENCY` (既定 4)、接続元 1 つあたり `TRACK_DOWNLOAD_PER_CLIENT`
  (既定 2) までで、超えた分は 503 / 429 (Retry-After 付き)。読まずに接続を保つ・極端に遅い
  転送が枠を握り続けないよう、1 チャンクの送信が 5 分止まるか、5 分ごとの送信量が 5 MiB
  (平均約 17 KiB/s) を下回ったら打ち切る (利用者には途中で切れたダウンロードとして見える)。
  打ち切った接続元は 10 分間、接続元ごとの上限に数えたままにする
- **API 仕様は非公開**: `/docs` / `/redoc` / `/openapi.json` は無効

## トラブルシュート

| 症状 | 主な原因 | 対処 |
|---|---|---|
| `/status` でエラーパネル | DCSSB WebService 到達不可 or 401 | `.env` の `DCSSB_API_KEY` を姉妹 repo と揃え、bot restart |
| Server Load 空 / `DCSSB_DB_URL not configured` | DSN 未設定 | `.env` に `DCSSB_DB_URL=postgresql://...` を追加 |
| 特定サーバだけ Load 欠落 | 該当 agent の Monitoring 未稼働 (CAP_SYS_PTRACE 等) | 姉妹 repo の該当 bot コンテナに `cap_add: [SYS_PTRACE]` があるか確認 |
| ブラウザで TLS エラー | Caddyfile の `http://` 接頭が残っている / DNS 未伝播 | Caddyfile 修正 → `docker compose restart caddy` でログ確認 |
| mixed-content で CSS 読めず | uvicorn の `--forwarded-allow-ips` 未設定 | Dockerfile に `--forwarded-allow-ips=*` があるか確認 |
| 外部から繋がらない | UFW / ルータ NAPT / ISP 80 遮断 | `tcpdump -i any 'tcp port <CADDY_HTTP_PORT>'` で SYN 到達確認 |
| `docker compose up` が「… を .env に設定してください」で止まる | 必須の環境変数が未設定 | `.env.example` を見て `.env` に追記 |
| Fitbit トークンの保存で `Permission denied` | `./data` の所有者が `APP_UID:APP_GID` でない | `sudo chown -R 10001:10001 data` (値は `APP_UID:APP_GID`) |
| `network ... _network not found` | 姉妹 compose 未起動 / project 名違い | `docker network ls` で実名確認、`docker-compose.yml` の `name:` を合わせる |

より詳しい運用上の注意は [.claude/skills/ffs-landing/SKILL.md](.claude/skills/ffs-landing/SKILL.md) を参照。

## ライセンス / クレジット

- 本体コード: FFS プロジェクト内部用、ライセンス未設定
- DCSServerBot: Special-K の実装、本 repo はその consumer
- Caddy / FastAPI / htmx / psycopg: 各 OSS の原ライセンスに従う
