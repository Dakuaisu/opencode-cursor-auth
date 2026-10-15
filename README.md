# opencode-cursor-auth

Use your **Cursor subscription** inside [opencode](https://opencode.ai) — no proxy server, no port, no separate API bill.

The plugin bridges opencode's OpenAI-style chat requests to the official [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) **in-process**, so every model your Cursor plan includes (GPT, Claude, Gemini, Kimi, GLM, Composer, …) shows up as a `cursor/*` model in opencode.

## Features

- **Official SDK, not a reverse-engineered API** — auth, checksums, and client versioning handled by `@cursor/sdk`
- **In-process bridge** — no local HTTP proxy, no port to collide on, no extra daemon
- **Full tool loop** — opencode's native tools (read, edit, bash, MCP, …) work end-to-end via a held-run bridge: one Cursor run spans the whole tool exchange
- **Thinking blocks** — Cursor reasoning streams into opencode as proper thinking blocks (`reasoning_content`)
- **Session resume** — conversations map to native Cursor agents (`Agent.resume`), in-memory and persisted to disk for 7 days, scoped per opencode session so parallel sub-agents never share an agent
- **System prompts** — delivered via `AGENTS.md` in a per-session workspace (the `--system-prompt` flag is server-gated by Cursor)
- **Dynamic model list with variants** — fetched live from `Cursor.models.list()`, cached 24h; every reasoning-effort / fast / 1M-context variant is its own model id
- **Context limits** — each model publishes its Cursor context window, so opencode's auto-compaction and context indicator work
- **Real error statuses** — 400 / 401 / 403 / 429 / 502 instead of a 200 stream carrying an error
- **Cancellation** — Esc or a sub-agent timeout cancels the Cursor run and closes the agent
- **Concurrency cap and retry** — at most 4 Cursor runs at once (configurable); transient failures retried before the first byte
- **Usage** — prompt, completion, cached-read, and reasoning tokens reported to opencode
- **Zero cost display** — models are marked cost-free since you're on subscription billing

## Requirements

- Node >= 22.13 (opencode runs plugins on Bun, which also works)
- [`cursor-agent` CLI](https://cursor.com/docs/cli) installed (`curl https://cursor.com/install -fsS | bash`) — the SDK's local executor uses it
- A Cursor subscription

## Install

Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@vidit19sharma/opencode-cursor-auth@latest"]
}
```

The plugin auto-registers a `cursor` provider — no manual provider config needed.

## Authenticate

```sh
opencode auth login
```

Pick **Cursor**, then either:

- **Log in with Cursor (browser)** — opens cursor.com, mints a 90-day SDK key, stored at `~/.cursor/sdk/auth.json`
- **Paste a Cursor API key** — from [cursor.com/dashboard](https://cursor.com/dashboard)

Alternatively set `CURSOR_API_KEY` in your environment.

When the browser-login key is used, the plugin checks it before each request (cached 60s): a missing or expired key returns a 401 telling you to run `opencode auth login`, and a one-time warning is printed to stderr within 7 days of expiry. The check is skipped for pasted keys and `CURSOR_API_KEY`.

## Use

```sh
opencode run -m cursor/gpt-5.5 "hello"
opencode run -m cursor/claude-opus-5-5 "hello"
opencode run -m cursor/auto "hello"
```

Or pick any `cursor/*` model from the opencode model selector.

## Models

```sh
opencode models | grep cursor/
```

- **Base ids** (`cursor/gpt-5.5`) send no parameters, so Cursor applies its own defaults. Cursor's `default` model is exposed as `cursor/auto`.
- **Variant ids** are the base id plus every non-default parameter value, in Cursor's parameter order. Boolean parameters use the parameter name. Examples: `cursor/gpt-5.5-low`, `cursor/gpt-5.5-high-fast`, `cursor/gpt-5.5-1m-extra-high`, `cursor/claude-opus-5-5-1m-max`.
- The full catalog is currently about 485 ids from 47 models.
- **Limits**: `limit.context` is the variant's context value, else the model's first listed context value, else 200k. `limit.output` is a fixed 32k accounting reserve (Cursor publishes no output cap and the bridge sends no `max_tokens`). Limits you set yourself in opencode config are kept.
- **Unknown ids** are passed through to Cursor, which answers with its own 400.
- **Blocked models**: Cursor's catalog has no per-account entitlement info. If Cursor rejects a model as "Model Blocked" (e.g. a team admin disabled it), the request fails with 403 `permission_error` carrying Cursor's message, and that model and all its variants are hidden from the list. Using a hidden id explicitly still sends it to Cursor. Blocked flags persist across catalog refreshes; delete `~/.cache/opencode-cursor-auth/models.json` to re-check.
- **Offline / logged out**: the stale cache is used if present, otherwise only `cursor/auto`.

The catalog is cached at `~/.cache/opencode-cursor-auth/models.json`; delete it to force a refresh.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_CURSOR_MAX_ACTIVE` | `4` | Max Cursor runs active at once; extra requests queue FIFO |
| `CURSOR_API_KEY` | unset | Use this key instead of the stored SDK key |

| Path | Contents |
| --- | --- |
| `~/.cursor/sdk/auth.json` | 90-day SDK key from browser login (written by `@cursor/sdk`) |
| `~/.cache/opencode-cursor-auth/models.json` | Model catalog, 24h TTL, blocked-model flags |
| `~/.cache/opencode-cursor-auth/sessions.json` | Conversation → Cursor agent map, 7-day TTL |

## How it works

```
opencode ──(OpenAI chat JSON)──> plugin fetch() ──> @cursor/sdk Agent ──> cursor-agent ──> Cursor backend
         <─(SSE stream)────────  bridge  <──(typed deltas: text / thinking / tool calls)
```

- opencode calls the provider's `fetch` — the plugin intercepts it in-process; `http://cursor.local/v1` is a dummy URL that never resolves.
- Each opencode tool is registered as a Cursor **custom tool** whose `execute()` parks a promise, emits an OpenAI `tool_calls` chunk, and resumes the *same* Cursor run when opencode sends the tool result back.
- Conversation prefixes, plus the opencode session id (sent via the `chat.headers` hook), are hashed → mapped to Cursor agent IDs, so follow-up turns use `Agent.resume` instead of replaying history. The map persists at `~/.cache/opencode-cursor-auth/sessions.json`.
- System messages are written to `AGENTS.md` in a per-session temp workspace and loaded via Cursor's project rules (`settingSources: ["project"]`). Workspaces are removed once no session references them.
- Variant ids are mapped back to Cursor `ModelSelection` params (`{ id, params }`).
- New turns take a slot from a FIFO semaphore (`OPENCODE_CURSOR_MAX_ACTIVE`); tool-result continuations reuse their run's slot. `Agent.create` / `Agent.resume` / `send` are attempted up to 3 times with jittered exponential backoff on 429, 5xx, and network errors, never after the first byte.
- The HTTP reply opens on the first text or thinking delta, so failures before any content become real HTTP errors.
- The request's abort signal and stream cancel cancel the Cursor run, close the agent, and release its slot.

### Errors

| Status | When |
| --- | --- |
| 400 | Unknown model or bad argument (Cursor's message); also an expired tool-call continuation |
| 401 | SDK key missing/expired, or Cursor rejects the key |
| 403 | Model blocked for your account (`permission_error`) |
| 429 | Cursor rate limit |
| 502 | Anything else |

These are JSON error responses when the failure happens before the first byte; mid-stream failures emit an SSE `error` frame and close the stream without `[DONE]`.

## Development

```sh
bun install
bun run build        # tsc → dist/
bun run test         # end-to-end bridge tests (requires Cursor login, uses real Cursor usage)
bun run spike        # raw @cursor/sdk validation
```

The test suite runs 13 scenarios: plain streaming, a full tool loop on one held run, in-memory and disk-persisted session resume, AGENTS.md system-prompt delivery, mid-stream abort, error statuses, session scoping, context limits and key checks, model variants, the concurrency cap, retry semantics, and blocked models.

## Known limitations

- `systemPrompt` as a true harness replacement is feature-gated server-side by Cursor; system text is applied via `AGENTS.md` as a project rule (merged under Cursor's harness prompt).
- The SDK spawns a `cursor-agent` worker per turn (~1–2 s startup on resume).
- The model list is Cursor's full catalog (~485 ids). It has no entitlement info, so models your plan or team blocks only disappear after the first 403.
- A run parked waiting for a tool result keeps its slot. Cursor-model sessions that spawn Cursor-model sub-agents nested deeper than `OPENCODE_CURSOR_MAX_ACTIVE` will stall; raise the limit if you fan out.
- Usage/rate limits are whatever your Cursor plan enforces — the plugin adds none beyond the concurrency cap.

## License

[MIT](./LICENSE) © Vidit Sharma
