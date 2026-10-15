/**
 * OpenAI chat-completions JSON <-> @cursor/sdk bridge, fully in-process.
 *
 * Tool loop ("held run" pattern, from pwnapplehat/Cursor-OpenAI):
 * each opencode tool is registered as a Cursor customTool whose execute()
 * PARKS on a promise. When the model requests tools we flush them to the
 * client as OpenAI tool_calls and keep the Cursor run alive. The client's
 * next HTTP request (role:"tool" messages) resolves the parked promises and
 * the SAME run continues — one metered Cursor run per opencode tool loop.
 */
import { Agent, type SDKAgent, type Run } from "@cursor/sdk"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

type ContentPart = { type: string; text?: string }
type OaMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | ContentPart[] | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}
type OaTool = {
  type: "function"
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}
type OaBody = {
  model: string
  messages: OaMessage[]
  tools?: OaTool[]
  stream?: boolean
}

function textOf(content: OaMessage["content"]): string {
  if (typeof content === "string") return content
  if (!content) return ""
  return content.map((p) => p.text ?? "").join("")
}

type ToolCallOut = { id: string; name: string; argumentsJson: string }
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number }

type Sink = {
  text(t: string): void
  reasoning(t: string): void
  toolCalls(calls: ToolCallOut[]): void
  finish(reason: "stop" | "tool_calls", usage?: Usage): void
  fail(err: unknown): void
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null, usage?: Usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
}

function sseResponse(model: string): { response: Response; sink: Sink } {
  const id = `chatcmpl-${randomUUID()}`
  const enc = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      send({ role: "assistant", content: "" })
    },
    cancel() {
      closed = true
    },
  })
  function send(delta: Record<string, unknown>, finish: string | null = null, usage?: Usage) {
    if (closed) return
    controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk(id, model, delta, finish, usage))}\n\n`))
  }
  function end() {
    if (closed) return
    controller.enqueue(enc.encode("data: [DONE]\n\n"))
    controller.close()
    closed = true
  }
  const sink: Sink = {
    text: (t) => send({ content: t }),
    reasoning: (t) => send({ reasoning_content: t }),
    toolCalls: (calls) =>
      send({
        tool_calls: calls.map((c, index) => ({
          index,
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argumentsJson },
        })),
      }),
    finish: (reason, usage) => {
      send({}, reason, usage)
      end()
    },
    fail: (err) => {
      send({ content: `\n\n[cursor error] ${err instanceof Error ? err.message : String(err)}` })
      send({}, "stop")
      end()
    },
  }
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    }),
    sink,
  }
}

function jsonCollector(model: string): { promise: Promise<Response>; sink: Sink } {
  const id = `chatcmpl-${randomUUID()}`
  let content = ""
  let calls: ToolCallOut[] = []
  let resolve!: (r: Response) => void
  const promise = new Promise<Response>((r) => (resolve = r))
  const sink: Sink = {
    text: (t) => (content += t),
    reasoning: () => {},
    toolCalls: (c) => (calls = calls.concat(c)),
    finish: (reason, usage) =>
      resolve(
        Response.json({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: content || null,
                ...(calls.length
                  ? {
                      tool_calls: calls.map((c2) => ({
                        id: c2.id,
                        type: "function",
                        function: { name: c2.name, arguments: c2.argumentsJson },
                      })),
                    }
                  : {}),
              },
              finish_reason: reason,
            },
          ],
          usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      ),
    fail: (err) =>
      resolve(
        Response.json(
          { error: { message: err instanceof Error ? err.message : String(err), type: "cursor_error" } },
          { status: 500 },
        ),
      ),
  }
  return { promise, sink }
}

type SessionEntry = { agentId: string; cwd: string; lastUsedAt: number }

type Held = {
  agent: SDKAgent
  cwd: string
  run: Run
  messages: OaMessage[]
  textAcc: string
  sink: Sink | null
  buffer: { kind: "text" | "reasoning"; t: string }[]
  pendingCalls: ToolCallOut[]
  parked: Map<string, (result: string) => void>
  flushTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  usage?: Usage
  wired: boolean
  done: boolean
}

const BATCH_SETTLE_MS = 300
const TOOL_RESULT_TIMEOUT_MS = 10 * 60 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000
// ponytail: single-user plugin, small fixed caps; make configurable if ever shared
const MAX_SESSIONS = 8

const sessions = new Map<string, SessionEntry>()
const heldByAgent = new Map<string, Held>()
const agentByToolCallId = new Map<string, string>()

function hashMessages(messages: OaMessage[]): string {
  const norm = messages.map((m) => [m.role, textOf(m.content), m.tool_call_id ?? "", JSON.stringify(m.tool_calls ?? null)])
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex")
}

function sweepSessions() {
  const now = Date.now()
  for (const [k, v] of sessions) if (now - v.lastUsedAt > SESSION_TTL_MS) sessions.delete(k)
  while (sessions.size > MAX_SESSIONS) {
    let oldestKey = ""
    let oldest = Infinity
    for (const [k, v] of sessions)
      if (v.lastUsedAt < oldest) {
        oldest = v.lastUsedAt
        oldestKey = k
      }
    sessions.delete(oldestKey)
  }
}

/**
 * Re-key the session under the conversation state the NEXT request will
 * present (current messages + the assistant message we just produced), since
 * session-unaware clients like opencode resend full history every turn.
 */
function rememberSession(held: Held, toolCalls: ToolCallOut[]) {
  const assistant: OaMessage = {
    role: "assistant",
    content: held.textAcc || null,
    ...(toolCalls.length
      ? { tool_calls: toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.argumentsJson } })) }
      : {}),
  }
  sessions.set(hashMessages(held.messages.concat(assistant)), {
    agentId: held.agent.agentId,
    cwd: held.cwd,
    lastUsedAt: Date.now(),
  })
  sweepSessions()
}

function mapUsage(u?: { inputTokens?: number; outputTokens?: number }): Usage | undefined {
  if (!u) return undefined
  const prompt = u.inputTokens ?? 0
  const completion = u.outputTokens ?? 0
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

// deltas arriving between tool flush and the continuation request get buffered
function emit(held: Held, kind: "text" | "reasoning", t: string) {
  if (held.sink) (kind === "text" ? held.sink.text : held.sink.reasoning)(t)
  else held.buffer.push({ kind, t })
}

function attachSink(held: Held, sink: Sink) {
  held.sink = sink
  for (const b of held.buffer) (b.kind === "text" ? sink.text : sink.reasoning)(b.t)
  held.buffer = []
}

function teardownHeld(agentId: string, held: Held) {
  held.done = true
  if (held.flushTimer) clearTimeout(held.flushTimer)
  if (held.idleTimer) clearTimeout(held.idleTimer)
  for (const id of held.parked.keys()) agentByToolCallId.delete(id)
  heldByAgent.delete(agentId)
}

/** Model requested tools: emit tool_calls, end this HTTP segment, park the run. */
function flushToolCalls(agentId: string, held: Held) {
  held.flushTimer = null
  if (held.done || !held.pendingCalls.length) return
  const calls = held.pendingCalls
  held.pendingCalls = []
  for (const c of calls) agentByToolCallId.set(c.id, agentId)
  const sink = held.sink
  held.sink = null
  sink?.toolCalls(calls)
  sink?.finish("tool_calls")
  rememberSession(held, calls)
  held.idleTimer = setTimeout(() => {
    teardownHeld(agentId, held)
    held.run.cancel().catch(() => {})
    try { held.agent.close() } catch {}
  }, TOOL_RESULT_TIMEOUT_MS)
  held.idleTimer.unref?.()
}

async function wireRunCompletion(agentId: string, held: Held) {
  if (held.wired) return
  held.wired = true
  try {
    const result = await held.run.wait()
    if (held.done) return
    const usage = mapUsage(result.usage) ?? held.usage
    teardownHeld(agentId, held)
    rememberSession(held, [])
    held.sink?.finish("stop", usage)
    try { held.agent.close() } catch {}
  } catch (err) {
    if (held.done) return
    teardownHeld(agentId, held)
    held.sink?.fail(err)
    try { held.agent.close() } catch {}
  }
}

export async function handleChatCompletion(body: OaBody, apiKey?: string): Promise<Response> {
  const streaming = body.stream !== false
  const sse = streaming ? sseResponse(body.model) : undefined
  const collected = streaming ? undefined : jsonCollector(body.model)
  const sink = (sse?.sink ?? collected?.sink)!
  const reply = () => sse?.response ?? collected!.promise

  // continuation: trailing tool results for a parked run
  const lastMsg = body.messages[body.messages.length - 1]
  if (lastMsg?.role === "tool" && lastMsg.tool_call_id && agentByToolCallId.has(lastMsg.tool_call_id)) {
    const agentId = agentByToolCallId.get(lastMsg.tool_call_id)!
    const held = heldByAgent.get(agentId)
    if (held && !held.done) {
      if (held.idleTimer) clearTimeout(held.idleTimer)
      held.messages = body.messages
      held.textAcc = ""
      attachSink(held, sink)
      for (const m of body.messages) {
        if (m.role !== "tool" || !m.tool_call_id) continue
        const resolve = held.parked.get(m.tool_call_id)
        if (resolve) {
          held.parked.delete(m.tool_call_id)
          agentByToolCallId.delete(m.tool_call_id)
          resolve(textOf(m.content))
        }
      }
      return reply()
    }
    sink.fail(new Error("cursor run for this tool call expired — please retry"))
    return reply()
  }

  // new turn: reuse the agent whose last-seen conversation matches our prefix
  const prefix = body.messages.slice(0, -1)
  const key = hashMessages(prefix)
  const entry = sessions.get(key)
  let agent: SDKAgent | undefined
  let cwd: string | undefined
  let newSuffix: OaMessage[] = body.messages
  if (entry) {
    sessions.delete(key)
    cwd = entry.cwd
    agent = await Agent.resume(entry.agentId, {
      model: { id: body.model },
      tools: ["mcp"],
      ...(apiKey ? { apiKey } : {}),
      local: { cwd, settingSources: [], enableAgentRetries: true },
    }).catch(() => undefined)
    if (agent) newSuffix = body.messages.slice(-1)
  }
  if (!agent) {
    cwd = await mkdtemp(join(tmpdir(), "opencode-cursor-"))
    agent = await Agent.create({
      model: { id: body.model },
      tools: ["mcp"],
      ...(apiKey ? { apiKey } : {}),
      local: { cwd, settingSources: [], enableAgentRetries: true },
    })
  }

  const held: Held = {
    agent,
    cwd: cwd!,
    run: undefined as unknown as Run,
    messages: body.messages,
    textAcc: "",
    sink: null,
    buffer: [],
    pendingCalls: [],
    parked: new Map(),
    flushTimer: null,
    idleTimer: null,
    wired: false,
    done: false,
  }
  attachSink(held, sink)

  const agentIdRef = { id: "" }
  const customTools: Record<string, unknown> = {}
  for (const t of body.tools ?? []) {
    customTools[t.function.name] = {
      description: t.function.description ?? "",
      inputSchema: t.function.parameters ?? { type: "object", properties: {} },
      execute: (args: unknown, ctx: { toolCallId?: string }) => {
        const id = (ctx.toolCallId ?? `call_${randomUUID()}`).replace(/\s+/g, "_")
        held.pendingCalls.push({ id, name: t.function.name, argumentsJson: JSON.stringify(args ?? {}) })
        if (held.flushTimer) clearTimeout(held.flushTimer)
        held.flushTimer = setTimeout(() => flushToolCalls(agentIdRef.id, held), BATCH_SETTLE_MS)
        return new Promise<string>((resolve) => held.parked.set(id, resolve))
      },
    }
  }

  // cursor-agent has no --system-prompt flag: prepend system text to the prompt
  const systemText = newSuffix
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n\n")
  const userParts = newSuffix
    .filter((m) => m.role !== "system")
    .map((m) => (m.role === "user" ? textOf(m.content) : `${m.role.toUpperCase()}: ${textOf(m.content)}`))
  const prompt = [systemText, ...userParts].filter(Boolean).join("\n\n") || "(empty message)"

  try {
    held.run = await held.agent.send(prompt, {
      onDelta: ({ update }: { update: { type: string; text?: string; usage?: { inputTokens?: number; outputTokens?: number } } }) => {
        if (update.type === "text-delta" && update.text) {
          held.textAcc += update.text
          emit(held, "text", update.text)
        } else if (update.type === "thinking-delta" && update.text) {
          emit(held, "reasoning", update.text)
        } else if (update.type === "turn-ended") {
          held.usage = mapUsage(update.usage)
        }
      },
      local: { customTools: customTools as never },
    })
  } catch (err) {
    sink.fail(err)
    return reply()
  }
  agentIdRef.id = held.run.agentId
  heldByAgent.set(held.run.agentId, held)
  void wireRunCompletion(held.run.agentId, held)

  return reply()
}
