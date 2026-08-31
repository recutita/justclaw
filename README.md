# justclaw

An autonomous agent framework that is just right.

justclaw is inspired by [OpenClaw](https://github.com/openclaw/openclaw) — a street tree, grown in fixed soil. justclaw is the soil itself.

The goal is not to be smaller. The goal is to be right.

The core processes events through a single LLM queue, providing reasoning, session memory, and identity. Modules connect external systems — messaging, timers, APIs — by communicating with the core over NDJSON (JSON-RPC 2.0) on stdin/stdout.

Runtime: **Bun**

## Philosophy

What justclaw leaves out is as deliberate as what it includes.

- **Right, not minimal.** Features are omitted until something concretely needs them — no permission system, no event schemas, no delivery guarantees, yet. The omissions are the design, not gaps in it.
- **Small core, mechanism not policy.** The core provides mechanisms: an event bus, a single serial LLM queue, process spawning, message routing. Modules decide policy: retries, persistence, formatting, error handling. Policy belongs in modules, not the core.
- **Unix philosophy.** Composable modules over text protocols (NDJSON, JSON-RPC). One responsibility per module. Failure is isolated by process boundaries.
- **LLMs tolerate ambiguity.** Data whose only consumer is the LLM stays loosely structured. Strict types live only at boundaries where machine code reads them.

## Requirements

- [Bun](https://bun.sh)
- macOS (`sandbox-exec`, included in the OS) or Linux (`bwrap`)

## Quickstart

**1. Set environment variables**

```sh
export JUSTCLAW_OPENAI_API_KEY=your-api-key
export JUSTCLAW_OPENAI_MODEL=gpt-5
export JUSTCLAW_HOME=$HOME/justclaw
```

**2. Install dependencies**

```sh
bun install
```

**3. Add a module**

Copy the `cli-chat` example module, which lets you chat from a local terminal:

```sh
mkdir -p $JUSTCLAW_HOME/modules/cli-chat
cp examples/cli-chat/module.json examples/cli-chat/main.ts $JUSTCLAW_HOME/modules/cli-chat/
```

**4. Start the core**

```sh
bun run src/index.ts
```

**5. Connect in a second terminal**

```sh
bun run examples/cli-chat/client.ts
```

Type a message and press Enter. The LLM response is printed to the same terminal.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `JUSTCLAW_OPENAI_API_KEY` | yes | — | API key passed to the OpenAI-compatible client |
| `JUSTCLAW_OPENAI_MODEL` | yes | — | Model name, e.g. `gpt-5` |
| `JUSTCLAW_OPENAI_API` | no | `chat_completions` | OpenAI API mode: `chat_completions` or `responses`. Use `responses` for multimodal tool results; compatible providers must support `/v1/responses` |
| `JUSTCLAW_OPENAI_INPUT_MODALITIES` | no | `image,file,audio` | Comma-separated list of multimodal input kinds the endpoint accepts (`image`, `file`, `audio`), or `none`. Bytes of a disabled kind are never sent, and `attach_image` / `attach_file` are not exposed to the LLM when their kind is disabled |
| `JUSTCLAW_OPENAI_BASE_URL` | no | OpenAI default | Base URL for the API endpoint; set to use a compatible provider |
| `JUSTCLAW_HOME` | no | `$HOME/justclaw` | Root directory for modules, workspace, history, character, and skills |
| `JUSTCLAW_WORKSPACE` | no | `$JUSTCLAW_HOME/workspace` | Override path for the workspace directory |
| `JUSTCLAW_CHARACTER` | no | `$JUSTCLAW_HOME/character` | Override path for the character directory |
| `JUSTCLAW_SKILLS` | no | `$JUSTCLAW_HOME/skills` | Override path for the skills directory |
| `JUSTCLAW_MAX_TURNS` | no | `10` | Maximum agent turns (LLM call to tool calls to repeat) per event before the runner gives up. Positive integer |
| `JUSTCLAW_MODEL_TIMEOUT` | no | `600` | Seconds to wait for a single model call. On expiry the LLM cycle fails and the event is dropped. Non-negative integer; `0` disables the bound. See [Timeouts](docs/spec.md#timeouts) |
| `JUSTCLAW_TOOL_TIMEOUT` | no | `60` | Seconds to wait for a module to answer a `tool/{name}` request. On expiry the tool call returns a timeout to the LLM and the turn continues. Non-negative integer; `0` disables the bound. See [Timeouts](docs/spec.md#timeouts) |
| `JUSTCLAW_DROP_REASONING_HISTORY` | no | `0` | `1` strips reasoning items carried over from previous events before sending the session history to the model. Reasoning generated within the current event is unaffected, and the history file on disk keeps every reasoning item either way. See [Reasoning in session history](docs/spec.md#reasoning-in-session-history) |
| `JUSTCLAW_MAX_RESTART_ATTEMPTS` | no | `1` | Maximum automatic restarts for a daemon that exits unexpectedly. Non-negative integer (`0` disables restart) |
| `JUSTCLAW_SANDBOX_RO_PATHS` | no | — | Colon-separated absolute paths mounted read-only into the module sandbox and the workspace sandbox |
| `JUSTCLAW_SANDBOX_RW_PATHS` | no | — | Colon-separated absolute paths mounted read-write into the module sandbox and the workspace sandbox (reachable by the LLM via the workspace sandbox) |
| `JUSTCLAW_SANDBOX_ENV` | no | — | Colon-separated variable names to pass into the module sandbox and the workspace sandbox in addition to the default allowlist (`PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ`, `TERM`, `USER`, `LOGNAME`, `JUSTCLAW_HOME`, `JUSTCLAW_WORKSPACE`, `JUSTCLAW_CHARACTER`, `JUSTCLAW_SKILLS`, and any `LC_*` variable). Everything else, including `JUSTCLAW_OPENAI_API_KEY`, is dropped. A variable named here reaches the agent: it can rewrite module code. See [Sandbox environment](docs/spec.md#sandbox-environment) |

## Architecture

The core runs a single LLM inference queue. Modules communicate with the core over NDJSON (JSON-RPC 2.0) on stdin/stdout. Events from modules are enqueued and processed serially; the LLM may call back into modules via tool calls.

1. A module emits an event (notification) to the core.
2. The core enqueues it on the single, serial LLM queue.
3. The LLM processes the event and may call module tools (`tool/{name}`, request/response).
4. Output is delivered to the current routing target.

### Core capabilities

- **Reasoning** — LLM-based inference via a single serial queue
- **Memory** — Per-session conversation history, persisted to disk
- **Identity** — Agent personality and instructions loaded from the character directory
- **Built-in tools** — `shell`, `create_file`, `edit_file`, `delete_file`, `route_message`, `attach_image`, `attach_file`, `restart_modules`, `turn_end`

Session history is not bounded by the core, so it has finite practical life. Long-term memory must be externalized — to `MEMORY.md` in the character directory or a dedicated module — and a session that has grown large should be retired with `sessions.new.v1` / `sessions.switch.v1` rather than grown indefinitely. See [Session lifetime and memory](docs/spec.md#session-lifetime-and-memory).

### Message routing

The canonical delivery target is the source of the most recently consumed message from a replyable module. The core persists this as `last_replyable_target` so that events from non-replyable sources (for example, a timer module) still route LLM output to the last replyable module.

When the LLM calls `route_message`, it creates a transient override for the current processing cycle only. Subsequent free-form text in that cycle goes to the override target. When the cycle ends the override is discarded.

## Modules

A module is a standalone executable placed under `$JUSTCLAW_HOME/modules/{name}/`. Each module directory contains a `module.json` manifest and an entrypoint.

```
$JUSTCLAW_HOME/
  modules/
    {module-name}/
      module.json      # manifest
      {entrypoint}     # executable
      ...              # module-specific data and state
  skills/
    {skill-name}/
      SKILL.md         # YAML frontmatter (name, description) + Markdown instructions
      ...              # optional scripts, templates, reference files
  workspace/           # LLM workspace (rw); available via shell and edit tools
  history/             # session history files (ro inside workspace sandbox)
  character/           # agent identity files (rw inside workspace sandbox)
```

Modules can be written in any language. The wire protocol is NDJSON over stdin/stdout. See [docs/spec.md](docs/spec.md) for the full protocol reference.

### Manifest (module.json)

**daemon** — long-running process started when the core starts:

```json
{
  "name": "{module-name}",
  "exec": "{entrypoint}",
  "mode": "daemon",
  "replyable": true
}
```

**timer** — one-shot process spawned on a cron schedule:

```json
{
  "name": "{module-name}",
  "exec": "{entrypoint}",
  "mode": "timer",
  "cron": "0 9 * * 1-5"
}
```

| | daemon | timer |
|---|---|---|
| Lifecycle | Long-running | One-shot (spawn, emit, exit) |
| Startup | When core starts or `restart_modules` | Core spawns on cron match |
| Event emission | Any time | Before exit |
| Tool calls | Supported | Not supported (process does not stay running) |
| `replyable` field | Optional (default `false`) | Not applicable |

`replyable: true` allows the core to deliver `message.send.v1` notifications to the module and makes it eligible as the default routing target for LLM output.

### Cron expressions

Cron expressions are 5-field and evaluated in UTC.

### Sandbox

Each module runs inside a platform sandbox (`bwrap` on Linux, `sandbox-exec` on macOS). The sandbox grants read-write access to the module's own directory (`modules/{name}/`) and temp paths. Modules cannot access each other's directories or the workspace directly.

The `shell`, `create_file`, `edit_file`, and `delete_file` built-in tools run in a separate workspace sandbox that grants read-write access to the workspace, character, and modules directories, and read-only access to the history directory.

## Skills

The skills directory (`$JUSTCLAW_HOME/skills/` by default, `JUSTCLAW_SKILLS` to override) holds agent skills in the [Agent Skills](https://agentskills.io/) format: one subdirectory per skill containing a `SKILL.md` with YAML frontmatter (`name`, `description`) and Markdown instructions, plus optional scripts and reference files.

Before each turn the core scans the directory and injects a skill index (name + description) into the system prompt. Full instructions are not loaded automatically; the LLM reads a skill's `SKILL.md` when a task matches its description. The directory is read-write inside the workspace sandbox, so the agent can create and edit its own skills; changes take effect on the next turn.

See [Skills directory](docs/spec.md#skills-directory) in the spec for details.

## Examples

- **[cli-chat](examples/cli-chat/)** — daemon module; local terminal chat via a Unix socket
- **[daily](examples/daily/)** — timer module; fires on a cron schedule and asks the LLM to write a daily log entry

## Protocol

The full wire protocol — methods, message formats, lifecycle diagrams, event types, session management, built-in tools, and routing rules — is in [docs/spec.md](docs/spec.md).
