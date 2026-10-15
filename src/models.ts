import { Cursor, type ModelListItem, type ModelParameterValue, type ModelSelection } from "@cursor/sdk"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CACHE_DIR = join(homedir(), ".cache", "opencode-cursor-auth")
const MODELS_CACHE_PATH = join(CACHE_DIR, "models.json")
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type ModelInfo = { name: string; context?: number; base?: string; params?: ModelParameterValue[] }
type ModelsCache = { version: 3; fetchedAt: number; models: Record<string, ModelInfo> }

let catalog: Record<string, ModelInfo> = {}

function contextValue(raw?: string): number | undefined {
  const match = raw?.trim().match(/^(\d+)([km]?)$/i)
  if (!match) return undefined
  const unit = match[2].toLowerCase()
  return Number(match[1]) * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1)
}

export function parseContext(m: ModelListItem): number | undefined {
  return contextValue(m.parameters?.find((p) => p.id === "context")?.values[0]?.value)
}

export function buildCatalog(list: ModelListItem[]): Record<string, ModelInfo> {
  const models: Record<string, ModelInfo> = {}
  const rename = (id: string) => (id === "default" ? "auto" : id)
  for (const m of list) {
    const context = parseContext(m)
    models[rename(m.id)] = { name: m.displayName ?? m.id, ...(context ? { context } : {}) }
  }
  for (const m of list) {
    const base = rename(m.id)
    for (const v of m.variants ?? []) {
      // id = base + non-default param values (first listed value is the default); "true" flags use the param id, e.g. gpt-5.5-low-fast
      const parts = v.params
        .filter((p) => m.parameters?.find((d) => d.id === p.id)?.values[0]?.value !== p.value)
        .map((p) => (p.value === "true" ? p.id : p.value))
      const id = [base, ...parts].join("-")
      if (models[id]) continue
      const context = contextValue(v.params.find((p) => p.id === "context")?.value) ?? models[base].context
      const label = v.displayName && v.displayName !== m.displayName ? v.displayName : parts.join(" ")
      models[id] = { name: `${models[base].name} (${label})`, ...(context ? { context } : {}), base, params: v.params }
    }
  }
  return models
}

function loadCachedModels(): ModelsCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(MODELS_CACHE_PATH, "utf8")) as ModelsCache
    if (raw?.version === 3 && raw.models && Object.keys(raw.models).length > 0) return raw
  } catch {
    // no cache yet, or unreadable — fall back
  }
  return undefined
}

// Live model list from Cursor, cached 24h to keep opencode startup fast.
// Offline/logged-out: stale cache if present, else just "auto" (Cursor's universal alias).
export async function currentModels(): Promise<Record<string, ModelInfo>> {
  const cached = loadCachedModels()
  if (cached && Date.now() - cached.fetchedAt <= MODELS_CACHE_TTL_MS) return (catalog = cached.models)
  try {
    const models = buildCatalog(await Cursor.models.list())
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(MODELS_CACHE_PATH, JSON.stringify({ version: 3, fetchedAt: Date.now(), models } satisfies ModelsCache))
    return (catalog = models)
  } catch {
    return (catalog = cached?.models ?? { auto: { name: "Auto" } })
  }
}

export function resolveModel(opencodeId: string): ModelSelection | undefined {
  if (!Object.keys(catalog).length) catalog = loadCachedModels()?.models ?? {}
  const m = catalog[opencodeId]
  if (!m) return undefined
  return m.base && m.params ? { id: m.base, params: m.params } : { id: opencodeId }
}
