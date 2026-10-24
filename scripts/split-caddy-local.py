#!/usr/bin/env python3
"""サーバーで手編集した caddy/Caddyfile の追加分を、git 管理外の caddy/local/ に切り出す (サーバーで実行)。

Caddyfile を直接編集すると git pull が止まるので、このサーバーだけの経路は caddy/local/ に置く
(Caddyfile の import /etc/caddy/local/... 参照)。この道具は一度きりの移行用で、書き込むのは --out だけ。
今の Caddyfile・.env・コンテナには触らない。

    python3 scripts/split-caddy-local.py --new-rev origin/main --out ~/ffs-caddy-local-candidate

1. 基点 (--base-rev、既定 HEAD) の Caddyfile と今の Caddyfile の差分を取る。
2. 追加された行のまとまりを、freedomflight.jp ブロックの中なら freedomflight.jp/50-server.caddy、
   ブロックの外 (最上位) なら sites/50-server.caddy に写す。
   `{$VAR}` を直書きに置き換えた行は、.env に足す VAR=値 として表示する (書き換えはしない)。
   それ以外の変更・削除・別ブロックの中への追加があれば止まる (手で移す)。
3. 検査: 今の Caddyfile と、新しい版 (--new-rev) の Caddyfile + 切り出したファイルを、どちらも
   `caddy adapt` で JSON にし、/updates/ の経路を除いて一致することを確かめる。
   adapt は使い捨てのコンテナ (--image) で、.env の値を環境変数として渡して行う。
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ENV_REF = re.compile(r"\{\$([A-Z0-9_]+)\}")
SITE_LOCAL = "freedomflight.jp"


def git_show(repo: Path, rev: str) -> list[str]:
    text = subprocess.check_output(["git", "show", f"{rev}:caddy/Caddyfile"], cwd=repo, text=True, encoding="utf-8")
    return text.replace("\r\n", "\n").split("\n")


def enclosing_block(lines: list[str], index: int) -> str | None:
    """lines[index] の直前の位置で開いている最上位のブロック名 (最上位なら None)。"""
    depth, name = 0, None
    for line in lines[:index]:
        stripped = line.split("#", 1)[0].strip() if not line.lstrip().startswith("#") else ""
        if depth == 0 and stripped.endswith("{"):
            name = stripped[:-1].strip()
        depth += stripped.count("{") - stripped.count("}")
        if depth == 0:
            name = None
    return name


def split(base: list[str], live: list[str]) -> tuple[list[str], list[str], dict[str, str], list[str]]:
    in_site, top, env, problems = [], [], {}, []
    matcher = difflib.SequenceMatcher(a=base, b=live, autojunk=False)
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == "equal":
            continue
        if op == "replace" and i2 - i1 == j2 - j1:
            for old, new in zip(base[i1:i2], live[j1:j2]):
                refs = ENV_REF.findall(old)
                if len(refs) == 1:
                    head, tail = old.split("{$" + refs[0] + "}")
                    if new.startswith(head) and new.endswith(tail) and len(new) > len(head) + len(tail):
                        env[refs[0]] = new[len(head):len(new) - len(tail)] if tail else new[len(head):]
                        continue
                problems.append(f"changed line {i1 + 1}: {old.strip()!r} -> {new.strip()!r}")
            continue
        if op != "insert":
            problems.append(f"{op} at base lines {i1 + 1}-{i2}")
            continue
        block = enclosing_block(base, i1)
        chunk = live[j1:j2]
        if block is None:
            top.extend(chunk + [""])
        elif block == SITE_LOCAL:
            in_site.extend(chunk + [""])
        else:
            problems.append(f"insert inside {block!r} at base line {i1 + 1}")
    return in_site, top, env, problems


def env_file(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def adapt(image: str, caddyfile: Path, local_dir: Path | None, env: dict[str, str]) -> dict:
    command = ["docker", "run", "--rm", "-v", f"{caddyfile}:/etc/caddy/Caddyfile:ro"]
    if local_dir is not None:
        command += ["-v", f"{local_dir}:/etc/caddy/local:ro"]
    for key in env:
        command += ["-e", key]
    command += [image, "caddy", "adapt", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
    result = subprocess.run(command, capture_output=True, text=True, env={**os.environ, **env})
    if result.returncode != 0:
        sys.exit(f"caddy adapt failed for {caddyfile}:\n{result.stderr[-2000:]}")
    return json.loads(result.stdout)


def _paths(route: dict) -> list[str]:
    return [p for m in route.get("match", []) if isinstance(m, dict) for p in m.get("path", [])]


def _overlap(a: str, b: str) -> bool:
    a, b = a.rstrip("*"), b.rstrip("*")
    return a.startswith(b) or b.startswith(a)


def canonical_config(config: dict) -> tuple[str, set]:
    """adapt の JSON を、意味の同じものが同じ形になるように直す。

    - group の名前は連番で、経路を足すとずれるので、グループの中身から付け直す。
    - 同じ group の経路は排他 (先に一致したものだけ動く) なので、パスが重ならない限り順序に意味がない。
      グループの中は並べ替える。重なるパスの組 (先, 後) は別に集めて、前後で同じことを確かめる。
    """
    pairs: set = set()

    def walk(node):
        if isinstance(node, list):
            return [walk(item) for item in node]
        if not isinstance(node, dict):
            return node
        out = {key: walk(value) for key, value in node.items() if key != "routes"}
        if "routes" in node:
            routes = [walk(route) for route in node["routes"]]
            members: dict[str, list] = {}
            for route in routes:
                if "group" in route:
                    members.setdefault(route["group"], []).append(route)
            names = {}
            for group, items in members.items():
                body = sorted(json.dumps({k: v for k, v in r.items() if k != "group"}, sort_keys=True) for r in items)
                names[group] = "g-" + hashlib.sha256("\n".join(body).encode()).hexdigest()[:16]
                for i, first in enumerate(items):
                    for second in items[i + 1:]:
                        for p in _paths(first):
                            for q in _paths(second):
                                if _overlap(p, q):
                                    pairs.add((p, q))
            result, run = [], []
            for route in routes + [None]:
                group = names.get(route.get("group")) if route else None
                if run and (route is None or group != run[0].get("group")):
                    matched = [r for r in run if r.get("match")]
                    rest = [r for r in run if not r.get("match")]
                    result.extend(sorted(matched, key=lambda r: json.dumps(r, sort_keys=True)) + rest)
                    run = []
                if route is None:
                    break
                route = dict(route)
                if "group" in route:
                    route["group"] = names[route["group"]]
                    run.append(route)
                else:
                    result.append(route)
            out["routes"] = result
        return out

    return json.dumps(walk(config), sort_keys=True, indent=1), pairs


def strip_updates(config: dict) -> dict:
    """adapt の結果から /updates/ の経路を除く (新しい版にだけある)。"""
    def walk(node):
        if isinstance(node, list):
            return [walk(item) for item in node if not (isinstance(item, dict) and "/updates/" in json.dumps(item.get("match", "")))]
        if isinstance(node, dict):
            return {key: walk(value) for key, value in node.items()}
        return node
    return walk(config)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--base-rev", default="HEAD")
    parser.add_argument("--new-rev")
    # 試験用: git の代わりにファイルで渡す
    parser.add_argument("--base-file")
    parser.add_argument("--new-file")
    parser.add_argument("--live", default="caddy/Caddyfile")
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--out", required=True)
    parser.add_argument("--image", default="caddy:2.11.2")
    args = parser.parse_args()
    repo = Path(args.repo)
    live_path = repo / args.live
    out = Path(os.path.expanduser(args.out))
    if out.exists() and any(out.iterdir()):
        sys.exit(f"{out} is not empty")

    if not (args.new_rev or args.new_file):
        sys.exit("--new-rev is required")
    read = lambda path: Path(path).read_text(encoding="utf-8").replace("\r\n", "\n").split("\n")  # noqa: E731
    base = read(args.base_file) if args.base_file else git_show(repo, args.base_rev)
    new = read(args.new_file) if args.new_file else git_show(repo, args.new_rev)
    live = live_path.read_text(encoding="utf-8").replace("\r\n", "\n").split("\n")
    in_site, top, env_moves, problems = split(base, live)
    if problems:
        sys.exit("手で移す必要がある変更があります:\n  " + "\n  ".join(problems))

    (out / SITE_LOCAL).mkdir(parents=True, exist_ok=True)
    (out / "sites").mkdir(exist_ok=True)
    header = "# split-caddy-local.py がサーバーの手編集から切り出した。以後はこのファイルを編集する。\n"
    if in_site:
        (out / SITE_LOCAL / "50-server.caddy").write_text(header + "\n".join(in_site), encoding="utf-8")
    if top:
        (out / "sites" / "50-server.caddy").write_text(header + "\n".join(top), encoding="utf-8")

    env = env_file(repo / args.env_file) if (repo / args.env_file).exists() else {}
    new_env = {**env, **env_moves}
    with tempfile.TemporaryDirectory() as tmp:
        new_file = Path(tmp) / "Caddyfile"
        new_file.write_text("\n".join(new), encoding="utf-8")
        before = strip_updates(adapt(args.image, live_path.resolve(), None, env))
        after = strip_updates(adapt(args.image, new_file, out.resolve(), new_env))
    before_text, before_pairs = canonical_config(before)
    after_text, after_pairs = canonical_config(after)
    same = before_text == after_text and before_pairs == after_pairs

    print(f"freedomflight.jp の中: {len(in_site)} 行 -> {out / SITE_LOCAL / '50-server.caddy'}")
    print(f"最上位のサイトブロック: {len(top)} 行 -> {out / 'sites' / '50-server.caddy'}")
    for key, value in env_moves.items():
        print(f".env に足す (今は Caddyfile に直書き): {key}={value}")
    print("adapt の一致 (/updates/ を除く):", "一致" if same else "不一致")
    if not same:
        for name, text in (("before", before_text), ("after", after_text)):
            (out.parent / f"{out.name}-{name}.json").write_text(text, encoding="utf-8")
        if before_pairs != after_pairs:
            print("重なるパスの前後が変わった:", sorted(before_pairs ^ after_pairs))
        print(f"差は {out.name}-before.json / -after.json を比べる")
        sys.exit(1)


if __name__ == "__main__":
    main()
