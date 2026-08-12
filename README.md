# pi-usage

A small, zero-configuration [Pi](https://pi.dev) extension that shows Claude and OpenAI Codex/ChatGPT subscription quota usage below the editor. Inspired by [`@marckrenn/pi-sub-bar`](https://github.com/marckrenn/pi-sub), but intentionally limited to these two providers and current usage formats.

```text
Claude: 5h ██░░░ 38% 2h · Week ███░░ 55% 4d · Fable █░░░░ 12% 3d
Codex: 5h █░░░░ 20% 3h · Week ████░ 82% 2d
```

## Install

```sh
pi install git:github.com/aliceisjustplaying/pi-usage
```

Then sign in to the subscription providers you use with Pi's `/login` command. The widget always checks both providers, regardless of the active model. Anthropic's `ANTHROPIC_OAUTH_TOKEN` environment variable is also recognized by Pi as an OAuth-token source.

## Behavior

- Refreshes asynchronously when a session starts, after the agent settles (at most once per 60 seconds), and whenever `/usage` is run.
- Uses Pi's `ctx.modelRegistry.getProviderAuth` so token refresh stays owned by Pi.
- Only contacts subscription endpoints for OAuth credentials. API-key and logged-out users see a short `/login` hint.
- Keeps no cache, starts no timers, and has no runtime dependencies.
- Uses an 8-second request timeout and makes one request per provider per refresh. In particular, HTTP 429 responses are not retried.
- Displays independent Claude model-scoped weekly quotas and Codex's shared 5-hour and weekly limits. Feature-specific Codex meters such as Spark are intentionally ignored.

The widget never reads Pi's auth files directly, logs tokens, persists credentials, or retains raw provider responses.

## Development

```sh
npm install
npm test
npm run typecheck
npm pack --dry-run
```

Tests use Node's built-in test runner and require Node 22.6 or newer for TypeScript type stripping. Only development dependencies are installed; the extension entrypoint has no runtime imports.

## Provider endpoint note

The subscription usage APIs are private and undocumented:

- Anthropic: `GET https://api.anthropic.com/api/oauth/usage`
- OpenAI Codex: `GET <provider baseUrl>/wham/usage` (normally `https://chatgpt.com/backend-api/wham/usage`)

Their response formats can change without notice. This package handles the currently observed formats and reports malformed responses without exposing payload contents.
