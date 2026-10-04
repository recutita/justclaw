import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
	Agent,
	AgentInputItem,
	Model,
	ModelRequest,
	ModelResponse,
	Runner,
} from "@openai/agents";
import type { FunctionTool } from "@openai/agents-core";
import { RunContext } from "@openai/agents-core";
import { EventQueue, timestampFromUUIDv7 } from "./event-queue";
import {
	assistantText,
	downscaleImage,
	dropReasoningItems,
	leadingMessages,
	ObservedModel,
	resolveDropReasoningHistory,
	resolveInputModalities,
	resolveModelTimeoutMs,
	resolveToolTimeoutMs,
	runLlmLoop,
	sanitizeHistoryForStorage,
} from "./llm-loop";
import { type StartedDaemon, stopDaemons } from "./runtime";
import { buildRuntimeInstructions } from "./runtime-prompt";
import { SessionStore } from "./session-store";

const hasBwrap = Boolean(Bun.which("bwrap"));
// attach_image/attach_file read through the workspace sandbox, so only run
// those integration checks when the platform sandbox backend is available.
const hasSandbox =
	hasBwrap ||
	(process.platform === "darwin" && Boolean(Bun.which("sandbox-exec")));

const tempDirs: string[] = [];
const originalOpenAIAPI = process.env.JUSTCLAW_OPENAI_API;
const originalDropReasoning = process.env.JUSTCLAW_DROP_REASONING_HISTORY;
const originalInputModalities = process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES;
const originalModelTimeout = process.env.JUSTCLAW_MODEL_TIMEOUT;
const originalToolTimeout = process.env.JUSTCLAW_TOOL_TIMEOUT;

afterEach(async () => {
	if (originalOpenAIAPI === undefined) {
		delete process.env.JUSTCLAW_OPENAI_API;
	} else {
		process.env.JUSTCLAW_OPENAI_API = originalOpenAIAPI;
	}
	if (originalDropReasoning === undefined) {
		delete process.env.JUSTCLAW_DROP_REASONING_HISTORY;
	} else {
		process.env.JUSTCLAW_DROP_REASONING_HISTORY = originalDropReasoning;
	}
	if (originalInputModalities === undefined) {
		delete process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES;
	} else {
		process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES = originalInputModalities;
	}
	if (originalModelTimeout === undefined) {
		delete process.env.JUSTCLAW_MODEL_TIMEOUT;
	} else {
		process.env.JUSTCLAW_MODEL_TIMEOUT = originalModelTimeout;
	}
	if (originalToolTimeout === undefined) {
		delete process.env.JUSTCLAW_TOOL_TIMEOUT;
	} else {
		process.env.JUSTCLAW_TOOL_TIMEOUT = originalToolTimeout;
	}
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function waitUntil(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 1000,
): Promise<void> {
	const started = Date.now();
	while (!(await condition())) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("condition timed out");
		}
		await delay(10);
	}
}

async function waitForQueueEmpty(dbPath: string): Promise<void> {
	const db = new Database(dbPath);
	try {
		await waitUntil(() => {
			const row = db.query("SELECT count(*) AS n FROM events").get() as {
				n: number;
			};
			return row.n === 0;
		});
	} finally {
		db.close();
	}
}

function findFunctionTool(agent: Agent, name: string): FunctionTool {
	const found = agent.tools?.find(
		(t): t is FunctionTool => t.type === "function" && t.name === name,
	);
	if (!found) {
		throw new Error(`tool ${name} not found on agent`);
	}
	return found;
}

// A model whose every response is one assistant message with `text`,
// followed by `extra` output items (a tool call, say).
function fakeModel(text: string, extra: unknown[] = []): Model {
	return {
		getResponse: async () =>
			({
				output: [
					{
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text }],
					},
					...extra,
				],
			}) as unknown as ModelResponse,
		getStreamedResponse: async function* () {},
	} as unknown as Model;
}

// Sequential responses, one assistant message each. Used to test a run that
// writes text, calls a tool, then writes text again.
function fakeModelQueue(texts: string[]): Model {
	let i = 0;
	return {
		getResponse: async () => {
			const text = texts[Math.min(i, texts.length - 1)] ?? "";
			i++;
			return {
				output: [
					{
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text }],
					},
				],
			} as unknown as ModelResponse;
		},
		getStreamedResponse: async function* () {},
	} as unknown as Model;
}

// One model call, the way the SDK makes it for each turn of a run.
async function callModel(agent: Agent): Promise<ModelResponse> {
	return (agent.model as Model).getResponse({
		input: [],
	} as unknown as ModelRequest);
}

describe("SessionStore", () => {
	test("list returns empty array for empty directory", async () => {
		const home = await createTempDir("justclaw-store-");
		const store = new SessionStore(path.join(home, "history"));
		expect(store.list()).toEqual([]);
	});

	test("list returns saved session ids sorted lexicographically", async () => {
		const home = await createTempDir("justclaw-store-");
		const store = new SessionStore(path.join(home, "history"));
		const idB = "01900000-0000-7000-8000-0000000000bb";
		const idA = "01900000-0000-7000-8000-0000000000aa";
		await store.save(idB, []);
		await store.save(idA, []);
		expect(store.list()).toEqual([idA, idB]);
	});

	test("load, save, and delete reject non-UUID session ids", async () => {
		const home = await createTempDir("justclaw-store-");
		const store = new SessionStore(path.join(home, "history"));
		await expect(store.save("not-a-uuid", [])).rejects.toThrow(
			/invalid session id/,
		);
		await expect(store.load("not-a-uuid")).rejects.toThrow(
			/invalid session id/,
		);
		await expect(store.delete("not-a-uuid")).rejects.toThrow(
			/invalid session id/,
		);
	});

	test("load returns null when file missing", async () => {
		const home = await createTempDir("justclaw-store-");
		const store = new SessionStore(path.join(home, "history"));
		const id = "01900000-0000-7000-8000-00000000aaaa";
		expect(await store.load(id)).toBeNull();
	});

	test("load returns [] for empty session file", async () => {
		const home = await createTempDir("justclaw-store-");
		const store = new SessionStore(path.join(home, "history"));
		const id = "01900000-0000-7000-8000-00000000cccc";
		await store.create(id);
		expect(await store.load(id)).toEqual([]);
	});

	test("load returns history when file has content", async () => {
		const home = await createTempDir("justclaw-store-");
		const store = new SessionStore(path.join(home, "history"));
		const id = "01900000-0000-7000-8000-00000000bbbb";
		await store.save(id, [{ role: "user", content: "x" } as AgentInputItem]);
		expect(await store.load(id)).toEqual([{ role: "user", content: "x" }]);
	});

	test("list ignores non-UUID json filenames such as notes.json", async () => {
		const home = await createTempDir("justclaw-store-");
		const historyPath = path.join(home, "history");
		await mkdir(historyPath, { recursive: true });
		await Bun.write(path.join(historyPath, "notes.json"), "{}");
		const id = "01900000-0000-7000-8000-00000000aaaa";
		const store = new SessionStore(historyPath);
		await store.save(id, []);
		expect(store.list()).toEqual([id]);
	});

	test("newestReadableSessionId is null when only non-UUID json files exist", async () => {
		const home = await createTempDir("justclaw-store-");
		const historyPath = path.join(home, "history");
		await mkdir(historyPath, { recursive: true });
		await Bun.write(path.join(historyPath, "notes.json"), "[]");
		const store = new SessionStore(historyPath);
		expect(store.list()).toEqual([]);
		expect(store.newestReadableSessionId()).toBeNull();
	});

	test("load returns null when UUID session file has invalid JSON", async () => {
		const home = await createTempDir("justclaw-store-");
		const historyPath = path.join(home, "history");
		const id = "01900000-0000-7000-8000-00000000dddd";
		await mkdir(historyPath, { recursive: true });
		await Bun.write(path.join(historyPath, `${id}.json`), "not json");
		const store = new SessionStore(historyPath);
		expect(await store.load(id)).toBeNull();
	});

	test("list excludes unreadable UUID session files", async () => {
		const home = await createTempDir("justclaw-store-");
		const historyPath = path.join(home, "history");
		const readable = "01900000-0000-7000-8000-00000000aaaa";
		const unreadable = "01900000-0000-7000-8000-00000000aaab";
		const store = new SessionStore(historyPath);
		await store.save(readable, []);
		await mkdir(historyPath, { recursive: true });
		await Bun.write(path.join(historyPath, `${unreadable}.json`), "{");
		expect(store.list()).toEqual([readable]);
	});

	test("newestReadableSessionId is null when empty, else lexicographic max", async () => {
		const home = await createTempDir("justclaw-store-");
		const store = new SessionStore(path.join(home, "history"));
		expect(store.newestReadableSessionId()).toBeNull();
		await store.save("01900000-0000-7000-8000-000000000001", []);
		await store.save("01900000-0000-7000-8000-000000000002", []);
		expect(store.newestReadableSessionId()).toBe(
			"01900000-0000-7000-8000-000000000002",
		);
	});

	test("newestReadableSessionId skips unreadable newest file", async () => {
		const home = await createTempDir("justclaw-store-");
		const historyPath = path.join(home, "history");
		const store = new SessionStore(historyPath);
		const readable = "01900000-0000-7000-8000-000000000001";
		const unreadableNewest = "01900000-0000-7000-8000-000000000002";
		await store.save(readable, []);
		await mkdir(historyPath, { recursive: true });
		await Bun.write(path.join(historyPath, `${unreadableNewest}.json`), "{");
		expect(store.newestReadableSessionId()).toBe(readable);
	});

	test("create writes empty history file, lists, and exists", async () => {
		const home = await createTempDir("justclaw-store-");
		const historyPath = path.join(home, "history");
		const store = new SessionStore(historyPath);
		const id = "01900000-0000-7000-8000-00000000feed";
		await store.create(id);
		expect(await store.load(id)).not.toBeNull();
		expect(store.list()).toContain(id);
		expect(await Bun.file(path.join(historyPath, `${id}.json`)).text()).toBe(
			"[]",
		);
	});

	test("create rejects non-UUID session id", async () => {
		const home = await createTempDir("justclaw-store-");
		const store = new SessionStore(path.join(home, "history"));
		await expect(store.create("not-a-uuid")).rejects.toThrow(
			/invalid session id/,
		);
	});

	test("ensureDefaultSessionIfEmpty creates history dir and one session when absent", async () => {
		const home = await createTempDir("justclaw-store-");
		const historyPath = path.join(home, "history");
		const store = new SessionStore(historyPath);
		await store.ensureDefaultSessionIfEmpty();
		const ids = store.list();
		expect(ids.length).toBe(1);
		expect(ids[0]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		expect(
			await Bun.file(path.join(historyPath, `${ids[0]}.json`)).text(),
		).toBe("[]");
	});

	test("ensureDefaultSessionIfEmpty is a no-op when sessions already exist", async () => {
		const home = await createTempDir("justclaw-store-");
		const store = new SessionStore(path.join(home, "history"));
		const existing = "01900000-0000-7000-8000-000000000001";
		await store.create(existing);
		await store.ensureDefaultSessionIfEmpty();
		expect(store.list()).toEqual([existing]);
	});
});

describe("downscaleImage", () => {
	const tinyPngBase64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

	test("keeps images within the max dimensions unchanged", async () => {
		const original = Buffer.from(tinyPngBase64, "base64");

		const result = await downscaleImage(original, "image/png");

		expect(result.mediaType).toBe("image/png");
		expect(result.data).toEqual(original);
	});

	test("normalizes oversized decodable images to JPEG", async () => {
		const original = await new Bun.Image(Buffer.from(tinyPngBase64, "base64"))
			.resize(3000, 3000)
			.png()
			.bytes();

		const result = await downscaleImage(original, "image/png");
		const metadata = await new Bun.Image(result.data).metadata();

		expect(result.mediaType).toBe("image/jpeg");
		expect(result.data[0]).toBe(0xff);
		expect(result.data[1]).toBe(0xd8);
		expect(metadata.width).toBe(2048);
		expect(metadata.height).toBe(2048);
	});

	test("falls back to the original bytes when decode fails", async () => {
		const original = Buffer.alloc(600 * 1024, 1);
		const originalConsoleError = console.error;
		console.error = () => {};
		try {
			const result = await downscaleImage(original, "image/png");

			expect(result.mediaType).toBe("image/png");
			expect(result.data).toEqual(original);
		} finally {
			console.error = originalConsoleError;
		}
	});
});

describe("resolveDropReasoningHistory", () => {
	test("defaults to keeping reasoning when unset or empty", () => {
		delete process.env.JUSTCLAW_DROP_REASONING_HISTORY;
		expect(resolveDropReasoningHistory()).toBe(false);
		process.env.JUSTCLAW_DROP_REASONING_HISTORY = "";
		expect(resolveDropReasoningHistory()).toBe(false);
	});

	test("parses 0 and 1", () => {
		process.env.JUSTCLAW_DROP_REASONING_HISTORY = "0";
		expect(resolveDropReasoningHistory()).toBe(false);
		process.env.JUSTCLAW_DROP_REASONING_HISTORY = "1";
		expect(resolveDropReasoningHistory()).toBe(true);
	});

	test("rejects anything else", () => {
		for (const raw of ["true", "yes", "2", "01"]) {
			process.env.JUSTCLAW_DROP_REASONING_HISTORY = raw;
			expect(() => resolveDropReasoningHistory()).toThrow(
				'JUSTCLAW_DROP_REASONING_HISTORY must be "0" or "1"',
			);
		}
	});
});

describe("timeout resolvers", () => {
	test("default to 10 minutes for the model and 60 seconds for module tools", () => {
		delete process.env.JUSTCLAW_MODEL_TIMEOUT;
		delete process.env.JUSTCLAW_TOOL_TIMEOUT;
		expect(resolveModelTimeoutMs()).toBe(600_000);
		expect(resolveToolTimeoutMs()).toBe(60_000);
		process.env.JUSTCLAW_MODEL_TIMEOUT = "";
		process.env.JUSTCLAW_TOOL_TIMEOUT = "";
		expect(resolveModelTimeoutMs()).toBe(600_000);
		expect(resolveToolTimeoutMs()).toBe(60_000);
	});

	test("read whole seconds and convert to milliseconds", () => {
		process.env.JUSTCLAW_MODEL_TIMEOUT = "90";
		process.env.JUSTCLAW_TOOL_TIMEOUT = "5";
		expect(resolveModelTimeoutMs()).toBe(90_000);
		expect(resolveToolTimeoutMs()).toBe(5_000);
	});

	test("treat 0 as no bound", () => {
		process.env.JUSTCLAW_MODEL_TIMEOUT = "0";
		process.env.JUSTCLAW_TOOL_TIMEOUT = "0";
		expect(resolveModelTimeoutMs()).toBe(0);
		expect(resolveToolTimeoutMs()).toBe(0);
	});

	test("reject non-integer and negative values", () => {
		for (const raw of ["abc", "-1", "1.5", "60s"]) {
			process.env.JUSTCLAW_MODEL_TIMEOUT = raw;
			expect(() => resolveModelTimeoutMs()).toThrow(
				"JUSTCLAW_MODEL_TIMEOUT must be a non-negative integer number of seconds",
			);
			process.env.JUSTCLAW_TOOL_TIMEOUT = raw;
			expect(() => resolveToolTimeoutMs()).toThrow(
				"JUSTCLAW_TOOL_TIMEOUT must be a non-negative integer number of seconds",
			);
		}
	});
});

describe("dropReasoningItems", () => {
	test("removes only reasoning items and preserves order", () => {
		const history = [
			{ role: "user", content: "a" },
			{ type: "reasoning", content: [{ type: "reasoning_text", text: "r" }] },
			{ role: "assistant", content: [{ type: "output_text", text: "b" }] },
		] as unknown as AgentInputItem[];

		expect(dropReasoningItems(history)).toEqual([
			history[0],
			history[2],
		] as AgentInputItem[]);
	});

	test("leaves a history without reasoning untouched", () => {
		const history = [{ role: "user", content: "a" }] as AgentInputItem[];
		expect(dropReasoningItems(history)).toEqual(history);
	});
});

describe("assistantText", () => {
	test("joins assistant text in order and skips everything else", () => {
		const items = [
			{ role: "user", content: "hi" },
			{ type: "reasoning", content: [{ type: "reasoning_text", text: "r" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "\n\nfirst" }],
			},
			{ type: "function_call", name: "memory__remember", arguments: "{}" },
			{ role: "assistant", content: [{ type: "output_text", text: "  " }] },
			{ role: "assistant", content: [{ type: "output_text", text: "second" }] },
		];
		expect(assistantText(items)).toBe("first\n\nsecond");
	});

	test("is empty when the items carry no assistant text", () => {
		expect(assistantText([{ type: "function_call", name: "turn_end" }])).toBe(
			"",
		);
	});
});

describe("leadingMessages", () => {
	const reasoning = { type: "reasoning", content: [] };
	const message = {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text: "reply" }],
	};
	const call = { type: "function_call", callId: "c1", name: "shell" };
	const leading = (items: unknown[]): unknown[] =>
		leadingMessages(items as AgentInputItem[]);

	test("keeps reasoning and messages before the first tool call", () => {
		expect(leading([reasoning, message, call])).toEqual([reasoning, message]);
	});

	test("drops reasoning left without the item that followed it", () => {
		expect(leading([reasoning, call])).toEqual([]);
		expect(leading([message, reasoning, call])).toEqual([message]);
	});

	test("keeps nothing after the first tool call", () => {
		expect(leading([call, message])).toEqual([]);
	});

	test("keeps the whole output of a response without tool calls", () => {
		expect(leading([reasoning, message])).toEqual([reasoning, message]);
	});
});

describe("ObservedModel", () => {
	test("runs onResponse with the input and output, then delivers the text", async () => {
		const events: string[] = [];
		const inner = {
			getResponse: async () => {
				events.push("model");
				return (await fakeModel("reply", [
					{ type: "function_call", name: "memory__remember", arguments: "{}" },
				]).getResponse({} as ModelRequest)) as ModelResponse;
			},
		} as unknown as Model;
		const model = new ObservedModel(
			async () => inner,
			async (input, output) => {
				events.push(`response:${JSON.stringify(input)}:${output.length}`);
			},
			(text) => {
				events.push(`deliver:${text}`);
			},
		);

		const response = await model.getResponse({
			input: [{ role: "user", content: "hi" }],
		} as unknown as ModelRequest);

		expect(events).toEqual([
			"model",
			'response:[{"role":"user","content":"hi"}]:2',
			"deliver:reply",
		]);
		expect(response.output).toHaveLength(2);
	});

	test("neither saves nor delivers when the model call fails", async () => {
		const events: string[] = [];
		const inner = {
			getResponse: async () => {
				throw new Error("400 context length exceeded");
			},
		} as unknown as Model;
		const model = new ObservedModel(
			async () => inner,
			async () => {
				events.push("response");
			},
			() => {
				events.push("deliver");
			},
		);

		await expect(
			model.getResponse({ input: [] } as unknown as ModelRequest),
		).rejects.toThrow("400");
		expect(events).toEqual([]);
	});

	test("delivers nothing for a response with only tool calls", async () => {
		const delivered: string[] = [];
		const inner = {
			getResponse: async () =>
				({
					output: [
						{ type: "function_call", name: "turn_end", arguments: "{}" },
					],
				}) as unknown as ModelResponse,
		} as unknown as Model;
		const model = new ObservedModel(
			async () => inner,
			async () => {},
			(text) => delivered.push(text),
		);

		await model.getResponse({ input: [] } as unknown as ModelRequest);

		expect(delivered).toEqual([]);
	});
});

describe("resolveInputModalities", () => {
	test("defaults to every modality when unset or empty", () => {
		delete process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES;
		expect([...resolveInputModalities()].sort()).toEqual([
			"audio",
			"file",
			"image",
		]);
		process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES = "  ";
		expect(resolveInputModalities().size).toBe(3);
	});

	test("parses a comma-separated subset", () => {
		process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES = "image, audio";
		const modalities = resolveInputModalities();
		expect(modalities.has("image")).toBe(true);
		expect(modalities.has("audio")).toBe(true);
		expect(modalities.has("file")).toBe(false);
	});

	test('"none" disables every modality', () => {
		process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES = "none";
		expect(resolveInputModalities().size).toBe(0);
	});

	test("rejects an unknown modality", () => {
		process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES = "image,video";
		expect(() => resolveInputModalities()).toThrow(
			/JUSTCLAW_OPENAI_INPUT_MODALITIES/,
		);
	});

	test("rejects a value that names no modality", () => {
		process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES = ",,";
		expect(() => resolveInputModalities()).toThrow(/use "none"/);
	});
});

describe("runLlmLoop", () => {
	test("sessions.switch.v1 is skipped with event.dropped when target file missing at apply time", async () => {
		const home = await createTempDir("justclaw-llm-switch-missing-");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		const missingId = "01900000-0000-7000-8000-00000000dead";

		const dropped: unknown[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod" },
				tools: [],
				peer: {
					notify: (method: string, params: unknown) => {
						if (method === "event") dropped.push(params);
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "sessions.switch.v1", id: missingId });

		const mockRunner = {
			run: async () => ({ finalOutput: null, history: [] }),
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});
		await delay(50);
		expect(queue.getMeta("active_session_id")).toBeNull();
		queue.close();
		await loopTask;

		console.error("DROPPEDDBG", JSON.stringify(dropped));
		expect(dropped.length).toBe(1);
		expect((dropped[0] as { type?: string }).type).toBe("event.dropped.v1");
	});

	test("reloads character files into the agent system prompt each turn", async () => {
		const home = await createTempDir("justclaw-llm-ctx-");
		const characterDir = path.join(home, "character");
		await mkdir(characterDir, { recursive: true });
		await Bun.write(path.join(characterDir, "AGENTS.md"), "CONTEXT_BLOCK");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		await sessionStore.ensureDefaultSessionIfEmpty();

		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		let capturedAgent: { instructions?: string } | undefined;
		const mockRunner = {
			run: async (agent: unknown) => {
				capturedAgent = agent as { instructions?: string };
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: "/tmp/hist",
			characterDir,
			modulesRoot: "/tmp/mods",
		});
		await delay(80);
		queue.close();
		await loopTask;

		expect(capturedAgent?.instructions).toBe(
			`<AGENTS.md>\nCONTEXT_BLOCK\n</AGENTS.md>\n\n${buildRuntimeInstructions({
				workspaceDir: "/tmp/ws",
				historyDir: "/tmp/hist",
				characterDir,
				modulesRoot: "/tmp/mods",
				modules: [],
				builtinTools: [
					"route_message",
					"restart_modules",
					"turn_end",
					"attach_image",
					"attach_file",
				],
			})}`,
		);
	});

	test("downscales image.send.v1 before building LLM input", async () => {
		const tinyPngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
		const imageData = Buffer.from(
			await new Bun.Image(Buffer.from(tinyPngBase64, "base64"))
				.resize(3000, 3000)
				.png()
				.bytes(),
		).toString("base64");
		const home = await createTempDir("justclaw-llm-image-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", {
			type: "image.send.v1",
			data: imageData,
			mediaType: "image/png",
		});

		let capturedInput: unknown;
		const mockRunner = {
			run: async (_agent: unknown, input: unknown) => {
				capturedInput = input;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
		});
		await waitForQueueEmpty(dbPath);
		queue.close();
		await loopTask;

		expect(Array.isArray(capturedInput)).toBe(true);
		const inputArr = capturedInput as AgentInputItem[];
		const userInput = inputArr[0] as {
			content: { type: string; text?: string; image?: string }[];
		};
		expect(userInput.content[0]?.text).toContain(
			"<mediaType>image/jpeg</mediaType>",
		);
		const image = userInput.content[1]?.image;
		expect(image?.startsWith("data:image/jpeg;base64,")).toBe(true);
		const outputBase64 = image?.replace("data:image/jpeg;base64,", "");
		const outputMetadata = await new Bun.Image(
			Buffer.from(outputBase64 ?? "", "base64"),
		).metadata();
		expect(outputMetadata.width).toBe(2048);
		expect(outputMetadata.height).toBe(2048);
	});

	test("builds audio.send.v1 as user audio input", async () => {
		const audioData = Buffer.from("audio-bytes").toString("base64");
		const home = await createTempDir("justclaw-llm-audio-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", {
			type: "audio.send.v1",
			data: audioData,
			mediaType: "audio/wav",
			format: "wav",
		});

		let capturedInput: unknown;
		const mockRunner = {
			run: async (_agent: unknown, input: unknown) => {
				capturedInput = input;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
		});
		await delay(80);
		queue.close();
		await loopTask;

		expect(Array.isArray(capturedInput)).toBe(true);
		const inputArr = capturedInput as AgentInputItem[];
		const userInput = inputArr[0] as {
			content: {
				type: string;
				text?: string;
				audio?: string;
				format?: string;
			}[];
		};
		expect(userInput.content[0]?.text).toContain("<format>wav</format>");
		expect(userInput.content[0]?.text).not.toContain(audioData);
		expect(userInput.content[1]).toEqual({
			type: "audio",
			audio: audioData,
			format: "wav",
		});
	});

	test("sends a disabled modality as text only, without the media part", async () => {
		process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES = "image";
		const fileData = Buffer.from("%PDF-1.4").toString("base64");
		const home = await createTempDir("justclaw-llm-modality-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", {
			type: "file.send.v1",
			data: fileData,
			mediaType: "application/pdf",
			filename: "report.pdf",
		});

		let capturedInput: unknown;
		const mockRunner = {
			run: async (_agent: unknown, input: unknown) => {
				capturedInput = input;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
		});
		await waitForQueueEmpty(dbPath);
		queue.close();
		await loopTask;

		const inputArr = capturedInput as AgentInputItem[];
		const userInput = inputArr[0] as { content: unknown };
		// The descriptive fields survive so the model knows what it could not see.
		expect(typeof userInput.content).toBe("string");
		expect(userInput.content as string).toContain(
			"<filename>report.pdf</filename>",
		);
		expect(userInput.content as string).not.toContain(fileData);
	});

	test("omits attach_file from the agent tools when file input is disabled", async () => {
		process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES = "image,audio";
		const home = await createTempDir("justclaw-llm-attach-omit-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "ping" });

		let toolNames: string[] = [];
		let instructions: unknown;
		const mockRunner = {
			run: async (agent: Agent) => {
				toolNames = (agent.tools ?? []).map((t) => t.name);
				instructions = agent.instructions;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			workspaceDir: "/tmp/ws",
			historyDir: "/tmp/hist",
			characterDir: home,
			modulesRoot: "/tmp/mods",
		});
		await waitForQueueEmpty(dbPath);
		queue.close();
		await loopTask;

		expect(toolNames).toContain("attach_image");
		expect(toolNames).not.toContain("attach_file");
		expect(instructions as string).toContain("attach_image");
		expect(instructions as string).not.toContain("attach_file");
	});

	test.skipIf(!hasSandbox)(
		"attach_image returns an image tool result in the current turn",
		async () => {
			process.env.JUSTCLAW_OPENAI_API = "responses";
			const tinyPngBase64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
			const home = await createTempDir("justclaw-attach-image-");
			const dbPath = path.join(home, "events.db");
			const imagePath = path.join(home, "pixel.png");
			const imageBytes = Buffer.from(tinyPngBase64, "base64");
			await Bun.write(imagePath, imageBytes);
			const queue = new EventQueue(dbPath);
			queue.enqueue("srcmod", { type: "event.v1", kind: "attach" });

			let toolResult: unknown;
			const rc = new RunContext();
			const mockRunner = {
				run: async (agent: Agent) => {
					toolResult = await findFunctionTool(agent, "attach_image").invoke(
						rc,
						JSON.stringify({ path: imagePath }),
					);
					return { finalOutput: null, history: [] };
				},
			} as unknown as Runner;

			const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
				runner: mockRunner,
				workspaceDir: home,
			});
			await waitForQueueEmpty(dbPath);
			queue.close();
			await loopTask;

			const sha256 = new Bun.CryptoHasher("sha256")
				.update(imageBytes)
				.digest("hex");
			expect(toolResult).toEqual({
				type: "image",
				image: {
					data: tinyPngBase64,
					mediaType: "image/png",
					size: imageBytes.byteLength,
					sha256,
					link: imagePath,
				},
				providerData: {
					justclaw: {
						metadata: {
							type: "image",
							mediaType: "image/png",
							size: imageBytes.byteLength,
							sha256,
							link: imagePath,
							attachable: true,
						},
					},
				},
			});
			const db = new Database(dbPath);
			try {
				const pendingCount = db
					.query("SELECT count(*) AS n FROM events")
					.get() as { n: number };
				expect(pendingCount.n).toBe(0);
			} finally {
				db.close();
			}
		},
	);

	test.skipIf(!hasSandbox)(
		"attach_file returns a file tool result in the current turn",
		async () => {
			process.env.JUSTCLAW_OPENAI_API = "responses";
			const home = await createTempDir("justclaw-attach-file-");
			const dbPath = path.join(home, "events.db");
			const filePath = path.join(home, "note.txt");
			const fileContent = "hello file\n";
			const fileBytes = Buffer.from(fileContent);
			await Bun.write(filePath, fileContent);
			const queue = new EventQueue(dbPath);
			queue.enqueue("srcmod", { type: "event.v1", kind: "attach" });

			let toolResult: unknown;
			const rc = new RunContext();
			const mockRunner = {
				run: async (agent: Agent) => {
					toolResult = await findFunctionTool(agent, "attach_file").invoke(
						rc,
						JSON.stringify({ path: filePath }),
					);
					return { finalOutput: null, history: [] };
				},
			} as unknown as Runner;

			const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
				runner: mockRunner,
				workspaceDir: home,
			});
			await waitForQueueEmpty(dbPath);
			queue.close();
			await loopTask;

			const sha256 = new Bun.CryptoHasher("sha256")
				.update(fileBytes)
				.digest("hex");
			expect(toolResult).toEqual({
				type: "file",
				file: {
					data: Buffer.from(fileContent).toString("base64"),
					mediaType: "text/plain",
					filename: "note.txt",
					size: fileBytes.byteLength,
					sha256,
					link: filePath,
				},
				providerData: {
					justclaw: {
						metadata: {
							type: "file",
							filename: "note.txt",
							mediaType: "text/plain",
							size: fileBytes.byteLength,
							sha256,
							link: filePath,
							attachable: true,
						},
					},
				},
			});
			const db = new Database(dbPath);
			try {
				const pendingCount = db
					.query("SELECT count(*) AS n FROM events")
					.get() as { n: number };
				expect(pendingCount.n).toBe(0);
			} finally {
				db.close();
			}
		},
	);

	test.skipIf(!hasSandbox)(
		"attach_image queues media for the next cycle in chat completions mode",
		async () => {
			process.env.JUSTCLAW_OPENAI_API = "chat_completions";
			const tinyPngBase64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
			const home = await createTempDir("justclaw-attach-image-delayed-");
			const dbPath = path.join(home, "events.db");
			const imagePath = path.join(home, "pixel.png");
			await Bun.write(imagePath, Buffer.from(tinyPngBase64, "base64"));
			const queue = new EventQueue(dbPath);
			queue.enqueue("srcmod", { type: "event.v1", kind: "attach" });

			let toolResult: unknown;
			let secondInput: unknown;
			let runCount = 0;
			const rc = new RunContext();
			const mockRunner = {
				run: async (agent: Agent, input: unknown) => {
					runCount += 1;
					if (runCount === 1) {
						toolResult = await findFunctionTool(agent, "attach_image").invoke(
							rc,
							JSON.stringify({ path: imagePath }),
						);
					} else {
						secondInput = input;
					}
					return { finalOutput: null, history: [] };
				},
			} as unknown as Runner;

			const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
				runner: mockRunner,
				workspaceDir: home,
			});
			await waitUntil(() => runCount >= 2);
			queue.close();
			await loopTask;

			expect(typeof toolResult).toBe("string");
			const delayed = JSON.parse(toolResult as string) as {
				type: string;
				delayed: boolean;
				image: { data?: string; mediaType?: string };
			};
			expect(delayed.type).toBe("image");
			expect(delayed.delayed).toBe(true);
			expect(delayed.image.data).toBeUndefined();
			expect(delayed.image.mediaType).toBe("image/png");

			expect(Array.isArray(secondInput)).toBe(true);
			const inputArr = secondInput as AgentInputItem[];
			const imageEvent = inputArr[0] as {
				role: string;
				content: Array<{ type: string; image?: string }>;
			};
			expect(imageEvent.content[1]).toEqual({
				type: "input_image",
				image: `data:image/png;base64,${tinyPngBase64}`,
			});
		},
	);

	test("sanitizes file and audio inputs but keeps image inputs before storing history", () => {
		const imageBytes = Buffer.from("image-bytes");
		const fileBytes = Buffer.from("file-bytes");
		const audioBytes = Buffer.from("audio-bytes");
		const imageSha = new Bun.CryptoHasher("sha256")
			.update(imageBytes)
			.digest("hex");
		const fileSha = new Bun.CryptoHasher("sha256")
			.update(fileBytes)
			.digest("hex");
		const audioSha = new Bun.CryptoHasher("sha256")
			.update(audioBytes)
			.digest("hex");
		const history = [
			{
				role: "user",
				content: [
					{
						type: "input_image",
						image: `data:image/png;base64,${imageBytes.toString("base64")}`,
					},
					{
						type: "input_file",
						file: `data:text/plain;base64,${fileBytes.toString("base64")}`,
						filename: "user-note.txt",
					},
					{
						type: "audio",
						audio: audioBytes.toString("base64"),
						format: "wav",
					},
				],
			},
			{
				type: "function_call_result",
				name: "mod__media",
				callId: "call-1",
				status: "completed",
				output: [
					{
						type: "input_image",
						image: `data:image/png;base64,${imageBytes.toString("base64")}`,
						providerData: {
							justclaw: {
								metadata: {
									type: "image",
									mediaType: "image/png",
									size: imageBytes.byteLength,
									sha256: imageSha,
									link: "/tmp/image.png",
									attachable: true,
								},
							},
						},
					},
					{
						type: "input_file",
						file: `data:text/plain;base64,${fileBytes.toString("base64")}`,
						filename: "note.txt",
						providerData: {
							justclaw: {
								metadata: {
									type: "file",
									filename: "note.txt",
									mediaType: "text/plain",
									size: fileBytes.byteLength,
									sha256: fileSha,
									link: "/tmp/note.txt",
									attachable: false,
								},
							},
						},
					},
				],
			},
		] as AgentInputItem[];

		const sanitized = sanitizeHistoryForStorage(history);
		expect(JSON.stringify(sanitized)).toContain(imageBytes.toString("base64"));
		expect(JSON.stringify(sanitized)).not.toContain(
			fileBytes.toString("base64"),
		);
		expect(JSON.stringify(sanitized)).not.toContain(
			audioBytes.toString("base64"),
		);
		expect(sanitized).toEqual([
			{
				role: "user",
				content: [
					{
						type: "input_image",
						image: `data:image/png;base64,${imageBytes.toString("base64")}`,
					},
					{
						type: "input_text",
						text: JSON.stringify({
							type: "file",
							file: {
								type: "file",
								filename: "user-note.txt",
								mediaType: "text/plain",
								size: fileBytes.byteLength,
								sha256: fileSha,
								attachable: false,
								omitted: "data",
							},
						}),
					},
					{
						type: "input_text",
						text: JSON.stringify({
							type: "audio",
							audio: {
								type: "audio",
								format: "wav",
								mediaType: "audio/wav",
								size: audioBytes.byteLength,
								sha256: audioSha,
								attachable: false,
								omitted: "data",
							},
						}),
					},
				],
			},
			{
				type: "function_call_result",
				name: "mod__media",
				callId: "call-1",
				status: "completed",
				output: [
					{
						type: "input_image",
						image: `data:image/png;base64,${imageBytes.toString("base64")}`,
						providerData: {
							justclaw: {
								metadata: {
									type: "image",
									mediaType: "image/png",
									size: imageBytes.byteLength,
									sha256: imageSha,
									link: "/tmp/image.png",
									attachable: true,
								},
							},
						},
					},
					{
						type: "input_text",
						text: JSON.stringify({
							type: "file",
							file: {
								type: "file",
								filename: "note.txt",
								mediaType: "text/plain",
								size: fileBytes.byteLength,
								sha256: fileSha,
								link: "/tmp/note.txt",
								attachable: false,
								omitted: "data",
							},
						}),
					},
				],
			},
		]);
	});

	test("skips LLM for sessions.switch.v1 and completes the event", async () => {
		const home = await createTempDir("justclaw-llm-session-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", {
			type: "sessions.switch.v1",
			id: "01900000-0000-7000-8000-00000000abcd",
		});

		let runnerCallCount = 0;
		const mockRunner = {
			run: async () => {
				runnerCallCount++;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
		});
		await delay(50);
		queue.close();
		await loopTask;

		expect(runnerCallCount).toBe(0);
	});

	test("drops non-event.v1 queue rows without calling LLM", async () => {
		const home = await createTempDir("justclaw-llm-drop-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "future.internal.v1", kind: "test" });

		let runnerCallCount = 0;
		const mockRunner = {
			run: async () => {
				runnerCallCount++;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
		});
		await delay(50);
		queue.close();
		await loopTask;

		expect(runnerCallCount).toBe(0);
	});

	test("loads history from switched-to session", async () => {
		const home = await createTempDir("justclaw-llm-session-");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		const savedHistory: AgentInputItem[] = [
			{ role: "user", content: "hello from session B" } as AgentInputItem,
		];
		const sessionB = "01900000-0000-7000-8000-0000000000bb";
		await sessionStore.save(sessionB, savedHistory);

		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "sessions.switch.v1", id: sessionB });
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		let capturedInput: unknown;
		const daemons = [
			{
				manifest: { name: "srcmod" },
				tools: [],
				peer: {
					notify: () => {},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const mockRunner = {
			run: async (_agent: unknown, input: unknown) => {
				capturedInput = input;
				return { finalOutput: null, history: savedHistory };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});

		// Wait until the runner has been called, then close the queue.
		for (let i = 0; i < 100; i++) {
			if (capturedInput !== undefined) break;
			await delay(10);
		}
		queue.close();
		await loopTask;

		expect(Array.isArray(capturedInput)).toBe(true);
		const inputArr = capturedInput as AgentInputItem[];
		expect(inputArr[0]).toMatchObject({
			role: "user",
			content: "hello from session B",
		});
	});

	test("drops failed sessions.switch.v1 when save throws and continues with next event", async () => {
		const home = await createTempDir("justclaw-llm-switch-save-throws-");
		const dbPath = path.join(home, "events.db");
		const baseStore = new SessionStore(path.join(home, "history"));
		const oldSession = "01900000-0000-7000-8000-0000000000aa";
		const targetSession = "01900000-0000-7000-8000-0000000000bb";
		await baseStore.save(oldSession, [
			{ role: "user", content: "old history" } as AgentInputItem,
		]);
		await baseStore.save(targetSession, []);

		let saveCalls = 0;
		const sessionStore = {
			newestReadableSessionId: () => oldSession,
			load: async (id: string) => baseStore.load(id),
			save: async (id: string, history: AgentInputItem[]) => {
				saveCalls++;
				if (id === oldSession && saveCalls === 2) {
					throw new Error("save exploded");
				}
				return baseStore.save(id, history);
			},
		} as SessionStore;

		const recorded: { method: string; params: unknown }[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod" },
				tools: [],
				peer: {
					notify: (method: string, p: unknown) => {
						recorded.push({ method, params: p });
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "prime" });
		queue.enqueue("srcmod", { type: "sessions.switch.v1", id: targetSession });
		queue.enqueue("srcmod", { type: "event.v1", kind: "after-switch-failure" });

		let runnerCallCount = 0;
		const mockRunner = {
			run: async () => {
				runnerCallCount++;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});

		for (let i = 0; i < 100; i += 1) {
			if (runnerCallCount >= 2 && recorded.length >= 1) break;
			await delay(10);
		}

		expect(queue.getMeta("active_session_id")).toBe(oldSession);
		queue.close();
		await loopTask;

		expect(runnerCallCount).toBe(2);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.method).toBe("event");
		expect((recorded[0]?.params as { type?: string }).type).toBe(
			"event.dropped.v1",
		);
	});

	test("adopts newest readable session id from history files", async () => {
		const home = await createTempDir("justclaw-llm-session-");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		const newer = "01900000-0000-7000-8000-000000000002";
		await sessionStore.save("01900000-0000-7000-8000-000000000001", []);
		await sessionStore.save(newer, []);
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		let runnerCallCount = 0;
		const mockRunner = {
			run: async () => {
				runnerCallCount++;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});
		await delay(80);
		expect(queue.getMeta("active_session_id")).toBe(newer);
		queue.close();
		await loopTask;

		expect(runnerCallCount).toBe(1);
	});

	test("adopts previous readable session when newest is unreadable", async () => {
		const home = await createTempDir("justclaw-llm-session-");
		const dbPath = path.join(home, "events.db");
		const historyPath = path.join(home, "history");
		const sessionStore = new SessionStore(historyPath);
		const olderReadable = "01900000-0000-7000-8000-000000000001";
		const newestUnreadable = "01900000-0000-7000-8000-000000000002";
		await sessionStore.save(olderReadable, []);
		await mkdir(historyPath, { recursive: true });
		await Bun.write(path.join(historyPath, `${newestUnreadable}.json`), "{");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		let runnerCallCount = 0;
		const mockRunner = {
			run: async () => {
				runnerCallCount++;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});
		await delay(80);
		expect(queue.getMeta("active_session_id")).toBe(olderReadable);
		queue.close();
		await loopTask;

		expect(runnerCallCount).toBe(1);
	});

	test("prefers meta active session id over newest fallback for initial adopt", async () => {
		const home = await createTempDir("justclaw-llm-session-");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		const metaActive = "01900000-0000-7000-8000-000000000001";
		const newest = "01900000-0000-7000-8000-000000000002";
		const metaHistory: AgentInputItem[] = [
			{ role: "user", content: "from-meta" } as AgentInputItem,
		];
		await sessionStore.save(metaActive, metaHistory);
		await sessionStore.save(newest, [] as never);
		const queue = new EventQueue(dbPath);
		queue.setMeta("active_session_id", metaActive);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		let capturedInput: unknown;
		const mockRunner = {
			run: async (_agent: unknown, input: unknown) => {
				capturedInput = input;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});
		await delay(80);
		expect(queue.getMeta("active_session_id")).toBe(metaActive);
		queue.close();
		await loopTask;

		expect(Array.isArray(capturedInput)).toBe(true);
		const inputArr = capturedInput as AgentInputItem[];
		expect(inputArr[0]).toMatchObject({
			role: "user",
			content: "from-meta",
		});
	});

	// Mirrors @openai/agents `getTurnInput`: the run's input verbatim, followed
	// by the items the run generated.
	function mockRunnerEchoing(
		generated: AgentInputItem[],
		capture: (input: unknown) => void,
	): Runner {
		return {
			run: async (_agent: unknown, input: unknown) => {
				capture(input);
				const asList =
					typeof input === "string"
						? [{ type: "message", role: "user", content: input }]
						: (input as AgentInputItem[]);
				return { finalOutput: null, history: [...asList, ...generated] };
			},
		} as unknown as Runner;
	}

	const seededReasoning = {
		type: "reasoning",
		id: "rs_seeded",
		content: [{ type: "reasoning_text", text: "past thinking" }],
	} as unknown as AgentInputItem;

	async function runWithSeededReasoning(): Promise<{
		capturedInput: AgentInputItem[];
		storedHistory: AgentInputItem[];
	}> {
		const home = await createTempDir("justclaw-llm-reasoning-");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		const sessionId = "01900000-0000-7000-8000-0000000000f1";
		await sessionStore.save(sessionId, [
			{ role: "user", content: "earlier" } as AgentInputItem,
			seededReasoning,
			{
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "earlier reply" }],
			} as AgentInputItem,
		]);
		const queue = new EventQueue(dbPath);
		queue.setMeta("active_session_id", sessionId);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		let capturedInput: unknown;
		const generatedReasoning = {
			type: "reasoning",
			id: "rs_new",
			content: [{ type: "reasoning_text", text: "new thinking" }],
		} as unknown as AgentInputItem;
		const runner = mockRunnerEchoing([generatedReasoning], (input) => {
			capturedInput = input;
		});

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner,
			sessionStore,
		});
		await waitForQueueEmpty(dbPath);
		queue.close();
		await loopTask;

		const storedHistory = await sessionStore.load(sessionId);
		if (storedHistory === null) {
			throw new Error("session history missing after run");
		}
		return { capturedInput: capturedInput as AgentInputItem[], storedHistory };
	}

	test("keeps reasoning history in model input by default", async () => {
		delete process.env.JUSTCLAW_DROP_REASONING_HISTORY;
		const { capturedInput, storedHistory } = await runWithSeededReasoning();

		expect(
			capturedInput
				.filter((i) => i.type === "reasoning")
				.map((i) => (i as { id?: string }).id),
		).toEqual(["rs_seeded"]);
		expect(storedHistory.filter((i) => i.type === "reasoning").length).toBe(2);
	});

	test("JUSTCLAW_DROP_REASONING_HISTORY=1 strips reasoning from model input but keeps it on disk", async () => {
		process.env.JUSTCLAW_DROP_REASONING_HISTORY = "1";
		const { capturedInput, storedHistory } = await runWithSeededReasoning();

		// The model never sees the previous event's reasoning...
		expect(capturedInput.filter((i) => i.type === "reasoning")).toEqual([]);
		expect(capturedInput.map((i) => i.type ?? "message")).toEqual([
			"message",
			"message",
			"message",
		]);

		// ...but the persisted audit trail still has it, alongside the reasoning
		// this run produced. Storing result.history directly would have dropped
		// the seeded item here.
		const storedReasoning = storedHistory.filter((i) => i.type === "reasoning");
		expect(storedReasoning.length).toBe(2);
		expect(storedReasoning[0]).toMatchObject({ id: "rs_seeded" });
		expect(storedReasoning[1]).toMatchObject({ id: "rs_new" });
		expect(storedHistory[0]).toMatchObject({ content: "earlier" });
	});

	test("falls back when meta active session id is invalid", async () => {
		const home = await createTempDir("justclaw-llm-session-");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		const invalidMeta = "not-a-uuid";
		const fallback = "01900000-0000-7000-8000-000000000002";
		await sessionStore.save(fallback, [] as never);
		const queue = new EventQueue(dbPath);
		queue.setMeta("active_session_id", invalidMeta);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		const mockRunner = {
			run: async () => ({ finalOutput: null, history: [] }),
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});
		await delay(80);
		expect(queue.getMeta("active_session_id")).toBe(fallback);
		queue.close();
		await loopTask;
	});

	test("does not recreate deleted active session at end of in-flight turn", async () => {
		const home = await createTempDir("justclaw-llm-no-resurrect-");
		const dbPath = path.join(home, "events.db");
		const historyPath = path.join(home, "history");
		const sessionStore = new SessionStore(historyPath);
		const activeId = "01900000-0000-7000-8000-0000000000aa";
		const sessionFilePath = path.join(historyPath, `${activeId}.json`);
		await sessionStore.save(activeId, [] as never);
		const queue = new EventQueue(dbPath);
		queue.setMeta("active_session_id", activeId);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		const mockRunner = {
			run: async () => {
				await sessionStore.delete(activeId);
				queue.deleteMeta("active_session_id");
				return {
					finalOutput: null,
					history: [
						{
							role: "assistant",
							content: "reply",
						} as unknown as AgentInputItem,
					],
				};
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});
		await delay(80);
		expect(queue.getMeta("active_session_id")).toBeNull();
		queue.close();
		await loopTask;

		expect(await Bun.file(sessionFilePath).exists()).toBe(false);
	});

	test("does not recreate deleted active session when switching away", async () => {
		const home = await createTempDir("justclaw-llm-switch-no-resurrect-");
		const dbPath = path.join(home, "events.db");
		const historyPath = path.join(home, "history");
		const sessionStore = new SessionStore(historyPath);
		const activeId = "01900000-0000-7000-8000-0000000000aa";
		const targetId = "01900000-0000-7000-8000-0000000000bb";
		const activePath = path.join(historyPath, `${activeId}.json`);
		await sessionStore.save(activeId, [
			{ role: "user", content: "from-active" } as AgentInputItem,
		]);
		await sessionStore.save(targetId, []);

		const queue = new EventQueue(dbPath);
		queue.setMeta("active_session_id", activeId);
		queue.enqueue("srcmod", { type: "event.v1", kind: "prime" });

		let runnerCallCount = 0;
		const mockRunner = {
			run: async () => {
				runnerCallCount++;
				return {
					finalOutput: null,
					history: [
						{
							role: "assistant",
							content: "reply",
						} as unknown as AgentInputItem,
					],
				};
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});

		for (let i = 0; i < 100; i += 1) {
			if (runnerCallCount >= 1) break;
			await delay(10);
		}

		await sessionStore.delete(activeId);
		queue.deleteMeta("active_session_id");
		queue.enqueue("srcmod", { type: "sessions.switch.v1", id: targetId });

		for (let i = 0; i < 100; i += 1) {
			if (queue.getMeta("active_session_id") === targetId) break;
			await delay(10);
		}

		const activeMeta = queue.getMeta("active_session_id");
		queue.close();
		await loopTask;

		expect(activeMeta).toBe(targetId);
		expect(await Bun.file(activePath).exists()).toBe(false);
	});

	test("updates meta active session id when switch is applied", async () => {
		const home = await createTempDir("justclaw-llm-switch-meta-");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		const targetSession = "01900000-0000-7000-8000-0000000000bb";
		await sessionStore.save(targetSession, [] as never);
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "sessions.switch.v1", id: targetSession });

		const mockRunner = {
			run: async () => ({ finalOutput: null, history: [] }),
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});
		await delay(50);
		expect(queue.getMeta("active_session_id")).toBe(targetSession);
		queue.close();
		await loopTask;
	});

	test("reloads session history when active metadata changes between events", async () => {
		const home = await createTempDir("justclaw-llm-meta-reload-");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		const firstSession = "01900000-0000-7000-8000-0000000000aa";
		const secondSession = "01900000-0000-7000-8000-0000000000bb";
		await sessionStore.save(firstSession, [
			{ role: "user", content: "from-first" } as AgentInputItem,
		]);
		await sessionStore.save(secondSession, [
			{ role: "user", content: "from-second" } as AgentInputItem,
		]);

		const queue = new EventQueue(dbPath);
		queue.setMeta("active_session_id", firstSession);
		queue.enqueue("srcmod", { type: "event.v1", kind: "first" });
		queue.enqueue("srcmod", { type: "event.v1", kind: "second" });

		const capturedInputs: unknown[] = [];
		const mockRunner = {
			run: async (_agent: unknown, input: unknown) => {
				capturedInputs.push(input);
				if (capturedInputs.length === 1) {
					queue.setMeta("active_session_id", secondSession);
				}
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});

		for (let i = 0; i < 100; i += 1) {
			if (capturedInputs.length === 2) break;
			await delay(10);
		}

		queue.close();
		await loopTask;

		expect(capturedInputs).toHaveLength(2);
		const firstInput = capturedInputs[0] as AgentInputItem[];
		const secondInput = capturedInputs[1] as AgentInputItem[];
		expect(Array.isArray(firstInput)).toBe(true);
		expect(Array.isArray(secondInput)).toBe(true);
		expect(firstInput[0]).toMatchObject({ content: "from-first" });
		expect(secondInput[0]).toMatchObject({ content: "from-second" });
	});

	test("does not adopt when the only UUID history file is unreadable", async () => {
		const home = await createTempDir("justclaw-llm-corrupt-adopt-");
		const dbPath = path.join(home, "events.db");
		const historyPath = path.join(home, "history");
		const sessionStore = new SessionStore(historyPath);
		const corruptId = "01900000-0000-7000-8000-000000000099";
		await mkdir(historyPath, { recursive: true });
		await Bun.write(path.join(historyPath, `${corruptId}.json`), "{");

		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		const recorded: { method: string; params: unknown }[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod" },
				tools: [],
				peer: {
					notify: (method: string, p: unknown) => {
						recorded.push({ method, params: p });
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const mockRunner = {
			run: async () => ({ finalOutput: null, history: [] }),
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});

		for (let i = 0; i < 50; i += 1) {
			if (recorded.length > 0) break;
			await delay(10);
		}

		expect(queue.getMeta("active_session_id")).toBeNull();
		queue.close();
		await loopTask;

		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.method).toBe("event");
		expect((recorded[0]?.params as { type?: string }).type).toBe(
			"event.dropped.v1",
		);
	});

	test("drops event when initial adopt throws and continues with later events", async () => {
		const home = await createTempDir("justclaw-llm-adopt-throws-");
		const dbPath = path.join(home, "events.db");
		const sessionId = "01900000-0000-7000-8000-0000000000cc";
		let callsToNewest = 0;
		const sessionStore = {
			newestReadableSessionId: () => {
				callsToNewest++;
				if (callsToNewest === 1) {
					throw new Error("newest failed");
				}
				return sessionId;
			},
			load: async (_id: string) => [],
			save: async () => {},
		} as unknown as SessionStore;

		const recorded: { method: string; params: unknown }[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod" },
				tools: [],
				peer: {
					notify: (method: string, p: unknown) => {
						recorded.push({ method, params: p });
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "first-fails-adopt" });
		queue.enqueue("srcmod", { type: "event.v1", kind: "second-continues" });

		let runnerCallCount = 0;
		const mockRunner = {
			run: async () => {
				runnerCallCount++;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});

		for (let i = 0; i < 100; i += 1) {
			if (runnerCallCount >= 1 && recorded.length >= 1) break;
			await delay(10);
		}

		expect(queue.getMeta("active_session_id")).toBe(sessionId);
		queue.close();
		await loopTask;

		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.method).toBe("event");
		expect((recorded[0]?.params as { type?: string }).type).toBe(
			"event.dropped.v1",
		);
		expect(runnerCallCount).toBe(1);
	});

	test("notifies event.dropped.v1 when session store is configured but no session can be adopted", async () => {
		const home = await createTempDir("justclaw-llm-session-");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		const queue = new EventQueue(dbPath);
		const params = { type: "event.v1" as const, kind: "test" };
		queue.enqueue("srcmod", params);

		const db = new Database(dbPath);
		const row = db
			.query("SELECT id FROM events WHERE state = 'pending'")
			.get() as { id: string };
		db.close();
		expect(row?.id).toBeDefined();

		let runnerCallCount = 0;
		const recorded: { method: string; params: unknown }[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod" },
				tools: [],
				peer: {
					notify: (method: string, p: unknown) => {
						recorded.push({ method, params: p });
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const mockRunner = {
			run: async () => {
				runnerCallCount++;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});

		for (let i = 0; i < 50; i += 1) {
			if (recorded.length > 0) break;
			await delay(10);
		}

		queue.close();
		await loopTask;

		expect(runnerCallCount).toBe(0);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.method).toBe("event");
		const payload = recorded[0]?.params as {
			type: string;
			source: string;
			timestamp: string;
			params: typeof params;
		};
		expect(payload.type).toBe("event.dropped.v1");
		expect(payload.source).toBe("srcmod");
		expect(payload.params).toEqual(params);
		expect(payload.timestamp).toBe(timestampFromUUIDv7(row.id));
	});

	test("notifies event.dropped.v1 when the runner throws", async () => {
		const home = await createTempDir("justclaw-llm-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		const params = { type: "event.v1" as const, kind: "test" };
		queue.enqueue("srcmod", params);

		const db = new Database(dbPath);
		const row = db
			.query("SELECT id FROM events WHERE state = 'pending'")
			.get() as { id: string };
		db.close();
		expect(row?.id).toBeDefined();

		const recorded: { method: string; params: unknown }[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod" },
				tools: [],
				peer: {
					notify: (method: string, p: unknown) => {
						recorded.push({ method, params: p });
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const mockRunner = {
			run: async () => {
				throw new Error("LLM failed");
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
		});

		for (let i = 0; i < 50; i += 1) {
			if (recorded.length > 0) {
				break;
			}
			await delay(10);
		}

		queue.close();
		await loopTask;

		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.method).toBe("event");
		const payload = recorded[0]?.params as {
			type: string;
			source: string;
			timestamp: string;
			params: typeof params;
		};
		expect(payload.type).toBe("event.dropped.v1");
		expect(payload.source).toBe("srcmod");
		expect(payload.params).toEqual(params);
		expect(payload.timestamp).toBe(timestampFromUUIDv7(row.id));
	});

	test("drops an event with an invalid XML key instead of killing the loop", async () => {
		const home = await createTempDir("justclaw-llm-badkey-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		// A leading-digit key is rejected by eventToXml; before the fix this threw
		// out of runLlmLoop before the per-event try block.
		queue.enqueue("srcmod", { type: "event.v1", "1bad": "x" });

		const recorded: { method: string; params: unknown }[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod" },
				tools: [],
				peer: {
					notify: (method: string, p: unknown) => {
						recorded.push({ method, params: p });
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		let runnerCallCount = 0;
		const mockRunner = {
			run: async () => {
				runnerCallCount++;
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
		});

		// The queued event is dropped and its row completed.
		await waitForQueueEmpty(dbPath);
		for (let i = 0; i < 50 && recorded.length < 1; i += 1) {
			await delay(10);
		}

		// An interrupt with an invalid key is dropped the same way.
		queue.setInterrupt("srcmod", { type: "event.v1", "2bad": "y" });
		for (let i = 0; i < 50 && recorded.length < 2; i += 1) {
			await delay(10);
		}

		queue.close();
		// The loop must resolve normally, not reject.
		await loopTask;

		expect(runnerCallCount).toBe(0);
		expect(recorded).toHaveLength(2);
		expect((recorded[0]?.params as { type?: string }).type).toBe(
			"event.dropped.v1",
		);
		expect((recorded[1]?.params as { type?: string }).type).toBe(
			"event.dropped.v1",
		);
	});

	test("aborts a hung module tool request so the run unwinds", async () => {
		const home = await createTempDir("justclaw-llm-hang-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("hangmod", { type: "event.v1", kind: "test" });

		const dropped: unknown[] = [];
		const daemons = [
			{
				manifest: { name: "hangmod", replyable: true },
				tools: [
					{
						name: "wait",
						parameters: { type: "object", properties: {} },
					},
				],
				peer: {
					// Never resolves: simulates a hung-but-alive module tool.
					request: () => new Promise(() => {}),
					notify: (method: string, params: unknown) => {
						if (method === "event") dropped.push(params);
					},
				},
			},
		] as unknown as StartedDaemon[];

		const abort = new AbortController();
		const rc = new RunContext();
		let toolInvoked = false;
		const mockRunner = {
			run: async (
				agent: Agent,
				_input: unknown,
				opts: { signal?: AbortSignal },
			) => {
				toolInvoked = true;
				// Without the abort race this invoke never resolves (the module tool
				// request hangs), so runner.run would block forever. With it, the
				// invoke unblocks when the signal fires, letting the run observe the
				// abort — modeled here the way the SDK aborts a run on its signal.
				await findFunctionTool(agent, "hangmod__wait").invoke(rc, "{}", {
					signal: opts.signal,
				});
				if (opts.signal?.aborted) {
					throw new Error("run aborted");
				}
				return { finalOutput: "unreachable", history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			abortSignal: abort.signal,
		});

		await waitUntil(() => toolInvoked);
		abort.abort();
		// Must resolve (not hang) once the abort unwinds the hung tool request.
		await loopTask;

		const droppedTypes = dropped.map((d) => (d as { type?: string }).type);
		expect(droppedTypes).toContain("event.dropped.v1");
		expect(droppedTypes).not.toContain("message.send.v1");
	});

	test("reports a module tool timeout as a tool result without failing the turn", async () => {
		process.env.JUSTCLAW_TOOL_TIMEOUT = "1";
		const home = await createTempDir("justclaw-llm-tool-timeout-");
		const queue = new EventQueue(path.join(home, "events.db"));
		queue.enqueue("slowmod", { type: "event.v1", kind: "test" });

		const notified: { type?: string; tool?: string; output?: string }[] = [];
		const daemons = [
			{
				manifest: { name: "slowmod", replyable: true },
				restartAttempts: 2,
				tools: [
					{ name: "wait", parameters: { type: "object", properties: {} } },
				],
				peer: {
					// Never resolves: the module is alive but unresponsive.
					request: () => new Promise(() => {}),
					notify: (method: string, params: unknown) => {
						if (method === "event") {
							notified.push(
								params as { type?: string; tool?: string; output?: string },
							);
						}
					},
				},
			},
		] as unknown as StartedDaemon[];

		const rc = new RunContext();
		let toolOutput: unknown;
		const mockRunner = {
			run: async (
				agent: Agent,
				_input: unknown,
				opts: { signal?: AbortSignal },
			) => {
				toolOutput = await findFunctionTool(agent, "slowmod__wait").invoke(
					rc,
					"{}",
					{ signal: opts.signal },
				);
				// The turn continues after the timeout and still produces a reply.
				await callModel(agent);
				return { finalOutput: "handled", history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			innerModel: fakeModel("handled"),
		});
		// The reply can only arrive after the 1s tool timeout, so the wait must
		// outlast it; the default 1s bound raced it.
		await waitUntil(
			() => notified.some((n) => n.type === "message.send.v1"),
			5000,
		);
		queue.close();
		await loopTask;

		expect(toolOutput).toBe("error: module did not respond within 1s");
		// The event is not dropped: the reply is delivered normally.
		const types = notified.map((n) => n.type);
		expect(types).toContain("message.send.v1");
		expect(types).not.toContain("event.dropped.v1");
		// The timed-out call is still reported to the delivery target.
		const toolCall = notified.find((n) => n.type === "tool_call.v1");
		expect(toolCall?.tool).toBe("slowmod__wait");
		expect(toolCall?.output).toContain("did not respond within 1s");
		// A module that only ever times out has not proved healthy.
		expect(
			(daemons[0] as unknown as { restartAttempts: number }).restartAttempts,
		).toBe(2);
	});

	test("delivers text written alongside a tool call as the response arrives, once", async () => {
		const home = await createTempDir("justclaw-llm-deliver-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		const sent: string[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod", replyable: true },
				tools: [],
				peer: {
					notify: (method: string, params: unknown) => {
						const p = params as { type?: string; text?: string };
						if (method === "event" && p.type === "message.send.v1") {
							sent.push(p.text ?? "");
						}
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		let sentDuringRun = -1;
		const mockRunner = {
			run: async (agent: Agent) => {
				// One response carrying the reply and a tool call; the run then
				// ends through turn_end, so finalOutput is empty.
				await callModel(agent);
				sentDuringRun = sent.length;
				return { finalOutput: "", history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			innerModel: fakeModel("reply", [
				{ type: "function_call", name: "turn_end", arguments: "{}" },
			]),
		});
		await waitForQueueEmpty(dbPath);
		queue.close();
		await loopTask;

		expect(sentDuringRun).toBe(1);
		expect(sent).toEqual(["reply"]);
	});

	test("does not send the same reply twice in one run", async () => {
		const home = await createTempDir("justclaw-llm-dedup-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		const sent: string[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod", replyable: true },
				tools: [],
				peer: {
					notify: (method: string, params: unknown) => {
						const p = params as { type?: string; text?: string };
						if (method === "event" && p.type === "message.send.v1") {
							sent.push(p.text ?? "");
						}
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const mockRunner = {
			run: async (agent: Agent) => {
				await callModel(agent);
				await callModel(agent);
				return { finalOutput: "", history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			innerModel: fakeModelQueue(["reply", "\n\nreply"]),
		});
		await waitForQueueEmpty(dbPath);
		queue.close();
		await loopTask;

		expect(sent).toEqual(["reply"]);
	});

	test("sends distinct replies from later responses in the same run", async () => {
		const home = await createTempDir("justclaw-llm-distinct-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		const sent: string[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod", replyable: true },
				tools: [],
				peer: {
					notify: (method: string, params: unknown) => {
						const p = params as { type?: string; text?: string };
						if (method === "event" && p.type === "message.send.v1") {
							sent.push(p.text ?? "");
						}
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const mockRunner = {
			run: async (agent: Agent) => {
				await callModel(agent);
				await callModel(agent);
				return { finalOutput: "", history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			innerModel: fakeModelQueue(["looking it up", "it is 3pm"]),
		});
		await waitForQueueEmpty(dbPath);
		queue.close();
		await loopTask;

		expect(sent).toEqual(["looking it up", "it is 3pm"]);
	});

	test("applies the model timeout to the agent", async () => {
		process.env.JUSTCLAW_MODEL_TIMEOUT = "42";
		const home = await createTempDir("justclaw-llm-model-timeout-");
		const queue = new EventQueue(path.join(home, "events.db"));
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		let seen: number | undefined;
		const mockRunner = {
			run: async (agent: Agent) => {
				seen = (agent as unknown as { modelSettings?: { timeoutMs?: number } })
					.modelSettings?.timeoutMs;
				return { finalOutput: "", history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
		});
		await waitUntil(() => seen !== undefined);
		queue.close();
		await loopTask;

		expect(seen).toBe(42_000);
	});

	test("resets restartAttempts after a module tool call resolves", async () => {
		const home = await createTempDir("justclaw-llm-tool-reset-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("pingmod", { type: "event.v1", kind: "test" });

		const daemon = {
			manifest: { name: "pingmod", replyable: true },
			// Preloaded at the max restart attempts: proves the reset (not a
			// freshly-spawned daemon that happens to already read 0).
			restartAttempts: 3,
			tools: [
				{
					name: "ping",
					parameters: { type: "object", properties: {} },
				},
			],
			peer: {
				request: async () => "pong",
				notify: () => {},
			},
		} as unknown as StartedDaemon;
		const daemons = [daemon];

		const rc = new RunContext();
		let toolInvoked = false;
		const mockRunner = {
			run: async (agent: Agent) => {
				toolInvoked = true;
				await findFunctionTool(agent, "pingmod__ping").invoke(rc, "{}", {});
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
		});

		await waitUntil(() => toolInvoked);
		queue.close();
		await loopTask;

		// A resolved tool call proves the daemon is alive and serving requests,
		// so it must reset the consecutive-failure count.
		expect(daemon.restartAttempts).toBe(0);
	});

	test("drops the reply when the run was aborted as it resolved", async () => {
		const home = await createTempDir("justclaw-llm-skip-gate-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		const events: unknown[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod", replyable: true },
				tools: [],
				peer: {
					notify: (method: string, params: unknown) => {
						if (method === "event") events.push(params);
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const mockRunner = {
			run: async () => {
				// sessions.skip.v1 landing just as the run resolves.
				queue.abortCurrentRun();
				return { finalOutput: "a reply", history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
		});
		await waitForQueueEmpty(dbPath);
		queue.close();
		await loopTask;

		const types = events.map((e) => (e as { type?: string }).type);
		expect(types).toContain("event.dropped.v1");
		expect(types).not.toContain("message.send.v1");
	});

	test("keeps a turn whose save failed so the next save writes it", async () => {
		const home = await createTempDir("justclaw-llm-save-rollback-");
		const dbPath = path.join(home, "events.db");
		const active = "01900000-0000-7000-8000-0000000000aa";
		let saveCalls = 0;
		const sessionStore = {
			newestReadableSessionId: () => active,
			load: async () => [],
			save: async () => {
				saveCalls++;
				if (saveCalls === 1) {
					throw new Error("save exploded");
				}
			},
		} as unknown as SessionStore;

		const queue = new EventQueue(dbPath);
		queue.setMeta("active_session_id", active);
		queue.enqueue("srcmod", { type: "event.v1", kind: "first" });
		queue.enqueue("srcmod", { type: "event.v1", kind: "second" });

		const capturedInputs: unknown[] = [];
		let runCount = 0;
		const mockRunner = {
			run: async (_agent: unknown, input: unknown) => {
				runCount++;
				capturedInputs.push(input);
				if (runCount === 1) {
					return {
						finalOutput: null,
						history: [{ role: "user", content: "turn1" } as AgentInputItem],
					};
				}
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});
		await waitUntil(() => runCount >= 2);
		queue.close();
		await loopTask;

		// The first turn happened (replies may have gone out), so the second
		// event carries it even though its save failed.
		expect(JSON.stringify(capturedInputs[1])).toContain("turn1");
	});

	// A run over a real session store whose runner makes two model calls the
	// way the SDK does: the first response is a reply plus a shell call, and
	// the second call's input carries that response and the shell result.
	// `outcome` picks how the run ends: normally, by throwing after both
	// responses, or by the provider rejecting the first or second call.
	type TwoCallOutcome =
		| "succeed"
		| "fail-after"
		| "reject-first"
		| "reject-second";
	async function runTwoModelCalls(outcome: TwoCallOutcome): Promise<{
		stored: AgentInputItem[];
		sent: string[];
		dropped: boolean;
	}> {
		const home = await createTempDir("justclaw-llm-checkpoint-");
		const dbPath = path.join(home, "events.db");
		const sessionStore = new SessionStore(path.join(home, "history"));
		const sessionId = "01900000-0000-7000-8000-0000000000c1";
		await sessionStore.save(sessionId, [
			{ role: "user", content: "earlier" } as AgentInputItem,
		]);
		const queue = new EventQueue(dbPath);
		queue.setMeta("active_session_id", sessionId);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		const sent: string[] = [];
		let dropped = false;
		const daemons = [
			{
				manifest: { name: "srcmod", replyable: true },
				tools: [],
				peer: {
					notify: (method: string, params: unknown) => {
						const p = params as { type?: string; text?: string };
						if (method !== "event") return;
						if (p.type === "message.send.v1") sent.push(p.text ?? "");
						if (p.type === "event.dropped.v1") dropped = true;
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const firstOutput = [
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "reply" }],
			},
			{
				type: "function_call",
				callId: "c1",
				name: "shell",
				arguments: "{}",
			},
		] as unknown as AgentInputItem[];
		const toolResult = {
			type: "function_call_result",
			callId: "c1",
			name: "shell",
			status: "completed",
			output: { type: "text", text: "ran" },
		} as unknown as AgentInputItem;
		let calls = 0;
		const innerModel = {
			getResponse: async () => {
				calls++;
				if (
					(calls === 1 && outcome === "reject-first") ||
					(calls === 2 && outcome === "reject-second")
				) {
					throw new Error("400 context length exceeded");
				}
				return {
					output: calls === 1 ? firstOutput : [],
				} as unknown as ModelResponse;
			},
			getStreamedResponse: async function* () {},
		} as unknown as Model;
		const mockRunner = {
			run: async (agent: Agent, input: unknown) => {
				const model = agent.model as Model;
				const asList = input as AgentInputItem[];
				const generated = [...firstOutput, toolResult];
				await model.getResponse({ input: asList } as unknown as ModelRequest);
				await model.getResponse({
					input: [...asList, ...generated],
				} as unknown as ModelRequest);
				if (outcome === "fail-after") throw new Error("run failed");
				return { finalOutput: "", history: [...asList, ...generated] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: daemons }, "test-model", {
			runner: mockRunner,
			sessionStore,
			innerModel,
		});
		await waitForQueueEmpty(dbPath);
		queue.close();
		await loopTask;

		const stored = await sessionStore.load(sessionId);
		if (stored === null) throw new Error("session history missing");
		return { stored, sent, dropped };
	}

	const countType = (items: AgentInputItem[], type: string) =>
		items.filter((i) => (i as { type?: string }).type === type).length;

	test("keeps what a failed run did up to its last model response", async () => {
		const { stored, sent, dropped } = await runTwoModelCalls("fail-after");

		expect(dropped).toBe(true);
		expect(sent).toEqual(["reply"]);
		const text = JSON.stringify(stored);
		expect(text).toContain("earlier");
		expect(text).toContain("reply");
		// The second response accepted the shell result, so the next event
		// sees that the tool ran.
		expect(countType(stored, "function_call")).toBe(1);
		expect(countType(stored, "function_call_result")).toBe(1);
	});

	test("does not store a tool result the provider rejected", async () => {
		const { stored, sent, dropped } = await runTwoModelCalls("reject-second");

		expect(dropped).toBe(true);
		// The reply went out with the first response and is in the history,
		// but the shell call and its result were never accepted.
		expect(sent).toEqual(["reply"]);
		expect(JSON.stringify(stored)).toContain("reply");
		expect(countType(stored, "function_call")).toBe(0);
		expect(countType(stored, "function_call_result")).toBe(0);
	});

	test("leaves the history untouched when the first call is rejected", async () => {
		const { stored, sent, dropped } = await runTwoModelCalls("reject-first");

		expect(dropped).toBe(true);
		expect(sent).toEqual([]);
		expect(stored).toEqual([
			{ role: "user", content: "earlier" } as AgentInputItem,
		]);
	});

	test("does not duplicate checkpointed items in the final save", async () => {
		const { stored } = await runTwoModelCalls("succeed");

		expect(countType(stored, "function_call")).toBe(1);
		expect(countType(stored, "function_call_result")).toBe(1);
		expect(countType(stored, "message")).toBe(1);
		expect(
			stored.filter((i) => (i as { role?: string }).role === "user"),
		).toHaveLength(2);
	});

	test("does not recreate a session deleted mid-run before metadata clears", async () => {
		const home = await createTempDir("justclaw-llm-delete-race-");
		const dbPath = path.join(home, "events.db");
		const historyPath = path.join(home, "history");
		const sessionStore = new SessionStore(historyPath);
		const activeId = "01900000-0000-7000-8000-0000000000aa";
		const sessionFilePath = path.join(historyPath, `${activeId}.json`);
		await sessionStore.save(activeId, []);
		const queue = new EventQueue(dbPath);
		queue.setMeta("active_session_id", activeId);
		queue.enqueue("srcmod", { type: "event.v1", kind: "test" });

		const mockRunner = {
			run: async () => {
				// Model the delete handler's window: the file is removed first,
				// before active_session_id metadata is cleared.
				await sessionStore.delete(activeId);
				return {
					finalOutput: null,
					history: [
						{
							role: "assistant",
							content: "reply",
						} as unknown as AgentInputItem,
					],
				};
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, { current: [] }, "test-model", {
			runner: mockRunner,
			sessionStore,
		});
		await waitForQueueEmpty(dbPath);
		queue.close();
		await loopTask;

		expect(await Bun.file(sessionFilePath).exists()).toBe(false);
	});

	test("restart_modules keeps character INIT injection for new sessions", async () => {
		const home = await createTempDir("justclaw-llm-restart-init-");
		const modulesRoot = path.join(home, "modules");
		const moduleDir = path.join(modulesRoot, "echomod");
		await mkdir(moduleDir, { recursive: true });
		await writeFile(
			path.join(moduleDir, "module.json"),
			JSON.stringify({ name: "echomod", exec: "./module.ts", mode: "daemon" }),
		);
		// On first initialize the module creates a new session and switches to
		// it. The core's session-request handler injects INIT.md only when it was
		// started with characterDir, which restart_modules must forward.
		const moduleScript = `#!/usr/bin/env bun
const pending = new Map();
let nextId = 100;
function sendRequest(method, params) {
  const id = nextId++;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
let initialized = false;
const chunks = [];
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  const lines = text.split(/\\r?\\n/);
  while (lines.length > 1) {
    const line = lines.shift();
    if (!line) continue;
    const msg = JSON.parse(line);
    if ("method" in msg) {
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
        if (!initialized) {
          initialized = true;
          (async () => {
            const created = await sendRequest("sessions", { type: "sessions.new.v1" });
            await sendRequest("sessions", { type: "sessions.switch.v1", id: created.id });
          })();
        }
      } else if (msg.method === "shutdown") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "ok" }) + "\\n");
        process.exit(0);
      }
    } else {
      const h = pending.get(msg.id);
      if (h) { pending.delete(msg.id); "error" in msg ? h.rej(new Error(msg.error.message)) : h.res(msg.result); }
    }
  }
  chunks.length = 0;
  if (lines[0]) chunks.push(Buffer.from(lines[0]));
}
`;
		const execPath = path.join(moduleDir, "module.ts");
		await writeFile(execPath, moduleScript);
		await chmod(execPath, 0o755);

		const characterDir = path.join(home, "character");
		await mkdir(characterDir, { recursive: true });
		const initMarker = "INIT_MARKER_TEXT";
		await writeFile(path.join(characterDir, "INIT.md"), initMarker);

		const sessionStore = new SessionStore(path.join(home, "history"));
		// A non-empty active session, so the loop's own bootstrap INIT injection
		// (which fires only for an empty adopted session) stays quiet. The only
		// remaining INIT source is the reloaded module's sessions.switch.v1
		// handler, which needs characterDir forwarded through restart_modules.
		const primedSession = "01900000-0000-7000-8000-0000000000aa";
		await sessionStore.save(primedSession, [
			{ role: "user", content: "primed" } as AgentInputItem,
		]);
		const queue = new EventQueue(path.join(home, "events.db"));
		queue.setMeta("active_session_id", primedSession);
		queue.enqueue("kicker", { type: "event.v1", kind: "kick" });

		const daemonsRef = { current: [] as StartedDaemon[] };
		const rc = new RunContext();
		const capturedInputs: string[] = [];
		let runCount = 0;
		const mockRunner = {
			run: async (agent: Agent, input: unknown) => {
				runCount += 1;
				if (runCount === 1) {
					await findFunctionTool(agent, "restart_modules").invoke(
						rc,
						JSON.stringify({ continuation: "" }),
					);
				} else {
					capturedInputs.push(JSON.stringify(input));
				}
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore,
			modulesRoot,
			characterDir,
			sandboxFactory: async (manifest) => ({
				backend: "sandbox-exec" as const,
				cmd: [manifest.execPath],
				cwd: manifest.moduleDir,
				env: process.env,
			}),
		});

		try {
			await waitUntil(
				() => capturedInputs.some((i) => i.includes(initMarker)),
				15000,
			);
		} finally {
			queue.close();
			await loopTask;
			await stopDaemons(daemonsRef.current);
		}

		expect(capturedInputs.some((i) => i.includes(initMarker))).toBe(true);
	}, 20000);
});
