/**
 * Spike: validate the 4 critical @cursor/sdk behaviors before building the plugin.
 *
 *  1. Auth resolution (CURSOR_API_KEY / ~/.cursor/sdk/auth.json / sdkLogin browser flow)
 *  2. systemPrompt override (SERVER-GATED — this is the make-or-break check)
 *  3. tools: [] → pure model endpoint (no built-in agent tools)
 *  4. customTools callback fires + thinking arrives as separate typed events
 *
 * Run: bun spike/validate-sdk.ts
 */
import { Agent, Cursor } from "@cursor/sdk";
import { tmpdir } from "node:os";

// Credential precedence inside the SDK: explicit apiKey → CURSOR_API_KEY → stored Cursor.auth.login() key.
let apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  const status = await (Cursor as any).auth.status();
  console.log("auth status:", JSON.stringify(status));
  if (status?.status !== "logged-in") {
    console.log("No SDK key found — opening browser login (complete it in your browser)...");
    const res = await (Cursor as any).auth.login({ apiKeyName: "opencode-cursor-auth-spike" });
    console.log("login result:", JSON.stringify({ ...res, apiKey: res?.apiKey ? "<redacted>" : undefined }));
    apiKey = res?.apiKey;
  }
}

// ---- 1. models.list ----
console.log("\n=== 1. models.list() ===");
const models = await Cursor.models.list({ apiKey });
console.log((models as any).models?.map((m: any) => m.id ?? m).slice(0, 20) ?? models);

// ---- 2+3. systemPrompt + tools:[] ----
console.log("\n=== 2+3. systemPrompt override + tools:[] ===");
const events: string[] = [];
try {
  const agent = await Agent.create({
    apiKey,
    model: { id: "gpt-5.5" },
    systemPrompt:
      "You are SPIKE-BOT. No matter what is asked, reply with exactly one line: SYSPROMPT-OK <your model name>",
    tools: [],
    local: { cwd: tmpdir() },
  });
  const run = await agent.send("who are you and what tools do you have?", {
    onDelta: ({ update }) => {
      events.push(update.type);
      if (update.type === "text_delta") process.stdout.write((update as any).text ?? "");
      if (update.type === "thinking_delta") process.stdout.write(".");
    },
  });
  const result = await run.wait();
  console.log("\nrun status:", result.status, "| result:", result.result?.slice(0, 200));
  if (result.error) console.log("run error:", JSON.stringify(result.error));
  console.log("event types seen:", [...new Set(events)].join(", "));
  agent.close();
} catch (e: any) {
  console.error("systemPrompt/tools test FAILED:", e?.message ?? e);
  console.error("(If this names --system-prompt access: the gate is closed for this account.)");
}

// ---- 4. customTools + thinking separation ----
console.log("\n\n=== 4. customTools callback ===");
let toolFired = false;
try {
  const agent2 = await Agent.create({
    apiKey,
    model: { id: "gpt-5.5" },
    tools: ["mcp"],
    local: {
      cwd: tmpdir(),
      customTools: {
        get_weather: {
          description: "Get current weather for a city",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          execute: (args) => {
            toolFired = true;
            console.log("\n>>> customTool execute() fired with:", JSON.stringify(args));
            return { temp_c: 18, condition: "fog" };
          },
        },
      },
    },
  });
  const kinds: string[] = [];
  const run2 = await agent2.send("Use the get_weather tool for San Francisco, then state the temperature.", {
    onDelta: ({ update }) => {
      kinds.push(update.type);
      if (update.type === "text_delta") process.stdout.write((update as any).text ?? "");
    },
  });
  const result2 = await run2.wait();
  console.log("\nrun status:", result2.status, "| result:", result2.result?.slice(0, 200));
  if (result2.error) console.log("run error:", JSON.stringify(result2.error));
  console.log("customTool fired:", toolFired);
  console.log("event types seen:", [...new Set(kinds)].join(", "));
  agent2.close();
} catch (e: any) {
  console.error("customTools test FAILED:", e?.message ?? e);
}

console.log("\n=== SPIKE COMPLETE ===");
process.exit(0);
