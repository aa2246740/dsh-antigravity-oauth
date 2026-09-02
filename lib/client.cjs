Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/Settings.tsx
const STATUS_PATH = "/plugins/dsh-antigravity-oauth/auth/status";
const LOGIN_PATH = "/plugins/dsh-antigravity-oauth/auth/login";
const COMPLETE_PATH = "/plugins/dsh-antigravity-oauth/auth/complete";
const LOGOUT_PATH = "/plugins/dsh-antigravity-oauth/auth/logout";
const POLL_INTERVAL_MS = 1e3;
const STYLE_ID = "dsh-antigravity-oauth-settings-theme";
const SETTINGS_CSS = `
.dsh-agy-page { display:flex; flex-direction:column; gap:16px; max-width:640px; color:var(--dsw-alias-label-primary); }
.dsh-agy-title { margin:0; font-size:20px; line-height:28px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-agy-body { margin:0; font-size:13px; line-height:20px; color:var(--dsw-alias-label-secondary); }
.dsh-agy-error { margin:0; font-size:13px; line-height:20px; color:var(--dsw-alias-state-error-primary); }
.dsh-agy-card {
  display:flex; flex-direction:column; gap:8px; padding:14px 16px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  background:var(--dsw-alias-bg-module-platform);
}
.dsh-agy-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
.dsh-agy-name { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-agy-status { display:flex; align-items:center; flex-wrap:wrap; gap:6px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.dsh-agy-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; background:var(--dsw-alias-label-dimmed, #9aa0a6); }
.dsh-agy-dot.is-signed-in { background:var(--dsw-alias-state-success-primary, #22a06b); }
.dsh-agy-dot.is-error { background:var(--dsw-alias-state-error-primary, #d92d20); }
.dsh-agy-dot.is-signing-in { background:var(--dsw-alias-brand-primary, #1677ff); }
.dsh-agy-btn {
  box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center;
  min-height:32px; padding:4px 14px; border-radius:16px; font:inherit; font-size:13px; line-height:20px; cursor:pointer;
}
.dsh-agy-btn:disabled { opacity:0.55; cursor:not-allowed; }
.dsh-agy-btn-secondary {
  border:1px solid var(--dsw-alias-border-l2);
  background:transparent;
  color:var(--dsw-alias-label-primary);
}
.dsh-agy-btn-primary {
  border:none;
  background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color:var(--dsw-alias-label-primary-foreground, #fff);
}
.dsh-agy-link { color:var(--dsw-alias-brand-primary); word-break:break-all; }
.dsh-agy-form { display:flex; flex-direction:column; gap:8px; }
.dsh-agy-input {
  box-sizing:border-box; width:100%; min-height:36px; padding:7px 10px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:8px;
  background:var(--dsw-alias-bg-page-primary, transparent);
  color:var(--dsw-alias-label-primary); font:inherit; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.dsh-agy-actions { display:flex; justify-content:flex-end; }
`;
function ensureThemeStyles() {
	if (typeof document === "undefined") return;
	if (document.getElementById(STYLE_ID) !== null) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = SETTINGS_CSS;
	document.head.appendChild(style);
}
async function jsonRequest(path, method = "GET", body) {
	const response = await fetch(path, {
		method,
		headers: {
			accept: "application/json",
			...body === void 0 ? {} : { "content-type": "application/json" }
		},
		credentials: "same-origin",
		...body === void 0 ? {} : { body: JSON.stringify(body) }
	});
	const value = await response.json().catch(() => void 0);
	if (!response.ok) {
		const message = typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : `HTTP ${response.status}`;
		throw new Error(message);
	}
	return value;
}
function AntigravitySettings({ t }) {
	if (t === void 0) throw new Error("Antigravity settings requires its translation function");
	const [account, setAccount] = (0, react.useState)(void 0);
	const [error, setError] = (0, react.useState)(void 0);
	const [busy, setBusy] = (0, react.useState)(false);
	const [draft, setDraft] = (0, react.useState)("");
	(0, react.useEffect)(() => {
		ensureThemeStyles();
	}, []);
	const refresh = (0, react.useCallback)(async () => {
		try {
			setAccount(await jsonRequest(STATUS_PATH));
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t("requestFailed"));
		}
	}, [t]);
	(0, react.useEffect)(() => {
		refresh();
	}, [refresh]);
	const signing = account?.status === "signing-in";
	(0, react.useEffect)(() => {
		if (!signing) return;
		const timer = window.setInterval(() => {
			refresh();
		}, POLL_INTERVAL_MS);
		return () => {
			window.clearInterval(timer);
		};
	}, [refresh, signing]);
	const signIn = async () => {
		const popup = window.open("about:blank", "_blank");
		if (popup !== null) popup.opener = null;
		setBusy(true);
		try {
			const challenge = await jsonRequest(LOGIN_PATH, "POST", {});
			if (popup !== null && challenge.url !== void 0) popup.location.replace(challenge.url);
			if (popup !== null && challenge.url === void 0) popup.close();
			await refresh();
		} catch (caught) {
			popup?.close();
			setError(caught instanceof Error ? caught.message : t("requestFailed"));
		} finally {
			setBusy(false);
		}
	};
	const complete = async () => {
		const value = draft.trim();
		if (value.length === 0) return;
		setBusy(true);
		try {
			await jsonRequest(COMPLETE_PATH, "POST", { url: value });
			setDraft("");
			await refresh();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t("requestFailed"));
		} finally {
			setBusy(false);
		}
	};
	const signOut = async () => {
		setBusy(true);
		try {
			await jsonRequest(LOGOUT_PATH, "POST", {});
			await refresh();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t("requestFailed"));
		} finally {
			setBusy(false);
		}
	};
	const label = account === void 0 ? t("loadingAccount") : account.status === "signed-in" ? t("signedIn") : account.status === "signing-in" ? t("signingIn") : account.status === "error" ? t("requestFailed") : t("signedOut");
	const dotClass = account?.status === "signed-in" ? "dsh-agy-dot is-signed-in" : account?.status === "error" ? "dsh-agy-dot is-error" : account?.status === "signing-in" ? "dsh-agy-dot is-signing-in" : "dsh-agy-dot";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "dsh-agy-page",
		"aria-labelledby": "antigravity-settings-title",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				id: "antigravity-settings-title",
				className: "dsh-agy-title",
				children: t("title")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-agy-body",
				children: t("tos")
			}),
			error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-agy-error",
				children: error
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: "dsh-agy-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-agy-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-agy-name",
							children: t("title")
						}), account?.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-agy-btn dsh-agy-btn-secondary",
							disabled: busy,
							onClick: () => {
								signOut();
							},
							children: busy ? t("working") : t("logout")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-agy-btn dsh-agy-btn-primary",
							disabled: busy,
							onClick: () => {
								signIn();
							},
							children: busy ? t("working") : account?.status === "error" ? t("loginAgain") : t("login")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-agy-status",
						role: "status",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							className: dotClass
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
					}),
					account?.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsh-agy-error",
						children: account.message
					}) : null,
					account?.status === "signed-in" && account.email !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "dsh-agy-body",
						children: [
							t("email"),
							" ",
							account.email
						]
					}) : null,
					account?.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "dsh-agy-body",
						children: [
							t("project"),
							" ",
							account.projectId
						]
					}) : null,
					account?.status === "signing-in" && account.url !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "dsh-agy-body",
						children: [
							t("openUrl"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: account.url,
								target: "_blank",
								rel: "noreferrer",
								className: "dsh-agy-link",
								children: account.url
							})
						]
					}) : null,
					account?.status === "signing-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "dsh-agy-form",
						onSubmit: (event) => {
							event.preventDefault();
							complete();
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsh-agy-body",
								children: t("completeHelp")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "text",
								className: "dsh-agy-input",
								autoComplete: "off",
								spellCheck: false,
								placeholder: t("completePlaceholder"),
								value: draft,
								disabled: busy,
								onChange: (event) => {
									setDraft(event.target.value);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-agy-actions",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "submit",
									className: "dsh-agy-btn dsh-agy-btn-primary",
									disabled: busy || draft.trim().length === 0,
									children: busy ? t("working") : t("complete")
								})
							})
						]
					}) : null
				]
			})
		]
	});
}
//#endregion
//#region src/client/locales.ts
const en = {
	nav: "Antigravity",
	title: "Google Antigravity",
	tos: "Unofficial Cloud Code Assist login. Review Google Terms of Service before signing in. Credentials stay in DSH’s private store, not in official CLI files.",
	loadingAccount: "Loading account…",
	signedOut: "Not signed in",
	signingIn: "Waiting for authorization…",
	signedIn: "Signed in",
	login: "Sign in",
	loginAgain: "Sign in again",
	logout: "Sign out",
	working: "Working…",
	openUrl: "Authorize",
	completeHelp: "If the browser window does not return, paste the redirect URL or authorization code.",
	completePlaceholder: "Paste redirect URL or code",
	complete: "Finish sign-in",
	requestFailed: "The login request failed.",
	email: "Account",
	project: "Project"
};
const zh = {
	nav: "Antigravity",
	title: "Google Antigravity",
	tos: "非官方 Cloud Code Assist 登录。登录前请阅读 Google 服务条款。凭据只保存在 DSH 的私有文件中，不会写入官方 CLI 登录文件。",
	loadingAccount: "正在加载账户…",
	signedOut: "尚未登录",
	signingIn: "正在等待授权…",
	signedIn: "已登录",
	login: "登录",
	loginAgain: "重新登录",
	logout: "退出",
	working: "处理中…",
	openUrl: "授权",
	completeHelp: "如果浏览器没有自动返回，请粘贴跳转 URL 或授权码。",
	completePlaceholder: "粘贴跳转 URL 或授权码",
	complete: "完成登录",
	requestFailed: "登录请求失败。",
	email: "账号",
	project: "项目"
};
//#endregion
//#region src/client/index.tsx
const name = "dsh-antigravity-oauth-client";
const inject = ["slots", "locale"];
function apply(ctx) {
	const namespace = "settings.antigravity-oauth";
	ctx.effect(() => ctx.locale.register(namespace, {
		zh,
		en
	}), "dsh-antigravity-oauth: settings copy");
	const t = ctx.locale.bind(namespace);
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "antigravity-oauth",
		order: 18,
		label: () => t("nav"),
		inject: () => ({ t })
	}, AntigravitySettings));
}
//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
