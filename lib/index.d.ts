import { GenerateOptions, LlmAdapter, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, RetryPolicyConfig, StreamChunk } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/plugin-config.d.ts
interface Config {
  streamIdleTimeoutMs?: number;
  retryPolicy?: RetryPolicyConfig;
  nativeTools?: boolean;
  nativeSearch?: boolean;
}
declare const Config: z<Config>;
//#endregion
//#region src/types.d.ts
type CcaKind = 'chat' | 'search';
type AntigravityGrant = {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
  projectId?: string;
  email?: string;
};
type AntigravityOAuth = AntigravityGrant & {
  projectId: string;
};
type EligibilitySummary = {
  hasProject: boolean;
  hasCurrentTier: boolean;
  freeTierAllowed: boolean;
  defaultTier?: string;
  rejected: boolean;
};
type CcaSession = {
  agentId: string;
  trajectoryId: string;
  stepIndex: number;
  sessionId: string;
  lastGoodEndpoint: string;
};
type ChatWireModelId = 'gemini-3.8-flash-low' | 'gemini-3.8-flash-medium' | 'gemini-3.8-flash-high' | 'gemini-3.7-flash-low' | 'gemini-3.7-flash-medium' | 'gemini-3.7-flash-high' | 'gemini-3.5-flash-extra-low' | 'gemini-3.5-flash-low' | 'gemini-3-flash-agent';
type GeminiPart = {
  text: string;
  thought?: boolean;
  thoughtSignature?: string;
} | {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  thoughtSignature?: string;
} | {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
    id?: string;
  };
} | {
  inlineData: {
    mimeType: string;
    data: string;
  };
};
type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};
type FunctionToolDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
type ChatGenerateInput = {
  kind: 'chat';
  model: ChatWireModelId;
  contents: GeminiContent[];
  system?: string;
  functions: readonly FunctionToolDeclaration[];
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
};
type SearchGenerateInput = {
  kind: 'search';
  model: ChatWireModelId;
  query: string;
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
};
type CcaGenerateInput = ChatGenerateInput | SearchGenerateInput;
type CcaUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
};
type CcaEvent = {
  type: 'text';
  text: string;
} | {
  type: 'thought';
  text: string;
} | {
  type: 'functionCall';
  id?: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
} | {
  type: 'inlineImage';
  mimeType: string;
  data: string;
} | {
  type: 'usage';
  usage: CcaUsage;
} | {
  type: 'finish';
  reason: string;
  responseId?: string;
} | {
  type: 'error';
  code?: number;
  message: string;
};
type AntigravityAccountState = {
  status: 'signed-out';
} | {
  status: 'signing-in';
  url?: string;
} | {
  status: 'authorized';
  email?: string;
  message: string;
  eligibility?: EligibilitySummary;
} | {
  status: 'signed-in';
  email?: string;
  expiresAt?: string;
  projectId: string;
} | {
  status: 'error';
  message: string;
};
//#endregion
//#region src/envelope.d.ts
declare function createCcaSession(endpoint?: string): CcaSession;
type RequestEnvelope = {
  requestId: string;
  labels: Record<string, string>;
  sessionId: string;
  step: number;
};
declare function streamGenerateContentUrl(endpoint: string): string;
type CcaRequestBody = {
  project: string;
  model: string;
  request: Record<string, unknown>;
  requestType: 'agent';
  userAgent: 'antigravity';
  requestId: string;
};
declare function buildCcaBody(projectId: string, input: CcaGenerateInput, envelope: RequestEnvelope): CcaRequestBody;
//#endregion
//#region src/cca-client.d.ts
type CcaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CcaClientOptions = {
  session: CcaSession;
  fetch?: CcaFetch;
  userAgent?: () => string;
  now?: () => number;
};
declare class CcaClient {
  readonly session: CcaSession;
  private readonly fetchImpl;
  private readonly userAgent;
  private readonly now;
  private lastExecutionId;
  constructor(options: CcaClientOptions);
  chat(oauth: AntigravityOAuth, input: ChatGenerateInput, signal?: AbortSignal): AsyncIterable<CcaEvent>;
  search(oauth: AntigravityOAuth, input: SearchGenerateInput, signal?: AbortSignal): AsyncIterable<CcaEvent>;
  private endpoints;
  private headers;
  private generate;
}
//#endregion
//#region src/store.d.ts
declare function antigravityAuthPath(dshHome?: string): string;
declare class AntigravityCredentialStore {
  readonly filename: string;
  constructor(filename?: string);
  private readDocument;
  read(): Promise<AntigravityGrant | undefined>;
  write(credential: AntigravityGrant): Promise<AntigravityGrant>;
  modify(fn: (current: AntigravityGrant | undefined) => Promise<AntigravityGrant | undefined>): Promise<AntigravityGrant | undefined>;
  clear(): Promise<void>;
}
//#endregion
//#region src/network.d.ts
type NetworkSettings = {
  mode: 'auto' | 'direct' | 'proxy';
  url: string;
};
declare class AntigravityNetwork {
  readonly filename: string;
  private agents;
  constructor(filename: string);
  read(): Promise<NetworkSettings>;
  save(value: unknown): Promise<void>;
  snapshot(): Promise<{
    effective: string;
    mode: "auto" | "direct" | "proxy";
    url: string;
  }>;
  fetch: typeof fetch;
  dispose(): Promise<void>;
}
//#endregion
//#region src/session.d.ts
type FetchImpl = typeof fetch;
declare class AntigravitySession {
  readonly store: AntigravityCredentialStore;
  readonly cca: CcaClient;
  readonly ccaSession: CcaSession;
  readonly thoughtSignatures: Map<string, string>;
  private readonly fetchImpl;
  private lastRefreshAttempt;
  private operation;
  private cancellation;
  private listening;
  private pendingUrl;
  private pendingState;
  private callbackServer;
  private account;
  readonly network: AntigravityNetwork;
  private serviceError;
  private completing;
  private eligibility;
  constructor(store: AntigravityCredentialStore, fetchImpl?: FetchImpl);
  snapshot(): Promise<AntigravityAccountState>;
  readStored(): Promise<AntigravityAccountState>;
  credential(): Promise<AntigravityOAuth | undefined>;
  requireCredential(): Promise<AntigravityOAuth>;
  refreshIfNeeded(now?: number): Promise<AntigravityOAuth | undefined>;
  private refreshGrant;
  signIn(): Promise<{
    url: string;
  }>;
  waitUntilSettled(): Promise<void>;
  complete(raw: string): Promise<AntigravityAccountState>;
  private finishCode;
  retryEligibility(): Promise<AntigravityAccountState>;
  cancel(): Promise<void>;
  signOut(): Promise<void>;
  dispose(): Promise<void>;
  private startLogin;
  private runLogin;
  private listenForCallback;
  private stopCallbackServer;
}
//#endregion
//#region src/adapter.d.ts
interface AntigravityAdapterOptions {
  nativeTools: boolean;
  nativeSearch: boolean;
  streamIdleTimeoutMs?: number;
  resolveAttachments?: () => AttachmentStore | undefined;
}
declare class AntigravityAdapter extends LlmAdapter {
  private readonly session;
  private readonly options;
  constructor(session: AntigravitySession, options: AntigravityAdapterOptions);
  providerInfo(provider: string): LlmProviderInfo;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  private emitChat;
  private collectSearch;
  private closeText;
  private closeThought;
  private emitImage;
}
declare function createAntigravityAdapter(session: AntigravitySession, options: AntigravityAdapterOptions): AntigravityAdapter;
//#endregion
//#region src/auth-routes.d.ts
interface AuthRouteOptions {
  onAuthChanged?: () => void | Promise<void>;
}
declare function registerAntigravityAuthRoutes(ctx: Context, session: AntigravitySession, options?: AuthRouteOptions): void;
//#endregion
//#region src/ids.d.ts
declare const AUTH_FILENAME = ".dsh-antigravity-oauth.json";
declare const HARNESS_ROUTE = "agy-google-antigravity";
declare const BOOT_MARKER = "[my-plugins/dsh-antigravity-oauth] loaded";
declare const AUTH_STATUS_PATH = "/plugins/dsh-antigravity-oauth/auth/status";
declare const AUTH_LOGIN_PATH = "/plugins/dsh-antigravity-oauth/auth/login";
declare const AUTH_COMPLETE_PATH = "/plugins/dsh-antigravity-oauth/auth/complete";
declare const AUTH_LOGOUT_PATH = "/plugins/dsh-antigravity-oauth/auth/logout";
//#endregion
//#region src/oauth.d.ts
declare const SCOPES: readonly ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/cclog", "https://www.googleapis.com/auth/experimentsandconfigs"];
declare const LOAD_CODE_ASSIST_BODY: Readonly<{
  metadata: {
    ideType: string;
  };
}>;
declare function authorizationUrl(state: string, redirectUri?: string): string;
//#endregion
//#region src/search-turn.d.ts
declare const SEARCH_FOLLOW_UP_LIMIT = 3;
declare const SEARCH_CONTINUE_GUIDANCE = "Search results are source material for you, not the user-facing answer. Continue the original task. Reply in the same language the user used. Use other tools if you still need local files or commands.";
type SearchTurnCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
};
declare function appendSearchTurns(contents: readonly GeminiContent[], calls: readonly SearchTurnCall[], results: readonly string[]): GeminiContent[];
declare function appendSearchMemo(contents: readonly GeminiContent[], query: string, result: string): GeminiContent[];
declare const THOUGHT_ONLY_CONTINUE = "You produced only internal reasoning and stopped. Continue the original user task now. If you need public documentation or current product facts, call search_web. Then answer in the same language the user used. Do not stop after thinking.";
declare const SEARCH_ANSWER_GUIDANCE = "You already ran web search. The results above are source material. Answer the user now in their language. Do not call search_web. Use other tools only if you still need local files.";
declare function withoutSearchWeb(functions: readonly FunctionToolDeclaration[]): FunctionToolDeclaration[];
declare function appendSearchDossier(contents: readonly GeminiContent[], rounds: readonly {
  query: string;
  result: string;
}[]): GeminiContent[];
declare function appendContinueMemo(contents: readonly GeminiContent[]): GeminiContent[];
//#endregion
//#region src/index.d.ts
type NativeAssembly = {
  tools: {
    name: string;
  }[];
  sections: {
    name: string;
    text: string;
  }[];
};
type NativeAssembleContext = {
  agent?: {
    options?: {
      provider?: string;
    };
  };
};
declare module '@deepseek-ai/cordis' {
  interface Events {
    'system-prompt/assemble'(assembly: NativeAssembly, context: NativeAssembleContext, next: () => Promise<NativeAssembly>): Promise<NativeAssembly>;
  }
}
declare const name = "llm-antigravity-oauth";
declare const inject: string[];
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { AUTH_COMPLETE_PATH, AUTH_FILENAME, AUTH_LOGIN_PATH, AUTH_LOGOUT_PATH, AUTH_STATUS_PATH, AntigravityCredentialStore, type AntigravityOAuth, AntigravitySession, BOOT_MARKER, CcaClient, type CcaKind, type CcaSession, Config, type Config as PluginConfig, HARNESS_ROUTE, LOAD_CODE_ASSIST_BODY, SCOPES, SEARCH_ANSWER_GUIDANCE, SEARCH_CONTINUE_GUIDANCE, SEARCH_FOLLOW_UP_LIMIT, THOUGHT_ONLY_CONTINUE, antigravityAuthPath, appendContinueMemo, appendSearchDossier, appendSearchMemo, appendSearchTurns, apply, authorizationUrl, buildCcaBody, createAntigravityAdapter, createCcaSession, inject, name, registerAntigravityAuthRoutes, streamGenerateContentUrl, withoutSearchWeb };