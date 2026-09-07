# dsh-antigravity-oauth

English | [中文](README.zh.md)

Unofficial Gemini Cloud Code Assist login for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is not Google Antigravity, not the public Gemini API, and not an official DeepSeek product.

## Warning

Using this plugin can get the Google account banned, limited, or signed out. That risk is real. Nobody here can undo it.

Sign-in pretends to be the Antigravity desktop client (`ideType: ANTIGRAVITY`) and talks to `daily-cloudcode-pa.googleapis.com` `/v1internal:streamGenerateContent`. That is not Google AI Studio, not Vertex, and not a supported third-party integration. Google can change or shut this path without notice.

Read [Google Terms of Service](https://policies.google.com/terms) and the Antigravity / Gemini product terms before connecting. Prefer a spare Google account. Do not paste `.dsh-antigravity-oauth.json`, refresh tokens, callback URLs, or authorization codes into issues or screenshots.

The OAuth client id/secret in this repo are the public Antigravity desktop-app client, not your Google password. Account tokens stay in `$DSH_HOME/.dsh-antigravity-oauth.json`.

If you want a supported Gemini integration, use Google's official API / AI Studio products.

## What it does

| | |
|---|---|
| Settings nav | **Antigravity** |
| Harness route | `agy-google-antigravity` |
| Public models | `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.5-flash` |
| Auth file | `$DSH_HOME/.dsh-antigravity-oauth.json` |
| Search | `search_web` as a separate Cloud Code Assist `googleSearch` turn |
| Image | Not available on this route |

It never reads or writes `~/.gemini`, Antigravity app data, `dsh-oauth-login`'s store, or Pi Agent `auth.json`. Do not merge this plugin with `dsh-oauth-login`.

It does not offer Claude, GPT-OSS, Gemini 3.6 / 3.1 Pro, official Gemini API keys, multi-account rotation, or DSH `web_search` / `web_fetch` on this route.

## Install

Node **22.19+**. This branch targets DeepSeek Harness **0.1.2-rc.1**.

```sh
git clone https://github.com/aa2246740/dsh-antigravity-oauth.git
cd dsh-antigravity-oauth
npm install
DSHX_HARNESS=/absolute/path/to/deepseek-harness npm run build
dsh plugin --profile web add file:./dsh-antigravity-oauth
```

Keep the `file:` prefix. Restart the Web Host. Open **Settings → Antigravity**. In a new chat, pick `agy-google-antigravity`.

## Sign in

1. Settings → Antigravity → **Sign in**.
2. Finish Google's consent screen.
3. If the window does not return, paste the redirect URL or authorization code into the form.

OAuth listens on `http://127.0.0.1:51121/oauth-callback`. Desktop OAuth here does not use PKCE.

If a turn 400s, TRANSPORT-storms, or leaves an unfinished tool call, start a new chat. Do not Continue that session.

## Proxy and config

Settings → Antigravity can use Host environment, direct, or an explicit HTTP(S) proxy. Settings persist in `$DSH_HOME/.dsh-antigravity-oauth.json.network.json`. SOCKS-only ports are not enough.

```yaml
- id: llm-antigravity-oauth
  name: dsh-antigravity-oauth
  config:
    nativeTools: true
    nativeSearch: true
```

| Key | Default | Meaning |
|---|---|---|
| `nativeSearch` | `true` | Offer `search_web` and intercept it onto googleSearch |
| `nativeTools` | `true` | Forward DSH function tools after schema sanitizing |
| `streamIdleTimeoutMs` | `300000` | Idle stream timeout |
| `retryPolicy` | Harness default | Official `dsh-llm` retry policy |

`nativeSearch: false` turns off Cloud Code Assist search. It does not bring DSH `web_search` back on this route.

## License

Apache-2.0. You run this at your own risk.
