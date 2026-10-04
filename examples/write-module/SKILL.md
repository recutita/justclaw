---
name: write-module
description: >
  Write, create, or add a new justclaw module (daemon or timer). Use whenever
  asked to build a new integration, add a capability, implement a webhook,
  create a scheduled task, write a daemon, or extend the agent with any new
  module-based feature — even if the user just says "add X" or "make the agent
  do Y" and implementing it as a module is the right approach.
---

# Writing a justclaw Module

Modules are standalone executables that communicate with the core over NDJSON
(JSON-RPC 2.0) on stdin/stdout. They can be written in any language; use Bun
(`#!/usr/bin/env bun`) for TypeScript.

## Directory structure

Create the module under the modules directory shown in your runtime instructions:

```
{modulesDir}/
  {name}/
    module.json    # manifest
    main.ts        # entrypoint (or any name)
```

## module.json

**Daemon** — long-running, spawned when the core starts:

```json
{
  "name": "{name}",
  "exec": "main.ts",
  "mode": "daemon",
  "replyable": true
}
```

**Timer** — one-shot, spawned on a cron schedule:

```json
{
  "name": "{name}",
  "exec": "main.ts",
  "mode": "timer",
  "cron": "0 9 * * 1-5"
}
```

Field reference:

| Field | Mode | Type | Default | Description |
|---|---|---|---|---|
| `name` | both | string | required | Must match the directory name |
| `mode` | both | string | required | `"daemon"` or `"timer"` |
| `exec` | both | string | required | Entrypoint path, relative to the module directory |
| `replyable` | daemon | boolean | `false` | When `true`, LLM reply text and `message.send.v1` notifications are routed to this module. Omit when the module does not need to receive replies. |
| `cron` | timer | string | required | 5-field cron expression, evaluated in UTC |

## Wire protocol rules

- **stdout**: NDJSON only. One JSON object per line. Never write anything else.
- **stderr**: logs and debug output. The core collects it.
- All messages follow JSON-RPC 2.0: `{ "jsonrpc": "2.0", ... }`.
- Messages with `id` are **requests** — the recipient must send a response.
- Messages without `id` are **notifications** — no response is expected or sent.

The `type` field is **reserved** in all payloads (request `params`, response `result`, notification `params`). Do not use `type` for your own event variants. Use `kind` (a convention) or another key for application-level discrimination.

Core-initiated messages:

| Method | Kind | Description |
|---|---|---|
| `initialize` | request | Core asks the module for its tool list |
| `tool/{name}` | request | Core invokes a tool the module declared |
| `shutdown` | request | Core asks the module to exit gracefully |
| `event` | notification | Core delivers an inbound notification; `params.type` selects the variant |

## Design for drops

**Assume any event you emit may not reach the LLM.** The core provides best-effort delivery only. It does not retry, persist, or acknowledge notifications. Any event you emit can be dropped before the LLM processes it.

Causes of drops:

| Cause | When it happens |
|---|---|
| LLM failure | Runner throws after the event was dequeued |
| Restart recovery | Module process exited with `running` queue rows (LLM cycle started but never finished) |
| No adoptable session | No readable UUID session files when the event is consumed |
| `sessions.interrupt.v1` overwrite | A second interrupt call displaces the first; the displaced event gets `event.dropped.v1` |
| `sessions.skip.v1` | Current LLM run aborted by a module call |
| `sessions.kill.v1` | All pending queue rows dropped at once |
| Session deleted after switch | `sessions.switch.v1` accepted, but file deleted before the loop applies it |

When a drop occurs, the core sends `event.dropped.v1` to the source module (see [Notifications from the core](#notifications-from-the-core)).

**Two design patterns:**

**Pattern 1 — tolerable loss.** File watchers, periodic timers, metrics. Emit and forget. If the event is dropped, the next occurrence will emit again.

```typescript
emitEvent({ kind: "file.changed", path: changedPath });
// if dropped, the next file change covers it
```

**Pattern 2 — must deliver.** Chat relays, outbound messaging, webhook bridges. Keep a pending store in `modules/{name}/` (a flat JSON file or SQLite database). On `event.dropped.v1`, re-emit. Clear the record only when the LLM confirms delivery (for example, via a tool call or a `message.send.v1` acknowledgment).

```typescript
// on inbound message:
pendingStore.set(msgId, { kind: "message.received", msgId, user, text });
emitEvent({ kind: "message.received", msgId, user, text });

// on event.dropped.v1 for one of your events:
const original = pendingStore.get(dropped.params.msgId as string);
if (original) emitEvent(original);

// on confirmed LLM delivery:
pendingStore.delete(msgId);
```

Note: drops do not apply to tool call request/response. If the LLM calls your `tool/{name}`, you will receive the request and must respond. Re-emit logic is only for `event.v1` notifications you emit.

## Daemon skeleton

```typescript
#!/usr/bin/env bun

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitEvent(params: Record<string, unknown>): void {
  writeLine({ jsonrpc: "2.0", method: "event", params: { type: "event.v1", ...params } });
}

// Helper for outbound JSON-RPC requests to the core (e.g. sessions.* operations).
let nextId = 1;
const pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function rpcRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  writeLine(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => { pendingRpc.set(id, { resolve, reject }); });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      let msg: unknown;
      try { msg = JSON.parse(line); } catch { continue; }

      if (!isRecord(msg) || msg.jsonrpc !== "2.0") continue;

      // Branch 1: response to an rpcRequest we sent (id present, no method).
      if (typeof msg.id === "number" && !("method" in msg)) {
        const pending = pendingRpc.get(msg.id);
        if (!pending) continue;
        pendingRpc.delete(msg.id);
        if (isRecord(msg.error)) {
          pending.reject(new Error(typeof msg.error.message === "string" ? msg.error.message : "rpc error"));
        } else {
          pending.resolve(msg.result);
        }
        continue;
      }

      // Branch 2: core-initiated request (id + method).
      if (typeof msg.id === "number" && typeof msg.method === "string") {
        if (msg.method === "initialize") {
          writeLine({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "my_tool",
                  description: "Description of what this tool does",
                  parameters: {
                    type: "object",
                    properties: {
                      input: { type: "string", description: "The input value" },
                    },
                    required: ["input"],
                  },
                },
              ],
            },
          });
          // Start background work here (open a socket, start polling, etc.)

        } else if (msg.method.startsWith("tool/")) {
          const toolName = msg.method.slice(5);
          const params = isRecord(msg.params) ? msg.params : {};
          // Handle the tool call. Return a result object.
          writeLine({ jsonrpc: "2.0", id: msg.id, result: { output: `handled ${toolName}` } });

        } else if (msg.method === "shutdown") {
          writeLine({ jsonrpc: "2.0", id: msg.id, result: "ok" });
          process.exit(0);

        } else {
          writeLine({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
        }
        continue;
      }

      // Branch 3: notification from core (method only, no id).
      if (typeof msg.method === "string" && msg.method === "event" && isRecord(msg.params)) {
        const params = msg.params;

        if (params.type === "message.send.v1" && typeof params.text === "string") {
          // LLM produced reply text. Deliver it to the external system.

        } else if (params.type === "tool_call.v1") {
          // A tool completed. Optionally forward progress to the user.
          // params.tool: tool name, params.input: arguments, params.output: JSON-encoded result

        } else if (params.type === "event.dropped.v1") {
          // The core could not complete an LLM cycle for an event this module emitted.
          // The core does not retry. Re-emit, write to a pending store,
          // or surface the failure to the external system as appropriate.
          console.error("[drop]", JSON.stringify(params.params));
        }
      }
    }
  }
}

void main();
```

To emit an event when something happens externally (for example, a message arrives on a socket):

```typescript
emitEvent({ kind: "message.received", user: "alice", text: "hello" });
```

## Timer skeleton

```typescript
#!/usr/bin/env bun

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      let msg: unknown;
      try { msg = JSON.parse(line); } catch { continue; }

      const r = msg as Record<string, unknown>;
      if (r.method === "initialize") {
        writeLine({ jsonrpc: "2.0", id: r.id, result: { tools: [] } });
        writeLine({
          jsonrpc: "2.0",
          method: "event",
          params: { type: "event.v1", kind: "timer.fired", text: "..." },
        });
        process.exit(0);
      }
    }
  }
}

void main();
```

Timer modules cannot serve tool calls — they exit after emitting. They also never receive `event.dropped.v1`: the core only routes drop notifications to registered daemons, and a timer is a short-lived process that is not registered, so a drop of a timer's event is logged and discarded. For delivery-critical work, use a daemon with internal scheduling instead of a timer.

## Emitting events to the LLM

| `type` | Purpose | Delivered |
|---|---|---|
| `event.v1` | Text-oriented event; payload fields converted to XML for the LLM | Current cycle |
| `image.send.v1` | Attach a base64-encoded image | Next cycle |
| `file.send.v1` | Attach a base64-encoded file (e.g., PDF) | Next cycle |

### XML conversion rules for `event.v1`

The core strips `type` from the payload and converts the remaining fields to XML before passing them to the LLM. Constraints:

- Object keys become XML element names. Keys must be valid XML names (no leading digits, no spaces, no special characters). An invalid key is not skipped: it fails conversion of the whole event, which is then dropped (the source receives `event.dropped.v1`). Never use untrusted or dynamic strings as keys — put variable data in values, not keys.
- Strings, numbers, and booleans become text content.
- Arrays become repeated elements with the same tag name.
- `null` values are omitted.
- `<`, `>`, and `&` are XML-escaped automatically.
- The core wraps the event with `source` and `timestamp` — do not add these yourself.

Use `kind` (not `type`) to distinguish your event variants. `type` is reserved for the protocol envelope.

**Example.** Module emits:

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "event.v1",
    "kind": "message.received",
    "user": "alice",
    "text": "hello",
    "tags": ["greeting", "casual"]
  }
}
```

LLM receives:

```xml
<event source="{module-name}" timestamp="2026-04-10T10:00:00Z">
  <kind>message.received</kind>
  <user>alice</user>
  <text>hello</text>
  <tags>greeting</tags>
  <tags>casual</tags>
</event>
```

## Sending images and files

Use `image.send.v1` and `file.send.v1` to deliver media to the LLM. These are delivered on the **next** LLM cycle after enqueue, not the current one.

**`image.send.v1`**

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `image.send.v1` |
| `data` | string | Base64-encoded image bytes |
| `mediaType` | string | MIME type, e.g. `image/png` |

```typescript
writeLine({
  jsonrpc: "2.0",
  method: "event",
  params: { type: "image.send.v1", data: base64Bytes, mediaType: "image/png" },
});
```

**`file.send.v1`**

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `file.send.v1` |
| `data` | string | Base64-encoded file bytes |
| `mediaType` | string | MIME type, e.g. `application/pdf` |
| `filename` | string | Basename for the file slot |

```typescript
writeLine({
  jsonrpc: "2.0",
  method: "event",
  params: { type: "file.send.v1", data: base64Bytes, mediaType: "application/pdf", filename: "report.pdf" },
});
```

## Notifications from the core

The core sends notifications to modules using `method: "event"` with a `type` discriminator.

| `type` | When sent | What to do |
|---|---|---|
| `message.send.v1` | LLM produced reply text | Deliver `params.text` to the external system |
| `tool_call.v1` | A workspace or module tool completed | Optionally forward tool activity to the user |
| `event.dropped.v1` | An event this module emitted did not produce an LLM cycle | Re-emit, write to a pending store, or surface the failure |

### `message.send.v1`

```json
{ "type": "message.send.v1", "text": "..." }
```

No destination information is included. The module determines where to deliver the text based on its own conversational state (typically the last active conversation context).

### `tool_call.v1`

```json
{
  "type": "tool_call.v1",
  "tool": "shell",
  "input": { "commands": ["ls -la"] },
  "output": "{\"output\":[{\"stdout\":\"...\",\"stderr\":\"\",\"outcome\":{\"type\":\"exit\",\"exitCode\":0}}]}"
}
```

| Field | Type | Description |
|---|---|---|
| `tool` | string | Tool name. Workspace tools use their bare name (`shell`, `create_file`, `edit_file`, `delete_file`); module tools use the `{module}__{name}` form they are exposed under. |
| `input` | object | Arguments passed to the tool by the LLM |
| `output` | string | JSON-encoded result returned by the tool |

Sent to the **current delivery target**, which may not be the module that owns the tool.

### `event.dropped.v1`

```json
{
  "type": "event.dropped.v1",
  "source": "{module-name}",
  "timestamp": "2026-04-14T10:00:00.000Z",
  "params": { "type": "event.v1", "kind": "message.received", "..." }
}
```

| Field | Type | Description |
|---|---|---|
| `source` | string | Module that originally emitted the event |
| `timestamp` | string | ISO 8601, when the event was received by the core |
| `params` | object | Original event params as emitted, except the base64 `data` field is stripped from `image.send.v1` / `file.send.v1` events |

The core does not retry delivery. Re-emitting the event is the module's responsibility. Because `data` is stripped from dropped `image.send.v1` / `file.send.v1` events, re-emit from your own pending store (Pattern 2) rather than from `params`. A dropped cycle may already have written a partial turn to session history (replies sent, tools run); re-emitting processes the event again after that.

## Sessions API

Session operations use JSON-RPC request/response with `method: "sessions"`. The `params.type` field selects the operation. Use the `rpcRequest()` helper from the daemon skeleton.

All 9 operations:

| `params.type` | Returns | Notes |
|---|---|---|
| `sessions.new.v1` | `{ id }` | Creates an empty session file. Does not activate it. Use `sessions.switch.v1` to switch. |
| `sessions.switch.v1` | `"ok"` | Enqueues a session switch. Returns when enqueued, not when applied. `sessions.active.v1` immediately after may still return the old id. |
| `sessions.active.v1` | `{ id }` | Returns the currently active session id. Source of truth is persisted metadata. |
| `sessions.list.v1` | `{ ids }` | All readable session ids, sorted lexicographically (chronological for UUIDv7). |
| `sessions.get.v1` | `{ history }` | Raw `AgentInputItem[]` for the session. Structure may change between versions. |
| `sessions.delete.v1` | `"ok"` | Idempotent. Clears `active_session_id` metadata if the deleted session was active. |
| `sessions.interrupt.v1` | `"ok"` | Sets the single in-memory interrupt slot. The payload (all fields except `type`) is delivered to the LLM before the next queue event, always as an `event.v1` (text/XML) — you cannot inject `image.send.v1` / `file.send.v1` through an interrupt. **Single slot only** — a second call overwrites the first; the displaced event's source receives `event.dropped.v1`. |
| `sessions.skip.v1` | `"ok"` or `"no-op"` | Aborts the current LLM run. The running event receives `event.dropped.v1`. Returns `"no-op"` if nothing is running. Combine with `sessions.interrupt.v1` for immediate effect. |
| `sessions.kill.v1` | `"ok"` | Drops all pending (not yet running) events from the queue. Each source module receives `event.dropped.v1` for its dropped events. |

Request format — `method` is always `"sessions"`, `params.type` selects the operation:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "sessions", "params": { "type": "sessions.new.v1" } }
{ "jsonrpc": "2.0", "id": 2, "method": "sessions", "params": { "type": "sessions.switch.v1", "id": "0196f4a2-..." } }
{ "jsonrpc": "2.0", "id": 3, "method": "sessions", "params": { "type": "sessions.interrupt.v1", "kind": "urgent", "text": "..." } }
```

**Example: create a new session and switch to it:**

```typescript
const { id } = await rpcRequest("sessions", { type: "sessions.new.v1" }) as { id: string };
await rpcRequest("sessions", { type: "sessions.switch.v1", id });
// The switch is now enqueued. The new session becomes active before the next event is processed.
```

**Immediate interrupt (cancel current run and inject an event):**

```typescript
await rpcRequest("sessions", { type: "sessions.interrupt.v1", kind: "urgent", text: "stop and do this instead" });
await rpcRequest("sessions", { type: "sessions.skip.v1" });
// The current LLM run is aborted; the interrupt event is processed next.
```

Timer modules can call `sessions.*` requests during their run, before `process.exit(0)`.

## Auto-routing

LLM reply text is delivered to the source of the most recently consumed event from a **replyable** module.

- Set `replyable: true` in `module.json` if your module should receive LLM text replies.
- Non-replyable modules trigger LLM cycles but do not receive reply text. Replies fall back to the last replyable source. If no replyable source has been recorded yet, the reply text is dropped — no module receives it.
- `route_message(module, text)` is a built-in LLM tool that overrides the delivery target within a cycle. It is called by the LLM, not by modules.
- `route_message` only works to a **different** replyable module than the current target; calling it with the current target returns an error.

## turn_end

`turn_end()` ends the current LLM turn immediately with no text output and no `message.send.v1` notification. The LLM calls it when the task is complete and no reply is needed — for example, after handling a timer event, completing a background task silently, or processing a webhook.

Called by the LLM, not by modules. Module authors should be aware: if `turn_end` is called, a `replyable` module will not receive a `message.send.v1` for that cycle.

## Deploy

After writing the files, reload the modules:

```
restart_modules({ continuation: "" })
```

The module appears in the next LLM turn. Pass a non-empty `continuation` to enqueue a follow-up event immediately after reload.
