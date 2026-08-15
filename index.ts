import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "pi-usage";
const REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const CODEX_FALLBACK_BASE_URL = "https://chatgpt.com/backend-api";
const GROK_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLIENT_VERSION = "1.0.3";
const MAX_RESPONSE_BYTES = 64 * 1024;

type UnknownRecord = Record<string, unknown>;

export interface UsageWindow {
  label: string;
  usedPercent?: number;
  resetsAt?: number;
}

export interface ProviderAuthResult {
  auth: {
    apiKey?: string;
    headers?: Record<string, string | null>;
    baseUrl?: string;
  };
  source?: string;
}

type ProviderState =
  | { kind: "loading" }
  | { kind: "login"; command?: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; windows: UsageWindow[] };

export interface UsageState {
  anthropic: ProviderState;
  codex: ProviderState;
  grok: ProviderState;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function parseResetTime(value: unknown): number | undefined {
  const epoch = resolveEpochTime(value);
  if (epoch !== undefined) return epoch;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanLabel(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32)
    .trim();
  return cleaned || fallback;
}

function parseAnthropicBucket(value: unknown, label: string): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = finiteNumber(value.utilization);
  const resetsAt = parseResetTime(value.resets_at);
  if (usedPercent === undefined && resetsAt === undefined) return undefined;
  return { label, usedPercent, resetsAt };
}

function scopedModelName(scope: unknown): string | undefined {
  if (!isRecord(scope) || !isRecord(scope.model)) return undefined;
  const name = cleanLabel(scope.model.display_name);
  return name || undefined;
}

/** Parse both legacy Claude buckets and the current generic limits array. */
export function parseAnthropicUsage(payload: unknown): UsageWindow[] | null {
  if (!isRecord(payload)) return null;

  const generic: UsageWindow[] = [];
  let hasSession = false;
  let hasWeeklyAll = false;

  if (Array.isArray(payload.limits)) {
    for (const entry of payload.limits) {
      if (!isRecord(entry) || typeof entry.kind !== "string") continue;
      const usedPercent = finiteNumber(entry.percent);
      const resetsAt = parseResetTime(entry.resets_at);
      if (usedPercent === undefined && resetsAt === undefined) continue;

      let label: string | undefined;
      if (entry.kind === "session") {
        label = "5h";
        hasSession = true;
      } else if (entry.kind === "weekly_all") {
        label = "Week";
        hasWeeklyAll = true;
      } else if (entry.kind === "weekly_scoped") {
        label = scopedModelName(entry.scope);
      }
      if (label) generic.push({ label, usedPercent, resetsAt });
    }
  }

  const windows = [...generic];
  if (!hasSession) {
    const legacy = parseAnthropicBucket(payload.five_hour, "5h");
    if (legacy) windows.unshift(legacy);
  }
  if (!hasWeeklyAll) {
    const legacy = parseAnthropicBucket(payload.seven_day, "Week");
    if (legacy) {
      const insertion = windows[0]?.label === "5h" ? 1 : 0;
      windows.splice(insertion, 0, legacy);
    }
  }

  return windows.length > 0 ? windows : null;
}

function resolveEpochTime(value: unknown): number | undefined {
  const epoch = finiteNumber(value);
  if (epoch === undefined || epoch < 0) return undefined;
  return epoch >= 1_000_000_000_000 ? epoch : epoch * 1000;
}

function windowDurationLabel(value: unknown, fallback: string): string {
  const seconds = finiteNumber(value);
  if (seconds === undefined || seconds <= 0) return fallback;
  if (seconds >= 86_400) {
    const days = Math.max(1, Math.round(seconds / 86_400));
    return days === 7 ? "Week" : `${days}d`;
  }
  return `${Math.max(1, Math.round(seconds / 3600))}h`;
}

function parseCodexWindow(value: unknown, fallbackLabel: string, nowMs: number): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = finiteNumber(value.used_percent);
  let resetsAt = resolveEpochTime(value.reset_at);
  if (resetsAt === undefined) {
    const after = finiteNumber(value.reset_after_seconds);
    if (after !== undefined && after >= 0) resetsAt = nowMs + after * 1000;
  }
  if (usedPercent === undefined && resetsAt === undefined) return undefined;
  return {
    label: windowDurationLabel(value.limit_window_seconds, fallbackLabel),
    usedPercent,
    resetsAt,
  };
}

/** Parse only the shared Codex usage windows, ignoring feature-specific meters. */
export function parseCodexUsage(payload: unknown, nowMs = Date.now()): UsageWindow[] | null {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return null;
  const windows = [
    parseCodexWindow(payload.rate_limit.primary_window, "Primary", nowMs),
    parseCodexWindow(payload.rate_limit.secondary_window, "Secondary", nowMs),
  ].filter((window): window is UsageWindow => window !== undefined);
  return windows.length > 0 ? windows : null;
}

function centsValue(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const cents = value.val === undefined ? 0 : finiteNumber(value.val);
  return cents !== undefined && cents >= 0 ? cents : undefined;
}

/** Parse Grok's current weekly credits format with the legacy monthly fallback. */
export function parseGrokUsage(payload: unknown): UsageWindow[] | null {
  if (!isRecord(payload) || !isRecord(payload.config)) return null;
  const config = payload.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  const periodType = typeof period?.type === "string" ? period.type.toUpperCase() : "";
  const hasLegacyAmounts = config.used !== undefined || config.monthlyLimit !== undefined;
  const label = periodType.includes("MONTHLY") || (!period && hasLegacyAmounts) ? "Month" : "Week";
  const resetsAt = parseResetTime(period?.end ?? config.billingPeriodEnd);

  const percentWasOmitted = config.creditUsagePercent === undefined;
  let usedPercent = finiteNumber(config.creditUsagePercent);
  if (usedPercent !== undefined && (usedPercent < 0 || usedPercent > 100)) usedPercent = undefined;
  if (usedPercent === undefined && percentWasOmitted) {
    const used = centsValue(config.used);
    const limit = centsValue(config.monthlyLimit);
    if (used !== undefined && limit !== undefined && limit > 0) {
      usedPercent = Math.min(100, (used / limit) * 100);
    } else if (period && resetsAt !== undefined) {
      // Proto3 omits zero-valued scalars at the beginning of a fresh period.
      usedPercent = 0;
    }
  }

  return usedPercent !== undefined || resetsAt !== undefined
    ? [{ label, usedPercent, resetsAt }]
    : null;
}

export function parseGrokUserId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const userId = payload.userId;
  return typeof userId === "string" && userId.length > 0 && userId.length <= 256 && /^[\x21-\x7e]+$/.test(userId)
    ? userId
    : undefined;
}

function compactCountdown(resetsAt: number | undefined, nowMs: number): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return "";
  const remaining = Math.max(0, resetsAt - nowMs);
  if (remaining < 60_000) return " <1m";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return ` ${minutes}m`;
  if (minutes < 24 * 60) {
    return ` ${Math.floor(minutes / 60)}h${minutes % 60}m`;
  }
  const hours = Math.ceil(remaining / 3_600_000);
  return ` ${Math.floor(hours / 24)}d${hours % 24}h`;
}

export function formatUsageWindow(window: UsageWindow, nowMs = Date.now()): string {
  const percent = window.usedPercent;
  const normalized = percent === undefined ? undefined : Math.min(100, Math.max(0, percent));
  const filled = normalized === undefined ? 0 : Math.round(normalized / 20);
  const bar = normalized === undefined ? "?????" : `${"█".repeat(filled)}${"░".repeat(5 - filled)}`;
  const amount = normalized === undefined ? "?%" : `${Math.round(normalized)}%`;
  return `${cleanLabel(window.label, "Usage")} ${bar} ${amount}${compactCountdown(window.resetsAt, nowMs)}`;
}

export function formatProviderLine(
  name: string,
  state: ProviderState,
  nowMs = Date.now(),
): string {
  if (state.kind === "loading") return `${name}: loading…`;
  if (state.kind === "login") return `${name}: ${state.command ?? "/login for OAuth"}`;
  if (state.kind === "error") return `${name}: ${state.message}`;
  return `${name}: ${state.windows.map((window) => formatUsageWindow(window, nowMs)).join(" · ")}`;
}

export function formatWidget(state: UsageState, nowMs = Date.now()): string[] {
  return [
    formatProviderLine("Claude", state.anthropic, nowMs),
    `${formatProviderLine("Codex", state.codex, nowMs)} │ ${formatProviderLine("Grok", state.grok, nowMs)}`,
  ];
}

function isOAuth(
  auth: ProviderAuthResult | undefined,
  allowAnthropicEnv: boolean,
): auth is ProviderAuthResult & { auth: { apiKey: string; headers?: Record<string, string | null>; baseUrl?: string } } {
  return Boolean(
    auth?.auth.apiKey &&
      (auth.source === "OAuth" || (allowAnthropicEnv && auth.source === "ANTHROPIC_OAUTH_TOKEN")),
  );
}

export function extractAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const payload: unknown = JSON.parse(decoded);
    if (!isRecord(payload)) return undefined;
    const claim = payload["https://api.openai.com/auth"];
    if (!isRecord(claim)) return undefined;
    const accountId = claim.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function codexUsageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/wham/usage`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = finiteNumber(response.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > MAX_RESPONSE_BYTES) throw new Error("oversized");
  if (!response.body) return JSON.parse(await response.text());

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("oversized");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function requestJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<
  | { kind: "ok"; payload: unknown }
  | { kind: "error"; message: string }
> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) return { kind: "error", message: `HTTP ${response.status}` };
    try {
      return { kind: "ok", payload: await readBoundedJson(response) };
    } catch {
      return { kind: "error", message: "malformed response" };
    }
  } catch (error) {
    if (isRecord(error) && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { kind: "error", message: "timeout" };
    }
    return { kind: "error", message: "request failed" };
  }
}

async function loadAnthropic(ctx: ExtensionContext, signal: AbortSignal): Promise<ProviderState> {
  let resolved: ProviderAuthResult | undefined;
  try {
    resolved = await ctx.modelRegistry.getProviderAuth("anthropic");
  } catch {
    return { kind: "error", message: "auth unavailable" };
  }
  if (!isOAuth(resolved, true)) return { kind: "login" };

  const result = await requestJson("https://api.anthropic.com/api/oauth/usage", {
    Authorization: `Bearer ${resolved.auth.apiKey}`,
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
  }, signal);
  if (result.kind === "error") return result;
  const windows = parseAnthropicUsage(result.payload);
  return windows ? { kind: "ready", windows } : { kind: "error", message: "malformed response" };
}

async function loadCodex(ctx: ExtensionContext, signal: AbortSignal): Promise<ProviderState> {
  let resolved: ProviderAuthResult | undefined;
  try {
    resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
  } catch {
    return { kind: "error", message: "auth unavailable" };
  }
  if (!isOAuth(resolved, false)) return { kind: "login" };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolved.auth.apiKey}`,
    Accept: "application/json",
  };
  const accountId = extractAccountId(resolved.auth.apiKey);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const providerBaseUrl = ctx.modelRegistry.getProvider?.("openai-codex")?.baseUrl;
  const baseUrl = resolved.auth.baseUrl || providerBaseUrl || CODEX_FALLBACK_BASE_URL;
  const result = await requestJson(codexUsageUrl(baseUrl), headers, signal);
  if (result.kind === "error") return result;
  const windows = parseCodexUsage(result.payload);
  return windows ? { kind: "ready", windows } : { kind: "error", message: "malformed response" };
}

async function resolveGrokAuth(ctx: ExtensionContext): Promise<ProviderAuthResult | undefined> {
  const active = ctx.model?.provider;
  const providers = active === "xai-auth" || active === "xai" ? [active] : ["xai-auth", "xai"];
  for (const provider of providers) {
    try {
      const resolved = await ctx.modelRegistry.getProviderAuth(provider);
      if (isOAuth(resolved, false)) return resolved;
    } catch {
      // A broken sibling provider must not hide another valid Grok login.
    }
  }
  return undefined;
}

function grokHeaders(
  token: string,
  clientMode: "interactive" | "headless",
  userId?: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": GROK_CLIENT_VERSION,
    "x-grok-client-mode": clientMode,
    ...(userId ? { "x-userid": userId } : {}),
  };
}

async function loadGrok(ctx: ExtensionContext, signal: AbortSignal): Promise<ProviderState> {
  let resolved: ProviderAuthResult | undefined;
  try {
    resolved = await resolveGrokAuth(ctx);
  } catch {
    return { kind: "error", message: "auth unavailable" };
  }
  if (!resolved?.auth.apiKey) return { kind: "login", command: "/login xai-auth" };

  const clientMode = ctx.mode === "tui" ? "interactive" : "headless";
  const identity = await requestJson(
    `${GROK_BASE_URL}/user`,
    grokHeaders(resolved.auth.apiKey, clientMode),
    signal,
  );
  if (identity.kind === "error") return identity;
  const userId = parseGrokUserId(identity.payload);
  if (!userId) return { kind: "error", message: "identity unavailable" };

  const billing = await requestJson(
    `${GROK_BASE_URL}/billing?format=credits`,
    grokHeaders(resolved.auth.apiKey, clientMode, userId),
    signal,
  );
  if (billing.kind === "error") return billing;
  const windows = parseGrokUsage(billing.payload);
  return windows ? { kind: "ready", windows } : { kind: "error", message: "usage unavailable" };
}

export default function usageExtension(pi: ExtensionAPI): void {
  let alive = false;
  let generation = 0;
  let lastRefreshAt = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeController: AbortController | undefined;
  let state: UsageState = {
    anthropic: { kind: "loading" },
    codex: { kind: "loading" },
    grok: { kind: "loading" },
  };

  const render = (ctx: ExtensionContext): void => {
    if (alive && ctx.hasUI !== false) {
      ctx.ui.setWidget(WIDGET_ID, formatWidget(state), { placement: "belowEditor" });
    }
  };

  const refresh = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
    const now = Date.now();
    if (!alive || (!force && now - lastRefreshAt < REFRESH_INTERVAL_MS)) return;
    lastRefreshAt = now;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const refreshGeneration = ++generation;
    state = {
      anthropic: { kind: "loading" },
      codex: { kind: "loading" },
      grok: { kind: "loading" },
    };
    render(ctx);

    const update = (provider: keyof UsageState, next: ProviderState): void => {
      if (!alive || generation !== refreshGeneration) return;
      state = { ...state, [provider]: next };
      render(ctx);
    };

    await Promise.all([
      loadAnthropic(ctx, controller.signal).then((next) => update("anthropic", next)),
      loadCodex(ctx, controller.signal).then((next) => update("codex", next)),
      loadGrok(ctx, controller.signal).then((next) => update("grok", next)),
    ]);
    if (activeController === controller) activeController = undefined;
  };

  const stopRefreshTimer = (): void => {
    if (refreshTimer === undefined) return;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  };

  const startRefreshTimer = (ctx: ExtensionContext): void => {
    if (refreshTimer !== undefined) return;
    refreshTimer = setInterval(() => {
      void refresh(ctx, false);
    }, REFRESH_INTERVAL_MS);
  };

  pi.on("session_start", (_event, ctx) => {
    alive = true;
    lastRefreshAt = 0;
    void refresh(ctx, true);
  });

  pi.on("agent_start", (_event, ctx) => {
    void refresh(ctx, false);
    startRefreshTimer(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    stopRefreshTimer();
    void refresh(ctx, false);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    alive = false;
    stopRefreshTimer();
    generation += 1;
    activeController?.abort();
    activeController = undefined;
    ctx.ui.setWidget(WIDGET_ID, undefined);
  });

  pi.registerCommand("usage", {
    description: "Refresh subscription quota usage",
    handler: async (_args, ctx) => {
      await refresh(ctx, true);
    },
  });
}
