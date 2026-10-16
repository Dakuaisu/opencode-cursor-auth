# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.3.0 — 2026-10-16

### Breaking

- The suffixed variant ids from 0.2.0 (`cursor/gpt-5.5-low`, `cursor/claude-opus-5-5-1m-max`, …) no longer exist; Cursor rejects them with 400 "Cannot use this model". Migrate `cursor/gpt-5.5-low` to model `cursor/gpt-5.5` + variant `low` (Ctrl+T in the TUI, or `variant:` in config).

### Added

- Cursor variants on opencode's native variant picker (Ctrl+T): the model list is the 47 base ids only, and every other Cursor variant is attached as an opencode model variant, named by the params that differ from Cursor's default (e.g. `low`, `272k-none`, `no-thinking`, `xhigh-fast`).
- Variants are selectable in config with `variant: "<name>"` next to `model` in an agent entry.
- `installation.md`: step-by-step install guide for AI coding agents (prerequisites, config edit, auth, verification, troubleshooting), shipped in the npm tarball; the README has a one-line prompt to hand to any LLM agent.
- `spike/probe-models.ts`: probes every base model once and reports AVAILABLE / BLOCKED / OTHER for the logged-in account.

### Changed

- A base id now means Cursor's own default variant (`isDefault`), sends its params explicitly, and gets that variant's context limit; previously it implied the first-listed param values and under-reported context (`gpt-5.5`: 272k → 1M).
- Models cache bumped to v4 `{name, context, params, variants, allowed}`; older cache files are refetched once.

### Fixed

- Blocked-model flags learned from 403s persist across the 24h catalog refresh (carried over by base id), so admin-blocked models stay hidden instead of reappearing; delete `models.json` to re-check.
- An unknown variant param id or value (sent as `cursor_params`) returns 400 `invalid_request_error` before any Cursor agent is created or concurrency slot taken.

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
