# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Model variants moved to opencode's native variant picker (Ctrl+T): only the 47 base ids are published, and each Cursor variant (e.g. `low`, `272k-none`, `no-thinking`, `fast`) is an opencode `variants` entry sent as `cursor_params` in the request body. Unknown variant params return 400.
- The base id now uses Cursor's real default variant (`isDefault`) and sends its params explicitly; previously it implied the first-listed param values (e.g. `gpt-5.5` is now 1M context / medium reasoning, was 272k).
- **Breaking:** suffixed variant ids like `cursor/gpt-5.5-low-fast` are removed; pick the base model and choose the variant with Ctrl+T. Models cache bumped to v4 (refetched once).

## 0.2.0 — 2026-10-16

### Added

- Model variants: every variant Cursor publishes (reasoning effort, fast, 1M context) is a selectable id, e.g. `cursor/gpt-5.5-low-fast`, `cursor/claude-opus-5-5-1m-max`. Ids are the base id plus non-default param values and map back to Cursor `ModelSelection` params; unknown ids still pass through to Cursor's own 400.
- Model context limits: each model gets `limit.context` from Cursor's `context` parameter (default 200k) and `limit.output` 32k. Without a limit opencode 1.19 sets context to 0 and silently disables auto-compaction and the context indicator.
- SDK key check on `/chat/completions` (60s cache, skipped for pasted/env keys): a missing or expired key returns 401 telling the user to run `opencode auth login`; one-time stderr warning within 7 days of expiry.
- Concurrency cap: a FIFO semaphore limits concurrently active Cursor runs (default 4, `OPENCODE_CURSOR_MAX_ACTIVE` to override). Extra requests queue; tool-result continuations never take a slot.
- Retry: `Agent.create` / `Agent.resume` / `send` are attempted up to 3 times with jittered backoff on 429, 5xx, and network errors; never after the first byte.
- Usage reports cache-read tokens (`prompt_tokens_details.cached_tokens`) and reasoning tokens (`completion_tokens_details.reasoning_tokens`).

### Changed

- Models cache bumped to v3 `{name, context, params}`; older cache files are refetched once. Catalog code moved to `src/models.ts`.
- The reply is opened only on content deltas (text/thinking), so run errors before any content become real JSON error responses instead of a 200 stream with an error frame.

### Fixed

- Real HTTP error statuses: failures before the first byte return a JSON error with a real status (400 bad model/argument, 401 auth, 403 blocked, 429 rate limit, 502 otherwise); mid-stream failures emit an OpenAI error frame and close without `[DONE]`.
- Admin-blocked models: "Model Blocked" / `permission_denied` map to 403 `permission_error` and are never retried. A 403 marks the model and its variants blocked in the models cache; they are hidden from the model list until the next 24h catalog refresh and still resolve if used explicitly.
- Abort propagation: the request AbortSignal and stream `cancel()` cancel the Cursor run, close the agent, and release registries (no more zombie runs burning usage).
- agentId race: the held run is registered before `send()`, so a tool call firing immediately can never miss its continuation lookup.
- Session resume is scoped by opencode session id (via the `chat.headers` hook), so byte-identical histories from different sessions (parallel sub-agents) never resume each other's Cursor agent. Unscoped callers and existing disk entries hash exactly as before.
- Per-session temp workspaces are removed once no session, disk, or held entry references them.

## 0.1.0 — 2026-10-15

- Initial release: in-process Cursor SDK bridge, auth, tool loop, session resume, AGENTS.md system prompt, dynamic model list.
