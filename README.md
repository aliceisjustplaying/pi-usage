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

Then sign in to the subscription providers you use with Pi's `/login` command. For Grok, install [`pi-xai-oauth`](https://github.com/BlockedPath/pi-xai-oauth) and run `/login xai-auth`; existing official Grok CLI credentials can be imported by that login flow. The widget always checks all three providers, regardless of the active model. Anthropic's `ANTHROPIC_OAUTH_TOKEN` environment variable is also recognized by Pi as an OAuth-token source.

## Behavior

- Refreshes asynchronously when a session starts, when the agent starts or settles, and whenever `/usage` is run. During active agent runs, Codex and Grok refresh every 60 seconds; Claude refreshes at most every 5 minutes to avoid rate-limiting its usage endpoint.
- Uses Pi's `ctx.modelRegistry.getProviderAuth` so token refresh stays owned by Pi.
- Only contacts subscription endpoints for OAuth credentials. API-key and logged-out users see a short `/login` hint.
- Mounts one persistent TUI widget and updates its existing text components only when a displayed line changes. Its single polling timer exists only while the agent is active and is cleaned up when the agent settles or the session shuts down.
- Keeps no persistent cache. If Claude's usage endpoint returns HTTP 429 after a successful refresh, the widget retains the last known Claude windows instead of replacing them with the transport error.
- Uses an 8-second request timeout and makes one request each for Claude and Codex, plus Grok's identity-first two-request billing flow. HTTP 429 responses are not retried.
- Displays Claude on the first line and Codex plus Grok on the second. The short duration after each percentage is the time until that quota resets, shown as hours/minutes or days/hours. Claude model-scoped weekly quotas are included; feature-specific Codex meters such as Spark are intentionally ignored.
- Uses only Pi-managed Grok OAuth from `xai-auth` or Pi's built-in `xai` provider. It never reads `~/.grok/auth.json` directly.

The widget never reads Pi's auth files directly, logs tokens, persists credentials, or retains raw provider responses.

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

- Anthropic: `GET https://api.anthropic.com/api/oauth/usage`
- OpenAI Codex: `GET <provider baseUrl>/wham/usage` (normally `https://chatgpt.com/backend-api/wham/usage`)
- Grok: `GET https://cli-chat-proxy.grok.com/v1/user`, then `GET /v1/billing?format=credits` with the transient validated user ID

Their response formats can change without notice. This package handles the currently observed formats and reports malformed responses without exposing payload contents.
