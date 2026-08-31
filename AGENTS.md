# AGENTS.md

Instructions for AI agents working on this project.

## Project

justclaw is an event-driven AI agent framework. Read `README.md` for the architecture overview and `docs/spec.md` for the wire protocol.

## Design Principles

These principles are non-negotiable. When proposing changes, check them against this list.

### Defer complexity (YAGNI)

Do not add features, fields, mechanisms, or abstractions until they are concretely needed. The current design intentionally omits many things (permission systems, event schemas, delivery guarantees, dependency graphs, versioning, etc.). These omissions are deliberate, not oversights. Adding them speculatively is a regression.

If something is missing, the first question is whether it actually needs to exist — not how to build it.

### Mechanism, not policy

The core provides mechanisms (event bus, LLM queue, process spawning, message routing). Modules decide policies (retry strategies, persistence, formatting, error handling). Do not pull policy decisions into the core.

### LLMs tolerate ambiguity

LLMs handle loosely-structured, unspecified, or partially-typed input without needing schemas or validation. Take advantage of this: do not impose strict types or schemas on data whose only consumer is the LLM. Free-form JSON converted to XML is sufficient for LLM-bound data.

Strict typing and validation belong only at boundaries where machine code consumes the data, because machine code does not tolerate ambiguity.

### Unix philosophy

Small core. Composable modules. Text-based protocols. One responsibility per module. Standard I/O. Failure isolation through process boundaries.

### Document rationale for complexity

If a design introduces non-obvious state, special cases, or clever behavior, the *why* must be written next to the *what*. The reader should not have to guess why the complexity exists. A rule without rationale is a future bug — someone will simplify it without understanding what it was protecting against.

### Use established standards

Prefer JSON-RPC, NDJSON, cron, XML, bwrap, and other battle-tested formats over custom inventions. Inventing protocols or formats is a last resort.

## When Proposing Changes

- **Question premises before suggesting solutions.** If a proposal feels complex, the framing may be wrong. Look for a simpler invariant or reframing first. (Example: "track triggering event + update on tool call" became "the destination of the most recently consumed message" — same behavior, simpler concept.)
- **Identify what is essential vs. incidental.** Many proposals carry incidental complexity that can be dropped without losing the essential property.
- **Surface tradeoffs explicitly.** Do not hide costs. If a choice has downsides, name them.
- **Resist scope creep.** A bug fix is a bug fix. A feature is a feature. Do not bundle "improvements" into unrelated work.

## Documentation Style

- All documentation is written in English. This includes `README.md`, `docs/spec.md`, `AGENTS.md`, and any future docs.
- Concrete examples over abstract descriptions.
- Tables when comparing options or showing field definitions.
- ASCII diagrams for protocol flows.
- No emojis.
- No forward-looking statements ("in the future we might...") unless the user explicitly asks for them. Current state only.
- No marketing language. State what things do, not how good they are.

## Communication Style

- Be direct. Skip preamble and filler. Lead with the answer.
- Do not flatter. Do not say "great question" or "excellent point."
- When the user asks for an evaluation, give an honest one with specific evidence, not generic praise.
- When you disagree, say so and explain why. Agreement by default is a failure mode.
- Ask focused clarifying questions when the design space is genuinely ambiguous. Do not ask questions you can answer yourself.

## Code Conventions

- Runtime: Bun.
- Modules are spawned as subprocesses; communication is via stdin/stdout NDJSON.
- Core is minimal. New functionality should default to being a module unless there is a clear reason to live in the core.
- Match the existing structure of `modules/{name}/`.

## Commits

- **Subject line only.** Imperative mood, capitalized, no trailing period, no type prefix (`feat:`, `fix:`). Check `git log`: essentially every commit here is one line.
- **No body.** Rationale about code belongs in a comment next to the code, and protocol rationale belongs in `docs/spec.md`; a commit body duplicates it somewhere nobody reads while working. Write one only when the rationale has nowhere else to live — a dependency upgrade is the case that has come up.
- **No trailers.** No `Co-Authored-By`, no generator attribution.
- Branch names: `feat/{topic}`, `refactor/{topic}`.

## Dependencies

Do not add dependencies unless absolutely necessary. Fewer dependencies means less surface area, less supply-chain risk, faster installs, and easier upgrades.

Bun and `@openai/agents` together cover the vast majority of needs:

- **Bun** provides the runtime, file I/O, subprocess spawning, HTTP, SQLite, testing, bundling, and many standard utilities out of the box.
- **`@openai/agents`** provides the agent loop, tool calling, and model integration. See the summary below.

Before adding any new package, check whether the functionality is already available in Bun or `@openai/agents`. If it is, use that instead. If you genuinely need a new dependency, justify it explicitly.

### `@openai/agents` summary

A TypeScript SDK from OpenAI for building LLM-based agents. Despite the name, it supports custom model providers via a `Model` abstraction, so it is not limited to OpenAI models.

**What it covers:**

- Agent loop (call LLM → decide tool → execute → feed result back → repeat)
- Tool calling, including parallel execution
- Function tools, computer use, code interpreter
- Streaming via async iterators
- Structured output (JSON Schema)
- Multi-agent handoffs
- Input/output guardrails
- Session/conversation history management
- Token usage tracking
- Typed errors (`ToolCallError`, `GuardrailExecutionError`, `MaxTurnsExceededError`, etc.)
- Tracing with spans and exporters

**Model providers:**

- OpenAI (Chat Completions and Responses APIs) as first-class
- Custom providers via `setDefaultModelProvider()`

**Runtime:** Built on Node standard APIs. Bun compatibility is not officially documented but generally expected to work; verify before relying on edge features.

**Documentation:** https://openai.github.io/openai-agents-js/
