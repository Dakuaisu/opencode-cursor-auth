import type { Plugin } from "@opencode-ai/plugin"
import { Cursor, type ModelListItem, type SdkAuthStatus } from "@cursor/sdk"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { errorResponse, handleChatCompletion } from "./bridge.js"

const BASE_URL = "http://cursor.local/v1"

const CACHE_DIR = join(homedir(), ".cache", "opencode-cursor-auth")
const MODELS_CACHE_PATH = join(CACHE_DIR, "models.json")
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000
// Cursor publishes no output limit and the bridge never passes max_tokens to Cursor, so output is only an accounting reserve for opencode.
const DEFAULT_CONTEXT = 200_000
const DEFAULT_OUTPUT = 32_000

type ModelInfo = { name: string; context?: number }
type ModelsCache = { version: 2; fetchedAt: number; models: Record<string, ModelInfo> }

export function parseContext(m: ModelListItem): number | undefined {
  const raw = m.parameters?.find((p) => p.id === "context")?.values[0]?.value
  const match = raw?.trim().match(/^(\d+)([km]?)$/i)
  if (!match) return undefined
  const unit = match[2].toLowerCase()
  return Number(match[1]) * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1)
}

function loadCachedModels(): ModelsCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(MODELS_CACHE_PATH, "utf8")) as ModelsCache
    if (raw?.version === 2 && raw.models && Object.keys(raw.models).length > 0) return raw
  } catch {
    // no cache yet, or unreadable — fall back
  }
  return undefined
}

// Live model list from Cursor, cached 24h to keep opencode startup fast.
// Offline/logged-out: stale cache if present, else just "auto" (Cursor's universal alias).
async function currentModels(): Promise<Record<string, ModelInfo>> {
  const cached = loadCachedModels()
  if (cached && Date.now() - cached.fetchedAt <= MODELS_CACHE_TTL_MS) return cached.models
  try {
    const list = await Cursor.models.list()
    const models: Record<string, ModelInfo> = {}
    for (const m of list) {
      const context = parseContext(m)
      models[m.id === "default" ? "auto" : m.id] = { name: m.displayName ?? m.id, ...(context ? { context } : {}) }
    }
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(MODELS_CACHE_PATH, JSON.stringify({ version: 2, fetchedAt: Date.now(), models } satisfies ModelsCache))
    return models
  } catch {
    return cached?.models ?? { auto: { name: "Auto" } }
  }
}

export function keyProblem(status: SdkAuthStatus, nowMs: number): string | undefined {
  if (status.status !== "logged-in") return "Cursor SDK key missing — run `opencode auth login` and pick Cursor"
  if (typeof status.apiKeyExpiresAtMs === "number" && status.apiKeyExpiresAtMs <= nowMs)
    return `Cursor SDK key expired on ${new Date(status.apiKeyExpiresAtMs).toISOString()} — run \`opencode auth login\` and pick Cursor`
  return undefined
}

const KEY_CHECK_TTL_MS = 60_000
const EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000
let keyStatus: { at: number; value: Promise<SdkAuthStatus | undefined> } | undefined
let warnedExpiry = false

async function checkKey(): Promise<string | undefined> {
  if (pastedApiKey || process.env.CURSOR_API_KEY) return undefined
  const now = Date.now()
  if (!keyStatus || now - keyStatus.at > KEY_CHECK_TTL_MS) {
    keyStatus = { at: now, value: Cursor.auth.status().catch(() => undefined) }
  }
  const status = await keyStatus.value
  if (!status) return undefined
  const exp = status.status === "logged-in" ? status.apiKeyExpiresAtMs : undefined
  if (!warnedExpiry && typeof exp === "number" && exp > now && exp - now <= EXPIRY_WARN_MS) {
    warnedExpiry = true
    const days = Math.ceil((exp - now) / (24 * 60 * 60 * 1000))
    console.error(`[opencode-cursor-auth] Cursor SDK key expires in ${days} days — run \`opencode auth login\` to renew`)
  }
  return keyProblem(status, now)
}

async function bodyText(input: Request | string | URL, init?: RequestInit): Promise<string> {
  const b = init?.body
  if (typeof b === "string") return b
  if (b instanceof Uint8Array) return new TextDecoder().decode(b)
  if (input instanceof Request) return input.text()
  return ""
}

let pastedApiKey: string | undefined

async function cursorFetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.includes("/chat/completions")) {
    const problem = await checkKey()
    if (problem) return errorResponse(problem, 401)
    const body = JSON.parse(await bodyText(input, init))
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const scope =
      new Headers(init?.headers).get("x-opencode-session") ??
      (input instanceof Request ? input.headers.get("x-opencode-session") : null) ??
      undefined
    return handleChatCompletion(body, pastedApiKey, signal, scope)
  }
  if (url.includes("/models")) {
    return Response.json({
      object: "list",
      data: Object.keys(await currentModels()).map((id) => ({ id, object: "model" })),
    })
  }
  return Response.json({ error: { message: `unsupported endpoint: ${url}` } }, { status: 404 })
}

export const CursorAuthPlugin: Plugin = async () => {
  return {
    config: async (config) => {
      const providers = (config.provider ??= {})
      const cursor = (providers["cursor"] ??= { models: {} })
      cursor.npm ??= "@ai-sdk/openai-compatible"
      cursor.name ??= "Cursor"
      cursor.options = { ...cursor.options, baseURL: BASE_URL }
      cursor.models ??= {}
      for (const [id, { name, context }] of Object.entries(await currentModels())) {
        cursor.models[id] ??= { name }
        const model = cursor.models[id]
        model.cost = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
        model.limit ??= { context: context ?? DEFAULT_CONTEXT, output: DEFAULT_OUTPUT }
      }
    },

    "chat.headers": async (input, output) => {
      if (input.model.providerID === "cursor") output.headers["x-opencode-session"] = input.sessionID
    },

    auth: {
      provider: "cursor",
      loader: async (getAuth) => {
        const auth = await getAuth().catch(() => undefined)
        if (auth && auth.type === "api" && auth.key !== "cursor-sdk-store") pastedApiKey = auth.key
        return {
          apiKey: "cursor-managed",
          baseURL: BASE_URL,
          fetch: cursorFetch,
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Log in with Cursor (browser)",
          authorize: async () => {
            let resolveUrl!: (url: string) => void
            const urlReady = new Promise<string>((r) => (resolveUrl = r))
            const login = Cursor.auth
              .login({
                apiKeyName: "opencode-cursor-auth",
                openBrowser: false,
                onLoginUrl: (url: string) => resolveUrl(url),
              })
              .catch((err: unknown) => err)
            const url = await Promise.race([urlReady, login.then(() => "")])
            return {
              url: typeof url === "string" && url ? url : "https://cursor.com/dashboard",
              instructions: "Complete the login in your browser. The key is stored in ~/.cursor/sdk/auth.json.",
              method: "auto" as const,
              callback: async () => {
                const result = await login
                if (result instanceof Error) return { type: "failed" as const }
                return { type: "success" as const, key: "cursor-sdk-store" }
              },
            }
          },
        },
        {
          type: "api",
          label: "Paste a Cursor API key (cursor.com/dashboard)",
        },
      ],
    },
  }
}

export default CursorAuthPlugin
