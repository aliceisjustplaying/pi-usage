import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const WIDGET_ID = "pi-usage";
const REFRESH_INTERVAL_MS = 60_000;
const ANTHROPIC_REFRESH_INTERVAL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const CODEX_FALLBACK_BASE_URL = "https://chatgpt.com/backend-api";
const CLAUDE_DESKTOP_COOKIE_DB = join(homedir(), "Library/Application Support/Claude/Cookies");
const CLAUDE_WEB_CACHE = join(homedir(), ".cache/pi-usage/claude-web.json");
const CLAUDE_WEB_CACHE_LOCK = `${CLAUDE_WEB_CACHE}.lock`;
const CLAUDE_WEB_CACHE_FRESH_MS = 30_000;
const CLAUDE_WEB_CACHE_MAX_MS = 24 * 60 * 60_000;
const CLAUDE_WEB_LOCK_MAX_MS = 30_000;
const CLAUDE_WEB_LOCK_WAIT_MS = 20_000;
const CLAUDE_WEB_LOCK_POLL_MS = 100;
const MACOS_KEYCHAIN_COMMAND = "/usr/bin/security";
const MACOS_SQLITE_COMMAND = "/usr/bin/sqlite3";
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

function execFileText(command: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      maxBuffer: MAX_RESPONSE_BYTES,
      signal,
      timeout: REQUEST_TIMEOUT_MS,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function decryptClaudeDesktopCookie(hex: string, key: Buffer): string | undefined {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined;
  const encrypted = Buffer.from(hex, "hex");
  if (encrypted.subarray(0, 3).toString() !== "v10") return undefined;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const decrypted = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ]).subarray(32).toString("utf8");
    return decrypted.length > 0 &&
      decrypted.length <= 8_192 &&
      /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(decrypted)
      ? decrypted
      : undefined;
  } catch {
    return undefined;
  }
}

async function readClaudeDesktopCookies(signal: AbortSignal): Promise<{
  sessionKey: string;
  organizationId: string;
  clearance?: string;
} | null> {
  if (process.platform !== "darwin") return null;
  try {
    const [password, rows] = await Promise.all([
      execFileText(MACOS_KEYCHAIN_COMMAND, [
        "find-generic-password",
        "-s",
        "Claude Safe Storage",
        "-w",
      ], signal),
      execFileText(MACOS_SQLITE_COMMAND, [
        "-separator",
        "\t",
        CLAUDE_DESKTOP_COOKIE_DB,
        "SELECT name, hex(encrypted_value) FROM cookies WHERE host_key = '.claude.ai' AND name IN ('sessionKey', 'lastActiveOrg', 'cf_clearance');",
      ], signal),
    ]);
    const key = pbkdf2Sync(password.trim(), "saltysalt", 1003, 16, "sha1");
    const encrypted = new Map<string, string>();
    for (const line of rows.trim().split("\n")) {
      const separator = line.indexOf("\t");
      if (separator > 0) encrypted.set(line.slice(0, separator), line.slice(separator + 1));
    }
    const sessionKey = decryptClaudeDesktopCookie(encrypted.get("sessionKey") ?? "", key);
    const organizationId = decryptClaudeDesktopCookie(encrypted.get("lastActiveOrg") ?? "", key);
    const clearance = decryptClaudeDesktopCookie(encrypted.get("cf_clearance") ?? "", key);
    if (!sessionKey || !organizationId || organizationId.length > 256) return null;
    return { sessionKey, organizationId, clearance };
  } catch {
    return null;
  }
}

async function requestClaudeWebUsage(
  organizationId: string,
  cookie: string,
  signal: AbortSignal,
): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: unknown | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    const request = httpsRequest({
      hostname: "claude.ai",
      path: `/api/organizations/${encodeURIComponent(organizationId)}/usage`,
      method: "GET",
      headers: {
        Cookie: cookie,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        response.once("end", () => finish(null));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("oversized"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          finish(null);
        }
      });
    });
    const onAbort = (): void => {
      request.destroy(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    request.on("error", fail);
    request.on("timeout", () => request.destroy(new Error("timeout")));
    if (signal.aborted) onAbort();
    else request.end();
  });
}

async function readClaudeWebCache(nowMs = Date.now()): Promise<{
  windows: UsageWindow[];
  ageMs: number;
} | null> {
  try {
    const payload: unknown = JSON.parse(await readFile(CLAUDE_WEB_CACHE, "utf8"));
    if (!isRecord(payload)) return null;
    const cachedAt = finiteNumber(payload.cachedAt);
    if (cachedAt === undefined) return null;
    const ageMs = nowMs - cachedAt;
    if (ageMs < 0 || ageMs > CLAUDE_WEB_CACHE_MAX_MS || !Array.isArray(payload.windows)) return null;
    const windows: UsageWindow[] = [];
    for (const entry of payload.windows) {
      if (!isRecord(entry)) continue;
      const label = cleanLabel(entry.label);
      const usedPercent = finiteNumber(entry.usedPercent);
      const resetsAt = finiteNumber(entry.resetsAt);
      if (!label || (usedPercent === undefined && resetsAt === undefined)) continue;
      if (resetsAt !== undefined && resetsAt <= nowMs) continue;
      if (resetsAt === undefined && ageMs > ANTHROPIC_REFRESH_INTERVAL_MS) continue;
      windows.push({ label, usedPercent, resetsAt });
    }
    return windows.length > 0 ? { windows, ageMs } : null;
  } catch {
    return null;
  }
}

async function writeClaudeWebCache(windows: UsageWindow[]): Promise<void> {
  const temporary = `${CLAUDE_WEB_CACHE}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    await mkdir(dirname(CLAUDE_WEB_CACHE), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ cachedAt: Date.now(), windows }), { mode: 0o600 });
    await rename(temporary, CLAUDE_WEB_CACHE);
  } catch {
    try {
      await unlink(temporary);
    } catch {
      // Best-effort cache cleanup only.
    }
  }
}

interface ClaudeWebCacheLock {
  handle: Awaited<ReturnType<typeof open>>;
  token: string;
}

async function createClaudeWebCacheLock(): Promise<ClaudeWebCacheLock> {
  const token = randomBytes(16).toString("hex");
  const handle = await open(CLAUDE_WEB_CACHE_LOCK, "wx", 0o600);
  try {
    await handle.writeFile(token, "utf8");
    return { handle, token };
  } catch (error) {
    await handle.close();
    try {
      await unlink(CLAUDE_WEB_CACHE_LOCK);
    } catch {
      // Best-effort cleanup after a failed lock write.
    }
    throw error;
  }
}

async function acquireClaudeWebCacheLock(): Promise<ClaudeWebCacheLock | undefined> {
  await mkdir(dirname(CLAUDE_WEB_CACHE_LOCK), { recursive: true, mode: 0o700 });
  try {
    return await createClaudeWebCacheLock();
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") return undefined;
  }
  try {
    const lock = await stat(CLAUDE_WEB_CACHE_LOCK);
    if (Date.now() - lock.mtimeMs <= CLAUDE_WEB_LOCK_MAX_MS) return undefined;
    await unlink(CLAUDE_WEB_CACHE_LOCK);
    return await createClaudeWebCacheLock();
  } catch {
    return undefined;
  }
}

async function releaseClaudeWebCacheLock(lock: ClaudeWebCacheLock): Promise<void> {
  await lock.handle.close();
  try {
    if ((await readFile(CLAUDE_WEB_CACHE_LOCK, "utf8")) === lock.token) {
      await unlink(CLAUDE_WEB_CACHE_LOCK);
    }
  } catch {
    // The lock was already cleaned up or replaced by another process.
  }
}

async function waitForClaudeWebCache(signal: AbortSignal): Promise<UsageWindow[] | null> {
  const deadline = Date.now() + CLAUDE_WEB_LOCK_WAIT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    const cached = await readClaudeWebCache();
    if (cached) return cached.windows;
    try {
      await stat(CLAUDE_WEB_CACHE_LOCK);
    } catch {
      return null;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, CLAUDE_WEB_LOCK_POLL_MS);
      function finish(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  return null;
}

async function loadClaudeWebUsage(signal: AbortSignal): Promise<UsageWindow[] | null> {
  const cached = await readClaudeWebCache();
  if (cached && cached.ageMs < CLAUDE_WEB_CACHE_FRESH_MS) return cached.windows;

  const lock = await acquireClaudeWebCacheLock();
  if (!lock) return cached?.windows ?? await waitForClaudeWebCache(signal);
  try {
    const refreshedCache = await readClaudeWebCache();
    if (refreshedCache && refreshedCache.ageMs < CLAUDE_WEB_CACHE_FRESH_MS) {
      return refreshedCache.windows;
    }
    const cookies = await readClaudeDesktopCookies(signal);
    if (!cookies) return cached?.windows ?? null;
    let cookie = `sessionKey=${cookies.sessionKey}; lastActiveOrg=${cookies.organizationId}`;
    if (cookies.clearance) cookie += `; cf_clearance=${cookies.clearance}`;
    let payload: unknown | null = null;
    try {
      payload = await requestClaudeWebUsage(cookies.organizationId, cookie, signal);
    } catch {
      // A stale quota-only cache is safer than exposing a transport error.
    }
    const windows = payload === null ? null : parseAnthropicUsage(payload);
    if (!windows) return cached?.windows ?? null;
    await writeClaudeWebCache(windows);
    return windows;
  } finally {
    await releaseClaudeWebCacheLock(lock);
  }
}

async function loadAnthropic(
  ctx: ExtensionContext,
  signal: AbortSignal,
  loadWebUsage: (signal: AbortSignal) => Promise<UsageWindow[] | null>,
): Promise<ProviderState> {
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
  if (result.kind === "error") {
    if (result.message === "HTTP 429") {
      const fallbackWindows = await loadWebUsage(signal);
      if (fallbackWindows) return { kind: "ready", windows: fallbackWindows };
    }
    return result;
  }
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

export interface UsageExtensionDependencies {
  loadClaudeWebUsage?: (signal: AbortSignal) => Promise<UsageWindow[] | null>;
}

export default function usageExtension(
  pi: ExtensionAPI,
  dependencies: UsageExtensionDependencies = {},
): void {
  const loadWebUsage = dependencies.loadClaudeWebUsage ?? loadClaudeWebUsage;
  let alive = false;
  let generation: Record<keyof UsageState, number> = {
    anthropic: 0,
    codex: 0,
    grok: 0,
  };
  let lastRefreshAt: Record<keyof UsageState, number> = {
    anthropic: 0,
    codex: 0,
    grok: 0,
  };
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeControllers: Partial<Record<keyof UsageState, AbortController>> = {};
  let activeRefreshes: Partial<Record<keyof UsageState, Promise<void>>> = {};
  let widgetLines: string[] = [];
  let widgetText: Text[] | undefined;
  let requestWidgetRender: (() => void) | undefined;
  let state: UsageState = {
    anthropic: { kind: "loading" },
    codex: { kind: "loading" },
    grok: { kind: "loading" },
  };

  const render = (ctx: ExtensionContext): void => {
    if (!alive || ctx.hasUI === false) return;
    const nextLines = formatWidget(state);
    const changedLines = nextLines.map((line, index) => line !== widgetLines[index]);
    if (nextLines.length === widgetLines.length && changedLines.every((changed) => !changed)) return;
    widgetLines = nextLines;

    if (ctx.mode === "tui" && widgetText) {
      for (const [index, line] of widgetLines.entries()) {
        if (changedLines[index]) widgetText[index]?.setText(line);
      }
      requestWidgetRender?.();
      return;
    }
    ctx.ui.setWidget(WIDGET_ID, widgetLines, { placement: "belowEditor" });
  };

  const mountWidget = (ctx: ExtensionContext): void => {
    if (ctx.hasUI === false) return;
    widgetLines = formatWidget(state);
    if (ctx.mode !== "tui") {
      ctx.ui.setWidget(WIDGET_ID, widgetLines, { placement: "belowEditor" });
      return;
    }

    ctx.ui.setWidget(WIDGET_ID, (tui) => {
      const container = new Container();
      widgetText = widgetLines.map((line) => new Text(line, 1, 0));
      for (const line of widgetText) container.addChild(line);
      requestWidgetRender = () => tui.requestRender();
      return container;
    }, { placement: "belowEditor" });
  };

  const refresh = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
    const now = Date.now();
    if (!alive) return;
    const requests: Promise<void>[] = [];

    const schedule = (
      provider: keyof UsageState,
      intervalMs: number,
      load: (ctx: ExtensionContext, signal: AbortSignal) => Promise<ProviderState>,
    ): void => {
      if (!force && now - lastRefreshAt[provider] < intervalMs) return;
      const currentRefresh = activeRefreshes[provider];
      if (currentRefresh) {
        requests.push(currentRefresh);
        return;
      }

      lastRefreshAt[provider] = now;
      const controller = new AbortController();
      activeControllers[provider] = controller;
      const refreshGeneration = ++generation[provider];
      let request: Promise<void>;
      request = load(ctx, controller.signal)
        .then((next) => {
          if (!alive || generation[provider] !== refreshGeneration) return;
          const current = state[provider];
          if (
            provider === "anthropic" &&
            current.kind === "ready" &&
            next.kind === "error" &&
            next.message === "HTTP 429"
          ) return;
          state = { ...state, [provider]: next };
          render(ctx);
        })
        .finally(() => {
          if (activeControllers[provider] === controller) delete activeControllers[provider];
          if (activeRefreshes[provider] === request) delete activeRefreshes[provider];
        });
      activeRefreshes[provider] = request;
      requests.push(request);
    };

    schedule("anthropic", ANTHROPIC_REFRESH_INTERVAL_MS, (ctx, signal) =>
      loadAnthropic(ctx, signal, loadWebUsage));
    schedule("codex", REFRESH_INTERVAL_MS, loadCodex);
    schedule("grok", REFRESH_INTERVAL_MS, loadGrok);
    await Promise.all(requests);
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
    lastRefreshAt = { anthropic: 0, codex: 0, grok: 0 };
    state = {
      anthropic: { kind: "loading" },
      codex: { kind: "loading" },
      grok: { kind: "loading" },
    };
    mountWidget(ctx);
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
    for (const provider of ["anthropic", "codex", "grok"] as const) {
      generation[provider] += 1;
      activeControllers[provider]?.abort();
    }
    activeControllers = {};
    activeRefreshes = {};
    widgetText = undefined;
    requestWidgetRender = undefined;
    widgetLines = [];
    ctx.ui.setWidget(WIDGET_ID, undefined);
  });

  pi.registerCommand("usage", {
    description: "Refresh subscription quota usage",
    handler: async (_args, ctx) => {
      await refresh(ctx, true);
    },
  });
}
