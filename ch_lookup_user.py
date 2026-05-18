#!/usr/bin/env python3
"""
Clubhouse profile lookup by numeric user_id OR by @username (resolves user_id).

Uses the same API base + headers style as princeplayer/server.js (clubhousePost).

Why a token?
  The Clubhouse unofficial API expects Authorization: Token … plus CH-UserID / CH-DeviceId.
  Your bot already uses this (PM2 env or data/accounts.json).

Optional — load credentials from accounts.json (recommended so CH-UserID matches the token):
  python3 ch_lookup_user.py --account main --user-id 1708433891
  python3 ch_lookup_user.py --account main --verify-auth

Still use env for CH_API_PROXY / CH_PROXY_SECRET if needed.

Examples:
  python3 ch_lookup_user.py --account main --user-id 1708433891
  python3 ch_lookup_user.py --account prince --username somehandle
  export CH_AUTH_TOKEN='…' && python3 ch_lookup_user.py --user-id 123
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def getenv(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v


def default_accounts_path() -> Path:
    return Path(__file__).resolve().parent / "data" / "accounts.json"


def apply_account(account_id: str, accounts_file: Path) -> None:
    """Set CH_* env vars from accounts.json so token + CH-UserID + device stay in sync."""
    if not accounts_file.is_file():
        print(f"Accounts file not found: {accounts_file}", file=sys.stderr)
        sys.exit(2)
    try:
        raw = json.loads(accounts_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"Cannot read accounts file: {e}", file=sys.stderr)
        sys.exit(2)
    acct = (raw.get("accounts") or {}).get(account_id)
    if not isinstance(acct, dict):
        print(f"No account id {account_id!r} under 'accounts' in {accounts_file}", file=sys.stderr)
        sys.exit(2)
    tok = acct.get("token") or acct.get("auth_token")
    if tok:
        os.environ["CH_AUTH_TOKEN"] = str(tok)
    uid = acct.get("userId")
    if uid is not None:
        os.environ["CH_BOT_USER_ID"] = str(uid)
    did = acct.get("deviceId")
    if did:
        os.environ["CH_DEVICE_ID"] = str(did)
    ua = acct.get("userAgent")
    if ua:
        os.environ["CH_UA"] = str(ua)
    ab = acct.get("appBuild")
    if ab is not None:
        os.environ["CH_APP_BUILD"] = str(ab)
    av = acct.get("appVersion")
    if av is not None:
        os.environ["CH_APP_VERSION"] = str(av)


def post_json(url: str, body: dict[str, Any], headers: dict[str, str]) -> tuple[int, Any]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            code = resp.getcode() or 200
            try:
                return code, json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                return code, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(raw) if raw else {"error": str(e)}
        except json.JSONDecodeError:
            return e.code, raw


def build_headers() -> dict[str, str]:
    token = getenv("CH_AUTH_TOKEN")
    if not token:
        print(
            "Missing CH_AUTH_TOKEN. Use --account main (reads data/accounts.json) or export CH_AUTH_TOKEN.",
            file=sys.stderr,
        )
        sys.exit(2)

    user_id = getenv("CH_BOT_USER_ID", getenv("CH_USER_ID", "1602673216"))
    device_id = getenv("CH_DEVICE_ID", "0AEAF080-27F9-45DB-B999-2C492F803CAF")
    ua = getenv("CH_UA", "clubhouse/3375 (iPhone; iOS 17.1.2; Scale/3.00)")
    app_build = getenv("CH_APP_BUILD", "3375")
    app_version = getenv("CH_APP_VERSION", "26.03.01")

    h: dict[str, str] = {
        "Content-Type": "application/json; charset=utf-8",
        "CH-AppBuild": app_build,
        "CH-AppVersion": app_version,
        "User-Agent": ua,
        "CH-DeviceId": device_id,
        "Authorization": f"Token {token}",
        "CH-UserID": str(user_id),
    }
    secret = getenv("CH_PROXY_SECRET")
    if secret:
        h["X-Proxy-Secret"] = secret
    return h


def print_profile_error_hint(payload: dict[str, Any]) -> None:
    msg = (payload.get("error_message") or payload.get("message") or "").lower()
    if "anonymous" in msg:
        print(
            "\n说明 / Note:\n"
            "  Clubhouse 对该 user_id 返回「unable to view anonymous profile」通常表示：\n"
            "  对方在系统里被当作「匿名用户」（例如部分 Web 听众等），服务器故意不提供 get_profile 资料。\n"
            "  这不是脚本或 token「坏了」；换一个有正常主页的用户 ID 用本脚本可以验证。\n"
            "  若此人当时在房里，请用 get_channel 返回的 users 列表或服务器上的 data/room_users_history.json 看当时展示名。\n",
            file=sys.stderr,
        )


def main() -> None:
    p = argparse.ArgumentParser(description="Clubhouse: lookup profile by user_id or username.")
    p.add_argument(
        "--account",
        metavar="ID",
        help="Load token, userId, deviceId from data/accounts.json (same keys as server multi-account)",
    )
    p.add_argument(
        "--accounts-file",
        type=Path,
        default=None,
        help=f"Path to accounts.json (default: {default_accounts_path()})",
    )
    p.add_argument(
        "--verify-auth",
        action="store_true",
        help="Call POST /me to verify token + CH-UserID + deviceId work, then exit",
    )
    g = p.add_mutually_exclusive_group(required=False)
    g.add_argument("--user-id", type=str, metavar="ID", help="Numeric Clubhouse user_id")
    g.add_argument("--username", type=str, metavar="HANDLE", help="Username without @")
    p.add_argument(
        "--raw",
        action="store_true",
        help="Print full JSON response instead of a short summary",
    )
    args = p.parse_args()

    acc_path = args.accounts_file or default_accounts_path()
    if args.account:
        apply_account(args.account, acc_path)

    api_root = (getenv("CH_API_PROXY", "https://www.clubhouseapi.com/api") or "").rstrip("/")
    headers = build_headers()

    if args.verify_auth:
        code, payload = post_json(
            f"{api_root}/me",
            {
                "return_blocked_ids": False,
                "timezone_identifier": "Asia/Tokyo",
                "return_following_ids": False,
            },
            headers,
        )
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        sys.exit(0 if code == 200 else 1)

    if not args.user_id and not args.username:
        p.error("one of --user-id, --username, or --verify-auth is required")

    url = f"{api_root}/get_profile"

    if args.user_id:
        try:
            uid = int(str(args.user_id).strip())
        except ValueError:
            print("--user-id must be an integer", file=sys.stderr)
            sys.exit(2)
        body: dict[str, Any] = {
            "query_id": None,
            "query_result_position": 0,
            "user_id": uid,
            "username": None,
        }
    else:
        uname = (args.username or "").strip().lstrip("@")
        if not uname:
            print("--username must be non-empty", file=sys.stderr)
            sys.exit(2)
        body = {
            "query_id": None,
            "query_result_position": 0,
            "user_id": None,
            "username": uname,
        }

    code, payload = post_json(url, body, headers)

    if args.raw:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        if isinstance(payload, dict) and payload.get("success") is False:
            print_profile_error_hint(payload)
        if code != 200:
            sys.exit(1)
        return

    if isinstance(payload, str):
        print(f"HTTP {code}\n{payload}")
        sys.exit(1 if code != 200 else 0)

    prof = payload.get("user_profile") if isinstance(payload, dict) else None
    if not isinstance(prof, dict):
        print(f"HTTP {code}\nUnexpected response (no user_profile):\n{json.dumps(payload, indent=2, ensure_ascii=False)}")
        if isinstance(payload, dict):
            print_profile_error_hint(payload)
        sys.exit(1 if code != 200 else 0)

    uid_out = prof.get("user_id")
    name = prof.get("name") or ""
    username = prof.get("username") or ""
    print("--- Clubhouse profile ---")
    print(f"user_id:   {uid_out}")
    print(f"name:      {name}")
    print(f"username:  {username}")
    if prof.get("bio"):
        print(f"bio:       {(prof.get('bio') or '')[:200]}{'…' if len(str(prof.get('bio') or '')) > 200 else ''}")
    if prof.get("photo_url"):
        print(f"photo_url: {prof.get('photo_url')}")

    if code != 200:
        sys.exit(1)


if __name__ == "__main__":
    main()
