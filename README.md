# dsh-antigravity-oauth

English | [中文](README.zh.md)

Isolated, unofficial Gemini Cloud Code Assist login for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is a community plugin. It is **not** Google Antigravity, **not** the public Gemini API, and **not** an official DeepSeek product.

---

## Warning — read this before you sign in

**Using this plugin can get the Google account banned, limited, or signed out.** That risk is real. Nobody here can undo it.

1. **Unofficial Cloud Code Assist.** Sign-in pretends to be the Antigravity desktop client (`ideType: ANTIGRAVITY`) and talks to `daily-cloudcode-pa.googleapis.com` `/v1internal:streamGenerateContent`. That is **not** Google AI Studio, **not** Vertex, and **not** a supported third-party integration. Google can change, rate-limit, or shut this path without notice.
2. **You accept Google's terms, not ours.** Read [Google Terms of Service](https://policies.google.com/terms) and the Antigravity / Gemini product terms before connecting. If those terms forbid this, do not sign in.
3. **Do not use an account you cannot afford to lose.** Prefer a spare Google account. Saved accounts share one OAuth client, one user agent, and your IP, so every account you add raises the visibility of all of them. Add only accounts you own, and keep switching manual.
4. **No warranty.** Chat working today does not mean the route, models, quota, or account will still work tomorrow.
5. **Do not paste secrets.** Never put `.dsh-antigravity-oauth.json`, refresh tokens, callback URLs, or authorization codes in issues, chats, or screenshots.
6. **The OAuth client id/secret in this repo are not your Google password.** They are the public Antigravity **desktop app** client (installed-app style), the same class of credentials the official IDE ships. They are required for this unofficial login. Your account tokens stay in `$DSH_HOME/.dsh-antigravity-oauth.json` on your machine.

If you want a supported Gemini integration, use Google's official API / AI Studio products. Do not use this plugin.

---

## What it does

| | |
|---|---|
| Settings nav | **Antigravity** |
| Harness route | `agy-google-antigravity` |
| Public models | `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.5-flash` |
| Auth file | `$DSH_HOME/.dsh-antigravity-oauth.json` (owner-only) |
| Saved accounts | Multiple; switched manually in Settings |
| Search | `search_web` → a **separate** Cloud Code Assist `googleSearch` turn |
| Image | **Removed.** This route does not generate images. |

The plugin never reads or writes official CLI auth files (`~/.gemini`, Antigravity app data, `dsh-oauth-login`'s store, Pi Agent `auth.json`).

It is **not** `dsh-oauth-login`. Do not merge the two.

---

## What it does not do

- Claude, GPT-OSS, Gemini 3.6 / 3.1 Pro, or any model that is not the two Flash ids above
- Google image generation (`generate_image` is dropped)
- Automatic account rotation, load balancing, or quota pooling — switching is always manual
- Official Gemini API keys
- DSH's default `web_search` / `web_fetch` on this route (they are hidden so they do not shadow Cloud Code Assist search)

---

## Multiple accounts

- **Settings → Antigravity → Add account** signs in another Google account without signing the current one out. Every completed login is kept.
- The radio in the account list switches the active account. The next model request uses it; a stream that is already running finishes on the account that started it.
- **Remove** deletes only that one account. Removing the active one promotes the first remaining account. Nothing is ever wiped in bulk.
- When Google answers `429` / quota exhausted, the error names the account and the list marks it **Quota limited**. Switch to another saved account yourself — the plugin never switches on its own.
- Idle accounts keep their refresh token. When you open this settings page the plugin re-checks at most one token per idle account per day, and never touches the Antigravity endpoints for idle accounts. A dead token shows **Re-login required**.
- All credentials live in one file: `{ version: 2, activeId, accounts: [...] }`. The first migration leaves a one-time `.dsh-antigravity-oauth.json.v1.bak` (owner-only). Rolling back to an older plugin release requires restoring that backup; removing extra accounts does not rewrite the file back to v1.
- Each account keeps its own Antigravity request session. Switching accounts does not carry one account's request identifiers into the other.

---

## Install

Node **22.19+**. This compatibility branch targets DeepSeek Harness **0.1.5-rc.2**; the desktop launcher has a separate version.

```sh
git clone https://github.com/aa2246740/dsh-antigravity-oauth.git
cd dsh-antigravity-oauth
npm install
DSHX_HARNESS=/absolute/path/to/deepseek-harness npm run build
```

Keep the `file:` prefix. This package treats DSH runtime as peer dependencies; a plain `./dsh-antigravity-oauth` symlink often cannot resolve them.

```sh
dsh plugin --profile web add file:./dsh-antigravity-oauth
```

Restart the Web Host (`dsh web` / DSH.app). Open **Settings → Antigravity**. In a **new** chat, pick route `agy-google-antigravity`.

---

## Sign in

1. Settings → Antigravity → **Sign in** (or **Add account** when already signed in).
2. Finish Google's consent screen in the browser.
3. If the window does not return, paste the redirect URL or authorization code into the form.

OAuth listens on `http://127.0.0.1:51121/oauth-callback`. Desktop OAuth here does **not** use PKCE.

Google authorization and Antigravity eligibility are separate states. An authorized grant is preserved if eligibility fails; adjust plugin networking and retry eligibility without repeating consent. Pending login can be cancelled, reopened or restarted. Model routing requires a resolved project. Existing paid tier/project takes precedence over a free-tier rejection; onboarding uses the server's default allowed tier. Actual account/location restrictions remain errors. No Cockpit or official-app credentials are read. Older plugin versions cannot parse a pending grant without a project or a v2 multi-account file; restore the `.v1.bak` backup before downgrading.

---

## Search, tools, and broken chats

Cloud Code Assist **v1internal cannot mix** built-in `googleSearch` with `functionDeclarations` on the same request. This plugin therefore:

- exposes `search_web` to the model
- runs that search as its own googleSearch-only round trip
- feeds the grounded result back as a `functionResponse` (or a source memo if the model never called the tool)
- continues the same chat with the original system prompt, tools, and language — the grounded dump is **not** the user-facing answer
- if the model only thinks and then stops (no text, no tools), the plugin nudges the same turn to continue — and will search when the user asked to look something up
- keeps ordinary tools (`bash`, `skill`, …) available on that follow-up turn

**If a turn 400s, TRANSPORT-storms, or leaves an unfinished tool call: start a new chat. Do not Continue that session.** Scarred transcripts keep failing.

Typical scars:

- `Function call is missing a thought_signature`
- `INVALID_ARGUMENT` on `functionResponse`
- a 400 that DSH then retries as `TRANSPORT`

Gemini 3.7 Flash High requires a `thought_signature` on later `functionCall` parts. This plugin stores and replays them. A session that 400'd before that handshake is still dead — new chat.

---

## Image generation

Google image on this catalog was removed on purpose:

- `gemini-3-pro-image` is not on this Cloud Code Assist list (404)
- `gemini-3.1-flash-image` has a **separate**, very small quota — not the Gemini 5-hour bar

Do not expect pictures from `agy-google-antigravity`.

---

## Proxy

Settings → Antigravity offers Host environment, direct, and explicit HTTP(S) proxy modes, with the effective route displayed. Settings persist in `$DSH_HOME/.dsh-antigravity-oauth.json.network.json` and apply to subsequent OAuth/CCA requests without restarting. They never change system networking or other plugins. Proxy credentials in URLs are rejected.

CCA fetch honors `HTTPS_PROXY` / `HTTP_PROXY` / `https_proxy` / `http_proxy` through undici `ProxyAgent`. Node 22+ often ignores those variables unless the process also sets `NODE_USE_ENV_PROXY=1`; this plugin does not rely on that flag.

A local HTTP proxy such as `http://127.0.0.1:45678` is enough when Google is otherwise unreachable. SOCKS-only ports are not.

---

## Config

Optional overlay on the `llm-antigravity-oauth` row:

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
| `nativeTools` | `true` | Forward DSH function tools (after schema sanitizing) |
| `streamIdleTimeoutMs` | `300000` | Idle stream timeout |
| `retryPolicy` | Harness default | Official `dsh-llm` retry policy |

`nativeSearch: false` turns off Cloud Code Assist search. It does not bring DSH `web_search` back on this route.

---

## License

Apache-2.0.

No affiliation with Google, DeepSeek, or the Antigravity IDE. You run this at your own risk.
