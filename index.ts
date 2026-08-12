import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "pi-usage";
const REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const CODEX_FALLBACK_BASE_URL = "https://chatgpt.com/backend-api";

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
  | { kind: "login" }
  | { kind: "error"; message: string }
  | { kind: "ready"; windows: UsageWindow[] };

export interface UsageState {
  anthropic: ProviderState;
  codex: ProviderState;
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

function compactCountdown(resetsAt: number | undefined, nowMs: number): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return "";
  const remaining = Math.max(0, resetsAt - nowMs);
  if (remaining < 60_000) return " <1m";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return ` ${minutes}m`;
  const hours = Math.ceil(remaining / 3_600_000);
  if (hours < 48) return ` ${hours}h`;
  return ` ${Math.ceil(remaining / 86_400_000)}d`;
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
  if (state.kind === "login") return `${name}: /login for OAuth`;
  if (state.kind === "error") return `${name}: ${state.message}`;
  return `${name}: ${state.windows.map((window) => formatUsageWindow(window, nowMs)).join(" · ")}`;
}

export function formatWidget(state: UsageState, nowMs = Date.now()): string[] {
  return [
    `${formatProviderLine("Claude", state.anthropic, nowMs)} │ ${formatProviderLine("Codex", state.codex, nowMs)}`,
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

async function requestJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<
  | { kind: "ok"; payload: unknown }
  | { kind: "error"; message: string }
> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) return { kind: "error", message: `HTTP ${response.status}` };
    try {
      return { kind: "ok", payload: await response.json() };
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

export default function usageExtension(pi: ExtensionAPI): void {
  let alive = false;
  let generation = 0;
  let lastRefreshAt = 0;
  let activeController: AbortController | undefined;
  let state: UsageState = { anthropic: { kind: "loading" }, codex: { kind: "loading" } };

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
    state = { anthropic: { kind: "loading" }, codex: { kind: "loading" } };
    render(ctx);

    const update = (provider: keyof UsageState, next: ProviderState): void => {
      if (!alive || generation !== refreshGeneration) return;
      state = { ...state, [provider]: next };
      render(ctx);
    };

    await Promise.all([
      loadAnthropic(ctx, controller.signal).then((next) => update("anthropic", next)),
      loadCodex(ctx, controller.signal).then((next) => update("codex", next)),
    ]);
    if (activeController === controller) activeController = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    alive = true;
    lastRefreshAt = 0;
    void refresh(ctx, true);
  });

  pi.on("agent_settled", (_event, ctx) => {
    void refresh(ctx, false);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    alive = false;
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
