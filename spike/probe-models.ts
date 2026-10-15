// Probe every base model once, sequentially, to find which ones this account may use.
import { handleChatCompletion } from "../src/bridge.js";
import { currentModels } from "../src/models.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const listed = await currentModels();
const cached = JSON.parse(readFileSync(join(homedir(), ".cache", "opencode-cursor-auth", "models.json"), "utf8")).models as Record<string, { base?: string; blocked?: true }>;
const ids = [...new Set([
  ...Object.entries(listed).filter(([, m]) => !m.base).map(([id]) => id),
  ...Object.entries(cached).filter(([, m]) => !m.base && m.blocked).map(([id]) => id),
])].filter((id) => id !== "auto");

const rows: { id: string; status: number; ms: number; info: string; type?: string }[] = [];
for (const id of ids) {
  const t0 = Date.now();
  let status = 0, info = "", type: string | undefined;
  try {
    const res = await handleChatCompletion({ model: id, stream: false, messages: [{ role: "user", content: "Reply with exactly: OK" }] } as never, undefined, AbortSignal.timeout(90_000), "ses_probe_" + id);
    status = res.status;
    const body = await res.json().catch(() => ({}));
    if (status === 200) info = String(body?.choices?.[0]?.message?.content ?? "").slice(0, 40);
    else { info = String(body?.error?.message ?? "").slice(0, 120); type = body?.error?.type; }
  } catch (e) {
    info = String((e as Error)?.message ?? e).slice(0, 120);
  }
  const row = { id, status, ms: Date.now() - t0, info, type };
  rows.push(row);
  console.log(`${id.padEnd(32)} ${status} ${(row.ms / 1000).toFixed(1)}s ${type ?? ""} ${JSON.stringify(info)}`);
}

const groups = [
  ["AVAILABLE (200)", rows.filter((r) => r.status === 200)],
  ["BLOCKED (403)", rows.filter((r) => r.status === 403)],
  ["OTHER", rows.filter((r) => r.status !== 200 && r.status !== 403)],
] as const;
console.log("\n=== SUMMARY ===");
for (const [label, rs] of groups) {
  console.log(`\n${label}: ${rs.length}`);
  for (const r of rs) console.log(`  ${r.id.padEnd(32)} ${String(r.status).padEnd(4)} ${(r.ms / 1000).toFixed(1).padStart(5)}s ${r.type ?? ""} ${JSON.stringify(r.info)}`);
}
console.log(`\nTOTAL ${rows.length} | available ${groups[0][1].length} | blocked ${groups[1][1].length} | other ${groups[2][1].length}`);
process.exit(0);
