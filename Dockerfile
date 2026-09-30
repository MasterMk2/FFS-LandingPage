FROM python:3.12-slim

# 実行ユーザーの uid/gid。./data (Fitbit トークン保存先) を bind-mount するので
# ホスト側の所有者と数値で揃える必要がある。compose の APP_UID / APP_GID で上書きできる
# (ホストで data/ を手編集したいならホストユーザーの uid/gid に合わせる)。
ARG APP_UID=10001
ARG APP_GID=10001

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# ログインシェル・ホームディレクトリ無しのアプリ専用ユーザー。
RUN groupadd --system --gid "${APP_GID}" app \
    && useradd --system --uid "${APP_UID}" --gid app \
        --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin app

# /app は root 所有のまま (COPY の既定)。アプリユーザーは読めるが書き換えられない。
# COPY はビルド元の権限をそのまま持ち込む (Windows のドライブ上からビルドすると
# 0777 になる) ので、group/other の書き込み権を外しておく。
COPY app/ ./app/
RUN chmod -R go-w /app

# compose ではルート FS を read_only にしていて、書けるのは /tmp (tmpfs) と /data だけ。
# HOME を /tmp に向けておき、ライブラリがホーム配下へ書こうとしても落ちないようにする。
ENV HOME=/tmp

# 数値で指定する (passwd を引かずに非 root と判定できる)。
USER ${APP_UID}:${APP_GID}

EXPOSE 8000

# --no-server-header: uvicorn の `Server: uvicorn` 応答ヘッダを出さない (#6)。
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*", "--no-server-header"]
