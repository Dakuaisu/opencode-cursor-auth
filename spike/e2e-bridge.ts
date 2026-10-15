/**
 * E2E driver for the bridge: simulates the exact requests opencode sends.
 * Test 1: plain streaming chat. Test 2: tool loop (request -> tool_calls ->
 * follow-up request with tool result -> final answer on the SAME cursor run).
 */
import { _resetForTest, _stats, handleChatCompletion } from "../src/bridge.js";

async function readSse(res: Response): Promise<{ content: string; reasoning: string; toolCalls: { id: string; name: string; args: string }[]; finish: string | null }> {
  const text = await res.text();
  let content = "";
  let reasoning = "";
  let finish: string | null = null;
  const toolCalls: { id: string; name: string; args: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = JSON.parse(line.slice(6));
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) content += choice.delta.content;
    if (choice.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    for (const tc of choice.delta?.tool_calls ?? []) {
      toolCalls.push({ id: tc.id, name: tc.function?.name, args: tc.function?.arguments });
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  return { content, reasoning, toolCalls, finish };
}

// --- Test 1: plain chat, streaming ---
console.log("=== Test 1: plain streaming chat ===");
const messages1 = [
  { role: "system", content: "You are a terse assistant. Reply in one short sentence." },
  { role: "user", content: "Say BRIDGE-OK and nothing else." },
];
const res1 = await handleChatCompletion({ model: "gpt-5.5", messages: messages1 as never, stream: true });
const out1 = await readSse(res1);
console.log("content:", JSON.stringify(out1.content));
console.log("reasoning chars:", out1.reasoning.length, "| finish:", out1.finish);
if (!out1.content.includes("BRIDGE-OK")) throw new Error("Test 1 FAILED: no BRIDGE-OK");

// --- Test 2: tool loop ---
console.log("\n=== Test 2: tool loop ===");
const tools = [
  {
    type: "function",
    function: {
      name: "get_secret_number",
      description: "Returns the secret number for a given label.",
      parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
    },
  },
];
const messages2: Record<string, unknown>[] = [
  { role: "system", content: "You must use tools when relevant." },
  { role: "user", content: "Call get_secret_number with label 'alpha', then tell me the number you got." },
];
const res2 = await handleChatCompletion({ model: "gpt-5.5", messages: messages2 as never, tools: tools as never, stream: true });
const out2 = await readSse(res2);
console.log("turn 1 finish:", out2.finish, "| tool calls:", JSON.stringify(out2.toolCalls));
if (out2.finish !== "tool_calls" || out2.toolCalls.length === 0) throw new Error("Test 2 FAILED: no tool_calls turn");

// Simulate opencode sending back the tool result (full history replay)
const tc = out2.toolCalls[0];
messages2.push({
  role: "assistant",
  content: out2.content || null,
  tool_calls: [{ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }],
});
messages2.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ secret_number: 7741 }) });

const res3 = await handleChatCompletion({ model: "gpt-5.5", messages: messages2 as never, tools: tools as never, stream: true });
const out3 = await readSse(res3);
console.log("turn 2 content:", JSON.stringify(out3.content));
console.log("turn 2 finish:", out3.finish);
if (!out3.content.includes("7741")) throw new Error("Test 2 FAILED: final answer missing 7741");

// --- Test 3: resume path (new turn, prefix matches remembered session -> Agent.resume) ---
console.log("\n=== Test 3: session resume ===");
messages2.push({ role: "assistant", content: out3.content });
messages2.push({ role: "user", content: "What was the secret number again? Reply with just the number." });
const res4 = await handleChatCompletion({ model: "gpt-5.5", messages: messages2 as never, tools: tools as never, stream: true });
const out4 = await readSse(res4);
console.log("turn 3 content:", JSON.stringify(out4.content), "| finish:", out4.finish);
if (!out4.content.includes("7741")) throw new Error("Test 3 FAILED: resumed agent lost context");

// --- Test 4: system prompt via AGENTS.md ---
console.log("\n=== Test 4: AGENTS.md system prompt ===");
const messages4 = [
  { role: "system", content: "You are TEST-BOT. End every reply with the token ZEBRA-99." },
  { role: "user", content: "Say hello in three words." },
];
const res5 = await handleChatCompletion({ model: "gpt-5.5", messages: messages4 as never, stream: true });
const out5 = await readSse(res5);
console.log("content:", JSON.stringify(out5.content), "| finish:", out5.finish);
if (!out5.content.includes("ZEBRA-99")) throw new Error("Test 4 FAILED: system prompt was not honored via AGENTS.md");

// --- Test 5: disk-backed resume after in-memory reset ---
console.log("\n=== Test 5: disk session resume ===");
messages2.push({ role: "assistant", content: out4.content });
_resetForTest();
messages2.push({ role: "user", content: "What was the secret number again? Just the number." });
const res6 = await handleChatCompletion({ model: "gpt-5.5", messages: messages2 as never, tools: tools as never, stream: true });
const out6 = await readSse(res6);
console.log("turn 4 content:", JSON.stringify(out6.content), "| finish:", out6.finish);
if (!out6.content.includes("7741")) throw new Error("Test 5 FAILED: disk-resumed agent lost context");

// --- Test 6: abort mid-stream tears down run + agent process ---
console.log("\n=== Test 6: abort mid-stream ===");
const ac = new AbortController();
const res7 = await handleChatCompletion(
  { model: "gpt-5.5", messages: [{ role: "user", content: "Count from 1 to 400, one number per line." }] as never, stream: true },
  undefined,
  ac.signal,
);
const reader = res7.body!.getReader();
const dec = new TextDecoder();
let aborted = false;
let chunks = 0;
const t0 = Date.now();
const drained = (async () => {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    chunks++;
    if (!aborted && dec.decode(value).includes('"content":"') && !dec.decode(value).includes('"content":""')) {
      aborted = true;
      ac.abort();
    }
  }
})();
await Promise.race([drained, new Promise((_, rej) => setTimeout(() => rej(new Error("Test 6 FAILED: stream did not end within 5s")), 5000))]);
console.log("stream ended after", Date.now() - t0, "ms |", chunks, "chunks | aborted:", aborted);
if (!aborted) throw new Error("Test 6 FAILED: never saw a content delta");
await new Promise((r) => setTimeout(r, 1500));
const stats = _stats();
console.log("stats:", JSON.stringify(stats));
if (stats.held !== 0) throw new Error("Test 6 FAILED: held run leaked");
const procs = new TextDecoder()
  .decode(Bun.spawnSync(["pgrep", "-fl", "cursor-agent"]).stdout)
  .split("\n")
  .filter((l) => l && !l.includes("worker-server"));
console.log("cursor-agent procs (non worker-server):", procs.length ? procs : "none");
if (procs.length) throw new Error("Test 6 FAILED: stray cursor-agent process after abort");
const res8 = await handleChatCompletion({ model: "gpt-5.5", messages: messages1 as never, stream: true });
const out8 = await readSse(res8);
console.log("post-abort content:", JSON.stringify(out8.content), "| finish:", out8.finish);
if (!out8.content.includes("BRIDGE-OK")) throw new Error("Test 6 FAILED: bridge unusable after abort");

// --- Test 7: auth error -> real HTTP status ---
console.log("\n=== Test 7: auth error status ===");
const res9 = await handleChatCompletion({ model: "gpt-5.5", messages: messages1 as never, stream: true }, "crsr_definitely_invalid_key");
const body9 = await res9.json();
console.log("status:", res9.status, "| body:", JSON.stringify(body9));
if (res9.status !== 401 || !body9?.error?.message) throw new Error("Test 7 FAILED: expected 401 with error.message");

console.log("\n=== Test 7b: bogus model ===");
const res10 = await handleChatCompletion({ model: "definitely-not-a-model", messages: messages1 as never, stream: true });
console.log("status:", res10.status, "| body:", (await res10.text()).slice(0, 160));
if (res10.status === 200) console.log("(Cursor accepted the bogus model; skipping assertion)");
else if (res10.status !== 400) throw new Error("Test 7b FAILED: expected 400 for unknown model");

// --- Test 8: scoped sessions do not collide ---
console.log("\n=== Test 8: scoped sessions do not collide ===");
const scopes = ["ses_test_A", "ses_test_B"];
const messages8 = [
  { role: "system", content: "You are a terse bot. Reply with exactly the single word PING and nothing else." },
  { role: "user", content: "Say the word." },
];
const before8 = new Set(_stats().agentIds);
const turn1 = await Promise.all(
  scopes.map((s) => handleChatCompletion({ model: "gpt-5.5", messages: messages8 as never, stream: true }, undefined, undefined, s).then(readSse)),
);
console.log("turn 1 replies:", JSON.stringify(turn1.map((o) => o.content)));
const after8 = _stats().agentIds;
const new8 = after8.filter((id) => !before8.has(id));
console.log("new agentIds:", JSON.stringify(new8));
if (new8.length !== 2)
  throw new Error(`Test 8 FAILED: expected 2 new session agents, got ${new8.length} (without scoping identical replies collapse both into one entry)`);
const turn2 = await Promise.all(
  scopes.map((s, i) =>
    handleChatCompletion(
      {
        model: "gpt-5.5",
        messages: [...messages8, { role: "assistant", content: turn1[i].content }, { role: "user", content: "Say it once more." }] as never,
        stream: true,
      },
      undefined,
      undefined,
      s,
    ).then(readSse),
  ),
);
console.log("turn 2 replies:", JSON.stringify(turn2.map((o) => o.content)));
if (turn2.some((o) => !o.content)) throw new Error("Test 8 FAILED: empty turn 2 reply");
const final8 = new Set(_stats().agentIds);
if (final8.size !== before8.size + 2 || !new8.every((id) => final8.has(id)))
  throw new Error(`Test 8 FAILED: expected both scopes to resume their own agent, got ${JSON.stringify([...final8])}`);
console.log("stats:", JSON.stringify(_stats()));

// --- Test 9: model limits + key check (no network beyond the cached catalog) ---
console.log("\n=== Test 9: model limits + key check ===");
const { CursorAuthPlugin, parseContext, keyProblem } = await import("../src/index.js");
const item = (value?: string) => ({ id: "m", displayName: "M", parameters: value ? [{ id: "context", values: [{ value }] }] : [] });
const ctxCases: [string | undefined, number | undefined][] = [["272k", 272000], ["1m", 1000000], ["200K", 200000], [undefined, undefined]];
for (const [input, expected] of ctxCases) {
  const got = parseContext(item(input));
  if (got !== expected) throw new Error(`Test 9 FAILED: parseContext(${input}) = ${got}, expected ${expected}`);
}
const now = Date.now();
const missing = keyProblem({ status: "logged-out" }, now);
const expired = keyProblem({ status: "logged-in", backendUrl: "x", apiKeyExpiresAtMs: now - 1 }, now);
const valid = keyProblem({ status: "logged-in", backendUrl: "x", apiKeyExpiresAtMs: now + 1e9 }, now);
if (!missing?.includes("missing")) throw new Error(`Test 9 FAILED: logged-out -> ${missing}`);
if (!expired?.includes("expired")) throw new Error(`Test 9 FAILED: expired -> ${expired}`);
if (valid !== undefined) throw new Error(`Test 9 FAILED: valid key -> ${valid}`);
console.log("keyProblem(missing):", missing);
console.log("keyProblem(expired):", expired);
const hooks = await CursorAuthPlugin({} as never);
const cfg: Record<string, unknown> = {};
await hooks.config!(cfg as never);
const models9 = (cfg as { provider: { cursor: { models: Record<string, { limit?: { context: number; output: number } }> } } }).provider.cursor.models;
const gpt = models9["gpt-5.5"]?.limit;
const auto = models9["auto"]?.limit;
console.log("gpt-5.5 limit:", JSON.stringify(gpt), "| auto limit:", JSON.stringify(auto), "| models:", Object.keys(models9).length);
if (gpt?.context !== 272000 || gpt?.output !== 32000) throw new Error(`Test 9 FAILED: gpt-5.5 limit ${JSON.stringify(gpt)}`);
if (!(typeof auto?.context === "number" && auto.context > 0)) throw new Error(`Test 9 FAILED: auto limit ${JSON.stringify(auto)}`);

console.log("\nALL BRIDGE TESTS PASSED");
process.exit(0);
