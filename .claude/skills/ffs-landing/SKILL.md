---
name: ffs-landing
description: Use when working on this repo (FFS-LandingPage = FFS DCS ランディング/ステータスサイト) — FastAPI + Jinja2 + HTMX, Docker, dcs_network external 参加, DCSSB RestAPI 連携。app/{main.py,dcssb.py,templates,static} の編集や docker-compose.yml のポート/ネットワーク、姉妹リポジトリ ffs-dcs-server-ops との API_KEY 同期に触る作業で自動 load。
---

# FFS-LandingPage スキル

このリポジトリは **FFS DCS サーバのランディング / ステータスサイト単体**。
DCS サーバ本体・DCSServerBot (DCSSB)・ネットワーク設計は**姉妹リポジトリ**
[ffs-dcs-server-ops](https://github.com/KeN7879/ffs-dcs-server-ops) にある。

同じホスト上に両 repo を clone する運用が前提。本 skill を開いたら**まず姉妹 repo の
`.claude/skills/ffs-dcs-restapi/SKILL.md` を前提として読む**こと (本 skill は重複を
避けて本 repo 固有の話に絞る)。

## 1. 全体トポロジ (抜粋)

```
[ブラウザ]
   │ :18150/tcp  (S=1 b=5 x=0 singleton, public/LAN)
   ▼
[ffs-website] ← このリポジトリ
   │ FastAPI (uvicorn 8000 内部) + Jinja2 + HTMX (15 秒 polling)
   │ networks.dcs_network: external: true
   │   name: ffs-dcs-server_dcs_network   ← 姉妹 repo compose project 名 prefix
   │
   │ http://dcs-server-1:9876/stats/servers   ← X-API-KEY
   ▼
[DCSSB master=dcsserverbot]  ← 姉妹 repo 側で稼働
   (netns 共有で実 bind 先は dcs-server-1)
```

**前提**: 姉妹 repo 側の dcsserverbot (master) で RestAPI plugin + WebService が
有効化されていること。されていなければ `apply-restapi-config.sh` を走らせる
(詳細は姉妹 repo の skill / BRINGUP_PROCEDURE §9.y)。

## 2. 本 repo 固有の前提

### 2.1 dcs_network は必ず external 参加

```yaml
networks:
  dcs_network:
    name: ffs-dcs-server_dcs_network   # 姉妹 repo の project 名が prefix
    external: true
```

- **本 repo で dcs_network を driver: bridge で定義してはいけない**。
  別の network が作られて dcs-server-1 に到達できなくなる (hostname 解決が失敗する)。
- 姉妹 repo の compose project 名を変えた場合は `name:` を追従させる。
  `docker network ls | grep dcs_network` で実名を確認できる。

### 2.2 DCSSB_BASE_URL は既定で `dcs-server-1:9876`

- dcsserverbot (master) は `network_mode: service:dcs-server-1` で netns 共有。
  よって WebService (`:9876`) は dcs-server-1 のインターフェースで listen される。
- ffs-website 側から見たターゲット hostname は dcsserverbot ではなく **dcs-server-1**
  (compose DNS は netns 共有先の container 名で解決する)。
- `DCSSB_BASE_URL` を `http://dcsserverbot:9876` にしてはいけない (存在しない name)。

### 2.3 DCSSB_API_KEY は姉妹 repo の .env と**同値必須**

- 揃っていないと RestAPI が 401 を返し、ランディングは "DCSSB API に到達できません"
  を表示する。
- 生成: 姉妹 repo 側で `openssl rand -hex 32` → 両方の `.env` にコピー。
- `.env` は両 repo で gitignored。LandingPage 側は `.env.example` を clone 時に
  `cp .env.example .env` する。

### 2.4 外部公開ポートは 18150 のみ、9876 は公開しない

- 18150 = `S=1 b=5 x=0` singleton (姉妹 repo の 18Sbx 規約)。
- 9876 (DCSSB WebService) は dcs_network 内部でのみ到達。ホスト公開もルータ NAPT も
  しない。debug mode の `/docs` が api_key を bypass するため事故る。

## 3. コード構成 (app/ 配下)

| ファイル | 役割 |
|---|---|
| [app/main.py](../../../app/main.py) | FastAPI エントリ。`/`, `/panel/servers`, `/healthz`。Jinja2 template + static mount |
| [app/dcssb.py](../../../app/dcssb.py) | DCSSB RestAPI クライアント。`httpx.AsyncClient` で X-API-KEY ヘッダ付与 |
| [app/templates/base.html](../../../app/templates/base.html) | 共通レイアウト (HTMX CDN load、hero、footer) |
| [app/templates/index.html](../../../app/templates/index.html) | ルート。`hx-get=/panel/servers hx-trigger="load, every 15s"` でポーリング |
| [app/templates/servers_panel.html](../../../app/templates/servers_panel.html) | サーバカード grid。DCSSB の `/stats/servers` レスポンスを表示。error 分岐あり |
| [app/static/style.css](../../../app/static/style.css) | ダークテーマ (`#0b1020` base)。`.card.status-{up,down,warn}` で色分け |

### 3.1 追加ルート/エンドポイントを足したいとき

1. `dcssb.py` に `async def get_xxx()` を追加 (`_get("/xxx")` を呼ぶ)
2. `main.py` に panel ルートを追加 (`@app.get("/panel/xxx")`)
3. template を `app/templates/xxx_panel.html` に作成
4. `index.html` に `<section hx-get="/panel/xxx" hx-trigger="...">` を追加

HTMX の `hx-swap` デフォルトは `innerHTML`、`hx-trigger` で polling や
`click` など指定。SSE/WebSocket 化するなら FastAPI 側を `starlette.responses`
に切り替える。

### 3.2 DCSSB レスポンスの型

`/stats/servers` は list[dict]。dict のキーは DCSSB upstream 実装に依存する
(**WIP マーキング**あり、キー名が variant しやすい)。テンプレ側は
`s.get("server_name") or s.get("name")` のように **or chain で fallback**
する防御的書き方で統一する。変更が入ったら API サーバを叩いて jq で確認:

```bash
docker exec ffs-dcsserverbot curl -s \
  -H "X-API-KEY: $(grep DCSSB_API_KEY ../ffs-dcs-server-ops/.env | cut -d= -f2)" \
  http://localhost:9876/stats/servers | jq 'first | keys'
```

(ffs-dcsserverbot 側は netns 共有で localhost:9876 に到達できる。)

## 4. Docker / 起動まわり

### 4.1 Dockerfile

- base: `python:3.12-slim`
- `pip install -r requirements.txt` (fastapi / uvicorn / jinja2 / httpx)
- CMD `uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers`
- build-time に秘密は持たない (api_key は runtime env only)

### 4.2 compose

- ports: `18150:8000/tcp` のみ
- environment:
  - `DCSSB_BASE_URL` (default `http://dcs-server-1:9876`)
  - `DCSSB_API_PREFIX` (default `/stats`)
  - `DCSSB_API_KEY` (.env から)
  - `DCSSB_TIMEOUT` ("3.0")
- `depends_on:` は書けない (姉妹 repo のサービスを参照できない)。別 compose project
  のため起動順は運用側が担保する (= 姉妹 repo の compose が先に立ち上がっている前提)。

### 4.3 ローカル開発 (docker 無し)

```bash
cd /home/ffs-dcs/FFS-LandingPage
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# 姉妹 repo 側を先に起動し、docker 経由で dcs_network に相乗りするなら
# ホストから dcs-server-1 の名前解決はできない → DCSSB_BASE_URL を
# 一時的に http://localhost:9876 にする + 姉妹 repo compose で 9876 を
# host publish する必要あり (運用では publish しないので dev 限定)。
DCSSB_BASE_URL=http://localhost:9876 \
DCSSB_API_KEY=$(grep DCSSB_API_KEY ../ffs-dcs-server/.env | cut -d= -f2) \
  uvicorn app.main:app --reload --port 8000
```

## 5. トラブルシュートのクイック対応表

| 症状 | 真っ先に疑う |
|---|---|
| `network ffs-dcs-server_dcs_network not found` | 姉妹 repo の compose が停止中、or project 名が違う (`docker network ls` で実名確認 → compose の `name:` を合わせる) |
| `/healthz` は OK だが `/` が "DCSSB API に到達できません" | 姉妹 repo 側で WebService + RestAPI 未有効化 (姉妹 skill §2.3 の apply script) |
| HTTP 401 | `.env` の DCSSB_API_KEY が姉妹 repo と不一致 |
| HTTP 404 | `DCSSB_API_PREFIX` が違う (`/stats` default) |
| 繋がるが `[]` (servers 空) | DCSSB が DCS に未 attach。姉妹 repo Discord で `/server list` を確認 |
| HTMX が更新しない (初期描画のみ) | `/panel/servers` が 500 を返している。curl で確認 + server ログ |
| HTMX CDN が読めない (オフライン環境) | `app/templates/base.html` の `<script src="...htmx...">` を vendor 化 (`app/static/` に置いて URL を差し替え) |
| 日本語が化ける | template の `<meta charset="utf-8">` を確認、static css の `font-family` にフォールバックを増やす |

## 6. 禁忌

- **`DCSSB_API_KEY` を commit**しない (`.env` は gitignored、`.env.example` には空で置く)
- **9876 を本 repo compose の ports に書かない** (姉妹 repo 側の責務だし、そもそも公開不要)
- **姉妹 repo の実装を本 repo に複製しない** (dcs-server、DCSSB、ネットワーク、
  bind-mount は姉妹 repo 側の single source of truth。LandingPage は consumer)
- **DCSSB の API エンドポイントを直接想定実装にする**ハードコーディングを避ける
  (`/stats/servers` のレスポンス構造は WIP 変動あり → fallback chain で受ける、§3.2)
- **main ブランチへ直接 push**する前に PR review を通す (shared state)

## 7. 変更の影響範囲マップ

| 変更 | 影響先 | 必要な再起動 |
|---|---|---|
| `app/templates/*.html` 編集 | landing の見た目 | `docker compose restart ffs-website` (uvicorn --reload ならば不要) |
| `app/static/style.css` 編集 | 同上 | 同上 (ブラウザ cache-bust 別途) |
| `app/main.py` / `app/dcssb.py` 編集 | ルート追加 / API 経路 | `docker compose restart ffs-website` |
| `requirements.txt` 追加 | 依存更新 | `docker compose build --no-cache ffs-website && docker compose up -d` |
| `docker-compose.yml` ports 変更 | 18150 の外部 port 変更 | `docker compose up -d --force-recreate ffs-website` + UFW 更新 |
| `.env` DCSSB_API_KEY ローテーション | 姉妹 repo 側も同時更新 | 本 repo `docker compose up -d --force-recreate` + 姉妹 repo で apply script 再実行 + bot restart |

## 8. 参照ファイル

- 姉妹 repo: https://github.com/KeN7879/ffs-dcs-server-ops
- 姉妹 repo の RestAPI skill: `../ffs-dcs-server/.claude/skills/ffs-dcs-restapi/SKILL.md`
- 姉妹 repo の BRINGUP §9.y: `../ffs-dcs-server/docs/Manual/FFS_DCS_BRINGUP_PROCEDURE.md`
- 姉妹 repo の apply script: `../ffs-dcs-server/scripts/apply-restapi-config.sh`
- 上流 DCSSB ドキュメント:
  - [RestAPI plugin](https://github.com/Special-K-s-Flightsim-Bots/DCSServerBot/blob/master/plugins/restapi/README.md)
  - [WebService](https://github.com/Special-K-s-Flightsim-Bots/DCSServerBot/blob/master/services/webservice/README.md)
