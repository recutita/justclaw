# justclaw Protocol Specification

This document defines the wire protocol between the core and modules.

## Transport

NDJSON over stdin/stdout. One JSON message per line. JSON-RPC 2.0 compliant.

stderr is reserved for log output. The core collects it.

## Semantics

JSON-RPC's two message kinds map to two distinct concerns:

| | Request/Response | Notification |
|---|---|---|
| Used for | Tool calling | Events, messaging |
| Direction | core -> module (primary) | module -> core (primary) |
| Response | Required | None |

- **Tool calling** uses request/response. The core asks a module to perform an action and waits for the result. This corresponds directly to LLM tool calling.
- **Events and messaging** use notifications. Modules emit events (e.g., external input received, file changed, timer fired) as one-way notifications. The core may also send notifications to modules, primarily for delivering messages.

### Errors

Error responses follow standard JSON-RPC 2.0. A peer that receives a request it cannot serve replies with an `error` object instead of a `result`:

| Code | When |
|---|---|
| `-32601` | The request reaches a peer with no request handler registered (for example, a `tool/{name}` call sent to a timer module, which serves no tools). Message: `Method not found`. |
| `-32000` | The request handler ran but threw. The thrown error's message is returned verbatim. Used for application-level failures such as an unsupported `sessions.*` type or a `sessions.switch.v1` to a nonexistent session. |

A malformed line (invalid JSON, missing `jsonrpc: "2.0"`, or a non-string `method`) is not answered with an error response; it raises a local error on the receiving side instead, because a correlation `id` may not be recoverable.

On the response-handling side, a peer never tears down the transport over a bad response:

- A response whose `id` is `null` (the JSON-RPC convention when the request `id` could not be recovered) is logged and ignored — it cannot be correlated to a pending request.
- A response carrying an `id` that matches no pending request raises a local error.

## Delivery Guarantees

The protocol provides best-effort delivery only. The core does not retry, persist, or acknowledge notifications. Modules are responsible for ensuring reliable delivery to external systems where it matters.

Modules with durability requirements should implement their own queuing, retry, and persistence (using their `modules/{name}/` directory for state). Modules whose events are tolerable to loss (e.g., file watchers, metrics) can rely on plain notifications without additional handling.

## Module Capabilities

A module may expose **tools** — request/response handlers the core can call. Tools are declared in the response to `initialize`.

Events are not declared. A module may emit any notification at any time; the core forwards them to the LLM queue without validating their payload schema. The only field it inspects is the reserved `type` discriminator (see [Reserved Fields](#reserved-fields)), which must be one of the known envelope types (`event.v1`, `image.send.v1`, `file.send.v1`, `audio.send.v1`); everything else in the payload is passed through untouched.

A daemon module may provide both tools and events. A timer module emits events only (it does not stay running, so it cannot serve tool calls). Both module types may send `sessions.*` requests to the core.

### Tool Definition Format

Each entry in the `tools` array follows the OpenAI function tool format:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Tool name. Must be unique within the module. Used as `{module}__{name}` in the LLM context. |
| `description` | string | no | Description for the LLM |
| `parameters` | object | no | JSON Schema object describing the parameters |

The core validates only that `name` is a non-empty string. `description` and `parameters` are passed through to the LLM unchanged and may be omitted; the core does not validate their contents.

## Reserved Fields

All payloads (request `params`, response `result`, notification `params`) reserve the top-level `type` field for envelope-level discrimination. The convention is dot-separated and versioned (`event.v1`, `message.send.v1`, etc.).

This applies to:

- All notifications in both directions
- All tool requests and responses
- All event payloads

For ordinary event semantics, modules should use another payload field such as `kind` rather than overloading `type`. `kind` is a convention, not a reserved protocol field.

### Tool Result Types

For `tool/{name}` responses, the top-level `result.type` field is reserved by the core:

| `result.type` | Handling |
|---|---|
| omitted | The whole `result` is converted with `JSON.stringify(result)` and passed to the LLM as text. This is the backwards-compatible default. |
| `json` | `result.data` is converted with `JSON.stringify(result.data)` when present; otherwise the whole `result` is stringified. |
| `image` | `result.image.data` is treated as base64 image bytes and downscaled by the same image ingestion rule used for `image.send.v1`. In Responses mode it is passed to the LLM as an image tool result; in Chat Completions mode it is queued as `image.send.v1` for the next LLM cycle and the current tool result is text metadata. |
| `file` | `result.file.data` is treated as base64 file bytes. In Responses mode it is passed to the LLM as a file tool result; in Chat Completions mode it is queued as `file.send.v1` for the next LLM cycle and the current tool result is text metadata. |
| anything else | The whole `result` is converted with `JSON.stringify(result)`. |

Image and file results may include `mediaType`, `filename` (files), and `link`. The core records metadata for media tool results: `type`, `filename` when present, `mediaType`, `size`, `sha256`, `link` when present, and `attachable`. `attachable` is true only when `link` names a readable regular file on the host at the time the result is processed.

Inline image data is stored in session history. Inline file and audio data are not: before session history is stored, the core replaces every `input_file` and `audio` byte payload with metadata plus `omitted: "data"`, regardless of whether the payload came from an event envelope, a built-in attach tool, or a module tool result. If a module expects the LLM to read the same file again in later turns, the module should keep the file under its module directory and return a readable `link` so the LLM can call `attach_file` again.

## Methods

| Method | Direction | Kind | Description |
|---|---|---|---|
| `initialize` | core -> module | request | Module returns its tools |
| `tool/{name}` | core -> module | request | Invoke a tool exposed by the module |
| `shutdown` | core -> module | request | Graceful stop |
| `event` | module -> core | notification | LLM-bound event emitted by the module |
| `sessions` | module -> core | request | Session operations; `params.type` selects the operation (see [Module → Core Session Requests](#module--core-session-requests)) |
| `event` | core -> module | notification | Core-initiated notification (see Core → Module Messaging) |

## Module → Core Notification Types

Modules emit LLM-bound events as notifications with `method: "event"`. The `type` field selects the envelope. Supported values:

| `type` | Purpose |
|---|---|
| `event.v1` | Canonical text-oriented event; payload fields are converted to XML for the LLM (see [Event Format for LLM](#event-format-for-llm)). |
| `image.send.v1` | Delivers a base64-encoded image on the **next** LLM cycle (see below). |
| `file.send.v1` | Delivers a base64-encoded file (for example a PDF) on the **next** LLM cycle (see below). |
| `audio.send.v1` | Delivers base64-encoded audio on the **next** LLM cycle (see below). |

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "event.v1",
    "kind": "message.received",
    "..."
  }
}
```

See [Event Format for LLM](#event-format-for-llm) for how each envelope reaches the LLM.

### `image.send.v1`

Emitted by a module to attach image bytes on the next dequeue. Params:

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `image.send.v1` |
| `data` | string | Base64-encoded image bytes (no validation; consumer is the LLM) |
| `mediaType` | string | MIME type (for example `image/png`) |

### `file.send.v1`

Emitted by a module to attach a document on the next dequeue. Params:

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `file.send.v1` |
| `data` | string | Base64-encoded file bytes |
| `mediaType` | string | MIME type (for example `application/pdf`) |
| `filename` | string | Basename for the file slot |

### `audio.send.v1`

Emitted by a module to attach audio bytes on the next dequeue. Params:

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `audio.send.v1` |
| `data` | string | Base64-encoded audio bytes |
| `mediaType` | string | MIME type (for example `audio/wav`) |
| `format` | string | Audio format for Chat Completions input. Use `wav` or `mp3`. |

## Module → Core Session Requests

Session operations use JSON-RPC request/response (`method: "sessions"`) so the module can confirm the result before emitting subsequent events. The `params.type` field selects the operation.

The bundled runtime always configures a session store (per-session history files under the history directory). A file is treated as a session only when all of the following hold: filename is UUID `{id}.json`, file is readable, JSON parsing succeeds, and the top-level JSON value is an array (minimum condition for `AgentInputItem[]`). Other `*.json` files and unreadable/invalid UUID files are not sessions. The session methods below assume that store is present.

Before any module is started, the bundled entrypoint ensures the history directory is non-empty: if there are no readable UUID `{id}.json` sessions yet (including a missing directory), it creates one empty session file with a new UUIDv7 and writes `[]`. That step is not a module-visible `sessions.new.v1` request; it exists so the LLM loop can adopt a session from disk without a prior `sessions.new.v1`. A line is written to the process stderr when this happens. On runtime startup, if `events.db` metadata does not yet contain `active_session_id`, the core seeds it from the newest readable UUID session id on disk. That startup seed fixes the initial active session before any module-visible `sessions.new.v1` calls can occur. Custom callers of `bootstrapRuntime` alone may omit the initial history-file creation step; in that configuration `sessions.active.v1` can still fail when there are no readable UUID sessions and the loop has not adopted a session yet.

### `sessions.new.v1`

Creates a new session and immediately writes an empty history file (`[]`). The core generates a UUIDv7 as the session identifier and returns it. The session appears in `sessions.list.v1` as soon as this call returns. The session is not activated; `sessions.new.v1` never changes the active session. Use `sessions.switch.v1` to switch.

Request:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "sessions", "params": { "type": "sessions.new.v1" } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "id": "0196f4a2-..." } }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | UUID (case-insensitive). The core returns UUIDv7 from this method. Used as the filename `$JUSTCLAW_HOME/history/{id}.json`. |

### `sessions.switch.v1`

Requests a switch to an existing session. The core enqueues that switch on the LLM queue and returns `"ok"` when the enqueue succeeds. The response means **the switch is queued**, not that the LLM loop has already loaded the new session or updated its active-session state.

The session becomes active before the next `event.v1` is processed by the LLM.

Request:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "sessions", "params": { "type": "sessions.switch.v1", "id": "0196f4a2-..." } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 2, "result": "ok" }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Session identifier. Must be a UUID (case-insensitive). Use the value returned by `sessions.new.v1` or an existing on-disk id. |

If no readable history file exists for the given id, the core returns a JSON-RPC error.

If the history file is removed or becomes unreadable **after** `sessions.switch.v1` returns `"ok"` but **before** the LLM loop applies that queued switch, the core does not change the in-memory session: it notifies the module that enqueued the switch row with `event.dropped.v1` (same shape as other dropped queue work), completes that queue row, and leaves the previously active session unchanged.

**Ordering guarantee:** because the module receives a response before sending the next notification, the session switch is registered in the core before any subsequent `event.v1` is enqueued. The LLM loop drains pending session switches immediately after dequeuing each event, so the correct session is always active when the event is processed.

**`sessions.active.v1` immediately after `sessions.switch.v1`:** the switch is applied asynchronously by the LLM loop. If the module calls `sessions.active.v1` in the same turn, before the loop has consumed the enqueued switch, the result can still be the **previous** active id. There is no guarantee that `"ok"` from `sessions.switch.v1` and a following `sessions.active.v1` observe the same id in that narrow window.

The core does not process `event.v1` until a session is active. If the LLM has not adopted a session yet, the core first tries the persisted active session id in `events.db` metadata. If that id is missing or unreadable, the core falls back to the **lexicographically greatest** readable UUID session id among `{id}.json` files in the history directory (for UUIDv7 ids in canonical string form, that is the newest id). You can also set the active session explicitly with `sessions.switch.v1`. If there are no readable UUID session files and no applicable `sessions.switch.v1` before the event is consumed, the core notifies the source module with `event.dropped.v1` and completes the queue row without running the LLM.

### `sessions.active.v1`

Returns the id of the currently active session. The source of truth is persisted `events.db` metadata key `active_session_id`, which is updated when the LLM loop successfully applies a session switch or adopts a fallback session.

Lookup order:

1. Persisted `events.db` metadata key `active_session_id`
2. Fallback: newest-on-disk readable UUID id (lexicographic maximum) when metadata is missing or unusable

Metadata is considered unusable when `active_session_id` is missing, unreadable, or invalid (for example non-UUID text). In those cases the core logs a warning and continues with fallback lookup.

This method is read-only: it does not update `active_session_id` metadata. Metadata is updated only by the LLM loop when it applies a session switch or adopts a fallback session.

If `sessions.switch.v1` was just accepted (`"ok"`) but the loop has not yet applied that switch, this method can still return the prior value until the switch is drained. See **Ordering guarantee** under `sessions.switch.v1`.

The core returns a JSON-RPC error when no id is available from either step above. After a normal bundled startup with an empty history, the bootstrap step above always leaves at least one file, so this error does not occur on first boot until every session file is removed, becomes unreadable, or the store is otherwise empty.

Request:

```json
{ "jsonrpc": "2.0", "id": 3, "method": "sessions", "params": { "type": "sessions.active.v1" } }
```

Response (when a session is active):

```json
{ "jsonrpc": "2.0", "id": 3, "result": { "id": "0196f4a2-..." } }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Session identifier. Must be a UUID (case-insensitive). Use the value returned by `sessions.new.v1` or an existing on-disk id. |

### `sessions.list.v1`

Returns the ids of all readable sessions (UUID `{id}.json` files that can be read, parsed as JSON, and treated as arrays). Non-UUID `*.json` files and unreadable UUID files are omitted. The list is sorted lexicographically, which is chronological order for UUIDv7 ids.

Request:

```json
{ "jsonrpc": "2.0", "id": 3, "method": "sessions", "params": { "type": "sessions.list.v1" } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 3, "result": { "ids": ["0196f4a2-...", "0196f4a3-..."] } }
```

| Field | Type | Description |
|---|---|---|
| `ids` | string[] | UUID basenames of readable `{id}.json` session files, lexicographically sorted. Non-UUID `*.json` files and unreadable UUID files are omitted. |

### `sessions.get.v1`

Returns the conversation history for a session. If no readable history file exists for the given id, the core returns a JSON-RPC error (same idea as `sessions.switch.v1` for a missing or unreadable session). When the file exists and contains `[]`, `history` is an empty array.

The `history` field contains the raw `AgentInputItem[]` used internally by the LLM loop. Its structure is not versioned and may change.

Request:

```json
{ "jsonrpc": "2.0", "id": 4, "method": "sessions", "params": { "type": "sessions.get.v1", "id": "0196f4a2-..." } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 4, "result": { "history": [ ... ] } }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Session identifier of the session whose history to retrieve. Must be a UUID (case-insensitive). |

### `sessions.delete.v1`

Deletes the history file for the given session. If no file exists for the id, the operation succeeds silently (idempotent).

If the deleted id is currently active (persisted metadata), the core deletes `active_session_id` immediately. The core does not auto-switch during `sessions.delete.v1`; fallback adoption can happen later when the LLM loop needs a session for event processing.

If a session is deleted while an LLM turn is in-flight, completion of that turn does not recreate the deleted session file. Deleted sessions are never written again.

Request:

```json
{ "jsonrpc": "2.0", "id": 7, "method": "sessions", "params": { "type": "sessions.delete.v1", "id": "0196f4a2-..." } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 7, "result": "ok" }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Session identifier. Must be a UUID (case-insensitive). Use the value returned by `sessions.new.v1` or an existing on-disk id. |

### `sessions.interrupt.v1`

Sets a single in-memory interrupt slot in the LLM loop. When the current run finishes (or is aborted via `sessions.skip.v1`), the loop checks the slot before calling `eventQueue.next()`. If set, the interrupt event is processed immediately without going through the SQLite queue.

Only one slot exists. A second `sessions.interrupt.v1` overwrites the first; the overwritten event receives `event.dropped.v1`. The source of the interrupt event is the calling module name. All fields in `params` except `type` are forwarded as the event payload.

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "sessions",
  "params": {
    "type": "sessions.interrupt.v1",
    "kind": "urgent",
    "text": "..."
  }
}
```

Response:

```json
{ "jsonrpc": "2.0", "id": 5, "result": "ok" }
```

### `sessions.skip.v1`

Aborts the currently running LLM cycle by signaling its abort controller. If no run is active, returns `"no-op"` and nothing else happens. The skip request itself only signals the abort; the aborted cycle is then torn down by the LLM loop's normal abort handling, which delivers `event.dropped.v1` to the source and removes the event from the queue (the same path used for any LLM-failure drop). Delivery and removal therefore happen asynchronously, after the request has returned, not within the skip handler.

Combine with `sessions.interrupt.v1` for immediate effect: set the interrupt slot, then call `sessions.skip.v1` to abort the current run. The loop picks up the interrupt slot as the next event instead of pulling from the queue.

Request:

```json
{ "jsonrpc": "2.0", "id": 6, "method": "sessions", "params": { "type": "sessions.skip.v1" } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 6, "result": "ok" }
```

`result` is `"ok"` when a run was aborted, `"no-op"` when nothing was running.

### `sessions.kill.v1`

Deletes all pending (not yet running) events from the queue. For each dropped event, `event.dropped.v1` is delivered to its source module. The event currently being processed by the LLM is not affected.

Request:

```json
{ "jsonrpc": "2.0", "id": 7, "method": "sessions", "params": { "type": "sessions.kill.v1" } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 7, "result": "ok" }
```

### Session lifetime and memory

The core does not bound a session's history by size, age, or token count. A session's history file grows for as long as it stays active; nothing in the core truncates, summarizes, or expires it. Session history therefore has finite practical life even though the core places no limit on it — at some point it grows too large to keep using without external action.

Capping and compacting history is deliberately left as agent policy, not core mechanism. The core's contribution is two primitives: sessions (`sessions.new.v1`, `sessions.switch.v1`) and `MEMORY.md`, a character-directory file re-read from disk before every turn (see [Character files](#character-files)). The expected operating model built on top of those primitives: the agent summarizes durable facts (user preferences, ongoing project state, anything worth keeping beyond the current conversation) into `MEMORY.md`, or hands them to a dedicated module for storage, since both persist independently of any one session's history. When a session's history has grown large enough to warrant a reset, the agent starts a new session with `sessions.new.v1` and activates it with `sessions.switch.v1`, rather than continuing to grow the old session indefinitely.

### Reasoning in session history

Models that emit reasoning have those items stored in the session history alongside messages and tool calls. Within a single event they are always replayed: a tool-calling chain requires the reasoning that preceded each call, and removing it mid-chain breaks the run.

Across events the trade-off differs by API mode. Under `responses` the stored item carries an id and no summary — the core requests neither reasoning summaries nor encrypted content — so replaying it costs almost nothing and lets the provider continue the earlier reasoning. Under `chat_completions` a provider that returns a `reasoning` field on the assistant message has that raw text replayed in full on every later event, which grows the history for no benefit once the event that produced it is finished.

`JUSTCLAW_DROP_REASONING_HISTORY=1` removes reasoning items carried over from previous events before the history is handed to the model. It does not touch reasoning produced inside the current event.

The history file on disk is unaffected by the setting. Reasoning is the record of how the agent reached a decision, so it stays on disk for inspection after the fact even when it is withheld from the model:

```
history/{id}.json   every reasoning item, always
       │
       └─ minus previous events' reasoning (when the flag is 1)
              │
              ▼
          model input
```

This is the only place where the persisted history and the input sent to the model intentionally differ. The two must not be "reconciled": the divergence is what preserves the audit trail. Concretely, the stored history is rebuilt from the unfiltered history plus the items the run generated, rather than from the run result directly — writing the run result back would erase the withheld reasoning from disk on the next save.

## Lifecycle (daemon)

```
Core                            Module
 |                                |
 |-- spawn ---------------------->|
 |-- {"jsonrpc":"2.0","id":1,     |
 |    "method":"initialize"} ---->|
 |<-- {"jsonrpc":"2.0","id":1,    |
 |     "result":{                 |
 |       "tools":[...]            |
 |     }} ---------------------- |
 |                                |
 |   (module emits events as      |
 |    notifications any time)     |
 |<-- {"jsonrpc":"2.0",           |
 |     "method":"event",          |
 |     "params":{...}} ---------- |
 |                                |
 |   (core invokes a tool)        |
 |-- {"jsonrpc":"2.0","id":2,     |
 |    "method":"tool/{name}",     |
 |    "params":{...}} ----------->|
 |<-- {"jsonrpc":"2.0","id":2,    |
 |     "result":{...}} ---------- |
 |                                |
 |-- {"jsonrpc":"2.0","id":3,     |
 |    "method":"shutdown"} ------>|
 |<-- {"jsonrpc":"2.0","id":3,    |
 |     "result":"ok"} ----------- |
 |                            exit(0)
```

## Lifecycle (timer)

```
Core                            Module
 |                                |
 |  cron match                    |
 |-- spawn ---------------------->|
 |-- initialize ----------------->|
 |<-- result -------------------- |
 |<-- event (notification) ------ |
 |                            exit(0)
 |  (core reaps process)          |
```

## Timer Execution

- Cron expressions are evaluated in UTC.
- If a cron tick fires while the previous run for that module is still active, the core kills the previous process (SIGTERM, then SIGKILL after 1 second) before spawning a new one.

## Module Execution

Each daemon module directory contains a `module.json` manifest. Required fields: `name` (must match the directory name), `mode` (`"daemon"`), `exec` (path to the entrypoint, relative to the module directory). Optional field:

| Field | Type | Default | Description |
|---|---|---|---|
| `replyable` | boolean | `false` | When `true`, the core may deliver `message.send.v1` to this module and the LLM may use `route_message` / final text routing to this module. Non-replyable modules still receive tool calls and emit events; outbound user messaging is not routed to them. |

Each timer module directory contains a `module.json` manifest. Required fields: `name` (must match the directory name), `mode` (`"timer"`), `exec` (path to the entrypoint, relative to the module directory), `cron` (schedule). Optional fields: none.

| Field | Type | Default | Description |
|---|---|---|---|
| `cron` | string | required | Cron expression (5-field, UTC) |

When the core starts a module, it executes the manifest's `exec` path inside the platform sandbox. Linux uses `bwrap`; macOS uses `sandbox-exec`.

The core does not parse module entrypoint shebangs. An interpreter named in a shebang (e.g. `#!/usr/bin/env bun`) must resolve to a path that is already mounted in the sandbox, or the module fails to start. Mounted read-only paths are:

- The standard OS read-only allowlist (`/usr`, `/bin`, `/etc`, `/nix`, and similar system paths).
- The core's own runtime directory (`dirname(process.execPath)`), auto-mounted read-only into every module sandbox. This covers the common case of a module written in the same runtime as the core (e.g. Bun installed under `~/.bun/bin`) without reading any module-controlled input.
- Paths listed in `JUSTCLAW_SANDBOX_RO_PATHS` (see below).

**Rationale:** An earlier design parsed each module's shebang and exposed the resolved interpreter's parent directory. Because the shebang line is module-controlled input (and the LLM can write it via the rw-mounted modules root), that let a module expose the parent directory of any path it named, including host directories with no relation to the module's own runtime.

### Operator-configured sandbox paths

Two environment variables let the operator add mount paths beyond the standard allowlist. Both are colon-separated lists of absolute paths, validated against the host filesystem: relative paths, paths containing `..`, and paths that resolve differently once normalized (e.g. `//`, `/.`) are rejected; entries that don't exist on the host are skipped. Rejected or missing entries are logged and otherwise ignored (fail closed).

| Variable | Mount | Scope |
|---|---|---|
| `JUSTCLAW_SANDBOX_RO_PATHS` | Read-only | Module sandbox and workspace sandbox |
| `JUSTCLAW_SANDBOX_RW_PATHS` | Read-write | Module sandbox and workspace sandbox |

These are operator input, not module input, so there is no per-module injection concern; validation exists to fail closed on misconfiguration rather than to defend against an adversarial value.

`JUSTCLAW_SANDBOX_RW_PATHS` grants are global: every module sandbox and the workspace sandbox get the same read-write access. For the workspace sandbox, that means the paths are reachable by the LLM (which drives the workspace shell).

## Operator instructions

The bundled entrypoint reads `$JUSTCLAW_HOME/AGENTS.md` before every LLM turn. If present, its content is fenced in a `<system-instructions>` element and prepended to the character context instructions. The dedicated tag — distinct from the character-file tags below — labels the content's origin: operator instructions live in a fixed file the agent cannot edit, and the fence separates them from editable character content. The fence is a delimiter, not an enforcement mechanism; see [Fence trust model](#fence-trust-model).

This file is outside all sandbox write paths, so the agent cannot modify it. Changes to the file take effect on the next turn without restarting the process.

Use this file for operator-level instructions that must persist regardless of character directory contents.

## Character directory

The core resolves a **character** directory for optional static agent context and for files the agent may edit alongside the workspace.

| Resolution | Path |
|---|---|
| `JUSTCLAW_CHARACTER` set | Absolute path from this env var |
| else `JUSTCLAW_HOME` set | `$JUSTCLAW_HOME/character` |
| else | `$HOME/justclaw/character` |

If neither `JUSTCLAW_HOME` nor `HOME` is available, character directory resolution fails the same way as workspace resolution when no overrides exist.

The bundled entrypoint creates the directory if missing (recursive mkdir), same as the workspace directory.

### Character files

The core reads the following files from the character directory, in order:

| File | Purpose |
|---|---|
| `AGENTS.md` | System instructions for the LLM (equivalent to CLAUDE.md / AGENTS.md in coding agents) |
| `SOUL.md` | Core values and ethical guidelines |
| `IDENTITY.md` | Personality, tone, and style |
| `USER.md` | User information and preferences |
| `MEMORY.md` | Cross-session memory |
| `INIT.md` | Startup tasks — injected as an `event.v1` when a new empty session becomes active |

`INIT.md` is the exception: it is **not** concatenated into the context instructions. It feeds the separate event-injection path described in its table row above and never appears in the system prompt. The remaining files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`) each present are read as UTF-8, trimmed, and fenced in an XML element named after the file:

```
<FILENAME.md>
<trimmed content>
</FILENAME.md>
```

The tag name is the filename itself (e.g. `<SOUL.md>`); runtime instructions document what each file means, so no descriptive attribute is needed. The fence delimits blocks whose content does not itself emit closing tags; it is not proof against forgery (see [Fence trust model](#fence-trust-model)). File content stays Markdown; only the boundary is XML. Sections are joined with a blank line. The combined string becomes **context instructions** in the agent system prompt (see [Agent system prompt](#agent-system-prompt)).

Missing files are silently skipped. An empty directory (or one containing none of the above filenames) produces empty context instructions. Other I/O errors from reading a present file propagate and abort `runLlmLoop` (they are not caught per-event).

The bundled LLM loop re-reads these files from disk immediately before each `event.v1` is passed to the model. Because the character directory is rw-mounted in the workspace sandbox, the LLM can edit these files via workspace tools; edits take effect on the next turn.

### Workspace sandbox

Built-in `shell`, `create_file`, `edit_file`, and `delete_file` run inside the workspace sandbox. That sandbox grants read-write access to the workspace directory, read-write access to the character directory, read-write access to the runtime modules directory (the same path the core uses to discover and load modules; same mount semantics as the character directory), read-write access to the skills directory (when configured; same mount semantics as the character directory), and read-only access to the history directory (when it exists on the host), in addition to the standard OS read-only paths and temp rules described for module execution. Path boundaries are enforced by the sandbox; the application does not duplicate that check.

## Skills directory

The core resolves an optional **skills** directory for agent skill definitions.

| Resolution | Path |
|---|---|
| `JUSTCLAW_SKILLS` set | Absolute path from this env var |
| else `JUSTCLAW_HOME` set | `$JUSTCLAW_HOME/skills` |
| else | `$HOME/justclaw/skills` |

The bundled entrypoint creates the directory if missing (recursive mkdir), same as the workspace and character directories.

### Skill format

Each skill is a subdirectory containing a `SKILL.md` file:

```
skills/
  {skill-name}/
    SKILL.md        # required: YAML frontmatter + Markdown instructions
    ...             # optional: scripts, templates, reference files
```

`SKILL.md` must begin with YAML frontmatter followed by Markdown:

```markdown
---
name: {skill-name}
description: {one-line description of when to use this skill}
---

# {Skill title}

...instructions...
```

Required frontmatter fields:

| Field | Description |
|---|---|
| `name` | Short identifier. Should match the directory name. |
| `description` | One sentence describing when the skill applies. Shown to the LLM in the skill index. |

Both fields must be YAML strings. Values that YAML types as something else are treated as missing, so quote names that read as other scalars (e.g. `name: "true"`, `name: "123"`).

### Skill discovery

Before each LLM turn, the bundled loop scans `skills/*/SKILL.md`, parses frontmatter, and injects a skill index (name + description table) into the runtime instructions. Full skill content is not loaded automatically; the LLM reads it on demand via `shell`.

Because the skills directory is rw-mounted in the workspace sandbox, the LLM can create, edit, and delete skills using `shell`, `create_file`, `edit_file`, and `delete_file`.

## Agent system prompt

The bundled LLM loop rebuilds the agent `instructions` string immediately before each LLM turn. It is composed of two parts:

| Part | Source | Content |
|---|---|---|
| Context instructions | Operator `AGENTS.md` and character files on disk (`SOUL.md`, etc.) | Each file fenced in its own XML element, as described under [Operator instructions](#operator-instructions) and [Character files](#character-files). Re-loaded before each LLM turn when `characterDir` is configured. Empty when no files are present or all trim empty. |
| Runtime instructions | `buildRuntimeInstructions` | Canonical paths and operational guidance (workspace, history layout, character files table, modules directory path, table of loaded modules with replyable flag and tool names, and skill index when a skills directory is configured), fenced in a `<runtime>` element. Inner prose is Markdown; only the boundary is XML. |

The core concatenates context instructions and runtime instructions with a **blank line** between them (`\n\n`). Each part is fenced in XML elements (`<system-instructions>`, the per-file character tags, and `<runtime>`) so the model can tell operator instructions, editable character content, and machine-supplied runtime facts apart. Runtime instructions are omitted unless the builder has the workspace path, history path, character path, modules directory path, and the current module list (the bundled entrypoint supplies all of these). Callers without a `characterDir` may still supply static context instructions (tests only in-tree).

### Fence trust model

The fences label origin for cooperative content; they are not an unforgeable boundary. File content is inserted without escaping (only event payloads are XML-escaped), so a character file containing a literal `</AGENTS.md>` followed by a `<system-instructions>` block produces a byte stream textually indistinguishable from a real operator block. The same applies to skill descriptions and module names interpolated into the `<runtime>` block.

This is acceptable because every writer of fenced content is already inside the trust boundary: the operator (who can edit the real `$JUSTCLAW_HOME/AGENTS.md` directly) and the agent itself (whose character files the model already follows as instructions, fence or no fence). Module sandboxes do not mount the character or skills directories, so modules cannot plant content. Forging a fence therefore grants no privilege the writer does not already have. Note also that no precedence rule between `<system-instructions>` and character content is stated anywhere in the prompt; the tags distinguish origin, not authority.

This reasoning is load-bearing. Two changes would invalidate it, and either one requires making the fence unforgeable first (e.g. closing tags carrying an unpredictable per-turn nonce that content cannot know): a prompt rule that gives `<system-instructions>` authority over character content, or any code path that writes character or skills files from untrusted input.

Before each LLM turn, the bundled loop refreshes the module table from the currently loaded daemons so `replyable` and tool names match the live process set. A successful `restart_modules` updates processes immediately and **ends the current LLM run**. The **next** dequeued event gets the updated prompt and module tool names.

## Core → Module Messaging

The core sends notifications to modules using `method: "event"` with a versioned `type` field as the discriminator. Unlike module-emitted events (which the LLM consumes), these notifications are consumed by module code, so their formats are fixed.

### `message.send.v1`

The core delivers outbound LLM-generated messages to modules via `message.send.v1`.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "message.send.v1",
    "text": "..."
  }
}
```

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `message.send.v1` |
| `text` | string | Message body |

The notification carries no destination information. Modules are responsible for determining where to actually deliver the message based on their own conversational state. A messaging module typically tracks its most recent conversation context and uses it as the default destination.

If precise destination control is required (e.g., DM a specific user, send to a non-default channel), modules should expose this as a tool with explicit parameters rather than relying on the `message.send.v1` notification.

### `tool_call.v1`

The core notifies the current message target each time a tool completes — both workspace tools (`shell`, `create_file`, `edit_file`, `delete_file`) and tools exposed by modules. The notification is sent to the same module that is the current delivery target at the time the tool is called (i.e., `event.source`, unless overridden by a prior `route_message` call in the same cycle).

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "tool_call.v1",
    "tool": "shell",
    "input": { "commands": ["ls -la"] },
    "output": "{\"output\":[{\"stdout\":\"...\",\"stderr\":\"\",\"outcome\":{\"type\":\"exit\",\"exitCode\":0}}]}"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `tool_call.v1` |
| `tool` | string | Tool name. Workspace tools use their bare name (`shell`, `create_file`, `edit_file`, `delete_file`). Module tools use the `{module}__{name}` form they are exposed under in the LLM context. |
| `input` | object | Arguments passed to the tool by the LLM |
| `output` | string | JSON-encoded result returned by the tool |

For `shell`, `output` is a JSON-encoded `ShellResult` containing per-command stdout, stderr, and outcome (exit code or timeout). For `create_file`, `edit_file`, and `delete_file`, `output` is a JSON-encoded object with a `status` field (`"completed"` or `"failed"`) and an optional `output` field with an error message.

### `event.dropped.v1`

The core notifies the source module when it **consumes an event for an LLM cycle but that cycle does not complete normally**. The source module can use this to decide whether to re-emit the event.

That includes at least:

- **Restart recovery:** the previous process exited while one or more events were still marked `running` in the queue (the LLM cycle had started but never finished).
- **LLM failure:** the runner throws or otherwise fails after the event was consumed and before the cycle would have completed successfully.
- **No adoptable session:** a session store is configured, the event was consumed from the queue, but no session could be adopted (no readable UUID `{id}.json` files on disk yet and no `sessions.switch.v1` applied before this event in the loop).

**Delivery guarantee: at-least-once, not exactly-once.** `event.dropped.v1` is a best-effort signal that the LLM cycle *may* not have completed normally — it is not proof that it didn't. Restart recovery in particular cannot distinguish "the process exited before the cycle finished" from "the process exited after the cycle finished but before the queue row was marked complete": the row stays `running` until the core finishes marking it complete, and a crash in that narrow window leaves the row `running` on disk even though the cycle already ran to completion (for example, a reply was already delivered). Stale-row recovery on the next start has no way to tell the two cases apart, so it sends `event.dropped.v1` either way. A module that reacts by re-emitting the event can therefore cause it to be processed twice. Modules for which that matters must dedupe on re-emit — for example, by attaching an idempotency key to the event and having whatever consumes a redelivery (the module itself, or a downstream system) ignore a repeat of the same key.

In all cases the notification shape is the same.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "event.dropped.v1",
    "source": "{module-name}",
    "timestamp": "2026-04-14T10:00:00+09:00",
    "params": {
      "type": "event.v1",
      "kind": "message.received",
      "..."
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `event.dropped.v1` |
| `source` | string | Name of the module that originally emitted the event |
| `timestamp` | string | Local ISO 8601 with an explicit numeric offset (never `Z`), when the event was originally received by the core |
| `params` | object | Original event params as emitted by the source module, with one exception (see below) |

For `image.send.v1`, `file.send.v1`, and `audio.send.v1` events, the base64 `data` field is stripped from `params` before the notification is sent; all other fields (`mediaType`, `filename`, `format`, etc.) are preserved. This keeps the core from echoing large binary payloads back through the module channel. The source module already holds the original data and can re-emit it if it chooses.

If the source module is not available (for example, not loaded after restart or the daemon is gone), the core logs the loss and removes the queue row; it does not retry delivery. Re-emitting the event is the module's responsibility; the core does not replay it automatically.

### Auto-routing

Because the LLM inference queue is single and serial, the most recently consumed received message is always uniquely defined. This is the canonical basis for routing:

> **The canonical delivery target is the source of the most recently consumed message from a replyable module.**

The core persists this as the `last_replyable_target` key in `events.db` metadata. Delivery target resolution at the start of each cycle:

| Event source | Delivery target | `last_replyable_target` update |
|---|---|---|
| `replyable: true` | `event.source` | Written with `event.source` |
| `replyable: false` | `last_replyable_target` if set; otherwise `event.source` | Not written |

**Rationale:** Non-replyable modules (for example, those that deliver images via `image.send.v1`) trigger LLM cycles but have no inbox for replies. Without a fallback, LLM output generated in response to their events would be silently dropped. Using the most recently persisted replyable source as the fallback target routes that output to the module most likely to handle it — the one the user was just interacting with.

#### Transient override

When the LLM calls the built-in `route_message` tool during a processing cycle, it creates a transient override of the delivery target:

- The override applies only within the current processing cycle.
- Free-form text output emitted after the override goes to the overridden target.
- When the cycle ends, the override is discarded.
- The next processing cycle starts fresh from the canonical state derived from the next consumed message.

**Rationale:** LLMs commonly emit free-form text immediately after a tool call without repeating the tool invocation. Without the override, that trailing text would be misrouted back to the canonical target instead of the module the LLM just explicitly addressed. The override resolves this without requiring the LLM to re-specify the destination on every output.

#### Example

```
Queue: [Event A from X (replyable), Event B from Y (replyable), Event C from NR (not replyable)]

[Cycle for A starts]
  source = X (replyable) -> last_replyable_target = X
  default target = X
  LLM emits text          -> delivered to X
  LLM calls route_message(module=Z, ...)
                          -> delivered to Z
                          -> override = Z
  LLM emits text          -> delivered to Z
[Cycle for A ends, override discarded]

[Cycle for B starts]
  source = Y (replyable) -> last_replyable_target = Y
  default target = Y
  LLM emits text          -> delivered to Y
[Cycle for B ends]

[Cycle for C starts]
  source = NR (not replyable)
  last_replyable_target = Y -> default target = Y
  LLM emits text          -> delivered to Y
[Cycle for C ends]
```

### Built-in Tool: `route_message`

The core provides `route_message` as a built-in tool, available to the LLM regardless of which modules are loaded. Use this only to forward output to a module other than the current delivery target. To reply to the sender of the current event, emit free-form text instead — it is delivered automatically. Calling `route_message` with the current delivery target as the destination returns an error.

```
route_message(module: string, text: string)
```

| Parameter | Description |
|---|---|
| `module` | Target module name (must differ from the current delivery target) |
| `text` | Message body |

The core forwards this as a `message.send.v1` notification to the named module only when that module's manifest has `replyable: true` and differs from the current delivery target; otherwise the tool returns an error. On success, the core sets the transient delivery-target override (see [Transient override](#transient-override)) to the named module for the rest of the current cycle. It does not modify the persisted `last_replyable_target`.

Trailing free-form assistant text after the LLM run is delivered the same way: only when the current delivery target module is replyable.

### Built-in Tool: `restart_modules`

Reloads all modules (daemon and timer) from the modules directory (same discovery path as startup). Manifest discovery and parsing run **before** any running module is stopped. If discovery or parsing fails, or if the directory contains no valid daemon modules, existing processes stay up and the tool returns an error string. If discovery succeeds, modules that fail to start are skipped (a warning is logged) and the remaining modules continue starting normally.

```
restart_modules({ continuation: string })
```

| Parameter | Description |
|---|---|
| `continuation` | Required. Ignored when reload fails. When reload succeeds and `continuation` is non-empty (after trim), the core enqueues exactly one follow-up internal event with `source` set to the **current** `event.source` and `params` fixed to `{ "type": "event.v1", "text": "<trimmed continuation>" }`. Pass an empty string when no follow-up is needed. The LLM does not supply `source` or arbitrary params. |

The bundled LLM loop implements this as a core tool. It requires a configured session store and modules root; if those are missing, the tool returns an error string instead of reloading.

**Turn boundary:** After `restart_modules` **succeeds**, processes match disk and the current LLM run ends immediately after that tool call. The agent does not continue with more tool calls or trailing free-form text in the reloaded state. The **next** `event.v1` shows the new module table and runs normally against the reloaded modules. Use a non-empty `continuation` when you want the core to enqueue exactly one handoff event under that new module set.

### Built-in Tool: `attach_image`

```
attach_image({ path: string })
```

| Parameter | Description |
|---|---|
| `path` | Path to an image file accessible within the workspace sandbox |

The file is read through the workspace sandbox, so the path must be within a sandbox-accessible directory (workspace, character, modules, history, or the standard OS read-only paths). The core infers a `mediaType` from the extension and downscales large images before re-encoding them. In Responses mode the image is returned as the tool result so it is available to the LLM in the same turn; in Chat Completions mode it is queued as `image.send.v1` for the next LLM cycle. On failure it returns `error: ...`.

### Built-in Tool: `attach_file`

```
attach_file({ path: string })
```

| Parameter | Description |
|---|---|
| `path` | Path to a file accessible within the workspace sandbox |

The file is read through the workspace sandbox, so the path must be within a sandbox-accessible directory (workspace, character, modules, history, or the standard OS read-only paths). The core infers `mediaType` from the extension and sets `filename` to the basename. In Responses mode the file is returned as the tool result so it is available to the LLM in the same turn; in Chat Completions mode it is queued as `file.send.v1` for the next LLM cycle. On failure it returns `error: ...`.

### Built-in Tool: `shell`

Executes shell commands sequentially inside the workspace sandbox. Each command runs as `sh -c <command>`. Commands do not share state between calls.

```
shell(commands: string[], timeout_ms?: number)
```

| Parameter | Description |
|---|---|
| `commands` | Shell commands to execute in order |
| `timeout_ms` | Per-command timeout in milliseconds (default: 30000) |

The sandbox grants read-write access to `$JUSTCLAW_HOME/workspace/`, read-write access to the character directory, read-write access to the runtime modules directory, read-write access to the skills directory (when configured), and read-only access to `$JUSTCLAW_HOME/history/`. After each invocation the core emits a `tool_call.v1` notification to the current delivery target.

### Built-in Tool: `create_file`

Write full content to a file inside the workspace sandbox. Overwrites the file if it already exists. Path boundaries are enforced by the sandbox; the application does not duplicate that check.

```
create_file(path: string, content: string)
```

| Parameter | Description |
|---|---|
| `path` | Absolute path to the file |
| `content` | Full file content |

After each invocation the core emits a `tool_call.v1` notification to the current delivery target.

### Built-in Tool: `edit_file`

Replace an exact substring in an existing file inside the workspace sandbox. Path boundaries are enforced by the sandbox; the application does not duplicate that check.

```
edit_file(path: string, old: string, new: string)
```

| Parameter | Description |
|---|---|
| `path` | Absolute path to the file |
| `old` | Exact substring to replace (must appear exactly once in the file) |
| `new` | Replacement text |

After each invocation the core emits a `tool_call.v1` notification to the current delivery target.

### Built-in Tool: `delete_file`

Delete a file inside the workspace sandbox. Path boundaries are enforced by the sandbox; the application does not duplicate that check.

```
delete_file(path: string)
```

| Parameter | Description |
|---|---|
| `path` | Absolute path to the file |

After each invocation the core emits a `tool_call.v1` notification to the current delivery target.

### Built-in Tool: `turn_end`

End the current LLM turn immediately without delivering any message. The SDK's agent loop cannot terminate without text output from the model; `turn_end` provides an explicit escape hatch via `toolUseBehavior`.

```
turn_end()
```

No parameters. On invocation the core sets `isFinalOutput: true` with an empty `finalOutput`, ending the run. No `message.send.v1` is delivered.

Use this when the task is complete and no reply is needed — for example after handling a timer event or completing a background task silently.

## Event Format for LLM

Event payloads are arbitrary JSON objects. The canonical text-oriented envelope is `type: "event.v1"`. The core uses `type` for envelope handling and does not forward that field to the LLM as a literal key in the user string. The remaining payload fields are converted to XML before passing them to the LLM. Many LLMs handle XML-tagged input better than raw JSON, producing more reliable reasoning.

**Multimodal envelopes (`image.send.v1`, `file.send.v1`, `audio.send.v1`):** The core builds the XML wrapper (`eventToXml`) from the payload with both `type` and the base64 `data` stripped, and passes it as an `input_text` part — so fields such as `mediaType`, `filename`, and `format` reach the LLM as text, but the bytes do not. The bytes go in a second content part: `input_image`, `input_file`, or `audio`. Image and file content use a **data URL string** (`data:<mediaType>;base64,<data>`), matching the Chat Completions path. Audio content uses inline base64 plus `format` (`wav` or `mp3`) so the OpenAI adapter can build `input_audio`. `data` is kept out of the XML so the bytes are not sent twice; the text copy would exhaust the context window. These rows are processed in the same session-adoption path as `event.v1`.

**Conversion rules (for the XML half):**

- Object keys become XML element names
- Strings, numbers, and booleans become text content
- Arrays become repeated elements with the same tag
- `null` values are omitted
- Special characters (`<`, `>`, `&`) are XML-escaped
- Object keys must be valid XML element names (no leading digits, no whitespace, no special characters). Invalid keys are an error.

The core wraps each event with metadata (`source`, `timestamp`) it knows independently of the module. `timestamp` is local wall-clock time (per the `TZ` environment variable or the system's local zone) with an explicit numeric offset — never `Z`, never a naked local time without an offset — so a reader is never left to infer the zone. Only persistence (`events.db`) stores timestamps in UTC.

**Example:**

Module emits:

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
<event source="{module-name}" timestamp="2026-04-10T10:00:00+09:00">
  <kind>message.received</kind>
  <user>alice</user>
  <text>hello</text>
  <tags>greeting</tags>
  <tags>casual</tags>
</event>
```
