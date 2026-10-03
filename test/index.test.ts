import { visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";
import assert from "node:assert/strict";

import usageExtension, {
  extractAccountId,
  formatProviderLine,
  formatUsageWindow,
  formatWidget,
  formatCompactWidget,
  plainStyle,
  parseAnthropicUsage,
  parseCodexCredits,
  parseCodexUsage,
  parseGrokUsage,
  parseGrokUserId,
  parseOpenCodeGoUsage,
} from "../index.ts";


const TAGS = ["Cl", "Cx", "Gk", "Go"];
const segment = (line: string | undefined, index: number): string => {
  const plain = (line ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  const groups: string[] = [];
  for (const word of plain.split(" ")) {
    if (TAGS.includes(word)) groups.push(word);
    else if (groups.length > 0) groups[groups.length - 1] += ` ${word}`;
  }
  return groups[index] ?? "";
};
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("parses Anthropic legacy usage buckets", () => {
  assert.deepEqual(
    parseAnthropicUsage({
      five_hour: { utilization: 24.6, resets_at: "2026-01-01T01:00:00Z" },
      seven_day: { utilization: 71, resets_at: "2026-01-07T00:00:00Z" },
    }),
    [
      { label: "5h", usedPercent: 24.6, resetsAt: Date.parse("2026-01-01T01:00:00Z") },
      { label: "Week", usedPercent: 71, resetsAt: Date.parse("2026-01-07T00:00:00Z") },
    ],
  );
});

test("parses current Anthropic limits including inactive Fable and future scoped models", () => {
  assert.deepEqual(
    parseAnthropicUsage({
      limits: [
        { kind: "session", percent: 10, resets_at: "2026-01-01T01:00:00Z", is_active: true },
        { kind: "weekly_all", percent: 77, resets_at: "2026-01-07T00:00:00Z", is_active: false },
        {
          kind: "weekly_scoped",
          percent: 100,
          resets_at: "2026-01-05T00:00:00Z",
          is_active: false,
          scope: { model: { display_name: "Fable" } },
        },
        {
          kind: "weekly_scoped",
          percent: 5,
          resets_at: 1_767_484_800,
          scope: { model: { display_name: "Future Model" } },
        },
      ],
    }),
    [
      { label: "5h", usedPercent: 10, resetsAt: Date.parse("2026-01-01T01:00:00Z") },
      { label: "Week", usedPercent: 77, resetsAt: Date.parse("2026-01-07T00:00:00Z") },
      { label: "Fable", usedPercent: 100, resetsAt: Date.parse("2026-01-05T00:00:00Z") },
      { label: "Future Model", usedPercent: 5, resetsAt: 1_767_484_800_000 },
    ],
  );
});

test("prefers generic account windows while retaining a missing legacy window", () => {
  assert.deepEqual(
    parseAnthropicUsage({
      five_hour: { utilization: 99 },
      seven_day: { utilization: 22 },
      limits: [{ kind: "session", percent: 12 }],
    }),
    [
      { label: "5h", usedPercent: 12, resetsAt: undefined },
      { label: "Week", usedPercent: 22, resetsAt: undefined },
    ],
  );
});

test("parses the Codex credit balance", () => {
  assert.equal(parseCodexCredits({ credits: { has_credits: true, unlimited: false, balance: "61246.065" } }), 61246.065);
  assert.equal(parseCodexCredits({ credits: { has_credits: true, unlimited: true, balance: "0" } }), "unlimited");
  assert.equal(parseCodexCredits({ credits: { has_credits: false, unlimited: false, balance: "0" } }), undefined);
  assert.equal(parseCodexCredits({ credits: null }), undefined);
  assert.equal(parseCodexCredits({}), undefined);
});

test("parses only Codex shared limits and ignores additional meters", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(
    parseCodexUsage(
      {
        rate_limit: {
          primary_window: {
            used_percent: 31,
            limit_window_seconds: 18_000,
            reset_at: 1_700_000_100,
          },
          secondary_window: {
            used_percent: 62,
            limit_window_seconds: 604_800,
            reset_at: 1_700_200_000_000,
          },
        },
        additional_rate_limits: [
          {
            limit_name: "Spark",
            rate_limit: {
              primary_window: {
                used_percent: 8,
                limit_window_seconds: 10_800,
                reset_after_seconds: 90,
              },
            },
          },
        ],
      },
      now,
    ),
    [
      { label: "5h", usedPercent: 31, resetsAt: 1_700_000_100_000 },
      { label: "Week", usedPercent: 62, resetsAt: 1_700_200_000_000 },
    ],
  );
});

test("parses Grok weekly credits, fresh periods, and legacy monthly fallback", () => {
  assert.deepEqual(
    parseGrokUsage({
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "2026-08-17T12:51:17Z",
        },
      },
    }),
    [{ label: "Week", usedPercent: 42.5, resetsAt: Date.parse("2026-08-17T12:51:17Z") }],
  );
  assert.deepEqual(
    parseGrokUsage({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "2026-08-17T12:51:17Z",
        },
      },
    }),
    [{ label: "Week", usedPercent: 0, resetsAt: Date.parse("2026-08-17T12:51:17Z") }],
  );
  assert.deepEqual(
    parseGrokUsage({
      config: {
        creditUsagePercent: 101,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "2026-08-17T12:51:17Z",
        },
      },
    }),
    [{ label: "Week", usedPercent: undefined, resetsAt: Date.parse("2026-08-17T12:51:17Z") }],
  );
  assert.deepEqual(
    parseGrokUsage({
      config: {
        used: { val: 250 },
        monthlyLimit: { val: 1000 },
        billingPeriodEnd: "2026-09-01T00:00:00Z",
      },
    }),
    [{ label: "Month", usedPercent: 25, resetsAt: Date.parse("2026-09-01T00:00:00Z") }],
  );
});

test("parses OpenCode Go rolling, weekly and monthly windows", () => {
  assert.deepEqual(
    parseOpenCodeGoUsage({
      usage: {
        rolling: { status: "ok", percent: 3, resetsAt: "2026-09-20T05:35:53.613Z" },
        weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-21T00:00:00.000Z" },
        monthly: { status: "ok", percent: 0 },
      },
    }),
    [
      { label: "5h", usedPercent: 3, resetsAt: Date.parse("2026-09-20T05:35:53.613Z") },
      { label: "Week", usedPercent: 100, resetsAt: Date.parse("2026-09-21T00:00:00.000Z") },
      { label: "Month", usedPercent: 0, resetsAt: undefined },
    ],
  );
  assert.equal(parseOpenCodeGoUsage({ usage: {} }), null);
  assert.equal(parseOpenCodeGoUsage({ error: { type: "AuthError" } }), null);
});

test("accepts only bounded header-safe Grok user IDs", () => {
  assert.equal(parseGrokUserId({ userId: "user-123" }), "user-123");
  assert.equal(parseGrokUserId({ userId: "user\r\nx-userid: attacker" }), undefined);
  assert.equal(parseGrokUserId({ userId: "x".repeat(257) }), undefined);
  assert.equal(parseGrokUserId({}), undefined);
});

test("handles malformed and partial payloads", () => {
  assert.equal(parseAnthropicUsage(null), null);
  assert.equal(parseAnthropicUsage({ limits: [{ kind: "weekly_scoped", percent: 50 }] }), null);
  assert.deepEqual(parseAnthropicUsage({ five_hour: { resets_at: "2026-01-01T00:00:00Z" } }), [
    { label: "5h", usedPercent: undefined, resetsAt: Date.parse("2026-01-01T00:00:00Z") },
  ]);

  assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: "nope" } } }), null);
  assert.deepEqual(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 0 } } }), [
    { label: "Primary", usedPercent: 0, resetsAt: undefined },
  ]);
  assert.equal(
    parseCodexUsage({
      additional_rate_limits: [
        { limit_name: "Spark", rate_limit: { primary_window: { used_percent: 3 } } },
      ],
    }),
    null,
  );
  assert.equal(parseGrokUsage(null), null);
  assert.equal(parseGrokUsage({ config: null }), null);
  assert.equal(parseGrokUsage({ config: { creditUsagePercent: 101 } }), null);
});

test("sanitizes provider-controlled labels before rendering", () => {
  assert.deepEqual(
    parseAnthropicUsage({
      limits: [
        {
          kind: "weekly_scoped",
          percent: 2,
          scope: { model: { display_name: "\u001b[31mFa\u202Eble\u001b[0m\nquota" } },
        },
      ],
    }),
    [{ label: "Fable quota", usedPercent: 2, resetsAt: undefined }],
  );
});

test("extracts ChatGPT account id from an OAuth JWT without exposing other claims", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    secret: "ignored",
  })}.signature`;
  assert.equal(extractAccountId(token), "acct-123");
  assert.equal(extractAccountId("not-a-jwt"), undefined);
});

test("formats compact bars, percentages, countdowns, and partial provider states", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    formatUsageWindow({ label: "5h", usedPercent: 61, resetsAt: now + 61 * 60_000 }, now),
    "5h ███░░ 61% 1h1m",
  );
  assert.equal(
    formatUsageWindow({ label: "Week", resetsAt: now + 30_000 }, now),
    "Week ????? ?% <1m",
  );
  assert.equal(
    formatUsageWindow({ label: "Week", usedPercent: 42, resetsAt: now + (5 * 24 + 3) * 3_600_000 }, now),
    "Week ██░░░ 42% 5d3h",
  );
  assert.equal(formatProviderLine("Claude", { kind: "login" }, now), "Claude: /login for OAuth");
  assert.deepEqual(
    formatWidget(
      {
        anthropic: { kind: "ready", windows: [{ label: "Fable", usedPercent: 100 }] },
        codex: { kind: "error", message: "HTTP 429" },
        grok: { kind: "login", command: "/login xai-auth" },
        opencodeGo: { kind: "ready", windows: [{ label: "Week", usedPercent: 100 }] },
      },
      now,
    ),
    ["Claude: Fable █████ 100%", "Codex: HTTP 429 │ Go: Week █████ 100%"],
  );
});

test("compact line marks trouble, and drops labels then calm reset times to stay on one line", () => {
  const now = 1_700_000_000_000;
  const hour = 3_600_000;
  const state = {
    anthropic: {
      kind: "ready" as const,
      windows: [
        { label: "5h", usedPercent: 10, resetsAt: now + 3 * hour },
        { label: "Week", usedPercent: 81, resetsAt: now + 9 * hour }, // late in the week: fine
        { label: "Fable", usedPercent: 60, resetsAt: now + 5 * 24 * hour }, // 2 days in: too fast
      ],
    },
    codex: { kind: "ready" as const, windows: [{ label: "Week", usedPercent: 0, resetsAt: now + 6 * 24 * hour }], credits: 0 },
    grok: { kind: "loading" as const },
    opencodeGo: {
      kind: "ready" as const,
      windows: [
        { label: "5h", usedPercent: 0, resetsAt: now + 4 * hour },
        { label: "Week", usedPercent: 100, resetsAt: now + 39 * hour },
        { label: "Month", usedPercent: 85, resetsAt: now + 7 * 24 * hour }, // 3 weeks in: fine
      ],
    },
  };
  const marked = { ...plainStyle, value: (tone: string, text: string) => (tone === "text" || tone === "dim" ? text : `<${tone}:${text}>`) };
  assert.equal(
    formatCompactWidget(state, now, marked),
    "Cl 5h 10·3h w 81·9h F <warning:60>·5d Cx w 0·6d $<error:0> Go 5h 0·4h w <error:100>·39h mo 85·7d",
  );

  const full = formatCompactWidget(state, now);
  const noLabels = "Cl 10·3h 81·9h 60·5d Cx 0·6d $0 Go 0·4h 100·39h 85·7d";
  const phone = "Cl 10 81 60·5d Cx 0 $0 Go 0 100·39h 85";
  assert.equal(formatCompactWidget(state, now, plainStyle, full.length), full);
  assert.equal(formatCompactWidget(state, now, plainStyle, full.length - 1), noLabels);
  assert.equal(formatCompactWidget(state, now, plainStyle, 44), phone);
  assert.ok(visibleWidth(formatCompactWidget(state, now, plainStyle, 20)) <= 20);
});

test("falls back to Claude Desktop web usage when the OAuth endpoint is rate limited", async () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  type WidgetContent = string[] | ((tui: unknown, theme: unknown) => { render(width: number): string[] });
  type UsageExtensionWithFallback = (
    pi: unknown,
    dependencies: { loadClaudeWebUsage(signal: AbortSignal): Promise<Array<{ label: string; usedPercent: number }> | null> },
  ) => void;

  const handlers = new Map<string, Handler>();
  let fallbackRequests = 0;
  let mountedWidget: { render(width: number): string[] } | undefined;
  const originalFetch = globalThis.fetch;

  const anthropicUserAgents: Array<string | null> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.match(url, /api\.anthropic\.com/);
    anthropicUserAgents.push(new Headers(init?.headers).get("user-agent"));
    return Response.json(
      { error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } },
      { status: 429 },
    );
  }) as typeof fetch;

  (usageExtension as unknown as UsageExtensionWithFallback)(
    {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerCommand() {},
    },
    {
      async loadClaudeWebUsage() {
        fallbackRequests += 1;
        return [
          { label: "5h", usedPercent: 6 },
          { label: "Week", usedPercent: 51 },
          { label: "Fable", usedPercent: 100 },
        ];
      },
    },
  );

  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      setWidget(_key: string, content: WidgetContent | undefined) {
        if (typeof content === "function") {
          mountedWidget = content({ requestRender() {} }, plainTheme);
        }
      },
    },
    modelRegistry: {
      async getProviderAuth(provider: string) {
        return provider === "anthropic"
          ? { auth: { apiKey: "oauth-token" }, source: "OAuth" }
          : undefined;
      },
      getProvider() {
        return undefined;
      },
    },
  };
  const claudeLine = (): string => mountedWidget?.render(200)[0]?.trim() ?? "";

  try {
    handlers.get("session_start")?.({}, ctx);
    for (let attempt = 0; attempt < 50 && segment(claudeLine(), 0).includes("…"); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(fallbackRequests, 1);
    assert.match(anthropicUserAgents[0] ?? "", /^claude-code\/\d+\.\d+\.\d+$/);
    assert.equal(segment(claudeLine(), 0), "Cl 5h 6 w 51 F 100");
  } finally {
    globalThis.fetch = originalFetch;
    handlers.get("session_shutdown")?.({}, ctx);
  }
});

test("updates a mounted widget in place and retains Claude usage when polling is rate limited", async () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  type WidgetContent = string[] | ((tui: unknown, theme: unknown) => { render(width: number): string[] });

  const handlers = new Map<string, Handler>();
  let usageCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  usageExtension({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      if (name === "usage") usageCommand = command.handler;
    },
  } as never, { loadClaudeWebUsage: async () => null });

  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  let nowMs = 1_700_000_000_000;
  Date.now = () => nowMs;
  let anthropicRequests = 0;
  let codexRequests = 0;
  let renderRequests = 0;
  const widgetUpdates: WidgetContent[] = [];
  let mountedWidget: { render(width: number): string[] } | undefined;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.anthropic.com")) {
      anthropicRequests += 1;
      if (anthropicRequests === 2) {
        return Response.json(
          { error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } },
          { status: 429 },
        );
      }
      return Response.json({
        limits: [
          { kind: "session", percent: 100 },
          {
            kind: "weekly_scoped",
            percent: 100,
            scope: { model: { display_name: "Fable" } },
          },
        ],
      });
    }
    if (url.includes("/wham/usage")) {
      codexRequests += 1;
      return Response.json({
        rate_limit: { primary_window: { used_percent: codexRequests === 1 ? 31 : 32 } },
        credits: { has_credits: true, unlimited: false, balance: "61246.0650680000" },
      });
    }
    if (url.endsWith("/user")) return Response.json({ userId: "user-123" });
    if (url.includes("/billing")) {
      return Response.json({ config: { creditUsagePercent: 42 } });
    }
    if (url.includes("/zen/go/v1/usage")) {
      return Response.json({ usage: { weekly: { status: "ok", percent: 60 } } });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setWidget(_key: string, content: WidgetContent | undefined) {
        if (content === undefined) return;
        widgetUpdates.push(content);
        if (typeof content === "function") {
          mountedWidget = content({ requestRender: () => { renderRequests += 1; } }, plainTheme);
        }
      },
    },
    modelRegistry: {
      async getProviderAuth(provider: string) {
        return {
          auth: { apiKey: "header.payload.signature" },
          source: "OAuth",
          ...(provider === "openai-codex" ? { auth: { apiKey: "header.payload.signature" } } : {}),
        };
      },
      getProvider() {
        return undefined;
      },
    },
  };
  const visibleLines = (): string[] => {
    if (mountedWidget) return mountedWidget.render(200).map((line) => line.trim());
    const latest = widgetUpdates.at(-1);
    return Array.isArray(latest) ? latest : [];
  };
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail("usage refresh did not settle");
  };

  try {
    const start = handlers.get("session_start");
    assert.ok(start);
    start({}, ctx);
    await waitFor(() => segment(visibleLines()[0], 0) !== "" && !segment(visibleLines()[0], 0).includes("…"));

    const claudeBefore = segment(visibleLines()[0], 0);
    const rendersBefore = renderRequests;
    nowMs += 60_000;
    handlers.get("agent_settled")?.({}, ctx);
    await waitFor(() => codexRequests === 2 && segment(visibleLines()[0], 1).includes("32"));
    const anthropicRequestsAfterMinute = anthropicRequests;

    assert.ok(usageCommand);
    await usageCommand("", ctx);

    assert.deepEqual(
      {
        widgetRegistrations: widgetUpdates.length,
        changedLineRenders: renderRequests - rendersBefore,
        anthropicRequestsAfterMinute,
        claudeBefore,
        claudeAfter: segment(visibleLines()[0], 0),
        codexAfter: `${segment(visibleLines()[0], 1)} · ${segment(visibleLines()[0], 2)}`,
        usageDetail: notifications.at(-1),
      },
      {
        widgetRegistrations: 1,
        changedLineRenders: 1,
        anthropicRequestsAfterMinute: 1,
        claudeBefore: "Cl 5h 100 F 100",
        claudeAfter: "Cl 5h 100 F 100",
        codexAfter: "Cx P 32 $61k · Go w 60",
        usageDetail: "Claude: 5h █████ 100% · Fable █████ 100%\nCodex: Primary ██░░░ 32% · Credits 61,246 │ Go: Week ███░░ 60%",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    handlers.get("session_shutdown")?.({}, ctx);
  }
});

test("a one-minute provider poll does not invalidate a slow Claude refresh", async () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  type WidgetContent = string[] | ((tui: unknown, theme: unknown) => { render(width: number): string[] });
  type ResolvedAuth = { auth: { apiKey: string }; source: string };

  const handlers = new Map<string, Handler>();
  usageExtension({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as never);

  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  let nowMs = 1_700_000_000_000;
  Date.now = () => nowMs;
  let resolveAnthropicAuth!: (auth: ResolvedAuth) => void;
  const delayedAnthropicAuth = new Promise<ResolvedAuth>((resolve) => {
    resolveAnthropicAuth = resolve;
  });
  let anthropicAuthRequests = 0;
  let codexAuthRequests = 0;
  let mountedWidget: { render(width: number): string[] } | undefined;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    assert.match(url, /api\.anthropic\.com/);
    return Response.json({ limits: [{ kind: "session", percent: 64 }] });
  }) as typeof fetch;

  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      setWidget(_key: string, content: WidgetContent | undefined) {
        if (typeof content === "function") {
          mountedWidget = content({ requestRender() {} }, plainTheme);
        }
      },
    },
    modelRegistry: {
      async getProviderAuth(provider: string) {
        if (provider === "anthropic") {
          anthropicAuthRequests += 1;
          return delayedAnthropicAuth;
        }
        if (provider === "openai-codex") codexAuthRequests += 1;
        return undefined;
      },
      getProvider() {
        return undefined;
      },
    },
  };
  const visibleLines = (): string[] => mountedWidget?.render(200).map((line) => line.trim()) ?? [];
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail("overlapping usage refresh did not settle");
  };

  try {
    handlers.get("session_start")?.({}, ctx);
    await waitFor(() => codexAuthRequests === 1 && segment(visibleLines()[0], 1) === "Cx login");
    await new Promise<void>((resolve) => setImmediate(resolve));

    nowMs += 60_000;
    handlers.get("agent_settled")?.({}, ctx);
    await waitFor(() => codexAuthRequests === 2);

    resolveAnthropicAuth({ auth: { apiKey: "oauth-token" }, source: "OAuth" });
    await waitFor(() => segment(visibleLines()[0], 0) === "Cl 5h 64");

    assert.equal(anthropicAuthRequests, 1, "the slow Claude auth request should be coalesced");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    handlers.get("session_shutdown")?.({}, ctx);
  }
});

test("a dead or rejected Codex login asks for /login openai-codex instead of an error", async () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  type ResolvedAuth = { auth: { apiKey: string }; source: string };
  const cases: Array<{ name: string; auth: () => Promise<ResolvedAuth>; codexStatus: number }> = [
    {
      name: "refresh token already used",
      auth: async () => {
        throw new Error("OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): refresh_token_reused");
      },
      codexStatus: 200,
    },
    { name: "usage endpoint rejects the token", auth: async () => ({ auth: { apiKey: "a.b.c" }, source: "OAuth" }), codexStatus: 401 },
  ];

  for (const { name, auth, codexStatus } of cases) {
    const handlers = new Map<string, Handler>();
    let usageCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    usageExtension({
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerCommand: (_name: string, command: { handler: typeof usageCommand }) => {
        usageCommand = command.handler;
      },
    } as never);
    const notifications: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: codexStatus })) as typeof fetch;
    let mountedWidget: { render(width: number): string[] } | undefined;
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        notify: (message: string) => notifications.push(message),
        setWidget(_key: string, content: unknown) {
          if (typeof content === "function") mountedWidget = content({ requestRender() {} }, plainTheme);
        },
      },
      modelRegistry: {
        getProviderAuth: async (provider: string) => (provider === "openai-codex" ? auth() : undefined),
        getProvider: () => undefined,
      },
    };
    const codexLine = () => segment(mountedWidget?.render(200)[0]?.trim(), 1);
    try {
      handlers.get("session_start")?.({}, ctx);
      for (let attempt = 0; attempt < 50 && codexLine() !== "Cx login"; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(codexLine(), "Cx login", name);
      await usageCommand?.("", ctx);
      assert.match(notifications.at(-1) ?? "", /Codex: \/login openai-codex for usage/, name);
    } finally {
      globalThis.fetch = originalFetch;
      handlers.get("session_shutdown")?.({}, ctx);
    }
  }
});

test("polls every minute only while the agent is active", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;

  const handlers = new Map<string, Handler>();
  usageExtension({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as never);

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const handles: Array<ReturnType<typeof setInterval>> = [];
  const cleared: Array<ReturnType<typeof setInterval>> = [];
  const delays: number[] = [];

  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    const handle = { callback } as unknown as ReturnType<typeof setInterval>;
    handles.push(handle);
    delays.push(delay ?? 0);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
    cleared.push(handle);
  }) as typeof clearInterval;

  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: { setWidget() {} },
    modelRegistry: {
      async getProviderAuth() {
        return undefined;
      },
      getProvider() {
        return undefined;
      },
    },
  };
  const invoke = (event: string): void => {
    const handler = handlers.get(event);
    assert.ok(handler, `missing ${event} handler`);
    handler({}, ctx);
  };

  try {
    invoke("session_start");
    assert.equal(handles.length, 0);

    invoke("agent_start");
    assert.deepEqual(delays, [60_000]);

    invoke("agent_start");
    assert.equal(handles.length, 1, "repeated starts must not create overlapping timers");

    invoke("agent_settled");
    assert.deepEqual(cleared, [handles[0]]);

    invoke("agent_start");
    assert.deepEqual(delays, [60_000, 60_000]);

    invoke("session_shutdown");
    assert.deepEqual(cleared, handles);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
