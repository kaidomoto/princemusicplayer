# Prince Music — AI Agent 操作手册

> **读此文件的 AI：你正在接管一个正在生产运行的音乐机器人。任何代码修改都可能导致 Clubhouse 房间中断。请仔细阅读本文档，尤其是"禁止做的事"部分。**

## 1. 项目概述

Prince Music 是一个将音乐播放到 Clubhouse 房间的服务端应用。
- **不是**浏览器播放音乐 — 音频由服务器上的 `ffplay` 播放
- **不是**简单的 web app — 涉及 PulseAudio 音频路由、Wine/Electron Bridge、Agora RTC SDK

### 音频流水线
```
用户 Remote 页面 (浏览器)
    │ Socket.IO: play/pause/next/seek/volume
    ▼
Node.js Server (server.js + socket.js)
    │ → session-manager.js 启动 ffplay
    ▼
ffplay → PulseAudio null-sink → Agora Bridge (Wine/Electron) → Clubhouse 房间
         (session_xxx)          port 8767-8769                   (Agora RTC)
         SIGSTOP=暂停
         SIGCONT=恢复
```

## 2. 核心文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `server.js` | ~3300 | 主入口：Express API、Clubhouse API、Bridge 控制、Keepalive、BridgeWatchdog |
| `session-manager.js` | ~760 | Session 管理：PulseAudio sink、ffplay 播放、进度追踪 |
| `socket.js` | ~430 | Socket.IO 事件：播放控制、状态同步、Voice Slots |
| `db.js` | - | JSON 文件数据库 |
| `client/src/views/Remote.jsx` | - | 播放器遥控页面 |
| `client/src/views/Broadcast.jsx` | - | 管理员广播控制面板 |
| `client/src/views/Player.jsx` | - | 歌曲/播放列表管理 |

## 3. 关键基础设施

```
VPS: 2.56.116.63 (Ubuntu 24.04, DesiVPS)
SSH: root (密钥认证, 端口 22)
域名: clubhouses.party (Cloudflare DNS, Full Strict SSL)
Node: v20.20.2
端口: 3096 (Express/Socket.IO)
反代: Nginx → 127.0.0.1:3096
进程: PM2 (prince-music)
音频用户: studio (运行 PulseAudio/Wine/ffplay)
```

## 4. 数据结构

### songs.json
```json
{ "id": "1770544501642", "title": "歌名", "url": "/storage/1770544501642.mp3", "playlistId": "1770544501640", "hidden": false }
```

### playlists.json
```json
{ "id": "1770544501640", "name": "播放列表名", "hidden": false }
```

### accounts.json
```json
{
  "main": { ... },     // elPricipito 账号 (主 bot)
  "prince": { ... },   // Prince 账号
  "principito": { ... }
}
```
每个账号包含 `auth_token`, `cookie`, `userId`, `label` 等字段。Token 会过期，需要定期更新。

## 5. Socket.IO 事件协议

### 客户端 → 服务器
| 事件 | 数据 | 说明 |
|------|------|------|
| `player_action` | `{ type, payload }` | type: load/pause/resume/volume/seek/loop/next/prev/gain |
| `get_data` | - | 请求播放列表和歌曲数据 |
| `time_update` | number | 客户端时间同步（已被服务端忽略） |
| `set_sleep_lock` | - | 激活睡眠锁 |
| `sleep_unlock` | password | 解锁睡眠锁 |

### 服务器 → 客户端
| 事件 | 数据 | 说明 |
|------|------|------|
| `state_update` | `{ playing, currentTrack, volume, currentTime, duration, loopMode, gain }` | 播放状态 |
| `data_update` | `{ playlists, songs }` | 数据刷新 |
| `sleep_lock_update` | boolean | 睡眠锁状态 |
| `session_info` | `{ sessionId, channel }` | 当前 session 信息 |
| `slots_update` | array | Voice Slots 状态 |

## 6. Clubhouse API 调用

### 安全的 API（可以调用）
- `active_ping` — 保持房间连接（30-35s 间隔）
- `get_channel` — 获取房间信息（120-150s 间隔）
- `update_channel_user_status` — 开/闭麦
- `invite_speaker` — 邀请用户上台（需去重）
- `add_channel_link` — 设置置顶链接

### ⚠️ 危险的 API（谨慎使用）
- `join_channel` — 加入房间。**会重置 speaker 状态（闭麦）**。仅在首次加入或手动 Reconnect 时使用。**绝不能**在自动逻辑（watchdog/定时器）中调用。
- `become_speaker` — 申请上台。仅在首次加入、接受邀请、手动 Reconnect 时使用。

## 7. ⛔ 禁止做的事

### 7.1 绝不能在自动逻辑中调用 join_channel
```
❌ setInterval 中调用 join_channel
❌ BridgeWatchdog 中调用 join_channel
❌ 任何自动恢复/重连中调用 join_channel
✅ 只有用户手动点击按钮时才能调用 join_channel
```
**原因**：join_channel 会让 Clubhouse 把 bot 重置为 listener（闭麦），反复调用可能触发风控封号。

### 7.2 Bridge 的 "fire-and-forget" 模式
```
Bridge 通过 WebSocket 接收命令。
发送顺序必须是：leave → (300ms) → join → (2000-5000ms) → unmute → close WS
WS 关闭后 Bridge 仍保持 Agora 连接。
❌ 不要保持 WS 长连接
❌ 不要频繁发送 join
```

### 7.3 PulseAudio 命令必须用 studio 用户
```bash
# ❌ 错误
pactl list short sinks

# ✅ 正确
sudo -u studio env XDG_RUNTIME_DIR=/tmp/runtime-studio \
  PULSE_SERVER=unix:/tmp/runtime-studio/pulse/native pactl list short sinks
```

### 7.4 不要在 PM2 restart 时同时操作 bridge
已实现互斥锁 `_bridgeOpInProgress`（模块级 var）。如果你添加新的 bridge 操作代码，必须检查这个锁。

### 7.5 ffplay 控制方式
```
暂停: kill -SIGSTOP <pid>
恢复: kill -SIGCONT <pid>
停止: kill -SIGTERM <pid>
Seek: 杀掉旧 ffplay + 用 -ss 参数启动新的
❌ 不要用 stdin 命令控制 ffplay
```

### 7.6 初始音量
Session 创建时 PulseAudio 音量默认为 0%。这是故意的，用户通过 Remote 页面手动调高。不要改回 100%。

### 7.7 npm run build 会覆盖 project.html
`client/dist/` 是 Vite 的构建输出目录，`npm run build` 会清空并重建。
project.html 的源文件备份在 `/root/prince-music/project.html`。
**每次 build 后必须执行**：
```bash
bash /root/prince-music/client/build-post.sh
```
或手动：`cp /root/prince-music/project.html /root/prince-music/client/dist/project.html`

## 8. 常用运维命令

```bash
# 重启服务
pm2 restart prince-music --update-env

# 查看日志
pm2 logs prince-music --lines 50

# 重建前端
cd /root/prince-music/client && npm run build

# 检查 Bridge 状态
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8767/   # 426 = OK

# 检查 PulseAudio sinks
sudo -u studio env XDG_RUNTIME_DIR=/tmp/runtime-studio \
  PULSE_SERVER=unix:/tmp/runtime-studio/pulse/native pactl list short sinks

# SSL 续期
certbot renew
```

## 9. 已知的 Bug 和修复历史

### 9.1 BridgeWatchdog join_channel (已修复)
- Watchdog 在 bridge 重启后调用 join_channel → bot 闭麦
- 修复：改为使用存储的 token，跳过 join_channel

### 9.2 变量作用域竞争 (已修复)
- `_bridgeOpInProgress` 在 Reconnect 和 Watchdog 中是不同作用域的同名变量
- 修复：提升为模块级 `var` 声明

### 9.3 headless Chrome 被移除
- 旧架构用 headless Chrome 播放音频，已完全替换为 ffplay
- `session-manager.js.bak_chrome` 是旧版本备份，不要恢复

## 10. 文件系统关键路径

```
/root/prince-music/                    # 项目根目录
├── server.js                          # 主服务
├── session-manager.js                 # 播放引擎
├── socket.js                          # Socket.IO 事件
├── db.js                              # JSON 数据库
├── data/
│   ├── songs.json                     # 歌曲元数据
│   ├── playlists.json                 # 播放列表
│   ├── accounts.json                  # Clubhouse 账号 (敏感)
│   ├── speaker_whitelist.json         # 白名单用户
│   ├── active_keepalive.json          # Keepalive 状态
│   └── party.json                     # Party 模式队列
├── .auth/                             # 密码哈希
├── storage/                           # 775个 MP3 文件 (13GB)
├── cookies.txt                        # yt-dlp YouTube cookie
├── secure-downloads/                  # SSH密钥/账号包 (非公开)
├── client/
│   ├── src/views/                     # React 前端
│   └── dist/                          # 构建产物 (Nginx serve)
└── AI_README.md                       # 本文件

/home/studio/
├── agora-bridge-8767/                 # Bridge 实例 1
├── agora-bridge-8768/                 # Bridge 实例 2
├── agora-bridge-8769/                 # Bridge 实例 3
├── start-bridge.sh                    # Bridge 启动脚本
├── play-audio.sh                      # ffplay 包装脚本
└── .config/pulse/default.pa           # PulseAudio 配置

/etc/nginx/sites-available/prince-music  # Nginx 配置
```

## 11. 修改代码的安全流程

1. **修改前**：`pm2 logs prince-music --lines 20` 确认当前状态正常
2. **修改代码**：编辑 server.js / session-manager.js / socket.js
3. **语法检查**：`node -c server.js` (必须通过)
4. **如果改了前端**：`cd client && npm run build`
5. **重启**：`pm2 restart prince-music --update-env`（只重启一次！）
6. **验证**：等待 2 分钟，检查日志确认 keepalive 恢复、bot speaker=true
7. **不要频繁重启**：每次重启都会产生一轮 API 调用

## 12. Nginx 关键配置

```
/ → /root/prince-music/client/dist/ (静态文件)
/api/ → proxy_pass http://127.0.0.1:3096
/socket.io/ → proxy_pass (WebSocket upgrade)
/agora-ws-{port}/ → http://127.0.0.1:{port} (Bridge WS)
/storage/ → 带 Referer 保护的静态 MP3
```
