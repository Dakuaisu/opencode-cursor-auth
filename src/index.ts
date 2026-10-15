import type { Plugin } from "@opencode-ai/plugin"
import { Cursor } from "@cursor/sdk"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { handleChatCompletion } from "./bridge.js"

const BASE_URL = "http://cursor.local/v1"

const CACHE_DIR = join(homedir(), ".cache", "opencode-cursor-auth")
const MODELS_CACHE_PATH = join(CACHE_DIR, "models.json")
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

type ModelsCache = { version: 1; fetchedAt: number; models: Record<string, string> }

function loadCachedModels(): ModelsCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(MODELS_CACHE_PATH, "utf8")) as ModelsCache
    if (raw?.version === 1 && raw.models && Object.keys(raw.models).length > 0) return raw
  } catch {
    // no cache yet, or unreadable — fall back
  }
  return undefined
}

// Live model list from Cursor, cached 24h to keep opencode startup fast.
// Offline/logged-out: stale cache if present, else just "auto" (Cursor's universal alias).
async function currentModels(): Promise<Record<string, string>> {
  const cached = loadCachedModels()
  if (cached && Date.now() - cached.fetchedAt <= MODELS_CACHE_TTL_MS) return cached.models
  try {
    const list = await Cursor.models.list()
    const models: Record<string, string> = {}
    for (const m of list) models[m.id === "default" ? "auto" : m.id] = m.displayName ?? m.id
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(MODELS_CACHE_PATH, JSON.stringify({ version: 1, fetchedAt: Date.now(), models } satisfies ModelsCache))
    return models
  } catch {
    return cached?.models ?? { auto: "Auto" }
  }
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
    const body = JSON.parse(await bodyText(input, init))
    return handleChatCompletion(body, pastedApiKey)
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
      for (const [id, displayName] of Object.entries(await currentModels())) {
        cursor.models[id] ??= { name: displayName }
        const model = cursor.models[id]
        model.cost = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
      }
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
