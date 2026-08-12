import test from "node:test";
import assert from "node:assert/strict";

import {
  extractAccountId,
  formatProviderLine,
  formatUsageWindow,
  formatWidget,
  parseAnthropicUsage,
  parseCodexUsage,
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

test("parses Codex shared and every additional rate limit independently", () => {
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
          {
            metered_feature: "Review",
            rate_limit: {
              secondary_window: { used_percent: 40, reset_after_seconds: 120 },
            },
          },
        ],
      },
      now,
    ),
    [
      { label: "5h", usedPercent: 31, resetsAt: 1_700_000_100_000 },
      { label: "Week", usedPercent: 62, resetsAt: 1_700_200_000_000 },
      { label: "Spark 3h", usedPercent: 8, resetsAt: now + 90_000 },
      { label: "Review Secondary", usedPercent: 40, resetsAt: now + 120_000 },
    ],
  );
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
  assert.deepEqual(
    parseCodexUsage({
      additional_rate_limits: [null, { limit_name: "Broken" }, { limit_name: "Valid", rate_limit: { primary_window: { used_percent: 3 } } }],
    }),
    [{ label: "Valid Primary", usedPercent: 3, resetsAt: undefined }],
  );
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
  assert.deepEqual(
    parseCodexUsage({
      additional_rate_limits: [
        { limit_name: "\u001b[2J Spark\n", rate_limit: { primary_window: { used_percent: 3 } } },
      ],
    }),
    [{ label: "Spark Primary", usedPercent: 3, resetsAt: undefined }],
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
    "5h ███░░ 61% 2h",
  );
  assert.equal(formatUsageWindow({ label: "Week", resetsAt: now + 30_000 }, now), "Week ????? ?% <1m");
  assert.equal(formatProviderLine("Claude", { kind: "login" }, now), "Claude: /login for OAuth");
  assert.deepEqual(
    formatWidget(
      {
        anthropic: { kind: "ready", windows: [{ label: "Fable", usedPercent: 100 }] },
        codex: { kind: "error", message: "HTTP 429" },
      },
      now,
    ),
    ["Claude: Fable █████ 100%", "Codex: HTTP 429"],
  );
});
