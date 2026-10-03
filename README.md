# pi-usage

A small, zero-configuration [Pi](https://pi.dev) extension that shows Claude, OpenAI Codex/ChatGPT, and Grok subscription quota usage below the editor. Inspired by [`@marckrenn/pi-sub-bar`](https://github.com/marckrenn/pi-sub), but intentionally limited to these providers and current usage formats.

```text
Claude: 5h ██░░░ 38% 2h17m · Week ███░░ 55% 4d6h · Fable █░░░░ 12% 3d2h
Codex: 5h █░░░░ 20% 3h8m · Week ████░ 82% 2d4h │ Grok: Week ██░░░ 42% 4d9h
```

## Install

```sh
pi install git:github.com/aliceisjustplaying/pi-usage
```

Then sign in to the subscription providers you use with Pi's `/login` command. For Grok, install [`pi-xai-oauth`](https://github.com/BlockedPath/pi-xai-oauth) and run `/login xai-auth`; existing official Grok CLI credentials can be imported by that login flow. The widget always checks all three providers, regardless of the active model. Anthropic's `ANTHROPIC_OAUTH_TOKEN` environment variable is also recognized by Pi as an OAuth-token source. On macOS, if Anthropic's OAuth usage endpoint returns HTTP 429, the extension can fall back to an existing logged-in Claude Desktop session.

## Behavior

- Refreshes asynchronously when a session starts, when the agent starts or settles, and whenever `/usage` is run. During active agent runs, Codex and Grok refresh every 60 seconds; Claude refreshes at most every 5 minutes to avoid rate-limiting its usage endpoint.
- Uses Pi's `ctx.modelRegistry.getProviderAuth` so token refresh stays owned by Pi.
- Normally contacts subscription endpoints only for OAuth credentials. API-key and logged-out users see `login` in the widget and the exact `/login` command in `/usage`.
- On an Anthropic OAuth HTTP 429, the macOS fallback reads Claude Desktop's encrypted `sessionKey`, organization, and optional Cloudflare cookies, decrypts them with the `Claude Safe Storage` Keychain entry, and sends them only to `https://claude.ai/api/organizations/{orgId}/usage`. The cookies are never logged or persisted by this extension. macOS may show a Keychain permission prompt the first time. Claude Desktop and Pi can be signed into different Anthropic accounts; the widget keeps the compact `Claude:` label either way.
- Mounts one persistent TUI widget and updates its existing text components only when a displayed line changes. Its single polling timer exists only while the agent is active and is cleaned up when the agent settles or the session shuts down.
- Shares successful Claude web fallback results through `~/.cache/pi-usage/claude-web.json` for 5 minutes. This file contains only parsed quota labels, percentages, reset times, and a cache timestamp—never cookies or raw responses. Windows past their reset time are ignored, and the file is ignored after 24 hours.
- If both Claude endpoints fail after a successful refresh, the widget retains the last known in-memory or quota-cache windows instead of replacing them with a transport error.
- Uses an 8-second wall-clock timeout per request or local credential command. The normal path makes one request each for Claude and Codex, plus Grok's identity-first two-request billing flow. After an Anthropic OAuth 429, Keychain access, SQLite access, and the web fallback can extend that Claude refresh to roughly 24 seconds in the worst case. HTTP 429 responses are not retried.
- Shows one line, never wrapped. Providers are colored badges (`Cl` Claude, `Cx` Codex, `Go` OpenCode Go). Each number is percent used, with a faint label and a faint time until it resets, for example `Cl 5h 13·3h w 81·10h F 49·10h  Cx w 0·6d $59k  Go 5h 0·4h w 100·39h mo 85·7d`. Order is fixed: Claude 5h, week and model-scoped weekly limits such as Fable (`F`); Codex week, then credits (`$`); Go 5h, week and month. New windows a provider reports are appended to its group.
- When the screen is too narrow, detail drops in this order so it stays on one line: labels, then reset times for numbers that are fine. At phone width (about 45 columns) it reads like `Cl 13 81 49  Cx 0 $59k  Go 0 100·39h 85`.
- Numbers that need attention sit on a filled block: yellow when usage is running ahead of the clock (at least 50% used and more than 10 points ahead of the share of the window that has passed), red at 95% or more. Zero credits are red. `login` means that provider's login is missing or dead.
- `/usage` refreshes and prints the detailed view, with every window's label, bar, percentage and reset countdown, plus the exact `/login` command when one is needed. Feature-specific Codex meters such as Spark are intentionally ignored.
- Uses only Pi-managed Grok OAuth from `xai-auth` or Pi's built-in `xai` provider. It never reads `~/.grok/auth.json` directly.

The widget never reads Pi's auth files directly, logs tokens, persists credentials, or retains raw provider responses. Its only persisted provider data is the bounded Claude quota cache described above.

## Development

```sh
npm install
npm test
npm run typecheck
npm pack --dry-run
```

Tests use Node's built-in test runner and require Node 22.19 or newer. The extension uses Pi's peer-provided `@earendil-works/pi-tui` components for in-place widget updates.

## Provider endpoint note

The subscription usage APIs are private and undocumented:

- Anthropic: `GET https://api.anthropic.com/api/oauth/usage`; on macOS HTTP 429 only, `GET https://claude.ai/api/organizations/{orgId}/usage` using the local Claude Desktop web session
- OpenAI Codex: `GET <provider baseUrl>/wham/usage` (normally `https://chatgpt.com/backend-api/wham/usage`)
- Grok: `GET https://cli-chat-proxy.grok.com/v1/user`, then `GET /v1/billing?format=credits` with the transient validated user ID

Their response formats can change without notice. This package handles the currently observed formats and reports malformed responses without exposing payload contents.
