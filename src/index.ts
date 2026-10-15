import type { Plugin } from "@opencode-ai/plugin"
import { Cursor } from "@cursor/sdk"
import { handleChatCompletion } from "./bridge.js"

const BASE_URL = "http://cursor.local/v1"

const MODELS = [
  "auto",
  "gpt-5.5",
  "claude-opus-5-5",
  "gemini-3-flash",
  "kimi-k2.7-code",
  "glm-5.2",
  "glm-5p3",
  "glm-5p3-flash",
]

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
    return Response.json({ object: "list", data: MODELS.map((id) => ({ id, object: "model" })) })
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
      for (const id of MODELS) {
        cursor.models[id] ??= { name: `${id} (Cursor)` }
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
