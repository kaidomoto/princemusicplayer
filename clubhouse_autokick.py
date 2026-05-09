"""
Clubhouse 自动踢人脚本
════════════════════════════════════════════════════════

功能：
  - 自动监控指定 Clubhouse 房间，发现以下用户立刻踢出：
      1. 通过网页（web）进来的监听者（is_web_listener = True）
      2. 永久黑名单内的用户（按 user_id 识别，改名也会被踢）
      3. 用户名包含关键词黑名单词语的用户
  - 白名单内的用户永远不会被踢（即使名字触发关键词）
  - 台上发言者和主持人自动跳过，不会误踢

认证来源：
  - 自动读取 data/accounts.json（与 server.js 共用同一份账号配置）
  - 默认使用 accounts.json 中 "default" 指定的账号
  - 可通过 --account <id> 指定使用其他账号（如 main / prince / principito）

使用方法：
  python3 clubhouse_autokick.py <房间链接>
  python3 clubhouse_autokick.py <房间链接> --account prince

  示例：
  python3 clubhouse_autokick.py https://www.clubhouse.com/room/PvKYDB0e

  每次开新房间换链接即可，无需修改脚本。
  按 Ctrl+C 停止监控。

扫描策略（防封号）：
  - 平时每 150 秒扫描一次（低频，24小时运行安全）
  - 发现需踢目标后自动切换为每 15 秒扫描（快速踢出）
  - 踢完后继续以 15 秒扫描，连续 CLEAN_SCANS_TO_SLOWDOWN 次无目标后才切回 150 秒
    （防止对方换匿名浏览器重进，默认需连续 3 次干净才切回，约 45 秒）
  - 网络抖动/DNS 错误自动等待后重试；收到 401/403 立刻停止

自定义配置：
  修改脚本顶部的以下变量：
  - KEYWORD_BLOCKLIST：用户名关键词黑名单
  - BLACKLIST_IDS：永久黑名单（user_id，改名也会被踢）
  - WHITELIST_IDS：永远不踢的用户 ID 白名单
  - CLEAN_SCANS_TO_SLOWDOWN：踢完后需多少次干净扫描才切回慢速（默认 3）
  - KICK_ALL_WEB_LISTENERS：是否踢所有 web listener（默认开启）
════════════════════════════════════════════════════════
"""

import requests
import time
import json
import os
import random
from datetime import datetime

# ============================================================
# 配置区 - 只需修改这里
# ============================================================

# 房间的 channel 名（进房间后从 URL 或下方说明获取）
CHANNEL = "WXphVrezXQfrQNe3j:uBH1SOcC1gRzCFAhAiDbvABeDZ6ARUuhcif7uEEqugQ"

# 是否踢掉所有 web listener（True = 踢所有web进来的人）
KICK_ALL_WEB_LISTENERS = True

# 用户名关键词黑名单（包含这些词的用户名自动踢，不区分大小写）
KEYWORD_BLOCKLIST = [
    "狗逼", "死全家", "母狗", "prince", "Betty", "操逼", "傻逼"
]

# 白名单 user_id（永远不会被踢，即使名字含关键词）
WHITELIST_IDS = {
    1297026092,  # 来如春梦（自己）
    1624993321,  # Prince
    1017789603,  # Harley Quinn
    1602673216,  # elPricipito
}

# 永久黑名单 user_id（一进房间立刻踢，不管名字是什么）
BLACKLIST_IDS = {
    1077003302,  # 依娜 姚       @tinayao1029
    1016587739,  # Jung Ken      @jfkguu
    582740660,   # jasm x        @jasm.x
    1879049903,  # Frank Xiao    @frank.w.xiao
    367037,      # Barbara Diggs @bab-z
    702271930,   # 夏任 Jiang    @xrjiang
}

# 平时扫描间隔（秒）：150s，安全低频
SCAN_INTERVAL_NORMAL = 150
# 发现 web listener 后切换为快速模式（秒）：15s，快速踢人
SCAN_INTERVAL_FAST = 15
# 踢完后需连续多少次无目标才切回慢速（防止对方换身份重进）
CLEAN_SCANS_TO_SLOWDOWN = 3

# ============================================================
# 以下不需要修改
# ============================================================

ACCOUNTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "accounts.json")

API_URL = "https://www.clubhouseapi.com/api"


def load_credentials(account_id=None):
    """从 data/accounts.json 读取认证信息（与 server.js 共用）"""
    if not os.path.exists(ACCOUNTS_PATH):
        print(f"[!] 找不到 accounts.json: {ACCOUNTS_PATH}")
        print("    请确认脚本和 data/ 目录在同一个 prince-music 文件夹下")
        exit(1)

    with open(ACCOUNTS_PATH, "r") as f:
        data = json.load(f)

    accounts = data.get("accounts", {})
    default_id = account_id or data.get("default", "main")

    acct = accounts.get(default_id)
    if not acct:
        available = ", ".join(accounts.keys())
        print(f"[!] 找不到账号 '{default_id}'，可用账号: {available}")
        exit(1)

    user_id    = str(acct["userId"])
    token      = acct["token"]
    device_id  = acct["deviceId"]
    app_build  = acct.get("appBuild", "3375")
    user_agent = acct.get("userAgent", f"clubhouse/{app_build} (iPhone; iOS 17.1.2; Scale/3.00)")
    label      = acct.get("label", default_id)

    print(f"[✓] 已加载账号: {label} (ID: {user_id}，来自 accounts.json → '{default_id}')")
    return user_id, token, device_id, app_build, user_agent


def make_headers(user_id, token, device_id, app_build, user_agent):
    return {
        "CH-Languages":    "en-US",
        "CH-Locale":       "en_US",
        "Accept":          "application/json",
        "Accept-Language": "en-US;q=1",
        "Accept-Encoding": "gzip, deflate",
        "CH-AppBuild":     str(app_build),
        "CH-AppVersion":   "24.01.02",
        "User-Agent":      user_agent,
        "Connection":      "keep-alive",
        "Content-Type":    "application/json; charset=utf-8",
        "CH-UserID":       str(user_id),
        "CH-DeviceId":     device_id,
        "Authorization":   f"Token {token}",
    }


def get_channel_users(channel, headers):
    resp = requests.post(
        f"{API_URL}/get_channel",
        headers=headers,
        json={"channel": channel, "channel_id": None},
        timeout=10
    )
    return resp.json()


def block_from_channel(channel, target_uid, headers):
    resp = requests.post(
        f"{API_URL}/block_from_channel",
        headers=headers,
        json={"channel": channel, "user_id": int(target_uid)},
        timeout=10
    )
    return resp.json()


def is_web_listener(user: dict) -> bool:
    """检测是否为 web listener（官方字段 is_web_listener）"""
    return user.get("is_web_listener", False) is True


def has_blocked_keyword(name: str) -> str | None:
    """检查用户名是否含有黑名单关键词，返回匹配到的词"""
    name_lower = name.lower()
    for kw in KEYWORD_BLOCKLIST:
        if kw.lower() in name_lower:
            return kw
    return None


def get_channel_name_hint(headers):
    """列出当前正在进行的房间，帮助用户找 channel 名"""
    try:
        # get_channels 是 GET 请求
        resp = requests.get(
            f"{API_URL}/get_channels",
            headers=headers,
            timeout=10
        )
        print(f"[debug] HTTP {resp.status_code}")
        if not resp.text.strip():
            print("[!] 服务器返回空响应，尝试备用方式...")
            # 备用：POST with empty body
            resp = requests.post(
                f"{API_URL}/get_channels",
                headers=headers,
                json={},
                timeout=10
            )
            print(f"[debug] 备用 HTTP {resp.status_code}")

        if resp.status_code != 200:
            print(f"[!] 服务器返回错误: {resp.status_code}")
            print(f"    响应内容: {resp.text[:300]}")
            print("\n请改用 Clubdeck 分享按钮获取房间链接，从 URL 末尾取 channel 名")
            return

        data = resp.json()
        channels = data.get("channels", [])
        if not channels:
            print("[i] 当前没有找到公开房间（私密房间不会出现在这里）")
            print("    请用 Clubdeck 右上角分享按钮，链接末尾就是 channel 名")
            return
        print("\n[i] 当前公开房间列表（找你所在的房间）：")
        print(f"  {'channel名':<20} {'标题':<40} {'人数'}")
        print("  " + "-" * 70)
        for ch in channels[:20]:
            cname = ch.get("channel", "")
            topic = ch.get("topic", "（无标题）")[:38]
            count = ch.get("num_all", 0)
            print(f"  {cname:<20} {topic:<40} {count}")
        print()
    except Exception as e:
        print(f"[!] 获取房间列表失败: {e}")
        print("    请用 Clubdeck 右上角分享按钮，链接末尾就是 channel 名")


def run(channel, headers):
    kicked_ids = set()
    current_interval = SCAN_INTERVAL_NORMAL
    clean_scan_count = 0
    print(f"\n{'='*55}")
    print(f"  开始监控房间: {channel}")
    print(f"  平时间隔: {SCAN_INTERVAL_NORMAL}s | 发现目标: {SCAN_INTERVAL_FAST}s | 出错立刻停止")
    print(f"  踢 web listener: {KICK_ALL_WEB_LISTENERS}")
    print(f"  关键词黑名单: {KEYWORD_BLOCKLIST}")
    print(f"{'='*55}")
    print("  按 Ctrl+C 停止\n")

    while True:
        try:
            data = get_channel_users(channel, headers)

            if not data.get("success"):
                err = data.get("error_message", str(data))
                print(f"[!] 获取房间失败: {err}，立刻停止")
                return

            users = data.get("users", [])
            now   = datetime.now().strftime("%H:%M:%S")

            listeners = [u for u in users
                         if not u.get("is_speaker") and not u.get("is_moderator")]

            # 检测是否有需要踢的目标，动态调整间隔
            has_targets = any(
                u.get("user_id") in BLACKLIST_IDS or
                (is_web_listener(u) and KICK_ALL_WEB_LISTENERS) or
                has_blocked_keyword(u.get("name", ""))
                for u in listeners
                if u.get("user_id") not in WHITELIST_IDS and u.get("user_id") not in kicked_ids
            )
            if has_targets:
                current_interval = SCAN_INTERVAL_FAST
                clean_scan_count = 0
                mode = "⚡ 快速模式"
            elif current_interval == SCAN_INTERVAL_FAST:
                clean_scan_count += 1
                remaining = CLEAN_SCANS_TO_SLOWDOWN - clean_scan_count
                if clean_scan_count >= CLEAN_SCANS_TO_SLOWDOWN:
                    current_interval = SCAN_INTERVAL_NORMAL
                    clean_scan_count = 0
                    mode = "💤 省电模式（连续无目标，切回慢速）"
                else:
                    mode = f"⚡ 快速模式（无目标，再 {remaining} 轮后切慢速）"
            else:
                mode = "💤 省电模式"

            wait = current_interval + random.uniform(0, current_interval * 0.1)
            print(f"[{now}] {mode} 房间共 {len(users)} 人，听众 {len(listeners)} 人（下次 {wait:.0f}s 后）")

            for user in listeners:
                uid      = user.get("user_id")
                name     = user.get("name", "")
                platform = user.get("platform", "")
                client   = user.get("client_type", "")

                # 打印每个听众的详情
                web_tag = "🌐 WEB" if user.get("is_web_listener") else "📱 app"
                print(f"         [{web_tag}] {name} (ID:{uid})")

                if uid in WHITELIST_IDS:
                    print(f"                → 白名单保护，跳过")
                    continue
                if uid in kicked_ids:
                    print(f"                → 已踢过，跳过")
                    continue

                reason = None

                if uid in BLACKLIST_IDS:
                    reason = "永久黑名单"
                elif KICK_ALL_WEB_LISTENERS and is_web_listener(user):
                    reason = "web listener"
                else:
                    kw = has_blocked_keyword(name)
                    if kw:
                        reason = f"用户名含关键词「{kw}」"

                if reason:
                    print(f"         ★ 触发踢人: {name} → {reason}")
                    result = block_from_channel(channel, uid, headers)
                    if result.get("success"):
                        kicked_ids.add(uid)
                        print(f"         ✓ 踢出成功")
                    else:
                        err = result.get("error_message", str(result))
                        print(f"         ✗ 踢出失败: {err}")

            time.sleep(wait)

        except KeyboardInterrupt:
            print("\n[*] 已停止监控")
            break
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code if e.response else 0
            if status in (401, 403):
                print(f"[!] 收到 {status} 认证错误，立刻停止（防封号）")
                return
            print(f"[!] HTTP 错误 {status}，{SCAN_INTERVAL_NORMAL}s 后重试")
            time.sleep(SCAN_INTERVAL_NORMAL + random.uniform(0, 30))
        except requests.exceptions.RequestException as e:
            # DNS 解析失败、连接超时等网络抖动，等待后重试
            print(f"[!] 网络错误（可能是网络抖动），{SCAN_INTERVAL_NORMAL}s 后重试: {e}")
            time.sleep(SCAN_INTERVAL_NORMAL + random.uniform(0, 30))
        except Exception as e:
            print(f"[!] 未知错误，立刻停止: {e}")
            return


if __name__ == "__main__":
    import sys, re, argparse

    parser = argparse.ArgumentParser(description="Clubhouse 自动踢人脚本")
    parser.add_argument("channel", nargs="?", default=None,
                        help="房间链接或 channel 名，例如：https://www.clubhouse.com/room/PvKYDB0e")
    parser.add_argument("--account", default=None,
                        help="指定使用 accounts.json 中的账号 ID（默认使用 default 账号）")
    args = parser.parse_args()

    user_id, token, device_id, app_build, user_agent = load_credentials(args.account)
    headers = make_headers(user_id, token, device_id, app_build, user_agent)

    # 解析 channel：支持完整链接或直接输入 channel 名
    channel = CHANNEL
    if args.channel:
        arg = args.channel
        m = re.search(r'/room/([a-zA-Z0-9]+)', arg)
        if m:
            channel = m.group(1)
            print(f"[✓] 从链接提取 channel: {channel}")
        else:
            channel = arg.strip("/").split("/")[-1].split("?")[0]
            print(f"[✓] 使用 channel: {channel}")

    if not channel:
        print("\n[!] 用法：python3 clubhouse_autokick.py <房间链接或channel名>")
        print("    例如：python3 clubhouse_autokick.py https://www.clubhouse.com/room/PvKYDB0e")
        print("          python3 clubhouse_autokick.py <链接> --account prince")
        sys.exit(1)

    run(channel, headers)
