# opencode-cursor-auth

Use your **Cursor subscription** inside [opencode](https://opencode.ai) — no proxy server, no port, no separate API bill.

The plugin bridges opencode's OpenAI-style chat requests to the official [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) **in-process**, so every model your Cursor plan includes (GPT, Claude, Gemini, Kimi, GLM, Composer, …) shows up as a `cursor/*` model in opencode.

## Features

- **Official SDK, not a reverse-engineered API** — auth, checksums, and client versioning handled by `@cursor/sdk`
- **In-process bridge** — no local HTTP proxy, no port to collide on, no extra daemon
- **Full tool loop** — opencode's native tools (read, edit, bash, MCP, …) work end-to-end via a held-run bridge: one Cursor run spans the whole tool exchange
- **Thinking blocks** — Cursor reasoning streams into opencode as proper thinking blocks (`reasoning_content`)
- **Session resume** — conversations map to native Cursor agents (`Agent.resume`), in-memory and persisted to disk for 7 days, so multi-turn chats don't replay history
- **System prompts** — delivered via `AGENTS.md` in a per-session workspace (the `--system-prompt` flag is server-gated by Cursor)
- **Dynamic model list** — fetched live from `Cursor.models.list()`, cached 24h
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

## Use

```sh
opencode run -m cursor/gpt-5.5 "hello"
opencode run -m cursor/claude-opus-5-5 "hello"
opencode run -m cursor/auto "hello"
```

Or pick any `cursor/*` model from the opencode model selector.

## How it works

```
opencode ──(OpenAI chat JSON)──> plugin fetch() ──> @cursor/sdk Agent ──> cursor-agent ──> Cursor backend
         <─(SSE stream)────────  bridge  <──(typed deltas: text / thinking / tool calls)
```

- opencode calls the provider's `fetch` — the plugin intercepts it in-process; `http://cursor.local/v1` is a dummy URL that never resolves.
- Each opencode tool is registered as a Cursor **custom tool** whose `execute()` parks a promise, emits an OpenAI `tool_calls` chunk, and resumes the *same* Cursor run when opencode sends the tool result back.
- Conversation prefixes are hashed → mapped to Cursor agent IDs, so follow-up turns use `Agent.resume` instead of replaying history. The map persists at `~/.cache/opencode-cursor-auth/sessions.json`.
- System messages are written to `AGENTS.md` in a per-session temp workspace and loaded via Cursor's project rules (`settingSources: ["project"]`).

## Development

```sh
bun install
bun run build        # tsc → dist/
bun run test         # end-to-end bridge tests (requires Cursor login)
bun run spike        # raw @cursor/sdk validation
```

The test suite exercises: plain streaming, a full tool loop on one held run, in-memory session resume, AGENTS.md system-prompt delivery, and disk-persisted resume.

## Known limitations

- `systemPrompt` as a true harness replacement is feature-gated server-side by Cursor; system text is applied as a project rule (merged under Cursor's harness prompt).
- The SDK spawns a `cursor-agent` worker per turn (~1–2 s startup on resume).
- Usage/rate limits are whatever your Cursor plan enforces — the plugin adds none.

## License

[MIT](./LICENSE) © Vidit Sharma
