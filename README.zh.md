# dsh-antigravity-oauth

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**独立、非官方** Gemini Cloud Code Assist 登录插件。

这是社区插件。**不是** Google Antigravity 官方产品，**不是** 公开 Gemini API，**也不是** DeepSeek 官方功能。

---

## 警告 — 登录前先读完

**用这个插件，Google 账号有被封、被限、被踢下线的真实风险。** 封了没人能救。

1. **非官方 Cloud Code Assist。** 登录时会伪装成 Antigravity 桌面客户端（`ideType: ANTIGRAVITY`），请求打到 `daily-cloudcode-pa.googleapis.com` 的 `/v1internal:streamGenerateContent`。这**不是** Google AI Studio，**不是** Vertex，**也不是** Google 支持的第三方接入。Google 随时可以改接口、限流或关掉这条路。
2. **你接受的是 Google 的条款，不是我们的。** 连接前请阅读 [Google 服务条款](https://policies.google.com/terms) 以及 Antigravity / Gemini 产品条款。条款不允许就不要登录。
3. **不要用丢不起的号。** 尽量用备用 Google 账号。多个保存的账号共用同一个 OAuth client、同一个 User-Agent 和你的 IP，每多加一个号，所有号一起被关注的风险都会上升。只添加你自己的账号，切换保持手动。
4. **没有担保。** 今天能聊，不代表明天路由、模型、额度或账号还在。
5. **不要贴机密。** Issue、聊天、截图里不要出现 `.dsh-antigravity-oauth.json`、refresh token、回调 URL 或授权码。
6. **仓库里的 OAuth client id/secret 不是你的 Google 密码。** 那是 Antigravity **桌面应用**的公开 client（安装应用那一类），官方 IDE 也带同样性质的凭据。非官方登录必须用它。你的账号 token 只存在本机 `$DSH_HOME/.dsh-antigravity-oauth.json`。

若你需要受支持的 Gemini 接入，请走 Google 官方 API / AI Studio。不要用这个插件。

---

## 它做什么

| | |
|---|---|
| 设置入口 | **Antigravity** |
| Harness 路由 | `agy-google-antigravity` |
| 公开模型 | `gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.5-flash` |
| 凭据文件 | `$DSH_HOME/.dsh-antigravity-oauth.json`（仅当前用户可读） |
| 保存的账号 | 多个；在设置里手动切换 |
| 搜索 | `search_web` → **单独一轮** Cloud Code Assist `googleSearch` |
| 生图 | **已删除。** 这条路由不会出图。 |

插件不读不写官方 CLI 登录文件（`~/.gemini`、Antigravity 应用数据、`dsh-oauth-login` 的 store、Pi Agent 的 `auth.json`）。

它**不是** `dsh-oauth-login`。不要把两个插件并在一起。

---

## 它不做什么

- Claude、GPT-OSS、Gemini 3.6 / 3.1 Pro，以及上面两个 Flash 之外的任何模型
- Google 生图（`generate_image` 会被丢掉）
- 自动账号轮换、负载均衡或额度池——切换永远手动
- 官方 Gemini API Key
- 本路由上 DSH 默认的 `web_search` / `web_fetch`（会藏起来，避免盖住 Cloud Code Assist 搜索）

---

## 多账号

- **设置 → Antigravity → 添加账号**：不退出当前账号，再登录一个 Google 账号。每次完成的登录都会保留。
- 账号列表里的单选框切换当前账号，下一次模型请求生效；已经在流的回复由发起它的账号跑完。
- **删除**只删那一个账号；删除当前账号时会自动顶上剩下的第一个。永远不会整批清空。
- Google 返回 `429`/额度用完时，报错会点名账号，列表里标**"配额受限"**；自己手动切到下一个账号。插件不会自动替你切。
- 闲置账号的 refresh token 长期有效。打开本设置页时，插件对每个闲置账号**每天最多做一次 token 预检**，不会为闲置账号请求任何 Antigravity 接口；token 失效会标"需要重新登录"。
- 所有凭据都在一个文件里：`{ version: 2, activeId, accounts: [...] }`。首次迁移会留一份一次性的 `.dsh-antigravity-oauth.json.v1.bak`（仅所有者可读）。回退旧版插件需要用它恢复；删掉多余账号不会把文件改回 v1。
- 每个账号有自己独立的 Antigravity 请求会话，切换账号不会把 A 号的请求标识带给 B 号。

---

## 安装

需要 Node **22.19+**。当前兼容分支面向 DeepSeek Harness **0.1.2-rc.1**；桌面壳版本号与 Host 版本号不同。

```sh
git clone https://github.com/aa2246740/dsh-antigravity-oauth.git
cd dsh-antigravity-oauth
npm install
DSHX_HARNESS=/absolute/path/to/deepseek-harness npm run build
```

`file:` 前缀必须留着。本插件把 DSH 运行时当 peer dependency，写成 `./dsh-antigravity-oauth` 往往解析不到依赖。

```sh
dsh plugin --profile web add file:./dsh-antigravity-oauth
```

重启 Web Host（`dsh web` / DSH.app）。打开 **设置 → Antigravity**。在**新对话**里选路由 `agy-google-antigravity`。

---

## 登录

1. 设置 → Antigravity → **登录**（已登录时显示为**添加账号**）。
2. 在浏览器里走完 Google 授权。
3. 若窗口没有自动返回，把跳转 URL 或授权码贴进表单。

OAuth 回调监听 `http://127.0.0.1:51121/oauth-callback`。这里的桌面 OAuth **不用** PKCE。

Google 授权与 Antigravity 服务资格分开显示。Google 授权成功后，即使资格检查失败也会保留本插件的凭据；可调整插件网络后点"重试资格检查"，不必反复授权。登录等待中可以取消、重新打开授权页或重新登录。只有拿到可用项目后才启用模型路由。

已有付费资格及项目优先于免费套餐的拒绝信息；开通时遵循服务端返回的默认套餐。真实地区／账号限制仍会明确报错，不会绕过限制，也不会读取 Cockpit 或官方应用凭据。降级到旧版前注意：旧版不认识尚未取得项目的授权记录，也不认识 v2 多账号格式——请先恢复迁移时留下的 `.v1.bak` 备份，不要通过删除凭据来处理。

---

## 搜索、工具、以及坏掉的对话

Cloud Code Assist **v1internal 不能**在同一次请求里同时带内置 `googleSearch` 和 `functionDeclarations`。所以插件会：

- 给模型看 `search_web`
- 搜索单独走一轮只有 googleSearch 的请求
- 把检索结果作为 `functionResponse` 交回（模型没调工具时则写成源材料备忘）
- **同一轮对话继续走**：带着原来的 system、工具、用户语言；接地长文不是给用户看的最终答复
- 模型如果只想了一下就停（没有正文、没有工具），同一轮会被推着继续；用户是在让它查资料时会先搜再答
- 普通工具（`bash`、`skill` 等）在这场 follow-up 里仍可调用

**某一轮 400、TRANSPORT 连打、或留下未完成的 tool call：开新对话。不要 Continue 那个会话。** 带伤的 transcript 会一直失败。

常见伤：

- `Function call is missing a thought_signature`
- `functionResponse` 上的 `INVALID_ARGUMENT`
- 先 400、再被 DSH 重试成 `TRANSPORT`

Gemini 3.7 Flash High 在后续 `functionCall` 上要带 `thought_signature`。本插件会保存并回放。但 400 发生在握手之前的会话仍然是死的 — 开新对话。

---

## 生图

这条目录上的 Google 生图已经删掉，原因是：

- `gemini-3-pro-image` 不在这份 Cloud Code Assist 目录里（404）
- `gemini-3.1-flash-image` 有**单独的、非常小的**额度，和 Gemini 5 小时条不是一回事

不要指望 `agy-google-antigravity` 出图。

---

## 代理

设置 → Antigravity 提供"跟随 Host 环境／直连／指定 HTTP(S) 代理"，显示实际采用的路由。只影响本插件的 OAuth 与 CCA 请求，保存在 `$DSH_HOME/.dsh-antigravity-oauth.json.network.json`，不会修改系统代理或其他插件。保存后后续请求即生效，无需重启 Host。不要在代理 URL 内放账号密码。

CCA 请求会通过 undici `ProxyAgent` 走 `HTTPS_PROXY` / `HTTP_PROXY` / `https_proxy` / `http_proxy`。Node 22+ 常常忽略这些变量，除非进程还设了 `NODE_USE_ENV_PROXY=1`；本插件不依赖那个开关。

本机 HTTP 代理例如 `http://127.0.0.1:45678`，在直连 Google 不通时够用。纯 SOCKS 端口不行。

---

## 配置

可选，写在 `llm-antigravity-oauth` 这一行：

```yaml
- id: llm-antigravity-oauth
  name: dsh-antigravity-oauth
  config:
    nativeTools: true
    nativeSearch: true
```

| 项 | 默认 | 含义 |
|---|---|---|
| `nativeSearch` | `true` | 提供 `search_web`，并拦截到 googleSearch |
| `nativeTools` | `true` | 转发 DSH 的 function tools（会先清洗 schema） |
| `streamIdleTimeoutMs` | `300000` | 流空闲超时 |
| `retryPolicy` | Harness 默认 | 官方 `dsh-llm` 重试策略 |

`nativeSearch: false` 会关掉 Cloud Code Assist 搜索。它不会把 DSH 的 `web_search` 还给这条路由。

---

## 许可

Apache-2.0。

与 Google、DeepSeek、Antigravity IDE 均无隶属关系。使用风险自负。
