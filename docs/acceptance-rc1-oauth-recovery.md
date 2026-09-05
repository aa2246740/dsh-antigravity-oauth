# RC1 OAuth recovery acceptance — 2026-09-05

Target: DeepSeek Harness 0.1.2-rc.1, branch `compat/dsh-0.1.2-rc.1`.

## Implemented

- Treat Google authorization and Antigravity service eligibility separately; preserve the plugin-owned grant after eligibility rejection without enabling a model route prematurely.
- Accept string/object project representations and existing current/paid tiers before evaluating free-tier rejection. Use the server-advertised onboarding tier. Actual eligibility restrictions remain errors.
- Add cancellation, eligibility retry, reopen-authorization link and plugin-only network settings. Bound non-stream requests; preserve model streaming idle-timeout behavior.
- Build the served client through DSHX externalClientBundle. The old wrapping script could reuse an existing client artifact instead of the newly compiled frontend; the build no longer invokes it or produces client.cjs.

## Local and isolated checks

- `DSHX_HARNESS=<target-checkout> npm run check`: typecheck, 66 tests in 16 files, server and client builds passed.
- Regression tests cover paid/free eligibility precedence, project object parsing, selected onboarding tier, true rejection, grant persistence across session reconstruction, retry without repeated code exchange, cancellation/relogin and proxy validation.
- OAuth integration test files run serially because their registered callback URI uses fixed port 51121.
- `dshx check <plugin-source>` passed.
- `dshx activation-plan <plugin> --change server` passed; no tested server-module HMR, so a new launcher-owned Host is required.
- `dshx verify-boot <plugin-source>` passed: temporary independent Home, live boot graph entry, client HTTP 200; temporary Host stopped and Home removed.

## Actual local runtime

- DSH.app was observed on a new launcher-owned Host. Old observed PID 47551 was absent; new Host PID 95047 served port 43127. No additional restart was performed after observing this transition.
- Settings rendered the new Antigravity UI. Network mode remained auto, resolving to the existing loopback HTTP proxy; no system proxy settings changed.
- Google authorization completed and the plugin displayed signed-in with a resolved project. The real Google Antigravity models appeared in the DSH model selector.
- Independent plugin CCA probe, Gemini 3.8 Flash low: `ANTIGRAVITY_OK`, stream finished without error.
- Actual DSH.app session **Antigravity Plugin Acceptance Test**, Gemini 3.8 Flash medium: `ANTIGRAVITY_OK`, one LLM step, approximately 2.2 seconds. No tools requested.
- Only the production listener on 43127 remained; isolated-test port 3080 was not listening.

## Limits

- Live evidence covers this account and Gemini 3.8 Flash. Other accounts, models, long-running refresh and real cancellation during a stalled provider request were not independently accepted in production.
- Cancellation and rejected-grant recovery have automated callback/storage coverage; the successful real account was not signed out merely to retest them.
- Older plugin versions cannot read an authorized grant that lacks a project. Preserve credentials when planning a downgrade; do not delete them as a workaround.
- A successful login/model request does not guarantee future service eligibility or remove the risks of an unofficial integration.
