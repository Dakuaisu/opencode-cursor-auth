# Install @vidit19sharma/opencode-cursor-auth

These instructions are designed for AI coding agents.

The plugin lets opencode use a Cursor subscription through the official `@cursor/sdk`, in-process. Supported on macOS/Linux; Windows untested.

## Prerequisites

### Check opencode version

```bash
opencode --version
```

You should see `1.19` or newer. If older or missing, ask the user to install or upgrade opencode before continuing.

### Check Node version

```bash
node --version
```

You should see `v22.13` or newer. opencode installs plugins with Bun, but `@cursor/sdk` spawns the `cursor-agent` binary and requires Node >= 22.13. If older, ask the user to upgrade Node.

### Check the Cursor CLI

```bash
cursor-agent --version
```

If this prints a version, continue. If it fails with `command not found`, install it:

```bash
curl https://cursor.com/install -fsS | bash
```

Then open a new shell, or add `~/.local/bin` to `PATH`, and re-run `cursor-agent --version`.

A Cursor subscription (Pro, Business, or team) is required. `cursor-agent login` is not required (the plugin has its own login) but is harmless.

## Installation

### Step 1: Remove the old open-cursor setup (only if present)

If `~/.config/opencode/plugin/cursor-acp.js` exists or the opencode config has a `cursor-acp` provider, the user has the old `@rama_nigg/open-cursor` proxy setup. Remove it:

1. Delete the `cursor-acp` block under `provider` in the opencode config.
2. Delete the file: `rm ~/.config/opencode/plugin/cursor-acp.js`
3. Uninstall it: `npm uninstall -g @rama_nigg/open-cursor`

Skip this step if none of these exist.

### Step 2: Add the plugin to the opencode config

The config file is `~/.config/opencode/opencode.json`. Some users have `~/.config/opencode/opencode.jsonc` instead; edit whichever exists.

If neither exists, create `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@vidit19sharma/opencode-cursor-auth@latest"]
}
```

If the file exists and has no top-level `plugin` array, add one:

```json
"plugin": ["@vidit19sharma/opencode-cursor-auth@latest"]
```

If a `plugin` array already exists, append `"@vidit19sharma/opencode-cursor-auth@latest"` and keep every existing entry.

Do not add a `provider.cursor` block by hand. On startup the plugin registers the `cursor` provider and its model list automatically. No `npm install` is needed; opencode installs the package at startup.

### Step 3: Authenticate

Pick one method.

**Browser login.** This step needs the user. Ask them to run:

```bash
opencode auth login
```

and choose provider **Cursor**, then **Log in with Cursor (browser)**. A browser opens; they sign in to Cursor. This mints a 90-day SDK key stored at `~/.cursor/sdk/auth.json` (written by `@cursor/sdk`, not by the plugin). When the key expires, requests return a 401 telling the user to run `opencode auth login` again; a warning is printed to stderr during the last 7 days.

**API key.** In `opencode auth login`, choose **Cursor**, then **Paste a Cursor API key**. Keys come from cursor.com/dashboard (Integrations / API keys). Alternatively, set `CURSOR_API_KEY` in the environment before starting opencode.

## Verification

```bash
opencode models | grep cursor/
```

You should see `cursor/auto`, `cursor/gpt-5.5`, `cursor/claude-opus-5-5`, and more. The first run fetches the catalog from Cursor (about 3 s); it is cached for 24 h at `~/.cache/opencode-cursor-auth/models.json`.

Variants are not separate ids. In the TUI, press Ctrl+T on a cursor model to pick its effort, thinking, fast, or context variant.

```bash
opencode run -m cursor/gpt-5.5 "Reply with exactly: CURSOR-AUTH-OK"
```

You should see `CURSOR-AUTH-OK`. In some setups `opencode run` does not exit on its own because of other plugins; Ctrl-C after the reply is fine.

Optional: to see which models the account is actually allowed to use, clone the repo, run `bun install`, then `bun spike/probe-models.ts`. It sends one tiny request per model.

## Upgrading

With `@latest` in the `plugin` array, restarting opencode picks up new versions. If it stays on an old version, clear the cached package and restart opencode:

```bash
rm -rf ~/.cache/opencode/packages/@vidit19sharma/opencode-cursor-auth@latest
```

## Done

The plugin is installed. Every model the user's Cursor plan includes is available as `cursor/*` in opencode.

## Troubleshooting

- **`Cannot connect to API`, or nothing happens on cursor models**: the auth entry is missing. Run `opencode auth login` and pick Cursor.
- **401 `Cursor SDK key missing/expired`**: run `opencode auth login`.
- **403 `permission_error` "Model Blocked"**: a team admin disabled that model for the account. It is hidden from `opencode models` from then on; delete `~/.cache/opencode-cursor-auth/models.json` to re-check.
- **400 `Cannot use this model`**: the model id is not in Cursor's catalog for this account.
- **`cursor-agent: command not found` at request time**: install the Cursor CLI (see Prerequisites) and make sure it is on `PATH` for the shell that launches opencode.
- **Model list empty or only `cursor/auto`**: the catalog fetch failed (offline or not logged in). Fix auth, delete `~/.cache/opencode-cursor-auth/models.json`, restart opencode.
- **Stray `cursor-agent` processes**: check with `pgrep -fl cursor-agent`. A single `worker-server` is the SDK's idle singleton and is normal.

### Paths

| Path | Contents |
| --- | --- |
| `~/.cursor/sdk/auth.json` | SDK key from browser login |
| `~/.cache/opencode-cursor-auth/models.json` | Model catalog, 24 h |
| `~/.cache/opencode-cursor-auth/sessions.json` | Conversation to Cursor agent map, 7 days |
| `~/.local/share/opencode/auth.json` | opencode's auth registry; the Cursor entry is a sentinel, the real key lives in the SDK file |

See the [README](README.md) for more detail.
