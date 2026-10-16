import type { Plugin } from "@opencode-ai/plugin"
import { Cursor, type SdkAuthStatus } from "@cursor/sdk"
import { errorResponse, handleChatCompletion } from "./bridge.js"
import { currentModels } from "./models.js"
export { parseContext } from "./models.js"

const BASE_URL = "http://cursor.local/v1"

// Cursor publishes no output limit and the bridge never passes max_tokens to Cursor, so output is only an accounting reserve for opencode.
const DEFAULT_CONTEXT = 200_000
const DEFAULT_OUTPUT = 32_000

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
      for (const [id, { name, context, variants }] of Object.entries(await currentModels())) {
        cursor.models[id] ??= { name }
        const model = cursor.models[id] as (typeof cursor.models)[string] & { variants?: Record<string, Record<string, unknown>> }
        model.cost = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
        model.limit ??= { context: context ?? DEFAULT_CONTEXT, output: DEFAULT_OUTPUT }
        if (variants) model.variants ??= Object.fromEntries(Object.entries(variants).map(([n, v]) => [n, { cursor_params: v.params }]))
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
