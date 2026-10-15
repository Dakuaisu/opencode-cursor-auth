/**
 * E2E driver for the bridge: simulates the exact requests opencode sends.
 * Test 1: plain streaming chat. Test 2: tool loop (request -> tool_calls ->
 * follow-up request with tool result -> final answer on the SAME cursor run).
 */
import { handleChatCompletion } from "../src/bridge.js";

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

console.log("\nALL BRIDGE TESTS PASSED");
process.exit(0);
