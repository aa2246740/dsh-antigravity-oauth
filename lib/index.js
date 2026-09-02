import { CallId, LlmAdapter, LlmError, ReasoningEffortId, RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { ProxyAgent, fetch as fetch$1 } from "undici";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
//#region src/ids.ts
const AUTH_FILENAME = ".dsh-antigravity-oauth.json";
const HARNESS_ROUTE = "agy-google-antigravity";
const BOOT_MARKER = "[my-plugins/dsh-antigravity-oauth] loaded";
const STREAM_IDLE_TIMEOUT_MS = 3e5;
const AUTH_STATUS_PATH = "/plugins/dsh-antigravity-oauth/auth/status";
const AUTH_LOGIN_PATH = "/plugins/dsh-antigravity-oauth/auth/login";
const AUTH_COMPLETE_PATH = "/plugins/dsh-antigravity-oauth/auth/complete";
const AUTH_LOGOUT_PATH = "/plugins/dsh-antigravity-oauth/auth/logout";
const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const CCA_ENDPOINTS = [DAILY_ENDPOINT, "https://daily-cloudcode-pa.sandbox.googleapis.com"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CALLBACK_PORT = 51121;
const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}/oauth-callback`;
const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
const ONBOARD_USER_PATH = "/v1internal:onboardUser";
const FREE_TIER_ID = "free-tier";
const ONBOARD_TIMEOUT_MS = 3e4;
const ONBOARD_POLL_INTERVAL_MS = 1e3;
const ANTIGRAVITY_VERSION_MANIFEST_URL = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const OAUTH_REFRESH_POLL_MS = 9e5;
const OAUTH_EXPIRES_SKEW_MS = 3e5;
//#endregion
//#region src/models.ts
const PUBLIC_MODELS = [{
	id: "gemini-3.7-flash",
	name: "Gemini 3.7 Flash",
	contextWindow: 1048576,
	maxTokens: 65536
}, {
	id: "gemini-3.5-flash",
	name: "Gemini 3.5 Flash",
	contextWindow: 1048576,
	maxTokens: 65536
}];
const REASONING_EFFORTS = [
	"low",
	"medium",
	"high"
];
const DEFAULT_REASONING_EFFORT = "medium";
const WIRE = {
	"gemini-3.7-flash": {
		low: "gemini-3.7-flash-low",
		medium: "gemini-3.7-flash-medium",
		high: "gemini-3.7-flash-high"
	},
	"gemini-3.5-flash": {
		low: "gemini-3.5-flash-extra-low",
		medium: "gemini-3.5-flash-low",
		high: "gemini-3-flash-agent"
	}
};
const THINKING_37 = {
	low: "LOW",
	medium: "MEDIUM",
	high: "HIGH"
};
function isPublicModelId(id) {
	return id === "gemini-3.7-flash" || id === "gemini-3.5-flash";
}
function routeChatModel(model, effort = DEFAULT_REASONING_EFFORT) {
	return WIRE[model][effort];
}
function thinkingLevelFor(model, effort) {
	return model === "gemini-3.7-flash" ? THINKING_37[effort] : void 0;
}
function publicModel(id) {
	return PUBLIC_MODELS.find((model) => model.id === id);
}
//#endregion
//#region src/types.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region src/schema.ts
const GEMINI_TYPES = /* @__PURE__ */ new Set([
	"string",
	"number",
	"integer",
	"boolean",
	"array",
	"object"
]);
function firstGeminiType(value) {
	if (typeof value === "string") {
		if (value === "null") return { nullable: true };
		return GEMINI_TYPES.has(value) ? {
			type: value,
			nullable: false
		} : { nullable: false };
	}
	if (!Array.isArray(value)) return { nullable: false };
	let type;
	let nullable = false;
	for (const entry of value) {
		if (entry === "null") {
			nullable = true;
			continue;
		}
		if (typeof entry === "string" && GEMINI_TYPES.has(entry) && type === void 0) type = entry;
	}
	return {
		type,
		nullable
	};
}
function unionBranch(raw) {
	if (!Array.isArray(raw) || raw.length === 0) return void 0;
	return raw.filter((entry) => {
		if (!isRecord(entry)) return true;
		return entry.type !== "null";
	})[0] ?? raw[0];
}
function sanitizeGeminiSchema(raw) {
	if (!isRecord(raw)) return void 0;
	const source = isRecord(unionBranch(raw.anyOf ?? raw.oneOf ?? raw.allOf)) ? {
		...raw,
		...unionBranch(raw.anyOf ?? raw.oneOf ?? raw.allOf)
	} : raw;
	const { type, nullable } = firstGeminiType(source.type);
	const out = {};
	if (type !== void 0) out.type = type;
	if (nullable || source.nullable === true) out.nullable = true;
	if (typeof source.description === "string" && source.description.length > 0) out.description = source.description;
	if (Array.isArray(source.enum)) {
		const values = source.enum.filter((entry) => typeof entry === "string");
		if (values.length > 0) out.enum = values;
	}
	if (Array.isArray(source.required)) {
		const required = source.required.filter((entry) => typeof entry === "string");
		if (required.length > 0) out.required = required;
	}
	const properties = sanitizeProperties(source.properties);
	if (properties !== void 0) {
		out.properties = properties;
		if (out.type === void 0) out.type = "object";
	}
	if (source.items !== void 0) {
		const items = sanitizeGeminiSchema(source.items);
		if (items !== void 0) out.items = items;
		if (out.type === void 0) out.type = "array";
	}
	if (out.type === void 0 && out.enum !== void 0) out.type = "string";
	return Object.keys(out).length === 0 ? {
		type: "object",
		properties: {}
	} : out;
}
function sanitizeProperties(raw) {
	if (!isRecord(raw)) return void 0;
	const properties = {};
	for (const [key, value] of Object.entries(raw)) {
		const schema = sanitizeGeminiSchema(value);
		if (schema !== void 0) properties[key] = schema;
	}
	return properties;
}
function sanitizeGeminiParameters(raw) {
	return sanitizeGeminiSchema(raw) ?? {
		type: "object",
		properties: {}
	};
}
//#endregion
//#region src/native-tools.ts
const DSH_WEB_TOOL_NAMES = ["web_search", "web_fetch"];
const DSH_WEB_SECTION_NAMES = ["tool:web_search", "tool:web_fetch"];
const SEARCH_WEB_TOOL = "search_web";
const DROPPED_TOOL_NAMES = /* @__PURE__ */ new Set(["generate_image"]);
const DSH_WEB_TOOL_NAME_SET = new Set(DSH_WEB_TOOL_NAMES);
const DSH_WEB_SECTION_NAME_SET = new Set(DSH_WEB_SECTION_NAMES);
const SEARCH_WEB_NAME_SET = /* @__PURE__ */ new Set([SEARCH_WEB_TOOL, "web_search"]);
const SEARCH_GUIDANCE = "Use search_web for news and public-web facts. Do not call web_search, web_fetch, or generate_image. This route has no image generation. Cloud Code Assist v1internal cannot mix built-in googleSearch with function tools, so search_web runs as a separate googleSearch-only request.";
const SEARCH_INTENT = new RegExp([
	"搜搜",
	"网上搜",
	"web search",
	"search the web",
	"google\\s+(?:for|search)",
	"查新闻",
	"(?:搜|搜索).{0,8}(?:新闻|资讯|网页)",
	"最近\\s*\\d+\\s*(?:小时|天).{0,16}(?:新闻|资讯|科技)",
	"\\bnews\\b"
].join("|"), "i");
function latestUserText(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === void 0 || message.role !== "user") continue;
		if (message.source?.kind === "tool" || message.source?.kind === "plugin") continue;
		const text = message.content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text ?? "").join("").trim();
		if (text.length === 0) continue;
		if (text.includes("<system-reminder>") || text.includes("<available_skills>")) continue;
		return text;
	}
	return "";
}
function wantsNativeSearch(text) {
	return SEARCH_INTENT.test(text);
}
const SEARCH_WEB_DECLARATION = {
	name: SEARCH_WEB_TOOL,
	description: "Search the public web via Cloud Code Assist googleSearch. Use this instead of web_search or web_fetch.",
	parameters: {
		type: "object",
		properties: { query: {
			type: "string",
			description: "Search query"
		} },
		required: ["query"]
	}
};
function isSearchWebToolName(name) {
	return SEARCH_WEB_NAME_SET.has(name);
}
function isDroppedToolName(name) {
	return DROPPED_TOOL_NAMES.has(name);
}
function isDshWebToolName(name) {
	return DSH_WEB_TOOL_NAME_SET.has(name);
}
function isDshWebSectionName(name) {
	return DSH_WEB_SECTION_NAME_SET.has(name);
}
function filterDshWebTools(tools) {
	if (tools === void 0) return [];
	return tools.filter((tool) => !isDshWebToolName(tool.name));
}
function ccaFunctionDeclarations(tools, search = true) {
	const kept = filterDshWebTools(tools ?? []).filter((tool) => tool.name !== "search_web" && !isDroppedToolName(tool.name)).map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: sanitizeGeminiParameters(tool.parameters)
	}));
	if (search) kept.push(SEARCH_WEB_DECLARATION);
	return kept;
}
function maskDshWebAssembly(assembly) {
	return {
		...assembly,
		tools: assembly.tools.filter((tool) => !isDshWebToolName(tool.name)),
		sections: [...assembly.sections.filter((section) => !isDshWebSectionName(section.name)), {
			name: "antigravity:native-tools",
			text: SEARCH_GUIDANCE
		}]
	};
}
function parseSearchWebArgs(args) {
	const query = typeof args.query === "string" ? args.query : typeof args.q === "string" ? args.q : typeof args.prompt === "string" ? args.prompt : typeof args.text === "string" ? args.text : "";
	if (query.length === 0) throw new Error("search_web requires a query");
	return query;
}
//#endregion
//#region src/adapter.ts
function effortOf(options) {
	const raw = options.reasoningEffort;
	if (raw === "low") return "low";
	if (raw === "medium") return "medium";
	if (raw === "high") return "high";
	return DEFAULT_REASONING_EFFORT;
}
function textOf(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function convertMessages(messages, thoughtSignatures) {
	const toolNames = /* @__PURE__ */ new Map();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "tool-call") toolNames.set(block.id, block.name);
	}
	const contents = [];
	for (const message of messages) {
		if (message.source.kind === "tool") {
			const block = message.content[0];
			if (block?.type !== "tool-result") continue;
			const responseText = textOf(block.content);
			contents.push({
				role: "user",
				parts: [{ functionResponse: {
					name: toolNames.get(block.toolCallId) ?? "tool",
					id: block.toolCallId,
					response: { result: responseText }
				} }]
			});
			continue;
		}
		if (message.role === "assistant") {
			const parts = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text.length > 0) parts.push({ text: block.text });
				if (block.type === "reasoning" && block.text.length > 0) parts.push({
					text: block.text,
					thought: true
				});
				if (block.type === "tool-call") {
					let args = {};
					try {
						args = JSON.parse(block.arguments);
					} catch {
						args = { raw: block.arguments };
					}
					const thoughtSignature = thoughtSignatures.get(block.id);
					parts.push({
						functionCall: {
							name: block.name,
							args,
							id: block.id
						},
						...thoughtSignature === void 0 ? {} : { thoughtSignature }
					});
				}
			}
			if (parts.length > 0) contents.push({
				role: "model",
				parts
			});
			continue;
		}
		if (message.role === "user") {
			const text = textOf(message.content);
			if (text.length > 0) contents.push({
				role: "user",
				parts: [{ text }]
			});
		}
	}
	if (contents.length === 0) contents.push({
		role: "user",
		parts: [{ text: "" }]
	});
	return contents;
}
function functionsFor(options, nativeSearch) {
	if (options.purpose === "compaction" || options.purpose === "session-title") return [];
	return ccaFunctionDeclarations(options.tools, nativeSearch);
}
var AntigravityAdapter = class extends LlmAdapter {
	session;
	options;
	constructor(session, options) {
		super();
		this.session = session;
		this.options = options;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Google Antigravity"
		};
	}
	listModels(provider) {
		return Promise.resolve(PUBLIC_MODELS.map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			inputModalities: ["text", "image"]
		})));
	}
	resolveModel(provider, model) {
		const spec = publicModel(model);
		const name = spec?.name ?? model;
		return Promise.resolve({
			provider,
			id: model,
			name,
			inputModalities: ["text", "image"],
			...spec === void 0 ? {} : {
				context: { contextWindow: spec.contextWindow },
				defaultMaxTokens: spec.maxTokens
			},
			reasoning: {
				efforts: REASONING_EFFORTS.map((id) => ({
					id: ReasoningEffortId(id),
					name: `${id.charAt(0).toUpperCase()}${id.slice(1)}`
				})),
				defaultEffort: ReasoningEffortId(DEFAULT_REASONING_EFFORT)
			}
		});
	}
	async *stream(options) {
		if (options.provider !== "agy-google-antigravity") throw new LlmError(`dsh-antigravity-oauth does not own provider "${options.provider}"`, "NO_ADAPTER");
		if (!isPublicModelId(options.model)) throw new LlmError(`unknown Antigravity model "${options.model}"`, "UNKNOWN_MODEL");
		const oauth = await this.session.refreshIfNeeded();
		if (oauth === void 0) throw new LlmError("Antigravity is not connected. Open Settings and sign in.", "MISSING_CREDENTIAL");
		const effort = effortOf(options);
		const wire = routeChatModel(options.model, effort);
		const functions = functionsFor(options, this.options.nativeSearch);
		const events = this.session.cca.chat(oauth, {
			kind: "chat",
			model: wire,
			contents: convertMessages(options.messages, this.session.thoughtSignatures),
			...options.system === void 0 || options.system.length === 0 ? {} : { system: options.system },
			functions,
			...thinkingLevelFor(options.model, effort) === void 0 ? {} : { thinkingLevel: thinkingLevelFor(options.model, effort) }
		}, options.signal);
		yield* this.emit(options, events);
	}
	async *emit(options, events) {
		let index = 0;
		let text = "";
		let thought = "";
		let usage;
		let finish;
		const toolNames = [];
		const pendingSearches = [];
		const attachments = this.options.resolveAttachments?.();
		const idleMs = this.options.streamIdleTimeoutMs ?? 3e5;
		const watchdog = options.signal === void 0 ? AbortSignal.timeout(idleMs) : AbortSignal.any([options.signal, AbortSignal.timeout(idleMs)]);
		const closeText = function* () {
			if (text.length === 0) return;
			yield {
				type: "block-end",
				index,
				block: {
					type: "text",
					text
				}
			};
			index += 1;
			text = "";
		};
		const closeThought = function* () {
			if (thought.length === 0) return;
			yield {
				type: "block-end",
				index,
				block: {
					type: "reasoning",
					text: thought
				}
			};
			index += 1;
			thought = "";
		};
		try {
			for await (const event of events) {
				if (watchdog.aborted) throw new LlmError("Antigravity stream idle timeout", "TIMEOUT");
				if (event.type === "usage") {
					usage = {
						inputTokens: event.usage.inputTokens,
						outputTokens: event.usage.outputTokens,
						...event.usage.reasoningTokens === void 0 ? {} : { reasoningTokens: event.usage.reasoningTokens },
						...event.usage.cacheReadTokens === void 0 ? {} : { cacheReadTokens: event.usage.cacheReadTokens }
					};
					continue;
				}
				if (event.type === "thought") {
					yield* closeText();
					if (thought.length === 0) yield {
						type: "block-start",
						index,
						blockType: "reasoning"
					};
					thought += event.text;
					yield {
						type: "reasoning-delta",
						index,
						text: event.text
					};
					continue;
				}
				if (event.type === "text") {
					yield* closeThought();
					if (text.length === 0) yield {
						type: "block-start",
						index,
						blockType: "text"
					};
					text += event.text;
					yield {
						type: "text-delta",
						index,
						text: event.text
					};
					continue;
				}
				if (event.type === "functionCall") {
					yield* closeThought();
					yield* closeText();
					if (isDroppedToolName(event.name)) continue;
					if (isSearchWebToolName(event.name) && this.options.nativeSearch) {
						pendingSearches.push(parseSearchWebArgs(event.args));
						continue;
					}
					const id = CallId(event.id ?? `call_${index}`);
					if (event.thoughtSignature !== void 0 && event.thoughtSignature.length > 0) this.session.thoughtSignatures.set(id, event.thoughtSignature);
					const args = JSON.stringify(event.args);
					yield {
						type: "block-start",
						index,
						blockType: "tool-call"
					};
					yield {
						type: "tool-call-delta",
						index,
						id,
						name: event.name,
						argumentsDelta: args
					};
					yield {
						type: "block-end",
						index,
						block: {
							type: "tool-call",
							id,
							name: event.name,
							arguments: args
						}
					};
					toolNames.push(event.name);
					index += 1;
					continue;
				}
				if (event.type === "inlineImage") {
					yield* closeThought();
					yield* closeText();
					yield* this.emitImage(index, event.mimeType, event.data, attachments);
					index += 1;
					continue;
				}
				if (event.type === "finish") finish = event.reason;
			}
			const latest = latestUserText(options.messages);
			if (pendingSearches.length === 0 && toolNames.length === 0 && this.options.nativeSearch && wantsNativeSearch(latest)) pendingSearches.push(latest);
			if (pendingSearches.length > 0) {
				const oauth = await this.session.refreshIfNeeded();
				if (oauth === void 0) throw new LlmError("Antigravity is not connected. Open Settings and sign in.", "MISSING_CREDENTIAL");
				const effort = effortOf(options);
				if (!isPublicModelId(options.model)) throw new LlmError(`unknown Antigravity model "${options.model}"`, "UNKNOWN_MODEL");
				const searchModel = options.model;
				for (const query of pendingSearches) for await (const event of this.session.cca.search(oauth, {
					kind: "search",
					model: routeChatModel(searchModel, effort),
					query,
					...thinkingLevelFor(searchModel, effort) === void 0 ? {} : { thinkingLevel: thinkingLevelFor(searchModel, effort) }
				}, options.signal)) {
					if (event.type === "thought") {
						yield* closeText();
						if (thought.length === 0) yield {
							type: "block-start",
							index,
							blockType: "reasoning"
						};
						thought += event.text;
						yield {
							type: "reasoning-delta",
							index,
							text: event.text
						};
					}
					if (event.type === "text") {
						yield* closeThought();
						if (text.length === 0) yield {
							type: "block-start",
							index,
							blockType: "text"
						};
						text += event.text;
						yield {
							type: "text-delta",
							index,
							text: event.text
						};
					}
					if (event.type === "usage") usage = {
						inputTokens: (usage?.inputTokens ?? 0) + event.usage.inputTokens,
						outputTokens: (usage?.outputTokens ?? 0) + event.usage.outputTokens
					};
				}
			}
			yield* closeThought();
			yield* closeText();
			if (usage !== void 0) yield {
				type: "usage",
				usage
			};
			const kind = toolNames.length > 0 ? "tool-calls" : finish === "MAX_TOKENS" ? "max-tokens" : "stop";
			if (kind === "stop" && index === 0) {
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: `model "${options.model}" returned a completed response with no content`,
							code: "EMPTY_RESPONSE"
						}
					}
				};
				return;
			}
			yield {
				type: "finish",
				reason: { kind }
			};
		} catch (error) {
			if (error instanceof LlmError) throw error;
			const message = error instanceof Error ? error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message : String(error);
			const code = /\b401\b|\b403\b/.test(message) ? "AUTH" : /\b429\b/.test(message) ? "RATE_LIMIT" : /\b5\d\d\b/.test(message) ? "SERVER" : "TRANSPORT";
			throw new LlmError(message, code, { cause: error });
		}
	}
	async *emitImage(index, mimeType, data, attachments) {
		if (attachments !== void 0) {
			const bytes = Buffer.from(data, "base64");
			const attachment = await attachments.saveImage({
				data: bytes,
				mediaType: mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/gif" || mimeType === "image/webp" ? mimeType : "image/png"
			});
			yield {
				type: "block-start",
				index,
				blockType: "image"
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "image",
					attachment
				}
			};
			return;
		}
		yield {
			type: "block-start",
			index,
			blockType: "text"
		};
		yield {
			type: "text-delta",
			index,
			text: `[image ${mimeType} ${data.length} bytes]`
		};
		yield {
			type: "block-end",
			index,
			block: {
				type: "text",
				text: `[image ${mimeType} ${data.length} bytes]`
			}
		};
	}
};
function createAntigravityAdapter(session, options) {
	return new AntigravityAdapter(session, options);
}
//#endregion
//#region src/redact.ts
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token|api[_-]?key|key)=)[^&\s]+/giu, "$1[redacted]").slice(0, 1e3);
}
function isSafeAuthUrl(raw) {
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:") return false;
		const host = url.hostname.toLowerCase();
		return host === "accounts.google.com" || host.endsWith(".google.com");
	} catch {
		return false;
	}
}
//#endregion
//#region src/auth-routes.ts
function trustedRequest(req) {
	const remote = req.socket.remoteAddress;
	if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const host = req.headers.host;
	if (host === void 0) return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === new URL(`http://${host}`).host;
	} catch {
		return false;
	}
}
function json(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(value));
}
async function readJson$1(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 4096) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function codeFrom(value) {
	if (typeof value !== "object" || value === null) throw new Error("expected a JSON object");
	if ("code" in value && typeof value.code === "string") return value.code;
	if ("url" in value && typeof value.url === "string") return value.url;
	if ("value" in value && typeof value.value === "string") return value.value;
	throw new Error("expected { \"code\": \"...\" } or { \"url\": \"...\" }");
}
function registerAntigravityAuthRoutes(ctx, session, options = {}) {
	const notify = async () => {
		await options.onAuthChanged?.();
	};
	ctx.effect(() => {
		const routes = [
			ctx.webServer.register({
				kind: "exact",
				path: AUTH_STATUS_PATH,
				handler: async (req, res) => {
					if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					json(res, 200, await session.snapshot());
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: AUTH_LOGIN_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						const challenge = await session.signIn();
						if (!isSafeAuthUrl(challenge.url)) throw new Error("authorization URL is outside Google accounts");
						json(res, 200, challenge);
						session.waitUntilSettled().then(async () => {
							await notify();
						});
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: AUTH_COMPLETE_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						const account = await session.complete(codeFrom(await readJson$1(req)));
						await notify();
						json(res, 200, {
							ok: true,
							account
						});
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: AUTH_LOGOUT_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						await session.signOut();
						await notify();
						json(res, 200, { ok: true });
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			})
		];
		return async () => {
			for (const dispose of routes) dispose();
			await session.dispose();
		};
	}, "dsh-antigravity-oauth: Web OAuth routes");
}
//#endregion
//#region src/envelope.ts
const INT63_MASK = (1n << 63n) - 1n;
const RANDOM_BOUND = 9000000000000000000n;
const WIRE_PROFILES = {
	"gemini-3.5-flash-extra-low": {
		modelEnum: "MODEL_PLACEHOLDER_M187",
		maxOutputTokens: 65536
	},
	"gemini-3.5-flash-low": {
		modelEnum: "MODEL_PLACEHOLDER_M20",
		maxOutputTokens: 65536
	},
	"gemini-3-flash-agent": {
		modelEnum: "MODEL_PLACEHOLDER_M132",
		maxOutputTokens: 65536
	},
	"gemini-3.7-flash-low": { maxOutputTokens: 65536 },
	"gemini-3.7-flash-medium": { maxOutputTokens: 65536 },
	"gemini-3.7-flash-high": { maxOutputTokens: 65536 }
};
function formatSignedDecimal(value) {
	return `-${value.toString()}`;
}
function randomSignedDecimalSessionId() {
	while (true) {
		const bytes = randomBytes(8);
		let value = 0n;
		for (const byte of bytes) value = value << 8n | BigInt(byte);
		value &= INT63_MASK;
		if (value < RANDOM_BOUND) return formatSignedDecimal(value);
	}
}
function createCcaSession(endpoint = DAILY_ENDPOINT) {
	return {
		agentId: randomUUID(),
		trajectoryId: randomUUID(),
		stepIndex: 1,
		sessionId: randomSignedDecimalSessionId(),
		lastGoodEndpoint: endpoint
	};
}
function advanceEnvelope(session, wireModelId, now = Date.now(), lastExecutionId) {
	session.stepIndex += 1;
	const step = session.stepIndex;
	const profile = WIRE_PROFILES[wireModelId];
	const labels = {
		last_step_index: String(step - 1),
		trajectory_id: session.trajectoryId
	};
	if (lastExecutionId !== void 0 && lastExecutionId.length > 0) labels.last_execution_id = lastExecutionId;
	if (profile?.modelEnum !== void 0) labels.model_enum = profile.modelEnum;
	return {
		requestId: `agent/${session.agentId}/${now}/${session.trajectoryId}/${step}`,
		labels,
		sessionId: session.sessionId,
		step
	};
}
function streamGenerateContentUrl(endpoint) {
	return `${endpoint.replace(/\/+$/, "")}/v1internal:streamGenerateContent?alt=sse`;
}
function systemInstruction(text, role) {
	return role === void 0 ? { parts: [{ text }] } : {
		role,
		parts: [{ text }]
	};
}
function functionTools(functions) {
	if (functions.length === 0) return [{ googleSearch: {} }];
	return [{ functionDeclarations: functions.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parametersJsonSchema: tool.parameters
	})) }];
}
function wrap(projectId, model, request, envelope) {
	return {
		project: projectId,
		model,
		request: {
			...request,
			sessionId: envelope.sessionId,
			labels: envelope.labels
		},
		requestType: "agent",
		userAgent: "antigravity",
		requestId: envelope.requestId
	};
}
function buildChatBody(projectId, input, envelope) {
	const generationConfig = { maxOutputTokens: WIRE_PROFILES[input.model]?.maxOutputTokens ?? 65536 };
	if (input.thinkingLevel !== void 0) generationConfig.thinkingConfig = {
		includeThoughts: true,
		thinkingLevel: input.thinkingLevel
	};
	else generationConfig.thinkingConfig = { includeThoughts: true };
	const tools = functionTools(input.functions);
	const request = {
		contents: input.contents,
		generationConfig,
		tools,
		toolConfig: { functionCallingConfig: { mode: "VALIDATED" } }
	};
	if (input.system !== void 0 && input.system.length > 0) request.systemInstruction = systemInstruction(input.system, "user");
	return wrap(projectId, input.model, request, envelope);
}
function detachedRequestId(now = Date.now()) {
	return `agent/${randomUUID()}/${now}/${randomUUID()}/2`;
}
function buildSearchBody(projectId, input, now = Date.now()) {
	const generationConfig = { maxOutputTokens: WIRE_PROFILES[input.model]?.maxOutputTokens ?? 65536 };
	if (input.thinkingLevel !== void 0) generationConfig.thinkingConfig = {
		includeThoughts: true,
		thinkingLevel: input.thinkingLevel
	};
	else generationConfig.thinkingConfig = { includeThoughts: true };
	return {
		project: projectId,
		model: input.model,
		request: {
			contents: [{
				role: "user",
				parts: [{ text: input.query }]
			}],
			generationConfig,
			tools: [{ googleSearch: {} }]
		},
		requestType: "agent",
		userAgent: "antigravity",
		requestId: detachedRequestId(now)
	};
}
function buildCcaBody(projectId, input, envelope) {
	if (input.kind === "search") return buildSearchBody(projectId, input);
	return buildChatBody(projectId, input, envelope);
}
//#endregion
//#region src/sse.ts
function dataPayload(block) {
	const lines = [];
	for (const line of block.split(/\r?\n/)) if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
	if (lines.length === 0) return void 0;
	return lines.join("\n");
}
async function* readSseJson(stream, signal) {
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted");
			const { done, value } = await reader.read();
			if (value !== void 0) buffer += value;
			const parts = buffer.split(/\r?\n\r?\n/);
			buffer = done ? "" : parts.pop() ?? "";
			const blocks = done && parts.length === 0 && buffer.length > 0 ? [buffer] : parts;
			if (done && parts.length > 0 && buffer.length > 0) blocks.push(buffer);
			for (const block of blocks) {
				const payload = dataPayload(block);
				if (payload === void 0 || payload.length === 0 || payload === "[DONE]") continue;
				yield JSON.parse(payload);
			}
			if (done) return;
		}
	} finally {
		reader.releaseLock();
	}
}
function usageFrom(raw) {
	if (!isRecord(raw)) return void 0;
	const input = typeof raw.promptTokenCount === "number" ? raw.promptTokenCount : 0;
	const output = typeof raw.candidatesTokenCount === "number" ? raw.candidatesTokenCount : 0;
	const reasoning = typeof raw.thoughtsTokenCount === "number" ? raw.thoughtsTokenCount : void 0;
	const cache = typeof raw.cachedContentTokenCount === "number" ? raw.cachedContentTokenCount : void 0;
	return {
		inputTokens: input,
		outputTokens: output,
		...reasoning === void 0 ? {} : { reasoningTokens: reasoning },
		...cache === void 0 || cache === 0 ? {} : { cacheReadTokens: cache }
	};
}
function parseCcaChunk(raw) {
	if (!isRecord(raw)) return [];
	if (isRecord(raw.error)) {
		const message = typeof raw.error.message === "string" ? raw.error.message : JSON.stringify(raw.error);
		const code = typeof raw.error.code === "number" ? raw.error.code : void 0;
		return [{
			type: "error",
			message,
			...code === void 0 ? {} : { code }
		}];
	}
	const response = isRecord(raw.response) ? raw.response : raw;
	if (!isRecord(response)) return [];
	const events = [];
	const usage = usageFrom(response.usageMetadata);
	if (usage !== void 0) events.push({
		type: "usage",
		usage
	});
	const responseId = typeof response.responseId === "string" ? response.responseId : void 0;
	const candidates = Array.isArray(response.candidates) ? response.candidates : [];
	let finishReason;
	for (const candidate of candidates) {
		if (!isRecord(candidate)) continue;
		if (typeof candidate.finishReason === "string") finishReason = candidate.finishReason;
		const content = isRecord(candidate.content) ? candidate.content : void 0;
		const parts = content !== void 0 && Array.isArray(content.parts) ? content.parts : [];
		let lastThoughtSignature;
		for (const part of parts) {
			if (!isRecord(part)) continue;
			const partSignature = typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0 ? part.thoughtSignature : void 0;
			if (part.thought === true && typeof part.text === "string") {
				if (partSignature !== void 0) lastThoughtSignature = partSignature;
				events.push({
					type: "thought",
					text: part.text
				});
				continue;
			}
			if (typeof part.text === "string" && part.text.length > 0) events.push({
				type: "text",
				text: part.text
			});
			if (isRecord(part.functionCall) && typeof part.functionCall.name === "string") {
				const args = isRecord(part.functionCall.args) ? part.functionCall.args : {};
				const callSignature = typeof part.functionCall.thoughtSignature === "string" && part.functionCall.thoughtSignature.length > 0 ? part.functionCall.thoughtSignature : partSignature ?? lastThoughtSignature;
				events.push({
					type: "functionCall",
					name: part.functionCall.name,
					args,
					...typeof part.functionCall.id === "string" ? { id: part.functionCall.id } : {},
					...callSignature === void 0 ? {} : { thoughtSignature: callSignature }
				});
			}
			if (isRecord(part.inlineData) && typeof part.inlineData.data === "string" && typeof part.inlineData.mimeType === "string") events.push({
				type: "inlineImage",
				mimeType: part.inlineData.mimeType,
				data: part.inlineData.data
			});
		}
	}
	if (finishReason !== void 0) events.push({
		type: "finish",
		reason: finishReason,
		...responseId === void 0 ? {} : { responseId }
	});
	return events;
}
//#endregion
//#region src/proxy-fetch.ts
const agents = /* @__PURE__ */ new Map();
function firstEnv(names) {
	for (const name of names) {
		const value = process.env[name];
		if (value !== void 0 && value.length > 0) return value;
	}
}
function noProxyList() {
	return (firstEnv(["NO_PROXY", "no_proxy"]) ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
function hostMatchesNoProxy(host, pattern) {
	const lowerHost = host.toLowerCase();
	const lower = pattern.toLowerCase();
	if (lower === "*") return true;
	if (lower.startsWith(".")) return lowerHost === lower.slice(1) || lowerHost.endsWith(lower);
	return lowerHost === lower || lowerHost.endsWith(`.${lower}`);
}
function proxyUrlFor(target) {
	let url;
	try {
		url = new URL(target);
	} catch {
		return;
	}
	if (noProxyList().some((pattern) => hostMatchesNoProxy(url.hostname, pattern))) return void 0;
	if (url.protocol === "https:") return firstEnv([
		"HTTPS_PROXY",
		"https_proxy",
		"ALL_PROXY",
		"all_proxy",
		"HTTP_PROXY",
		"http_proxy"
	]);
	if (url.protocol === "http:") return firstEnv([
		"HTTP_PROXY",
		"http_proxy",
		"ALL_PROXY",
		"all_proxy"
	]);
}
function agentFor(proxy) {
	const existing = agents.get(proxy);
	if (existing !== void 0) return existing;
	const agent = new ProxyAgent(proxy);
	agents.set(proxy, agent);
	return agent;
}
async function envProxyFetch(input, init) {
	const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
	const proxy = proxyUrlFor(url);
	if (proxy === void 0) return fetch(input, init);
	return fetch$1(url, {
		...init,
		dispatcher: agentFor(proxy)
	});
}
//#endregion
//#region src/user-agent.ts
let discoveredVersion;
let inFlight;
function parseAntigravityManifestVersion(yamlText) {
	for (const line of yamlText.split(/\r?\n/)) {
		const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
		if (match === null) continue;
		const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		return /^\d+\.\d+\.\d+$/.test(version) ? version : void 0;
	}
}
function getAntigravityVersion() {
	return process.env.DSH_ANTIGRAVITY_VERSION || discoveredVersion || "2.11.0";
}
function antigravityUserAgent(version = getAntigravityVersion()) {
	const cl = process.env.DSH_ANTIGRAVITY_CL || "963137146";
	return `antigravity/hub/${version} (aidev_client; os_type=${process.env.DSH_ANTIGRAVITY_OS || "darwin"}; arch=${process.env.DSH_ANTIGRAVITY_ARCH || "arm64"}; cl=${cl})`;
}
function ensureAntigravityVersion(fetcher = fetch, signal) {
	if (process.env.DSH_ANTIGRAVITY_VERSION || discoveredVersion !== void 0) return Promise.resolve();
	if (inFlight !== void 0) return inFlight;
	inFlight = (async () => {
		try {
			const timeout = AbortSignal.timeout(5e3);
			const response = await fetcher(ANTIGRAVITY_VERSION_MANIFEST_URL, {
				headers: {
					"Cache-Control": "no-cache",
					"User-Agent": "electron-builder"
				},
				signal: signal === void 0 ? timeout : AbortSignal.any([signal, timeout])
			});
			if (response.ok) discoveredVersion = parseAntigravityManifestVersion(await response.text());
		} catch {} finally {
			if (discoveredVersion === void 0) inFlight = void 0;
		}
	})();
	return inFlight;
}
//#endregion
//#region src/cca-client.ts
var CcaHttpError = class extends Error {
	status;
	constructor(status, body) {
		super(`CCA ${status}: ${body.slice(0, 800)}`);
		this.name = "CcaHttpError";
		this.status = status;
	}
};
function classifyStatus(status) {
	if (status === 401 || status === 403) return "auth";
	if (status === 429 || status >= 500) return "retry";
	return "fail";
}
var CcaClient = class {
	session;
	fetchImpl;
	userAgent;
	now;
	lastExecutionId;
	constructor(options) {
		this.session = options.session;
		this.fetchImpl = options.fetch ?? envProxyFetch;
		this.userAgent = options.userAgent ?? antigravityUserAgent;
		this.now = options.now ?? Date.now;
	}
	async *chat(oauth, input, signal) {
		yield* this.generate(oauth, input, signal);
	}
	async *search(oauth, input, signal) {
		yield* this.generate(oauth, input, signal);
	}
	endpoints() {
		const last = this.session.lastGoodEndpoint;
		const rest = CCA_ENDPOINTS.filter((endpoint) => endpoint !== last);
		return last.length > 0 ? [last, ...rest] : [...CCA_ENDPOINTS];
	}
	headers(access) {
		return {
			Authorization: `Bearer ${access}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			"User-Agent": this.userAgent()
		};
	}
	async *generate(oauth, input, signal) {
		const body = input.kind === "search" ? buildSearchBody(oauth.projectId, input, this.now()) : buildChatBody(oauth.projectId, input, advanceEnvelope(this.session, input.model, this.now(), this.lastExecutionId));
		const endpoints = this.endpoints();
		let lastError;
		for (let index = 0; index < endpoints.length; index += 1) {
			const endpoint = endpoints[index];
			const url = streamGenerateContentUrl(endpoint);
			try {
				const response = await this.fetchImpl(url, {
					method: "POST",
					headers: this.headers(oauth.access),
					body: JSON.stringify(body),
					signal
				});
				if (!response.ok) {
					const text = await response.text();
					const error = new CcaHttpError(response.status, text);
					if (classifyStatus(response.status) === "retry" && index < endpoints.length - 1) {
						lastError = error;
						continue;
					}
					throw error;
				}
				if (response.body === null) throw new Error("CCA stream had no body");
				this.session.lastGoodEndpoint = endpoint;
				let sawFinish = false;
				for await (const raw of readSseJson(response.body, signal)) {
					const events = parseCcaChunk(raw);
					for (const event of events) {
						if (event.type === "finish" && event.responseId !== void 0) {
							if (input.kind === "chat") this.lastExecutionId = event.responseId;
							sawFinish = true;
						}
						if (event.type === "error") throw new Error(event.message);
						yield event;
					}
				}
				if (!sawFinish) yield {
					type: "finish",
					reason: "STOP"
				};
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (signal?.aborted) throw lastError;
				if (index === endpoints.length - 1) throw lastError;
			}
		}
		throw lastError ?? /* @__PURE__ */ new Error("CCA request failed");
	}
};
//#endregion
//#region src/oauth.ts
const CLIENT_ID = atob("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==");
const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs"
];
const LOAD_CODE_ASSIST_BODY = Object.freeze({ metadata: { ideType: "ANTIGRAVITY" } });
function newOAuthState() {
	return randomBytes(16).toString("hex");
}
function authorizationUrl(state, redirectUri = CALLBACK_URI) {
	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: SCOPES.join(" "),
		state,
		access_type: "offline",
		prompt: "consent"
	});
	return `${AUTH_URL}?${params.toString()}`;
}
function extractOAuthCode(raw) {
	const trimmed = raw.trim();
	if (trimmed.includes("://") || trimmed.includes("?")) {
		const url = new URL(trimmed);
		const code = url.searchParams.get("code");
		if (code === null || code.length === 0) throw new Error("authorization response is missing code");
		const state = url.searchParams.get("state");
		return state === null ? { code } : {
			code,
			state
		};
	}
	if (trimmed.length === 0) throw new Error("authorization code is empty");
	return { code: trimmed };
}
function parseTokenPayload(raw, filename) {
	if (!isRecord(raw)) throw new Error(`${filename} token response must be an object`);
	if (typeof raw.access_token !== "string" || raw.access_token.length === 0) throw new Error(`${filename} token response is missing access_token`);
	if (typeof raw.expires_in !== "number" || !Number.isFinite(raw.expires_in)) throw new Error(`${filename} token response is missing expires_in`);
	return {
		access_token: raw.access_token,
		expires_in: raw.expires_in,
		...typeof raw.refresh_token === "string" ? { refresh_token: raw.refresh_token } : {}
	};
}
async function readJson(response, label) {
	const text = await response.text();
	if (!response.ok) throw new Error(`${label} failed: ${response.status} ${response.statusText}: ${text.slice(0, 800)}`);
	if (text.length === 0) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${label} returned invalid JSON`);
	}
}
async function exchangeAuthorizationCode(code, redirectUri = CALLBACK_URI, fetcher = fetch, now = Date.now()) {
	const payload = parseTokenPayload(await readJson(await fetcher(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri
		})
	}), "token exchange"), "token exchange");
	if (payload.refresh_token === void 0 || payload.refresh_token.length === 0) throw new Error("No refresh token received. Please try again.");
	return {
		type: "oauth",
		access: payload.access_token,
		refresh: payload.refresh_token,
		expires: now + payload.expires_in * 1e3 - OAUTH_EXPIRES_SKEW_MS
	};
}
async function refreshAccessToken(current, fetcher = fetch, now = Date.now()) {
	const payload = parseTokenPayload(await readJson(await fetcher(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: current.refresh,
			grant_type: "refresh_token"
		})
	}), "token refresh"), "token refresh");
	return {
		type: "oauth",
		access: payload.access_token,
		refresh: payload.refresh_token ?? current.refresh,
		expires: now + payload.expires_in * 1e3 - OAUTH_EXPIRES_SKEW_MS,
		projectId: current.projectId,
		...current.email === void 0 ? {} : { email: current.email }
	};
}
async function fetchUserEmail(accessToken, fetcher = fetch) {
	try {
		const response = await fetcher(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
		if (!response.ok) return void 0;
		const payload = await response.json();
		return isRecord(payload) && typeof payload.email === "string" ? payload.email : void 0;
	} catch {
		return;
	}
}
function assistHeaders(accessToken) {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": antigravityUserAgent()
	};
}
function parseLoadCodeAssist(payload) {
	if (!isRecord(payload)) throw new Error("loadCodeAssist response must be an object");
	const projectId = typeof payload.cloudaicompanionProject === "string" && payload.cloudaicompanionProject.length > 0 ? payload.cloudaicompanionProject : void 0;
	const hasCurrentTier = payload.currentTier !== void 0 && payload.currentTier !== null;
	const allowed = Array.isArray(payload.allowedTiers) ? payload.allowedTiers.some((tier) => isRecord(tier) && tier.id === "free-tier") : false;
	const ineligible = Array.isArray(payload.ineligibleTiers) ? payload.ineligibleTiers.find((tier) => isRecord(tier) && tier.tierId === "free-tier") : void 0;
	return {
		projectId,
		hasCurrentTier,
		freeTierAllowed: allowed,
		ineligibility: isRecord(ineligible) && typeof ineligible.reasonMessage === "string" ? {
			reasonMessage: ineligible.reasonMessage,
			...typeof ineligible.validationUrl === "string" && ineligible.validationUrl.length > 0 ? { validationUrl: ineligible.validationUrl } : {}
		} : void 0
	};
}
async function postLoadCodeAssist(accessToken, fetcher, signal) {
	return parseLoadCodeAssist(await readJson(await fetcher(`${DAILY_ENDPOINT}${LOAD_CODE_ASSIST_PATH}`, {
		method: "POST",
		headers: assistHeaders(accessToken),
		body: JSON.stringify(LOAD_CODE_ASSIST_BODY),
		signal
	}), "loadCodeAssist"));
}
async function onboardUser(accessToken, fetcher, signal) {
	const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
	const remaining = () => {
		const left = deadline - Date.now();
		if (left <= 0) throw new Error(`onboardUser timed out after ${ONBOARD_TIMEOUT_MS}ms`);
		return left;
	};
	const headers = assistHeaders(accessToken);
	let response = await fetcher(`${DAILY_ENDPOINT}${ONBOARD_USER_PATH}`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			tierId: FREE_TIER_ID,
			metadata: LOAD_CODE_ASSIST_BODY.metadata
		}),
		signal: signal === void 0 ? AbortSignal.timeout(remaining()) : AbortSignal.any([signal, AbortSignal.timeout(remaining())])
	});
	let payload = await readJson(response, "onboardUser");
	while (true) {
		if (!isRecord(payload)) throw new Error("onboardUser response must be an object");
		if (payload.done === true) {
			if (payload.error !== void 0 && payload.error !== null) {
				const error = isRecord(payload.error) ? payload.error : {};
				const message = typeof error.message === "string" ? error.message : JSON.stringify(payload.error);
				throw new Error(`OnboardUser operation failed: ${message}`);
			}
			if (payload.response === void 0 || payload.response === null) throw new Error("failed to unmarshal OnboardUserResponse");
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(ONBOARD_POLL_INTERVAL_MS, remaining())));
		const name = typeof payload.name === "string" ? payload.name : "";
		if (name.length === 0) throw new Error("onboardUser returned an operation without a name");
		response = await fetcher(`${DAILY_ENDPOINT}/v1internal/${name}`, {
			method: "GET",
			headers,
			signal: signal === void 0 ? AbortSignal.timeout(remaining()) : AbortSignal.any([signal, AbortSignal.timeout(remaining())])
		});
		payload = await readJson(response, "onboardUser operation");
	}
}
async function discoverProject(accessToken, fetcher = fetch, signal) {
	const initial = await postLoadCodeAssist(accessToken, fetcher, signal);
	if (!initial.freeTierAllowed && initial.ineligibility !== void 0) {
		const extra = initial.ineligibility.validationUrl === void 0 ? "" : `\n${initial.ineligibility.validationUrl}`;
		throw new Error(`${initial.ineligibility.reasonMessage}${extra}`);
	}
	if (!initial.hasCurrentTier) await onboardUser(accessToken, fetcher, signal);
	const refreshed = await postLoadCodeAssist(accessToken, fetcher, signal);
	if (refreshed.projectId !== void 0) return refreshed.projectId;
	throw new Error("loadCodeAssist did not return a cloudaicompanionProject");
}
async function completeOAuthLogin(code, fetcher = fetch, now = Date.now(), signal) {
	const tokens = await exchangeAuthorizationCode(code, CALLBACK_URI, fetcher, now);
	const email = await fetchUserEmail(tokens.access, fetcher);
	const projectId = await discoverProject(tokens.access, fetcher, signal);
	return {
		...tokens,
		projectId,
		...email === void 0 ? {} : { email }
	};
}
//#endregion
//#region src/session.ts
function html(ok) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? "Signed in" : "Sign-in failed"}</title></head><body><p>${ok ? "You can close this window and return to DeepSeek Harness." : "Authorization failed. Return to DeepSeek Harness and try again."}</p></body></html>`;
}
var AntigravitySession = class {
	store;
	cca;
	ccaSession;
	thoughtSignatures = /* @__PURE__ */ new Map();
	fetchImpl;
	lastRefreshAttempt = 0;
	operation;
	cancellation;
	pendingUrl;
	pendingState;
	callbackServer;
	account = { status: "signed-out" };
	constructor(store, fetchImpl = envProxyFetch) {
		this.store = store;
		this.fetchImpl = fetchImpl;
		this.ccaSession = createCcaSession();
		this.cca = new CcaClient({
			session: this.ccaSession,
			fetch: fetchImpl
		});
	}
	async snapshot() {
		if (this.operation !== void 0) return this.account;
		if (this.account.status === "error") return this.account;
		return this.readStored();
	}
	async readStored() {
		const credential = await this.store.read();
		if (credential === void 0) return { status: "signed-out" };
		return {
			status: "signed-in",
			projectId: credential.projectId,
			...credential.email === void 0 ? {} : { email: credential.email },
			...Number.isNaN(credential.expires) ? {} : { expiresAt: new Date(credential.expires).toISOString() }
		};
	}
	async credential() {
		return this.store.read();
	}
	async requireCredential() {
		const credential = await this.refreshIfNeeded();
		if (credential === void 0) throw new Error("Antigravity is not connected. Open Settings and sign in.");
		return credential;
	}
	async refreshIfNeeded(now = Date.now()) {
		const current = await this.store.read();
		if (current === void 0) return void 0;
		if (now < current.expires - 9e5) return current;
		if (now - this.lastRefreshAttempt < 3e5) return current;
		this.lastRefreshAttempt = now;
		try {
			const next = await refreshAccessToken(current, this.fetchImpl, now);
			await this.store.write(next);
			return next;
		} catch {
			return current;
		}
	}
	async signIn() {
		if (this.operation === void 0) this.startLogin();
		if (this.pendingUrl !== void 0) return { url: this.pendingUrl };
		await this.operation?.catch(() => void 0);
		if (this.pendingUrl !== void 0) return { url: this.pendingUrl };
		if (this.account.status === "error") throw new Error(this.account.message);
		if ((await this.readStored()).status === "signed-in") throw new Error("already signed in");
		throw new Error("login did not produce an authorization URL");
	}
	async waitUntilSettled() {
		await this.operation?.catch(() => void 0);
	}
	async complete(raw) {
		const extracted = extractOAuthCode(raw);
		if (this.pendingState !== void 0 && extracted.state !== void 0 && extracted.state !== this.pendingState) throw new Error("OAuth state mismatch");
		const credential = await completeOAuthLogin(extracted.code, this.fetchImpl);
		await this.store.write(credential);
		this.account = await this.readStored();
		this.pendingUrl = void 0;
		this.pendingState = void 0;
		this.cancellation?.abort(/* @__PURE__ */ new Error("Antigravity login completed"));
		this.stopCallbackServer();
		await this.waitUntilSettled();
		this.operation = void 0;
		this.cancellation = void 0;
		return this.account;
	}
	async signOut() {
		this.cancellation?.abort(/* @__PURE__ */ new Error("Antigravity login cancelled"));
		await this.operation?.catch(() => void 0);
		this.stopCallbackServer();
		await this.store.clear();
		this.account = { status: "signed-out" };
		this.pendingUrl = void 0;
		this.pendingState = void 0;
	}
	async dispose() {
		this.cancellation?.abort(/* @__PURE__ */ new Error("Antigravity plugin disposed"));
		await this.operation?.catch(() => void 0);
		this.stopCallbackServer();
	}
	startLogin() {
		const cancellation = new AbortController();
		this.cancellation = cancellation;
		const state = newOAuthState();
		this.pendingState = state;
		const url = authorizationUrl(state);
		if (!isSafeAuthUrl(url)) {
			this.account = {
				status: "error",
				message: "authorization URL is outside Google accounts"
			};
			return;
		}
		this.pendingUrl = url;
		this.account = {
			status: "signing-in",
			url
		};
		ensureAntigravityVersion(this.fetchImpl, cancellation.signal);
		this.operation = this.listenForCallback(state, cancellation.signal).then(async (code) => {
			const credential = await completeOAuthLogin(code, this.fetchImpl, Date.now(), cancellation.signal);
			await this.store.write(credential);
			this.account = await this.readStored();
		}, (error) => {
			if (this.account.status === "signed-in") return;
			this.account = {
				status: "error",
				message: safeMessage(error)
			};
		}).finally(() => {
			this.operation = void 0;
			this.cancellation = void 0;
			this.stopCallbackServer();
		});
	}
	listenForCallback(state, signal) {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => {
				try {
					const requestUrl = new URL(req.url ?? "/", CALLBACK_URI);
					if (requestUrl.pathname !== "/oauth-callback") {
						res.writeHead(404, { "content-type": "text/plain" });
						res.end("not found");
						return;
					}
					const code = requestUrl.searchParams.get("code");
					const returnedState = requestUrl.searchParams.get("state");
					if (code === null || code.length === 0 || returnedState !== state) {
						res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
						res.end(html(false));
						reject(/* @__PURE__ */ new Error("OAuth callback is missing code or state"));
						return;
					}
					res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
					res.end(html(true));
					resolve(code);
				} catch (error) {
					reject(error);
				}
			});
			this.callbackServer = server;
			const onAbort = () => {
				this.stopCallbackServer();
				reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("login cancelled"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			server.once("error", reject);
			server.listen(CALLBACK_PORT, "127.0.0.1");
		});
	}
	stopCallbackServer() {
		this.callbackServer?.close();
		this.callbackServer = void 0;
	}
};
//#endregion
//#region src/store.ts
const AUTH_FORMAT_VERSION = 1;
const OAUTH_FIELDS = /* @__PURE__ */ new Set([
	"type",
	"access",
	"refresh",
	"expires",
	"projectId",
	"email"
]);
function isENOENT(error) {
	return error?.code === "ENOENT";
}
async function assertOwnerOnly(filename) {
	let mode;
	try {
		mode = (await stat(filename)).mode;
	} catch (error) {
		if (isENOENT(error)) return;
		throw error;
	}
	if (process.platform === "win32") return;
	if ((mode & 63) !== 0) throw new Error(`dsh-antigravity-oauth: ${filename} is readable beyond its owner (mode ${(mode & 511).toString(8)}); run "chmod 600 ${filename}" before starting again`);
}
function parseAntigravityOAuth(raw, filename) {
	if (!isRecord(raw)) throw new Error(`dsh-antigravity-oauth: ${filename} credential must be an object`);
	if (raw.type !== "oauth") throw new Error(`dsh-antigravity-oauth: ${filename} credential type must be oauth`);
	if (Object.keys(raw).some((key) => !OAUTH_FIELDS.has(key))) throw new Error(`dsh-antigravity-oauth: ${filename} credential contains an unknown field`);
	if (typeof raw.access !== "string" || raw.access.length === 0) throw new Error(`dsh-antigravity-oauth: ${filename} access must be a non-empty string`);
	if (typeof raw.refresh !== "string" || raw.refresh.length === 0) throw new Error(`dsh-antigravity-oauth: ${filename} refresh must be a non-empty string`);
	if (typeof raw.expires !== "number" || !Number.isFinite(raw.expires) || raw.expires <= 0) throw new Error(`dsh-antigravity-oauth: ${filename} expires must be a positive finite number`);
	if (typeof raw.projectId !== "string" || raw.projectId.length === 0) throw new Error(`dsh-antigravity-oauth: ${filename} projectId must be a non-empty string`);
	if (raw.email !== void 0 && typeof raw.email !== "string") throw new Error(`dsh-antigravity-oauth: ${filename} email must be a string`);
	return {
		type: "oauth",
		access: raw.access,
		refresh: raw.refresh,
		expires: raw.expires,
		projectId: raw.projectId,
		...typeof raw.email === "string" ? { email: raw.email } : {}
	};
}
function parseDocument(text, filename) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`dsh-antigravity-oauth: ${filename} is not valid JSON`);
	}
	if (!isRecord(value)) throw new Error(`dsh-antigravity-oauth: ${filename} must contain an object`);
	if (value.version !== AUTH_FORMAT_VERSION) throw new Error(`dsh-antigravity-oauth: ${filename} has unsupported auth format version ${String(value.version)}`);
	if (Object.keys(value).some((key) => key !== "version" && key !== "credential")) throw new Error(`dsh-antigravity-oauth: ${filename} contains an unknown top-level field`);
	if (value.credential === void 0) return void 0;
	return {
		version: AUTH_FORMAT_VERSION,
		credential: parseAntigravityOAuth(value.credential, filename)
	};
}
function antigravityAuthPath(dshHome) {
	return resolve(join(resolveDshHome(dshHome), AUTH_FILENAME));
}
var AntigravityCredentialStore = class {
	filename;
	constructor(filename = antigravityAuthPath()) {
		this.filename = resolve(filename);
	}
	async readDocument() {
		await assertOwnerOnly(this.filename);
		try {
			return parseDocument(await readFile(this.filename, "utf8"), this.filename);
		} catch (error) {
			if (isENOENT(error)) return void 0;
			throw error;
		}
	}
	async read() {
		const document = await this.readDocument();
		return document === void 0 ? void 0 : structuredClone(document.credential);
	}
	async write(credential) {
		const next = parseAntigravityOAuth(credential, this.filename);
		await mkdir(dirname(this.filename), {
			recursive: true,
			mode: 448
		});
		return withFileLock(this.filename, async () => {
			await writeFileAtomic(this.filename, `${JSON.stringify({
				version: AUTH_FORMAT_VERSION,
				credential: next
			}, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
			return structuredClone(next);
		});
	}
	async modify(fn) {
		await mkdir(dirname(this.filename), {
			recursive: true,
			mode: 448
		});
		return withFileLock(this.filename, async () => {
			const current = (await this.readDocument())?.credential;
			const candidate = await fn(current === void 0 ? void 0 : structuredClone(current));
			if (candidate === void 0) return current === void 0 ? void 0 : structuredClone(current);
			const next = parseAntigravityOAuth(candidate, this.filename);
			await writeFileAtomic(this.filename, `${JSON.stringify({
				version: AUTH_FORMAT_VERSION,
				credential: next
			}, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
			return structuredClone(next);
		});
	}
	async clear() {
		await rm(this.filename, { force: true });
	}
};
//#endregion
//#region src/plugin-config.ts
const Config = z.object({
	streamIdleTimeoutMs: z.number().min(1).default(STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema,
	nativeTools: z.boolean().default(true),
	nativeSearch: z.boolean().default(true)
});
//#endregion
//#region src/index.ts
const name = "llm-antigravity-oauth";
const inject = ["llm"];
async function syncAuthenticatedRoute(session, registration) {
	const credential = await session.credential();
	registration.replace(credential === void 0 ? [] : [HARNESS_ROUTE]);
}
function apply(ctx, config) {
	console.log("[my-plugins/dsh-antigravity-oauth] loaded");
	const session = new AntigravitySession(new AntigravityCredentialStore());
	const registration = ctx.llm.registerAdapter([HARNESS_ROUTE], createAntigravityAdapter(session, {
		nativeTools: config.nativeTools !== false,
		nativeSearch: config.nativeSearch !== false,
		streamIdleTimeoutMs: config.streamIdleTimeoutMs,
		resolveAttachments: () => ctx.get("attachments")
	}));
	const refreshRoutes = () => syncAuthenticatedRoute(session, registration);
	refreshRoutes();
	ensureAntigravityVersion(envProxyFetch);
	ctx.effect(() => {
		const timer = setInterval(() => {
			session.refreshIfNeeded().catch(() => {});
		}, OAUTH_REFRESH_POLL_MS);
		session.refreshIfNeeded().catch(() => {});
		return () => clearInterval(timer);
	}, "dsh-antigravity-oauth: refresh oauth grant");
	ctx.inject(["webServer"], (webCtx) => {
		registerAntigravityAuthRoutes(webCtx, session, { onAuthChanged: refreshRoutes });
	});
	if (config.nativeTools !== false) ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.on("system-prompt/assemble", async (_assembly, context, next) => {
			const assembled = await next();
			return context.agent?.options?.provider === "agy-google-antigravity" ? maskDshWebAssembly(assembled) : assembled;
		});
	});
}
//#endregion
export { AUTH_COMPLETE_PATH, AUTH_FILENAME, AUTH_LOGIN_PATH, AUTH_LOGOUT_PATH, AUTH_STATUS_PATH, AntigravityCredentialStore, AntigravitySession, BOOT_MARKER, CcaClient, Config, HARNESS_ROUTE, LOAD_CODE_ASSIST_BODY, SCOPES, antigravityAuthPath, apply, authorizationUrl, buildCcaBody, createAntigravityAdapter, createCcaSession, inject, name, registerAntigravityAuthRoutes, streamGenerateContentUrl };
