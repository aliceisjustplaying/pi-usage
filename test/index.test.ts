import test from "node:test";
import assert from "node:assert/strict";

import usageExtension, {
  extractAccountId,
  formatProviderLine,
  formatUsageWindow,
  formatWidget,
  parseAnthropicUsage,
  parseCodexUsage,
  parseGrokUsage,
  parseGrokUserId,
} from "../index.ts";

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
      },
      now,
    ),
    ["Claude: Fable █████ 100%", "Codex: HTTP 429 │ Grok: /login xai-auth"],
  );
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
