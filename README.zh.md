# dsh-antigravity-oauth

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的非官方 Gemini Cloud Code Assist 登录。

这不是 Google Antigravity，不是公开 Gemini API，也不是 DeepSeek 官方产品。

## 警告

用这个插件可能导致 Google 账号被封、被限或被踢下线。这个风险是真的，这里没人能帮你挽回。

登录会伪装成 Antigravity 桌面客户端（`ideType: ANTIGRAVITY`），请求打到 `daily-cloudcode-pa.googleapis.com` `/v1internal:streamGenerateContent`。这不是 Google AI Studio，不是 Vertex，也不是受支持的第三方集成。Google 随时可以改或关掉这条路。

登录前先读 [Google 服务条款](https://policies.google.com/terms) 以及 Antigravity / Gemini 产品条款。尽量用备用账号。不要把 `.dsh-antigravity-oauth.json`、refresh token、回调 URL 或授权码贴到 Issue 或截图里。

仓库里的 OAuth client id/secret 是 Antigravity 桌面应用的公开客户端，不是你的 Google 密码。账号 token 只写 `$DSH_HOME/.dsh-antigravity-oauth.json`。

想要受支持的 Gemini，用 Google 官方 API / AI Studio。

## 它做什么

| | |
|---|---|
| 设置导航 | **Antigravity** |
| Harness 路由 | `agy-google-antigravity` |
| 公开模型 | `gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.5-flash` |
| 登录文件 | `$DSH_HOME/.dsh-antigravity-oauth.json` |
| 搜索 | `search_web`，单独一轮 Cloud Code Assist `googleSearch` |
| 出图 | 这条路由没有 |

不读不写 `~/.gemini`、Antigravity 应用数据、`dsh-oauth-login` 的 store、Pi Agent `auth.json`。不要和 `dsh-oauth-login` 混成一份。

## 安装

Node **22.19+**。这条兼容线面向 DeepSeek Harness **0.1.2-rc.1**。

```sh
git clone https://github.com/aa2246740/dsh-antigravity-oauth.git
cd dsh-antigravity-oauth
npm install
DSHX_HARNESS=/absolute/path/to/deepseek-harness npm run build
dsh plugin --profile web add file:./dsh-antigravity-oauth
```

`file:` 前缀留着。重启 Web Host。打开 **设置 → Antigravity**。新对话里选 `agy-google-antigravity`。

## 登录

1. 设置 → Antigravity → **Sign in**。
2. 在浏览器里走完 Google 授权。
3. 窗口没回来就手动把 redirect URL 或授权码贴进表单。

OAuth 听 `http://127.0.0.1:51121/oauth-callback`。这里的桌面 OAuth 不用 PKCE。

一轮如果 400、TRANSPORT 风暴、或留下没做完的 tool call，开新对话。不要对那个会话点 Continue。

## 代理和配置

设置 → Antigravity 可选 Host 环境、直连或显式 HTTP(S) 代理。写在 `$DSH_HOME/.dsh-antigravity-oauth.json.network.json`。SOCKS 端口不够。

```yaml
- id: llm-antigravity-oauth
  name: dsh-antigravity-oauth
  config:
    nativeTools: true
    nativeSearch: true
```

`nativeSearch: false` 关掉 Cloud Code Assist 搜索，不会把 DSH `web_search` 还回来。

## 许可

Apache-2.0。风险自负。
