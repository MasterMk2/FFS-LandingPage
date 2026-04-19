---
name: ffs-landing
description: Use when working on this repo (FFS-LandingPage) — FastAPI + Jinja2 + HTMX + Caddy による FFS DCS コミュニティの公開ランディング / ステータス / リーダーボード / リプレイ DL サイト。Caddy リバプロで freedomflight.jp / iyakusai.com / sneaker / lardoon サブドメインを HTTPS 終端、DCSSB RestAPI + postgres (serverstats) を参照。app/{main.py,dcssb.py,db.py,cache.py,templates,static} 編集や docker-compose.yml のネットワーク/ポート、caddy/Caddyfile、姉妹リポジトリ ffs-dcs-server の .env API_KEY / nodes.yaml extension に触る作業で自動 load。
---

# FFS-LandingPage スキル

FFS DCS コミュニティの **公開向けランディングサイト + リバプロ** を一つにまとめた repo。
DCS サーバ本体・DCSSB・postgres・ネットワーク設計は **姉妹リポジトリ**
[ffs-dcs-server-ops](https://github.com/KeN7879/ffs-dcs-server-ops) にある。
同ホスト上に両 repo を clone する運用前提。**姉妹 repo 側の skill** (特に
`ffs-dcs-restapi` と nodes.yaml 構造) を読んでから本 skill を読むと理解が早い。

## 1. トポロジ

```
                          [ WAN ]
                             │  :80 / :443
                             ▼
                    [ router (NAPT) ]
                             │  192.168.3.170:30080 / :30443
                             ▼
                        [ ホスト ]
                             │  (Docker publish)
                             ▼
                        [ ffs-caddy ]
                         :80 / :443 (TLS 終端 + Host 振り分け)
       ┌────────────┬──────────────┬──────────────────┬───────────┐
       ▼            ▼              ▼                  ▼           ▼
  iyakusai.com    freedomflight   sneaker.            lardoon.   (catch-all)
  (sibling/ 系)    .jp            freedomflight.jp    ~.jp       → 404
       │           │              │                   │
  file_server  reverse_proxy   reverse_proxy     reverse_proxy
  ./iyakusai/  ffs-website:8000 ffs-sneaklardooon  ffs-sneak ~
               (本 repo の本体)   :7788              :3883
                    │
                    ├─ dcs_network  → dcs-server-1:9876 (DCSSB RestAPI + /tracks)
                    └─ db_network   → ffs-postgres:5432 (serverstats RO)
```

ffs-website 本体は **ホストへ直接 publish しない** (Caddy 経由のみ)。
iyakusai / sneaker / lardoon は DCS サーバとは無関係のサイトだが、同じ Caddy
で一緒にホストしている (公開 IP が 1 本のため Host ヘッダで振り分け)。

## 2. ネットワーク接続

| network | 用途 | external name (docker) |
|---|---|---|
| `dcs_network` | ffs-website → DCSSB RestAPI / caddy → ffs-website / caddy → sneaker/lardoon | `ffs-dcs-server_dcs_network` (姉妹 compose が作成) |
| `db_network` | ffs-website → postgres (serverstats RO SELECT) | `ffs-dcs-server_db_network` |

両方 **external: true** で参加。姉妹 repo の compose project 名が変わったら
[docker-compose.yml](../../../docker-compose.yml) の `networks.*.name:` を追従。

## 3. 公開ページ一覧 (ユーザが目にする URL)

| URL | 役割 | 関連 handler / template |
|---|---|---|
| `https://freedomflight.jp/` | ランディング Home (intro + live stats + カード) | `home()` / [home.html](../../../app/templates/home.html) |
| `https://freedomflight.jp/status` | サーバステータス (cards + Server Load graphs) | `status_page()` / [index.html](../../../app/templates/index.html) |
| `https://freedomflight.jp/leaderboard` | 月次リーダーボード (飛行時間 / 撃墜 等) | `leaderboard()` / [leaderboard.html](../../../app/templates/leaderboard.html) |
| `https://freedomflight.jp/tracks` | リプレイ (.trk) 一覧とダウンロード | `tracks_page()` / [tracks.html](../../../app/templates/tracks.html) |
| `https://freedomflight.jp/healthz` | ヘルスチェック (JSON) | `healthz()` |
| `https://iyakusai.com/` (+ `www` / `2025`) | 静的 HTML (医学薬学祭) | Caddy file_server → `./iyakusai/` |
| `https://sneaker.freedomflight.jp/` | Sneaker (Live Map) — 実体は姉妹 repo の `ffs-sneaklardooon:7788` | Caddy reverse_proxy |
| `https://lardoon.freedomflight.jp/` | Lardoon (Tacview archive) — 実体は `ffs-sneaklardooon:3883` | Caddy reverse_proxy |

## 4. 内部エンドポイント (HTMX / 内部用)

| URL | 用途 |
|---|---|
| `GET /panel/servers` | サーバカード HTML フラグメント。HTMX が Status ページで 15s 毎 polling |
| `GET /panel/serverload` | Server Load カード (FPS/CPU/Memory/Players 時系列 SVG)。30s 毎 |
| `GET /proxy/tracks/{server}/{filename}` | .trk ダウンロードプロキシ (api_key を注入して DCSSB から取得) |

## 5. コード構成 (app/ 配下)

| ファイル | 役割 |
|---|---|
| [app/main.py](../../../app/main.py) | FastAPI エントリ・ルート定義・cache 起動 (lifespan) |
| [app/cache.py](../../../app/cache.py) | `Fetcher[T]` — 周期リフレッシュ付き in-memory cache |
| [app/dcssb.py](../../../app/dcssb.py) | DCSSB WebService クライアント (RestAPI + /tracks) |
| [app/db.py](../../../app/db.py) | postgres `serverstats` を RO で SELECT、時系列と SVG スパークライン生成 |
| [app/sysmon.py](../../../app/sysmon.py) | psutil でホスト CPU/mem/swap/loadavg/uptime を /host/proc 経由で取得 |
| [app/templates/base.html](../../../app/templates/base.html) | 共通レイアウト。ヒーロー + Nav + footer |
| [app/templates/home.html](../../../app/templates/home.html) | Home ページ (Welcome / quick stats / カード) |
| [app/templates/index.html](../../../app/templates/index.html) | Status ページ (HTMX panel mount 2 枚) |
| [app/templates/leaderboard.html](../../../app/templates/leaderboard.html) | Leaderboard (カテゴリ別 top 10) |
| [app/templates/tracks.html](../../../app/templates/tracks.html) | Replays (各サーバの .trk 一覧 + DL リンク) |
| [app/templates/servers_panel.html](../../../app/templates/servers_panel.html) | HTMX: サーバカード (mission/weather/extensions) |
| [app/templates/serverload_panel.html](../../../app/templates/serverload_panel.html) | HTMX: FPS/CPU/Memory/Players スパークライン |
| [app/templates/sysmon_panel.html](../../../app/templates/sysmon_panel.html) | HTMX: ホスト CPU/Mem/Swap/Load カード |
| [app/static/style.css](../../../app/static/style.css) | ダークテーマ、全スタイル統合 |

## 6. バックグラウンドキャッシュ ([app/cache.py](../../../app/cache.py))

F5 連打で upstream (DCSSB / postgres) に負荷を掛けないよう、HTTP handler は
**必ず in-memory cache を読むだけ** にしている。refresh は FastAPI lifespan で
起動した asyncio タスクが interval 毎に並行実行。

| cache 名 | データ元 | interval | 用途 |
|---|---|---|---|
| `servers_cache` | `dcssb.get_servers()` | **15s** | Status カード + Services バー + Home quick stats |
| `load_cache` | `db.get_server_load_series()` | **60s** | Server Load graphs (DCSSB Monitoring が 1 分毎書き) |
| `highscore_cache` | `dcssb.get_highscore(period='month', limit=10)` | **300s** | Leaderboard |
| `tracks_cache` | summary + 各サーバ list をバッチで取得 | **60s** | Replays ページ + Home quick stats |

**設計上の注意**:
- `CachedValue` は最新 1 件のみ保持 (履歴は持たない)。時系列グラフは `serverstats`
  テーブルに元データがあるのでそちらから window 分 SELECT して再生成する。
- `_state = CachedValue(...)` は参照 atomic swap なので読み手と書き手の衝突は
  起こらない。
- upstream 失敗時は **直近成功値を保持**し `error` フィールドのみ更新。復旧時に
  次の tick で自動差し替え → ダウンタイムに強い。
- 1 プロセスローカルなのでマルチインスタンス化するときは Redis 等へ移行。

## 7. Caddy (リバプロ / TLS 終端)

[caddy/Caddyfile](../../../caddy/Caddyfile) にサイトブロックを記述。
[docker-compose.yml](../../../docker-compose.yml) の `caddy` サービスで起動。

| サイト | 振り分け先 |
|---|---|
| `iyakusai.com`, `www.iyakusai.com`, `2025.iyakusai.com` | file_server `/srv/iyakusai/` (本 repo `./iyakusai/` を bind-mount) |
| `freedomflight.jp` | reverse_proxy `ffs-website:8000` |
| `sneaker.freedomflight.jp` | reverse_proxy `ffs-sneaklardooon:7788` |
| `lardoon.freedomflight.jp` | reverse_proxy `ffs-sneaklardooon:3883` |
| `:80` catch-all | 404 (未登録 Host / IP 直打ち) |

### TLS
Let's Encrypt で **自動発行 + 自動更新**。期限 30 日前に certmagic が自動 renew。
証明書は `caddy_data` docker volume に保存、コンテナ再作成でも保持される。
更新の前提:
- Caddy 常時稼働 (`restart: unless-stopped`)
- ルータ NAPT `:80/:443 → 192.168.3.170:30080/30443` が維持
- UFW で `30080/tcp`, `30443/tcp` が open
- DNS が host IP を指し続ける

### 公開ポート (ホスト側)
Caddy のみが `30080:80`, `30443:443` を publish。ffs-website の `8000` は
**docker network 内部のみ**公開 (Caddy 経由でしか到達できない)。

## 8. DCSSB 連携 ([app/dcssb.py](../../../app/dcssb.py))

base URL は `http://dcs-server-1:9876` (dcs_network 内)。認証は `X-API-Key`
ヘッダで .env の `DCSSB_API_KEY` を投げる。prefix は 2 種:

| prefix | 用途 | 実装関数 |
|---|---|---|
| `/stats` (`DCSSB_API_PREFIX`) | RestAPI plugin: `/servers`, `/highscore` 等 | `get_servers()`, `get_highscore()` 他 |
| `/tracks` (`DCSSB_TRACKS_PREFIX`) | Tracks 配布 endpoint: `/`, `/{server}`, `/{server}/{filename}` | `get_tracks_summary()`, `get_tracks_list()`, `fetch_track_file()` |

API key は**本 repo と姉妹 repo の .env で同値必須**。不一致だと 401。

### extension preprocessing
`_expand_extensions()` で DCSSB の `\n**Label [port]**` 形式の複合 value を
1 chip = 1 エンドポイント に正規化 (Tacview の RTT / Remote Ctrl 分離など)。

`_split_extensions()` で全サーバに共通する value (Sneaker/Lardoon URL 等) を
**global** と判定し、per-server カード内の `ext-chip` から除外
(サーバ毎に異なる LotAtc/Tacview ポート等のみ残す)。
Sneaker / Lardoon はホームページの Tools & Services セクションにハードコード。

## 9. postgres `serverstats` 連携 ([app/db.py](../../../app/db.py))

DCSSB Monitoring が 1 分毎に書き込むテーブル。FPS/CPU/memory/bytes/users/status
を `_HISTORY_MINUTES` (=60 分) 分 SELECT して、サーバ毎に最新値 + スパークライン
用の SVG path を事前計算して返す。

### 接続情報
`.env` の `DCSSB_DB_URL` に `postgresql://ffs_landing_ro:<pass>@ffs-postgres:5432/dcsserverbot`
を設定。`ffs_landing_ro` は姉妹 repo 側で以下の grant を受けた **read-only** role:

```sql
CREATE ROLE ffs_landing_ro LOGIN PASSWORD '<hex-48>';
GRANT CONNECT ON DATABASE dcsserverbot TO ffs_landing_ro;
GRANT USAGE ON SCHEMA public TO ffs_landing_ro;
GRANT SELECT ON serverstats TO ffs_landing_ro;
```

他テーブルへの read 権限は**敢えて付けていない** (最小権限)。新しいテーブルを
読みたくなったら必要に応じて GRANT を追加する。

### スパークライン
`_sparkline()` で values 配列を SVG `M x y L x y ...` 形式に変換。viewBox 固定で
CSS `width:100%` ストレッチ。stroke は `vector-effect="non-scaling-stroke"` で
アスペクト比崩れを回避。閾値色分けは html 側では行わず、CSS `.fps-chart` 等で色配当。

## 10. Tracks 配布 ([dcssb.py fetch_track_file](../../../app/dcssb.py) + [main.py proxy_track_download](../../../app/main.py))

DCSSB `/tracks/{server}/{filename}` は `X-API-Key` 必須なので**ブラウザ直 DL 不可**。
landing 側に proxy endpoint を立て、api_key ヘッダを注入してバイナリを転送:

```
ブラウザ ──GET /proxy/tracks/server1/foo.trk──▶ ffs-website
                                                  │ +X-API-Key
                                                  ▼
                                    DCSSB /tracks/server1/foo.trk
```

### セキュリティ (proxy 側)
- server 名: `^[A-Za-z0-9_-]+$` でホワイトリスト
- filename: `^[A-Za-z0-9._-]+\.trk$` で path traversal 拒否
- DCSSB が返す 404/400 はそのまま伝搬

## 11. Docker compose

| service | 役割 | 公開 | volumes |
|---|---|---|---|
| `ffs-website` | FastAPI 本体 (uvicorn `--proxy-headers --forwarded-allow-ips=*`) | なし (internal) | なし (コード COPY) |
| `caddy` | リバプロ + TLS 終端 | `30080:80`, `30443:443` | `./caddy/Caddyfile`, `./iyakusai/`, `caddy_data`, `caddy_config` |

`depends_on: caddy: ffs-website` で起動順を守るが、ネットワーク的には external
参加なので姉妹 repo が生きてないと dcs_network/db_network に join できない。

## 12. 起動順序

1. 姉妹 repo `ffs-dcs-server`: `docker compose up -d` (postgres / DCSSB / dcs-server* / sneaklardooon)
2. 姉妹 repo 側 初回のみ: RestAPI plugin config 投入 (`apply-restapi-config.sh`)
3. 姉妹 repo 側 初回のみ: `ffs_landing_ro` role 作成
4. 本 repo `.env` 用意 (DCSSB_API_KEY + DCSSB_DB_URL)
5. 本 repo: `docker compose up -d --build`
6. ルータ NAPT `80→30080`, `443→30443` 設定 (既設なら skip)
7. UFW で `30080/tcp`, `30443/tcp` を allow

## 13. トラブルシュート

| 症状 | 疑うところ | 対処 |
|---|---|---|
| `network ffs-dcs-server_dcs_network not found` | 姉妹 compose 停止中 / project 名違い | `docker network ls` で実名確認 → `docker-compose.yml` の `name:` を合わせる |
| `network ... _db_network not found` | 同上 | `db_network.name:` も合わせる |
| `/` が 500 で「DCSSB API に到達できません」 | RestAPI plugin 未有効 / 401 | 姉妹 repo `apply-restapi-config.sh` or `.env` DCSSB_API_KEY 同期 |
| Server Load カード空 / `DCSSB_DB_URL not configured` | postgres DSN 未設定 | 本 repo `.env` に追記 |
| Server Load 特定サーバだけ欠落 | 該当 agent で Monitoring が動いてない | 姉妹 repo compose で該当 bot に `cap_add: [SYS_PTRACE]` があるか確認 |
| Mission/Theatre が `-` | DCSSB レスポンスキー変化 | `s.mission.name` / `s.mission.theatre` fallback chain を servers_panel.html で確認 |
| ブラウザで cert warning / TLS エラー | Caddy が :443 listen 未、または上流 HTTP 前提サービス | Caddyfile に `http://` 接頭付いていないか / TLS 化したいなら DNS + ACME 到達性を確認 |
| mixed-content (CSS 404) | uvicorn が X-Forwarded-Proto を信用していない | Dockerfile の CMD に `--forwarded-allow-ips=*` があるか確認 |
| 外部から 30080/30443 に届かない | UFW で未許可 | `sudo ufw allow 30080/tcp`, `sudo ufw allow 30443/tcp` |
| 外部から 80/443 届かない | ルータ NAPT 未 / ISP が 80 遮断 | tcpdump で SYN の有無確認。届かなければ router / ISP 側 |
| ACME で LE から cert 取れない | DNS 未伝播 / 別ホストに 80/443 届いてる | `dig @1.1.1.1 <domain>` で A が正しいか → Caddy log で `challenge` 失敗行確認 |
| Services バーに古いラベル残骸 | DCSSB が旧 nodes.yaml をメモリキャッシュ | 姉妹 repo で `docker compose restart dcsserverbot*` |
| HTMX が更新しない | HTMX CDN 到達不可 / panel 500 | ブラウザ devtools で /panel/* のステータス確認 |

## 14. 変更の影響範囲

| 変更 | 影響 | 必要な再起動 / 手続 |
|---|---|---|
| `app/templates/*.html` 編集 | 見た目のみ | `docker compose build ffs-website && up -d --force-recreate ffs-website` |
| `app/static/style.css` | 同上 | 同上 (CSS は image COPY 済、bind-mount してないのでビルド必須) |
| `app/main.py` / `app/dcssb.py` / `app/db.py` / `app/cache.py` | ルート / ロジック | 同上 |
| `requirements.txt` | 依存追加 | `docker compose build --no-cache ffs-website` |
| `caddy/Caddyfile` | ルーティング | `docker compose restart caddy` (ビルド不要) |
| `iyakusai/` 配下 | 静的サイト内容 | なし (bind-mount、即反映) |
| `docker-compose.yml` networks/ports | インフラ | `docker compose up -d --force-recreate` |
| `.env` | 資格情報 | `docker compose up -d --force-recreate ffs-website` |
| DNS 追加 (新サブドメイン) | 新サイト拡張 | Caddyfile に site block 追加 → restart caddy で LE 自動発行 |
| `DCSSB_API_KEY` ローテ | 認証 | 姉妹 repo と同時更新 → 両方 restart |
| postgres RO password ローテ | DB 接続 | `ALTER ROLE ffs_landing_ro PASSWORD …` → 本 repo `.env` 更新 → restart ffs-website |

## 15. 禁忌

- **`DCSSB_API_KEY` を commit** しない (`.env` は gitignored)
- **`DCSSB_DB_URL` の平文パスワードを commit** しない (`.env` のみ、gitignored)
- **姉妹 repo の実装を本 repo に複製しない** (DCSSB / DCS / postgres / netns 設計
  は姉妹 repo が single source of truth、本 repo は consumer)
- **ffs-website を直 publish しない** (現状 Caddy 経由のみ、攻撃面最小化)
- **LE に cert 要求を無駄打ちしない** — 落ちたサイトブロックがあれば一旦 `http://`
  接頭で留めて、DNS + 到達性確認してから有効化する (Failed Validation rate limit
  5/hostname/hour に注意)
- **`caddy_data` volume を消さない** — ACME アカウント + 証明書が吹き飛ぶ。
  復旧は即新規発行可能だが duplicate cert rate limit (5/week/FQDN) に抵触する
  危険がある
- **main に直接 push しない** — shared state、PR レビューを通す

## 16. 参照

- 姉妹 repo: https://github.com/KeN7879/ffs-dcs-server-ops
- 姉妹 skill: `../ffs-dcs-server/.claude/skills/ffs-dcs-restapi/SKILL.md`
- 姉妹 nodes.yaml: `../ffs-dcs-server/config/dcsserverbot/nodes.yaml` (SneakerLink/LardoonLink extension 定義)
- DCSSB RestAPI plugin: https://github.com/Special-K-s-Flightsim-Bots/DCSServerBot/blob/master/plugins/restapi/README.md
- DCSSB Monitoring plugin: https://github.com/Special-K-s-Flightsim-Bots/DCSServerBot/blob/master/plugins/monitoring/README.md
- Caddy v2 docs: https://caddyserver.com/docs/caddyfile
