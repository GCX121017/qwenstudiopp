# Qwen Studio++

> 源码仓库：[GCX121017/qwenstudiopp](https://github.com/GCX121017/qwenstudiopp) ｜ 问题反馈：[Issues](https://github.com/GCX121017/qwenstudiopp/issues)

把 **Qwen Studio（chat.qwen.ai）** 变成一个跑在你自己电脑上的 **OpenAI 兼容 API 服务**。
输入 `qspp` 回车即可启动，配套本地管理网页，填入 Token、生成密钥，就能在 **Cherry Studio、zcode** 等任何支持 OpenAI 协议的工具里调用 Qwen 全系模型（纯对话补全包装，不含联网搜索）。

```
 ██████╗ ██╗  ██╗██╗    ██╗███████╗███╗   ██╗
 ██╔═══██╗██║ ██╔╝██║    ██║██╔════╝████╗  ██║
 ██║   ██║█████╔╝ ██║ █╗ ██║█████╗  ██╔██╗ ██║
 ██║▄▄ ██║██╔═██╗ ██║███╗██║██╔══╝  ██║╚██╗██║
 ╚██████╔╝██║  ██╗╚███╔███╔╝███████╗██║ ╚████║
  ╚══▀▀═╝ ╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝╚═╝  ╚═══╝
```

## 功能特性

| 特性 | 说明 |
|------|------|
| **OpenAI 完整兼容** | `/v1/chat/completions`（流式 + 非流式）、`/v1/models`，标准 Bearer 鉴权 |
| **本地管理网页** | 浏览器打开 `http://127.0.0.1:8818`，图形化配置一切 |
| **Token 管理** | 管理页粘贴 Qwen Token，保存前自动验证连通性；支持 JWT 或整段 Cookie |
| **本地密钥** | 自动生成 `sk-qpp-...` 密钥，一键复制 / 重新生成，外部工具只认这个密钥 |
| **思考摘要** | 思考过程通过 `reasoning_content` 字段透传（Cherry Studio 自动折叠展示），可在请求中开关 |
| **多轮对话** | 自动把 messages 历史拼接为上下文，无状态设计，无需维护会话 |
| **依赖自检** | 启动时自动检查 Node 版本 / 依赖 / 配置目录 / 端口，缺失依赖自动安装 |
| **防风控** | 全局请求节流（默认 3.2s），显著降低触发 Qwen 滑块验证的概率 |
| **零运行时依赖** | 核心只用 Node 内置模块，下载即用，离线可运行 |

---

## 安装

前置条件：已安装 [Node.js](https://nodejs.org) **18 或更高**（LTS 即可）。

### 方式一：npm 安装（推荐）

```bash
npm install -g qwen-studio-pp
```

装完在任意终端输入 `qspp` 回车即可启动。以后升级：`npm install -g qwen-studio-pp@latest`；卸载：`npm uninstall -g qwen-studio-pp`。

### 方式二：离线 zip 安装（Windows 脚本）

**Windows：**
1. 解压 `qwen-studio-pp` 文件夹到任意目录（**不要在压缩软件预览窗口里直接双击运行**）
2. 双击 `install.cmd`（或右键 `install.ps1` → 使用 PowerShell 运行）
3. 看到 `Install complete!` 后，**重新打开一个终端**

**Windows 手动安装（保底方式，脚本有任何问题时用它）：**
```bat
cd /d "C:\你的解压路径\qwen-studio-pp"
npm install -g .
qspp --version
```
显示 `qwen-studio-pp v1.1.9` 即安装成功，效果与脚本完全一致。

> 说明：安装/启动/卸载脚本的提示信息为英文，这是刻意的 —— Windows CMD 对含中文的批处理文件存在编码解析 bug（会把中文提示误当成命令执行），纯 ASCII 脚本在所有语言区域下都稳定。命令用法见下方表格，含义一目了然。

**macOS / Linux：**
```bash
cd qwen-studio-pp
npm install -g .
```

### 方式三：免安装直接运行

不想装全局命令？解压后直接双击 `start.cmd`（Windows），或：

```bash
node bin/cli.js
```

### 卸载

双击 `uninstall.cmd`，或 `npm uninstall -g qwen-studio-pp`。
本地配置与 Token 保留在 `~/.qwen-studio-pp/`（Windows 为 `%USERPROFILE%\.qwen-studio-pp`），可手动删除。

---

## 使用

### 1. 启动

任意终端（PowerShell / CMD）输入：

```
qspp
```

回车后：
- 自动进行环境自检（Node 版本 → 依赖 → 配置目录 → 端口占用自动换位 → Token 状态）
- 启动本地服务（默认 `http://127.0.0.1:8818`）
- 自动打开浏览器进入管理页

常用参数：

```
qspp --port 9000        # 指定端口
qspp --lan              # 允许局域网设备调用（绑定 0.0.0.0）
qspp --no-open          # 不自动打开浏览器
qspp doctor             # 仅环境自检
qspp key                # 重新生成 API 密钥
qspp token <token>      # 命令行直接保存 Token
```

### 2. 配置 Qwen Token（管理页第 1 步）

打开管理页 → 卡片 1 → 粘贴 Token → **测试并保存**。

获取 Token（两种方式任选）：

- **方式 A · JWT（推荐）**：浏览器登录 [chat.qwen.ai](https://chat.qwen.ai) → F12 → Console 输入 `localStorage.token` → 复制 `eyJ` 开头的字符串
- **方式 B · 整段 Cookie**：F12 → Network → 点任意请求 → 复制 `cookie:` 请求头的完整值

Token 是账号凭证，仅保存在本机 `~/.qwen-studio-pp/config.json`，不会上传到任何第三方。

### 3. 生成/查看本地密钥（管理页第 2 步）

首次启动自动生成 `sk-qpp-...` 密钥。这是外部工具调用你的本地服务时用的密钥，可随时重新生成（旧密钥立即失效）。

### 4. 在线测试（管理页第 3 步）

输入消息直接试，走完整链路：流式输出、思考摘要、耗时与 token 统计一目了然。

### 5. 接入外部工具（管理页第 4 步）

管理页内含按你的实际地址和密钥自动填好的配置示例（Cherry Studio / zcode / curl / Python / Node.js）。

**Cherry Studio**：设置 → 模型服务 → 添加「OpenAI 兼容」→
- API 地址：`http://127.0.0.1:8818/v1`
- API 密钥：管理页里的 `sk-qpp-...`
- 模型：点「获取模型」自动拉取（qwen3.8-max / qwen3.7-max / qwen3.7-plus 等）

**zcode / 各类 CLI Agent**：

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8818/v1
export OPENAI_API_KEY=sk-qpp-xxxx
export OPENAI_MODEL=qwen3.8-max
```

**curl 快速验证**：

```bash
curl http://127.0.0.1:8818/v1/chat/completions \
  -H "Authorization: Bearer sk-qpp-xxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.8-max","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

---

## API 说明

### `POST /v1/chat/completions`

完全兼容 OpenAI Chat Completions 协议，额外扩展两个可选字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `stream` | boolean | `true` 返回 SSE 增量；`false` 返回完整 JSON |
| `thinking` | boolean | 是否输出思考摘要（透传到 `reasoning_content`），默认开启 |

- 流式 chunk 格式：`role` → `reasoning_content`（思考）→ `content`（正文）→ `finish_reason:"stop"` + `usage` → `[DONE]`
- 非流式响应：思考文本在 `choices[0].message.reasoning_content`

### `GET /v1/models`

返回你 Qwen 账号可用的真实模型列表（qwen3.8-max、qwen3.7-max、qwen3.7-plus、qwen3.6-plus、qwen3.5-plus、qwen3.5-omni-plus 等）。

### 错误格式

```json
{ "error": { "message": "Token 无效或已过期...", "type": "authentication_error", "code": "AUTH_FAILED" } }
```

常见 code：`NO_TOKEN`（未配 Token）/ `AUTH_FAILED`（Token 失效，重新获取）/ `NETWORK`（无法连上 Qwen）/ `UPSTREAM_5xx`（Qwen 侧错误）。

---

## 架构与工作原理

```
Cherry Studio / zcode / curl
        │  OpenAI 协议 (http://127.0.0.1:8818/v1)
        ▼
┌─ Qwen Studio++ (本地 Node 服务, 零依赖) ─┐
│  密钥鉴权 → 请求转换 → 全局节流            │
│  Qwen 逆向客户端:                          │
│   · Bearer/Cookie 双认证                   │
│   · 每次请求自动新建会话 (chats/new)       │
│   · 多轮历史拼接 (flat)                    │
│   · SSE 解析: 思考快照去重 / 正文增量      │
│   · 25s 响应头超时 (防静默挂起)            │
└──────────────────┬────────────────────────┘
                   │ HTTPS (仅访问 chat.qwen.ai)
                   ▼
            chat.qwen.ai 网页端接口
```

- **无状态设计**：每个 API 请求独立建会话，多轮上下文由 OpenAI messages 历史拼接保证，崩溃/重启零残留
- **思考摘要去重**：Qwen 的思考流是快照式重复推送，解析器自动识别覆盖/追加，客户端拿到的永远是增量
- **静默挂起防护**：Qwen 对不完整请求头会"永不响应"，服务端内置完整请求头 + 25 秒响应头超时

## 配置文件

`~/.qwen-studio-pp/config.json`：

```json
{
  "port": 8818,
  "host": "127.0.0.1",
  "apiKey": "sk-qpp-...",
  "qwenToken": "eyJ...",
  "defaultModel": "qwen3.8-max",
  "thinking": true,
  "throttleMs": 3200,
  "autoOpen": true
}
```

## 常见问题

**Q: 双击 install.cmd 一闪而过 / 提示很短就退出？**
1.1.3 之前的版本存在批处理括号解析陷阱，1.1.3 已重写为无括号结构。若仍异常：①不要在压缩软件预览窗口里直接双击，先解压到磁盘；②改用上方“手动安装保底方式”（三条命令）；③PowerShell 版报错一闪而过时，改在终端里执行 `powershell -ExecutionPolicy Bypass -File install.ps1` 就能看到完整错误。

**Q: 安装成功但报错像是旧版本的（比如 ByteString/乱码）？**
磁盘上的新版本 ≠ 正在运行的服务。升级后必须：关闭所有旧服务窗口（或任务管理器结束 node.exe）→ 重新运行 `qspp` → 浏览器 Ctrl+F5 强刷管理页，页眉徽章显示的版本才是实际在跑的版本。

**Q: 保存 token 时报 "Cannot convert argument to a ByteString ... index 35 ... 20013"？**
这是 **v1.1.3 及之前版本的已知 bug，v1.1.4 已修复**，与 token 内容无关。根因：报错中的 `20013` 是汉字"中"的编码，它来自工具发给 Qwen 的 `Timezone` 请求头——中文版 Windows 上 Node 会把时区名输出成 `(中国标准时间)`（恰好"中"字位于第 35 个字符，与报错逐位吻合），而 HTTP 头只允许拉丁字符。你的 token 是纯 ASCII 就不会有问题，英文系统也从不复现，所以此前排查走了弯路。v1.1.4 起时区头强制用英文时区名，且所有请求头发送前都在本地逐一校验——这个原始报错在物理上已不可能再出现；若你仍看到它，说明正在运行的还是旧版本，请按上一条核对版本。

**Q: 保存 token 或对话时报 "无法连接 chat.qwen.ai: fetch failed"？**
这是**网络连接问题，与 token 无关**。v1.1.5 起报错会附带方括号内的真实原因和中文对策，管理页 Token 配置区还新增了「网络诊断」按钮（保存失败时也会自动运行），逐层检测 DNS → TCP → TLS → HTTPS 并给出针对性建议。常见对照：`[ENOTFOUND]` DNS 解析失败（换 DNS 如 223.5.5.5 / 手机热点对照）；`[ECONNREFUSED]` 连接被拒（本机代理软件已关但系统代理仍指向它）；`[ETIMEDOUT]` 超时（Windows 防火墙拦截 node.exe 出站——首次启动弹窗点了"取消"就会被拦，需在防火墙设置中放行）；`[ECONNRESET]` 连接被重置（代理/安全软件拦截）。自查三步：①浏览器能否打开 chat.qwen.ai；②Windows 防火墙放行 node.exe；③关闭代理软件后重试。

**Q: 对话显示"发生错误"、错误详情是 "[object Object]"，或思考结束后突然中断？**
这是 **v1.1.6 及之前版本的已知 bug，v1.1.7 已修复**，共三个根因：①长回答超过 90 秒会被本地超时信号硬切（用户实测"思考流到 1 分 33 秒报错"，与 90 秒超时+开销分秒不差）——超时保护本意只管"响应头 30 秒内到达"，旧实现却连正文流一起割断；②上游在流中返回的错误帧（风控/服务端异常）被静默丢弃，看起来像"莫名中断/空回复"；③错误详情对象被拼成 `[object Object]`，真实原因全部丢失。v1.1.7 起超时只管响应头阶段，流中错误帧会把上游真实错误原样透传并附风控对策提示；v1.1.8 起 OpenAI 错误帧的 code/message/status 由本地强制归一化，客户端不可能再拼出 `null: [object Object]` 之类的失真报错。若错误提示提到"风控"：连续长回答容易触发 Qwen 风控软标记（表现：首条正常→后续被掐→新对话立即失败），在浏览器打开 chat.qwen.ai 完成滑块验证或冷却几分钟即可恢复；也可在管理页把"请求最小间隔"调大。

**Q: 长回答跑到 10 分钟被截断？**
这是 v1.1.7 的固定"10 分钟流式上限"保险丝，**v1.1.8 起默认放宽到 30 分钟**，且部分正文不再静默丢失——会在回复尾部追加可见的截断标记。如果你的模型经常输出超长内容，可设环境变量后重启服务继续放宽：`QPP_MAX_STREAM_MINUTES`（分钟数，默认 30，最大 480）；另有 `QPP_IDLE_TIMEOUT_MINUTES`（流中途无数据的停滞判定，默认 3 分钟，一般无需调整）。Windows 下设置方法：`set QPP_MAX_STREAM_MINUTES=60` 后在同一终端窗口运行 `qspp`（或写入系统环境变量）。注意 30 分钟内仍被中断且错误提示"风控/停滞"的，属于上游问题而非本地截断，参照上一条 FAQ 处理。

**Q: 一直转圈然后 502？**
Token 失效最常见（网页端退出登录/长期未用都会失效）。回管理页重新获取粘贴即可。服务启动后管理页顶部徽章会显示 Qwen 连接状态。

**Q: 报 401 Invalid API key？**
外部工具里填的密钥和管理页里的不一致。复制管理页卡片 2 中的密钥；若重生成过，需要同步更新到工具里。

**Q: 偶尔触发滑块验证 / 回答变空？**
连续高频调用会触发 Qwen 风控。默认 3.2s 节流已大幅降低概率；如仍出现，等几分钟自动解除，或在管理页把"请求最小间隔"调大。

**Q: Cherry Studio 拉取不到模型列表？**
确认地址以 `/v1` 结尾、密钥正确、服务在跑（管理页能打开）。仍失败时看终端日志。

**Q: 多轮对话上下文会丢失吗？**
不会。服务是无状态代理，多轮上下文由客户端（Cherry Studio 等）随请求携带的 messages 历史拼接实现。

**Q: 局域网其他设备能用吗？**
启动时加 `--lan`，然后其他设备访问 `http://你的内网IP:8818/v1`。注意管理页仍仅限本机打开。

## 免责声明

本项目基于 Qwen Studio 网页端接口逆向封装，仅供个人学习研究、本地自动化与效率工具使用；请遵守上游服务条款，勿用于商业转售或高并发滥用，Token 凭证请妥善保管。
