import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Agent, AgentInputItem, Runner } from "@openai/agents";
import type { FunctionTool } from "@openai/agents-core";
import { RunContext } from "@openai/agents-core";
import { EventQueue } from "./event-queue";
import { JsonRpcPeer } from "./jsonrpc";
import { runLlmLoop } from "./llm-loop";
import {
	discoverDaemonManifests,
	discoverTimerManifests,
	parseDaemonManifest,
	parseTimerManifest,
	resolveModulesRoot,
	type TimerModuleManifest,
} from "./module-manifest";
import {
	bootstrapRuntime,
	reloadModules,
	type StartedDaemon,
	startDaemon,
	stopDaemons,
} from "./runtime";
import {
	createDarwinSandboxProfile,
	createLinuxBubblewrapCommand,
	createLinuxWorkspaceBwrapCommand,
	createSandboxLaunchSpec,
	resolveSandboxBackend,
	type SandboxLaunchSpec,
} from "./sandbox";
import { SessionStore } from "./session-store";
import { fireTimer } from "./timer-runner";

const tempDirs: string[] = [];
const originalJustclawHome = process.env.JUSTCLAW_HOME;
const originalOpenAIAPI = process.env.JUSTCLAW_OPENAI_API;

beforeEach(() => {
	delete process.env.JUSTCLAW_HOME;
	delete process.env.JUSTCLAW_OPENAI_API;
});

afterEach(async () => {
	if (originalJustclawHome === undefined) {
		delete process.env.JUSTCLAW_HOME;
	} else {
		process.env.JUSTCLAW_HOME = originalJustclawHome;
	}
	if (originalOpenAIAPI === undefined) {
		delete process.env.JUSTCLAW_OPENAI_API;
	} else {
		process.env.JUSTCLAW_OPENAI_API = originalOpenAIAPI;
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

function createSessionContext(homeDir: string): {
	sessionStore: SessionStore;
} {
	return {
		sessionStore: new SessionStore(path.join(homeDir, "history")),
	};
}

async function waitUntil(
	predicate: () => boolean | Promise<boolean>,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await predicate()) {
			return;
		}
		await delay(10);
	}

	throw new Error("Timed out waiting for condition");
}

function createModuleScript({
	initializeResponse = '{"tools":[]}',
	shutdownResponse = '"ok"',
	stderrLine,
	malformedStdout = false,
	exitImmediately = false,
	closeStdoutWithoutExit = false,
	ignoreInitialize = false,
	ignoreShutdown = false,
	ignoreTerminate = false,
	exitAfterShutdown = true,
	shutdownSideEffectPath,
}: {
	initializeResponse?: string;
	shutdownResponse?: string;
	stderrLine?: string;
	malformedStdout?: boolean;
	exitImmediately?: boolean;
	closeStdoutWithoutExit?: boolean;
	ignoreInitialize?: boolean;
	ignoreShutdown?: boolean;
	ignoreTerminate?: boolean;
	exitAfterShutdown?: boolean;
	shutdownSideEffectPath?: string;
} = {}): string {
	return `#!/usr/bin/env bun
import { closeSync } from "node:fs";
${stderrLine ? `console.error(${JSON.stringify(stderrLine)});\n` : ""}${ignoreTerminate ? 'process.on("SIGTERM", () => {});\n' : ""}${exitImmediately ? "process.exit(0);\n" : ""}${closeStdoutWithoutExit ? "closeSync(1);\nsetInterval(() => {}, 1000);\n" : ""}const lines = [];
for await (const chunk of Bun.stdin.stream()) {
	lines.push(chunk);
	const text = Buffer.concat(lines).toString("utf8");
	const inputLines = text.split(/\\r?\\n/);
	while (inputLines.length > 1) {
		const line = inputLines.shift();
		if (!line) continue;
		${malformedStdout ? 'console.log("{oops"); continue;' : ""}
		const message = JSON.parse(line);
		if (message.method === "initialize") {
			${ignoreInitialize ? "continue;" : ""}
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: ${initializeResponse} }));
		} else if (message.method === "shutdown") {
			${
				shutdownSideEffectPath
					? `await Bun.write(${JSON.stringify(shutdownSideEffectPath)}, "shutdown\\n");`
					: ""
			}
			${ignoreShutdown ? "continue;" : ""}
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: ${shutdownResponse} }));
			${exitAfterShutdown ? "process.exit(0);" : ""}
		}
	}
	lines.length = 0;
	if (inputLines[0]) {
		lines.push(Buffer.from(inputLines[0]));
	}
}`;
}

function createModuleScriptWithPingTool(): string {
	const initializeResult = JSON.stringify({
		tools: [
			{
				name: "ping",
				description: "p",
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		],
	});
	return `#!/usr/bin/env bun
const lines = [];
for await (const chunk of Bun.stdin.stream()) {
	lines.push(chunk);
	const text = Buffer.concat(lines).toString("utf8");
	const inputLines = text.split(/\\r?\\n/);
	while (inputLines.length > 1) {
		const line = inputLines.shift();
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.method === "initialize") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: ${initializeResult} }));
		} else if (message.method === "shutdown") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
			process.exit(0);
		} else if (typeof message.method === "string" && message.method.startsWith("tool/")) {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { pong: true } }));
		}
	}
	lines.length = 0;
	if (inputLines[0]) {
		lines.push(Buffer.from(inputLines[0]));
	}
}
`;
}

async function writeDaemonModule(
	homeDir: string,
	moduleName: string,
	script: string,
): Promise<void> {
	await writeRawModule(
		homeDir,
		moduleName,
		JSON.stringify({
			name: moduleName,
			exec: "./module.ts",
			mode: "daemon",
		}),
		script,
	);
}

async function writeRawModule(
	homeDir: string,
	moduleName: string,
	manifestText: string,
	script: string,
): Promise<void> {
	const moduleDir = path.join(
		resolveModulesRoot(undefined, homeDir),
		moduleName,
	);
	await mkdir(moduleDir, { recursive: true });
	await writeFile(path.join(moduleDir, "module.json"), manifestText);
	const scriptPath = path.join(moduleDir, "module.ts");
	await writeFile(scriptPath, script);
	await chmod(scriptPath, 0o755);
}

/** Daemon script: JSON-RPC over stdin/stdout with a pending-request map; runs `firstInitAsyncBodyLines` once after first `initialize`. */
function createJsonRpcStdinClientModuleScript(
	resultPath: string,
	firstInitAsyncBodyLines: string[],
): string {
	const initBody = firstInitAsyncBodyLines
		.map((line) => `            ${line}`)
		.join("\n");
	return `#!/usr/bin/env bun
const resultPath = ${JSON.stringify(resultPath)};
const pending = new Map();
let nextId = 100;
function sendRequest(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg.params = params;
  process.stdout.write(JSON.stringify(msg) + "\\n");
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
}
const chunks = [];
let initialized = false;
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
${initBody}
          })();
        }
      } else if (msg.method === "shutdown") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "ok" }) + "\\n");
        process.exit(0);
      }
    } else {
      const h = pending.get(msg.id);
      if (h) { pending.delete(msg.id); "error" in msg ? h.reject(new Error(msg.error.message)) : h.resolve(msg.result); }
    }
  }
  chunks.length = 0;
  if (lines[0]) chunks.push(Buffer.from(lines[0]));
}
`;
}

function createStdoutClosingShellScript(): string {
	return `#!/bin/sh
exec 1>&-
sleep 10
`;
}

function createUnsandboxedSpec(
	moduleDir: string,
	execPath: string,
): SandboxLaunchSpec {
	return {
		backend: "sandbox-exec",
		cmd: [execPath],
		cwd: moduleDir,
		env: process.env,
	};
}

function findRestartModulesTool(agent: Agent): FunctionTool {
	const found = agent.tools?.find(
		(t): t is FunctionTool =>
			t.type === "function" && t.name === "restart_modules",
	);
	if (!found) {
		throw new Error("restart_modules tool not found on agent");
	}
	return found;
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

describe("parseDaemonManifest", () => {
	test("accepts a valid daemon manifest", () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		expect(manifest.name).toBe("example");
		expect(manifest.execPath).toBe(path.resolve("/tmp/example", "./run"));
		expect(manifest.replyable).toBe(false);
	});

	test("accepts replyable true", () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
			replyable: true,
		});
		expect(manifest.replyable).toBe(true);
	});

	test("rejects timer mode", () => {
		expect(() =>
			parseDaemonManifest("/tmp/example", "example", {
				name: "example",
				exec: "./run",
				mode: "timer",
			}),
		).toThrow('must declare mode "daemon"');
	});

	test("rejects directory/name mismatch", () => {
		expect(() =>
			parseDaemonManifest("/tmp/example", "example", {
				name: "other",
				exec: "./run",
				mode: "daemon",
			}),
		).toThrow('name must match directory "example"');
	});

	test("rejects missing exec", () => {
		expect(() =>
			parseDaemonManifest("/tmp/example", "example", {
				name: "example",
				mode: "daemon",
			}),
		).toThrow('must contain a non-empty string "exec"');
	});

	test("rejects absolute exec paths", () => {
		expect(() =>
			parseDaemonManifest("/tmp/example", "example", {
				name: "example",
				exec: "/usr/bin/python",
				mode: "daemon",
			}),
		).toThrow('"exec" must be relative to the module directory');
	});

	test("rejects exec paths that escape the module directory", () => {
		expect(() =>
			parseDaemonManifest("/tmp/example", "example", {
				name: "example",
				exec: "../run",
				mode: "daemon",
			}),
		).toThrow('"exec" must stay inside the module directory');
	});

	test("accepts exec paths that start with dots but stay inside the module directory", () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./..bin/run",
			mode: "daemon",
		});

		expect(manifest.execPath).toBe(path.resolve("/tmp/example/..bin/run"));
	});

	test("rejects empty name", () => {
		expect(() =>
			parseDaemonManifest("/tmp/example", "example", {
				name: "",
				exec: "./run",
				mode: "daemon",
			}),
		).toThrow('must contain a non-empty string "name"');
	});

	test("rejects unsupported mode", () => {
		expect(() =>
			parseDaemonManifest("/tmp/example", "example", {
				name: "example",
				exec: "./run",
				mode: "other",
			}),
		).toThrow('must declare mode "daemon"');
	});
});

describe("parseTimerManifest", () => {
	test("accepts a valid timer manifest", () => {
		const manifest = parseTimerManifest("/tmp/tick", "tick", {
			name: "tick",
			exec: "./run",
			mode: "timer",
			cron: "0 9 * * 1-5",
		});

		expect(manifest.name).toBe("tick");
		expect(manifest.mode).toBe("timer");
		expect(manifest.cron).toBe("0 9 * * 1-5");
		expect(manifest.execPath).toBe(path.resolve("/tmp/tick", "./run"));
	});

	test("rejects daemon mode", () => {
		expect(() =>
			parseTimerManifest("/tmp/example", "example", {
				name: "example",
				exec: "./run",
				mode: "daemon",
			}),
		).toThrow('must declare mode "timer"');
	});

	test("rejects missing cron", () => {
		expect(() =>
			parseTimerManifest("/tmp/example", "example", {
				name: "example",
				exec: "./run",
				mode: "timer",
			}),
		).toThrow('must contain a non-empty string "cron"');
	});

	test("rejects empty cron string", () => {
		expect(() =>
			parseTimerManifest("/tmp/example", "example", {
				name: "example",
				exec: "./run",
				mode: "timer",
				cron: "",
			}),
		).toThrow('must contain a non-empty string "cron"');
	});

	test("rejects invalid cron expression", () => {
		expect(() =>
			parseTimerManifest("/tmp/example", "example", {
				name: "example",
				exec: "./run",
				mode: "timer",
				cron: "not-a-cron",
			}),
		).toThrow('"cron" is not a valid cron expression');
	});
});

describe("discoverTimerManifests", () => {
	test("discovers timer modules and skips daemon directories", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const modulesRoot = resolveModulesRoot(undefined, homeDir);
		await writeDaemonModule(homeDir, "echo", createModuleScript());
		await writeRawModule(
			homeDir,
			"ticker",
			JSON.stringify({
				name: "ticker",
				exec: "./module.ts",
				mode: "timer",
				cron: "0 0 * * *",
			}),
			"#!/usr/bin/env bun\nconsole.log('noop');\n",
		);

		const manifests = await discoverTimerManifests(modulesRoot);

		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.name).toBe("ticker");
		expect(manifests[0]?.cron).toBe("0 0 * * *");
	});

	test("fails when manifest JSON is invalid", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeRawModule(
			homeDir,
			"bad-timer",
			"{oops",
			"#!/usr/bin/env bun\nconsole.log('noop');\n",
		);
		const modulesRoot = resolveModulesRoot(undefined, homeDir);

		await expect(discoverTimerManifests(modulesRoot)).rejects.toThrow(
			"is not valid JSON",
		);
	});
});

describe("discoverDaemonManifests", () => {
	test("skips timer-only module directories", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const modulesRoot = resolveModulesRoot(undefined, homeDir);
		await writeRawModule(
			homeDir,
			"only-timer",
			JSON.stringify({
				name: "only-timer",
				exec: "./module.ts",
				mode: "timer",
				cron: "0 0 * * *",
			}),
			"#!/usr/bin/env bun\nconsole.log('noop');\n",
		);

		const manifests = await discoverDaemonManifests(modulesRoot);

		expect(manifests).toHaveLength(0);
	});
});

describe("JsonRpcPeer", () => {
	test("increments request ids and resolves matching responses", async () => {
		const sentLines: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: (line) => {
				sentLines.push(line);
			},
		});

		const first = peer.request("initialize");
		const second = peer.request("shutdown");

		expect(JSON.parse(sentLines[0] ?? "{}").id).toBe(1);
		expect(JSON.parse(sentLines[1] ?? "{}").id).toBe(2);

		peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "bye" }));
		peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));

		await expect(first).resolves.toBe("ok");
		await expect(second).resolves.toBe("bye");
	});

	test("surfaces invalid JSON lines", () => {
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: () => {},
		});

		expect(() => peer.handleLine("{oops")).toThrow(
			"received invalid JSON-RPC line",
		);
	});

	test("delivers notifications", () => {
		const methods: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: () => {},
			onNotification: (message) => {
				methods.push(message.method);
			},
		});

		peer.handleLine(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "event",
				params: { type: "message.received" },
			}),
		);

		expect(methods).toEqual(["event"]);
	});

	test("notify sends a JSON-RPC notification without an id", () => {
		const sentLines: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: (line) => {
				sentLines.push(line);
			},
		});

		peer.notify("event", { type: "event.v1", x: 1 });
		expect(sentLines).toHaveLength(1);
		const msg = JSON.parse(sentLines[0] ?? "{}");
		expect(msg.jsonrpc).toBe("2.0");
		expect(msg.method).toBe("event");
		expect(msg.id).toBeUndefined();
		expect(msg.params).toEqual({ type: "event.v1", x: 1 });
	});

	test("notify omits params when undefined", () => {
		const sentLines: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: (line) => {
				sentLines.push(line);
			},
		});

		peer.notify("ping");
		const msg = JSON.parse(sentLines[0] ?? "{}");
		expect(msg.method).toBe("ping");
		expect("params" in msg).toBe(false);
	});

	test("notify silently drops when the peer is closed", () => {
		const sentLines: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: (line) => {
				sentLines.push(line);
			},
		});

		peer.close(new Error("closed"));
		peer.notify("event", { type: "event.v1" });
		expect(sentLines).toHaveLength(0);
	});

	test("logs and ignores responses for unknown request ids without tearing down the peer", async () => {
		const log: string[] = [];
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => {
			log.push(args.join(" "));
		};

		try {
			const peer = new JsonRpcPeer({
				name: "test",
				sendLine: () => {},
			});

			const pending = peer.request("initialize");

			expect(() =>
				peer.handleLine(
					JSON.stringify({ jsonrpc: "2.0", id: 99, result: "ok" }),
				),
			).not.toThrow();
			expect(log.some((line) => line.includes("unknown request id 99"))).toBe(
				true,
			);

			// The peer stays alive and unrelated in-flight requests are unaffected.
			peer.handleLine(
				JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ready" }),
			);
			await expect(pending).resolves.toBe("ready");
		} finally {
			console.error = originalConsoleError;
		}
	});

	test("logs and ignores responses with null id", () => {
		const log: string[] = [];
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => {
			log.push(args.join(" "));
		};

		try {
			const peer = new JsonRpcPeer({
				name: "test",
				sendLine: () => {},
			});
			peer.handleLine(
				JSON.stringify({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error" },
				}),
			);
			expect(log.some((line) => line.includes("null id"))).toBe(true);

			log.length = 0;
			peer.handleLine(
				JSON.stringify({ jsonrpc: "2.0", id: null, result: "orphan" }),
			);
			expect(log.some((line) => line.includes("null id"))).toBe(true);
		} finally {
			console.error = originalConsoleError;
		}
	});

	test("rejects malformed error responses", async () => {
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: () => {},
		});

		const request = peer.request("initialize");
		peer.handleLine(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				error: { code: "bad", message: "nope" },
			}),
		);

		await expect(request).rejects.toThrow(
			"received malformed JSON-RPC error response",
		);
	});

	test("calls onRequest handler and returns result", async () => {
		const sentLines: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: (line) => {
				sentLines.push(line);
			},
			onRequest: async (method) => {
				if (method === "ping") return "pong";
				throw new Error("unexpected method");
			},
		});

		peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }));
		await delay(10);

		expect(sentLines).toHaveLength(1);
		const response = JSON.parse(sentLines[0] ?? "{}");
		expect(response.id).toBe(7);
		expect(response.result).toBe("pong");
	});

	test("sends error response when onRequest throws", async () => {
		const sentLines: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: (line) => {
				sentLines.push(line);
			},
			onRequest: async () => {
				throw new Error("handler error");
			},
		});

		peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "fail" }));
		await delay(10);

		expect(sentLines).toHaveLength(1);
		const response = JSON.parse(sentLines[0] ?? "{}");
		expect(response.id).toBe(8);
		expect(response.error?.code).toBe(-32000);
		expect(response.error?.message).toBe("handler error");
	});

	test("echoes string id in response to inbound request", async () => {
		const sentLines: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: (line) => {
				sentLines.push(line);
			},
			onRequest: async () => "ok",
		});

		peer.handleLine(
			JSON.stringify({ jsonrpc: "2.0", id: "req-abc", method: "ping" }),
		);
		await delay(10);

		expect(sentLines).toHaveLength(1);
		const response = JSON.parse(sentLines[0] ?? "{}");
		expect(response.id).toBe("req-abc");
		expect(response.result).toBe("ok");
	});

	test("responds Method not found when no request handler is registered", () => {
		const sentLines: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: (line) => {
				sentLines.push(line);
			},
		});

		peer.handleLine(
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		);

		expect(sentLines).toHaveLength(1);
		const response = JSON.parse(sentLines[0] ?? "{}");
		expect(response.id).toBe(1);
		expect(response.error?.code).toBe(-32601);
	});
});

describe("sandbox", () => {
	test("selects sandbox-exec on darwin", () => {
		expect(resolveSandboxBackend("darwin")).toBe("sandbox-exec");
	});

	test("selects bwrap on linux", () => {
		expect(resolveSandboxBackend("linux")).toBe("bwrap");
	});

	test("rejects unsupported platforms", () => {
		expect(() => resolveSandboxBackend("win32")).toThrow(
			"Unsupported sandbox platform",
		);
	});

	test("builds a darwin profile with module and temp write access", () => {
		const profile = createDarwinSandboxProfile("/tmp/module");
		expect(profile).toContain('(subpath "/tmp/module")');
		expect(profile).toContain('(subpath "/System")');
		expect(profile).toContain('(subpath "/usr")');
		expect(profile).toContain('(subpath "/opt")');
		expect(profile).toContain('(subpath "/Library")');
		expect(profile).toContain('(subpath "/private/etc")');
		expect(profile).toContain('(subpath "/tmp")');
		expect(profile).toContain('(subpath "/private/tmp")');
		expect(profile).not.toContain('(subpath "/")');
		expect(profile).toContain("(allow network*)");
	});

	test("includes inherited TMPDIR in the darwin profile", () => {
		const profile = createDarwinSandboxProfile("/tmp/module", {
			...process.env,
			TMPDIR: "/var/folders/example/T/",
		});

		expect(profile).toContain('(subpath "/var/folders/example/T")');
		expect(profile).toContain('(subpath "/private/var/folders/example/T")');
	});

	test("darwin module sandbox exposes JUSTCLAW_SANDBOX_RO_PATHS as read-only", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "darwin",
			env: { ...process.env, JUSTCLAW_SANDBOX_RO_PATHS: "/srv/extra-ro" },
			lookupExecutable: async (command) =>
				command === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null,
			pathExists: async (candidatePath) => candidatePath === "/srv/extra-ro",
		});

		const profile = spec.cmd[2] ?? "";
		expect(profile).toContain('(subpath "/srv/extra-ro")');
		expect(profile.slice(profile.indexOf("(allow file-write*"))).not.toContain(
			'(subpath "/srv/extra-ro")',
		);
	});

	test("darwin module sandbox exposes JUSTCLAW_SANDBOX_RW_PATHS as read-write", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "darwin",
			env: { ...process.env, JUSTCLAW_SANDBOX_RW_PATHS: "/srv/extra-rw" },
			lookupExecutable: async (command) =>
				command === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null,
			pathExists: async (candidatePath) => candidatePath === "/srv/extra-rw",
		});

		const profile = spec.cmd[2] ?? "";
		expect(profile).toContain('(subpath "/srv/extra-rw")');
		expect(profile.slice(profile.indexOf("(allow file-write*"))).toContain(
			'(subpath "/srv/extra-rw")',
		);
	});

	test("a malicious darwin module shebang produces no extra interpreter mount", async () => {
		// Regression test: the core no longer reads module entrypoints to derive
		// mounts, so a shebang naming an arbitrary path (e.g. an ssh key, or "//"
		// which previously bypassed the "/" root guard) cannot expose anything.
		// There is no readTextFile option any more -- nothing in module.json or
		// the entrypoint file is consulted when building the profile.
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "darwin",
			lookupExecutable: async (command) =>
				command === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null,
			pathExists: async () => true,
		});

		const profile = spec.cmd[2] ?? "";
		expect(profile).not.toContain('(subpath "/home/x/.ssh")');
		expect(profile).not.toContain('(subpath "/home/x/.ssh/id_rsa")');
		expect(profile).not.toContain('(subpath "/")');
	});

	test("builds a linux bwrap command from the readonly allowlist", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});
		const existingPaths = new Set([
			"/bin",
			"/usr",
			"/usr/local",
			"/opt",
			"/etc",
			"/lib",
			"/nix",
			"/tmp/example",
			"/tmp",
		]);
		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) => existingPaths.has(candidatePath),
		});

		expect(cmd.slice(0, 3)).toEqual([
			"/usr/bin/bwrap",
			"--die-with-parent",
			"--new-session",
		]);
		expect(cmd).toContain("--unshare-pid");
		expect(cmd).toContain("/usr");
		expect(cmd).toContain("/usr/local");
		expect(cmd).not.toContain("/run");
		expect(cmd).not.toContain("/var/run");
		expect(cmd).toContain("--ro-bind");
		expect(cmd).toContain("--bind");
		expect(cmd).toContain("--proc");
		expect(cmd).toContain("--dev");
		expect(cmd).toContain(path.resolve("/tmp/example", "./run"));
	});

	test("creates bwrap mountpoints for home module directories", async () => {
		const moduleDir = "/home/test/justclaw/modules/example";
		const manifest = parseDaemonManifest(moduleDir, "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp" || candidatePath === moduleDir,
		});

		expect(cmd).toContain("/home");
		expect(cmd).toContain("/home/test");
		expect(cmd).toContain("/home/test/justclaw");
		expect(cmd).toContain("/home/test/justclaw/modules");
		expect(cmd).toContain(moduleDir);
		expect(cmd).toContain("--bind");
	});

	test("mounts the core runtime directory in the module sandbox", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});
		const coreRuntimeDir = path.dirname(process.execPath);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === coreRuntimeDir,
		});

		expect(
			cmd.some(
				(token, index) =>
					token === "--ro-bind" &&
					cmd[index + 1] === coreRuntimeDir &&
					cmd[index + 2] === coreRuntimeDir,
			),
		).toBe(true);
	});

	test("does not mount the core runtime directory in the workspace sandbox", async () => {
		const coreRuntimeDir = path.dirname(process.execPath);

		const cmd = await createLinuxWorkspaceBwrapCommand(
			"/usr/bin/bwrap",
			"/ws",
			"/hist",
			{
				pathExists: async (candidatePath) =>
					candidatePath === "/ws" ||
					candidatePath === "/tmp" ||
					candidatePath === coreRuntimeDir,
				bindHistoryDir: false,
			},
		);

		expect(cmd).not.toContain(coreRuntimeDir);
	});

	test("mounts JUSTCLAW_SANDBOX_RO_PATHS entries read-only on linux", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			env: { ...process.env, JUSTCLAW_SANDBOX_RO_PATHS: "/srv/extra-ro" },
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/srv/extra-ro",
		});

		expect(
			cmd.some(
				(token, index) =>
					token === "--ro-bind" &&
					cmd[index + 1] === "/srv/extra-ro" &&
					cmd[index + 2] === "/srv/extra-ro",
			),
		).toBe(true);
	});

	test("mounts JUSTCLAW_SANDBOX_RW_PATHS entries read-write on linux", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			env: { ...process.env, JUSTCLAW_SANDBOX_RW_PATHS: "/srv/extra-rw" },
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/srv/extra-rw",
		});

		expect(
			cmd.some(
				(token, index) =>
					token === "--bind" &&
					cmd[index + 1] === "/srv/extra-rw" &&
					cmd[index + 2] === "/srv/extra-rw",
			),
		).toBe(true);
	});

	test("applies JUSTCLAW_SANDBOX_RO_PATHS / RW_PATHS to the workspace sandbox", async () => {
		const cmd = await createLinuxWorkspaceBwrapCommand(
			"/usr/bin/bwrap",
			"/ws",
			"/hist",
			{
				env: {
					...process.env,
					JUSTCLAW_SANDBOX_RO_PATHS: "/srv/extra-ro",
					JUSTCLAW_SANDBOX_RW_PATHS: "/srv/extra-rw",
				},
				pathExists: async (candidatePath) =>
					candidatePath === "/ws" ||
					candidatePath === "/tmp" ||
					candidatePath === "/srv/extra-ro" ||
					candidatePath === "/srv/extra-rw",
				bindHistoryDir: false,
			},
		);

		expect(
			cmd.some(
				(token, index) =>
					token === "--ro-bind" &&
					cmd[index + 1] === "/srv/extra-ro" &&
					cmd[index + 2] === "/srv/extra-ro",
			),
		).toBe(true);
		expect(
			cmd.some(
				(token, index) =>
					token === "--bind" &&
					cmd[index + 1] === "/srv/extra-rw" &&
					cmd[index + 2] === "/srv/extra-rw",
			),
		).toBe(true);
	});

	test("rejects malformed JUSTCLAW_SANDBOX_RO_PATHS entries and skips them", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});
		const originalConsoleError = console.error;
		const errors: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};

		try {
			const cmd = await createLinuxBubblewrapCommand(
				"/usr/bin/bwrap",
				manifest,
				{
					env: {
						...process.env,
						JUSTCLAW_SANDBOX_RO_PATHS: [
							"relative/path",
							"/a/../b",
							"//double",
							"/.",
							"/",
							"/does/not/exist",
							"/opt/good",
						].join(":"),
					},
					pathExists: async (candidatePath) =>
						candidatePath === "/tmp/example" ||
						candidatePath === "/tmp" ||
						candidatePath === "/opt/good",
				},
			);

			expect(
				cmd.some(
					(token, index) =>
						token === "--ro-bind" &&
						cmd[index + 1] === "/opt/good" &&
						cmd[index + 2] === "/opt/good",
				),
			).toBe(true);
			expect(cmd).not.toContain("relative/path");
			expect(cmd).not.toContain("/a/../b");
			expect(cmd).not.toContain("//double");
			expect(cmd).not.toContain("/does/not/exist");
			expect(
				cmd.some(
					(token, index) => token === "--ro-bind" && cmd[index + 1] === "/",
				),
			).toBe(false);
			expect(errors.length).toBeGreaterThan(0);
		} finally {
			console.error = originalConsoleError;
		}
	});

	test("a malicious linux module shebang produces no extra interpreter mount", async () => {
		// Regression test: the core no longer reads module entrypoints to derive
		// mounts. Even if the host happens to have these malicious-looking paths
		// (a shebang of "//bun" previously bypassed the "/" guard; an absolute
		// path could name any file readable by the sandboxed process), nothing
		// queries them because there is no readTextFile option any more.
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/" ||
				candidatePath === "/home/x/.ssh" ||
				candidatePath === "/home/x/.ssh/id_rsa",
		});

		expect(cmd).not.toContain("/home/x/.ssh");
		expect(cmd).not.toContain("/home/x/.ssh/id_rsa");
		expect(
			cmd.some(
				(token, index) => token === "--ro-bind" && cmd[index + 1] === "/",
			),
		).toBe(false);
	});

	test("omits missing optional linux readonly mounts", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" || candidatePath === "/tmp",
		});

		expect(cmd).not.toContain("/sys");
		expect(cmd).not.toContain("/var");
		expect(cmd).not.toContain("/var/tmp");
		expect(cmd).not.toContain("/usr/local");
		expect(cmd).toContain("/tmp/example");
		expect(cmd).toContain("/tmp");
	});

	test("mounts the linux resolver symlink target without exposing /run wholesale", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/etc" ||
				candidatePath === "/etc/resolv.conf" ||
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp",
			realPath: async (candidatePath) =>
				candidatePath === "/etc/resolv.conf"
					? "/run/systemd/resolve/stub-resolv.conf"
					: candidatePath,
		});

		expect(cmd).toContain("/run");
		expect(cmd).toContain("/run/systemd");
		expect(cmd).toContain("/run/systemd/resolve");
		expect(cmd).toContain("/run/systemd/resolve/stub-resolv.conf");
		expect(
			cmd.filter(
				(token, index) => token === "--ro-bind" && cmd[index + 1] === "/run",
			),
		).toHaveLength(0);
	});

	test("fails when a required writable linux sandbox path is unavailable", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		await expect(
			createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
				pathExists: async (candidatePath) => candidatePath === "/tmp/example",
			}),
		).rejects.toThrow("Required writable sandbox path is unavailable: /tmp");
	});

	test("fails closed when the darwin backend is missing", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		await expect(
			createSandboxLaunchSpec(manifest, {
				platform: "darwin",
				lookupExecutable: async () => null,
			}),
		).rejects.toThrow("sandbox-exec backend is unavailable");
	});

	test("fails closed when the linux backend is missing", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});

		await expect(
			createSandboxLaunchSpec(manifest, {
				platform: "linux",
				lookupExecutable: async () => null,
			}),
		).rejects.toThrow("bwrap backend is unavailable");
	});

	test("preserves environment variables in the launch spec", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});
		const env = { ...process.env, OPENAI_API_KEY: "test-key" };

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "darwin",
			env,
			lookupExecutable: async () => "/usr/bin/sandbox-exec",
		});

		expect(spec.env.OPENAI_API_KEY).toBe("test-key");
		expect(spec.cmd[0]).toBe("/usr/bin/sandbox-exec");
	});

	test("normalizes TMPDIR to /tmp in the linux launch spec", async () => {
		const manifest = parseDaemonManifest("/tmp/example", "example", {
			name: "example",
			exec: "./run",
			mode: "daemon",
		});
		const env = { ...process.env, TMPDIR: "/var/tmp/custom" };

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "linux",
			env,
			lookupExecutable: async () => "/usr/bin/bwrap",
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/usr",
		});

		expect(spec.env.TMPDIR).toBe("/tmp");
	});
});

describe("reloadModules", () => {
	test("rejects empty modules directory and leaves running daemons untouched", async () => {
		const homeDir = await createTempDir("justclaw-reload-empty-");
		await writeDaemonModule(homeDir, "solo", createModuleScript());
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const before = daemonsRef.current.map((d) => d.manifest.name).sort();
		try {
			await rm(path.join(runtime.modulesRoot, "solo"), { recursive: true });
			await expect(
				reloadModules(daemonsRef, runtime.modulesRoot, runtime.eventQueue, {
					sessionStore: ctx.sessionStore,
					sandboxFactory: async (manifest) =>
						createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
				}),
			).rejects.toThrow("No modules available");
			expect(daemonsRef.current.map((d) => d.manifest.name).sort()).toEqual(
				before,
			);
		} finally {
			await stopDaemons(daemonsRef.current);
			runtime.eventQueue.close();
		}
	});

	test("leaves running daemons unchanged when discovery fails", async () => {
		const homeDir = await createTempDir("justclaw-reload-bad-");
		await writeDaemonModule(homeDir, "good", createModuleScript());
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const before = daemonsRef.current.map((d) => d.manifest.name).sort();
		try {
			await writeRawModule(homeDir, "bad", "{not json", createModuleScript());
			await expect(
				reloadModules(daemonsRef, runtime.modulesRoot, runtime.eventQueue, {
					sessionStore: ctx.sessionStore,
					sandboxFactory: async (manifest) =>
						createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
				}),
			).rejects.toThrow();
			expect(daemonsRef.current.map((d) => d.manifest.name).sort()).toEqual(
				before,
			);
		} finally {
			await stopDaemons(daemonsRef.current);
			runtime.eventQueue.close();
		}
	});

	test("drops removed modules after reload", async () => {
		const homeDir = await createTempDir("justclaw-reload-drop-");
		await writeDaemonModule(homeDir, "keep", createModuleScript());
		await writeDaemonModule(homeDir, "gone", createModuleScript());
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		try {
			await rm(path.join(runtime.modulesRoot, "gone"), { recursive: true });
			await reloadModules(daemonsRef, runtime.modulesRoot, runtime.eventQueue, {
				sessionStore: ctx.sessionStore,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			});
			expect(daemonsRef.current.map((d) => d.manifest.name).sort()).toEqual([
				"keep",
			]);
		} finally {
			await stopDaemons(daemonsRef.current);
			runtime.eventQueue.close();
		}
	});
});

describe("bootstrapRuntime", () => {
	test("fails when HOME is unavailable", async () => {
		const sessionHome = await createTempDir("justclaw-bs-no-home-");
		await expect(
			bootstrapRuntime({
				homeDir: "",
				...createSessionContext(sessionHome),
			}),
		).rejects.toThrow("HOME is not set and JUSTCLAW_HOME is not set");
	});

	test("fails when runtime modules directory does not exist", async () => {
		const homeDir = await createTempDir("justclaw-home-");

		await expect(
			bootstrapRuntime({
				homeDir,
				eventQueuePath: path.join(homeDir, "events.db"),
				...createSessionContext(homeDir),
			}),
		).rejects.toThrow("No modules directory found at");
	});

	test("ignores directories without a manifest file", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const moduleDir = path.join(
			resolveModulesRoot(undefined, homeDir),
			"missing-manifest",
		);
		await mkdir(moduleDir, { recursive: true });

		const manifests = await discoverDaemonManifests(
			resolveModulesRoot(undefined, homeDir),
		);

		expect(manifests).toHaveLength(0);
	});

	test("fails fast when no valid modules are installed", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const modulesRoot = resolveModulesRoot(undefined, homeDir);
		await mkdir(modulesRoot, { recursive: true });
		await mkdir(path.join(modulesRoot, "notes"), { recursive: true });
		await writeFile(path.join(modulesRoot, ".DS_Store"), "noise");

		await expect(
			bootstrapRuntime({
				homeDir,
				eventQueuePath: path.join(homeDir, "events.db"),
				...createSessionContext(homeDir),
			}),
		).rejects.toThrow(`No modules available in ${modulesRoot}`);
	});

	test("ignores non-module filesystem noise in the modules root", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const modulesRoot = resolveModulesRoot(undefined, homeDir);
		await mkdir(modulesRoot, { recursive: true });
		await writeFile(path.join(modulesRoot, ".DS_Store"), "noise");
		await mkdir(path.join(modulesRoot, "notes"), { recursive: true });
		await writeDaemonModule(homeDir, "echo", createModuleScript());

		const manifests = await discoverDaemonManifests(modulesRoot);

		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.name).toBe("echo");
	});

	test("fails when manifest JSON is invalid", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeRawModule(
			homeDir,
			"bad-manifest",
			"{oops",
			createModuleScript(),
		);

		await expect(
			bootstrapRuntime({
				homeDir,
				eventQueuePath: path.join(homeDir, "events.db"),
				...createSessionContext(homeDir),
			}),
		).rejects.toThrow("is not valid JSON");
	});

	test("discovers, initializes, and shuts down a daemon module", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"echo",
			createModuleScript({ stderrLine: "booted" }),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		expect(runtime.modulesRoot).toBe(path.join(homeDir, "justclaw", "modules"));
		expect(runtime.daemons).toHaveLength(1);
		expect(runtime.daemons[0]?.tools).toEqual([]);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("restarts a daemon that exits after initialize", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const startCountPath = path.join(homeDir, "exit-after-init-starts.txt");
		await writeDaemonModule(
			homeDir,
			"exit-after-init",
			`#!/usr/bin/env bun
let starts = 0;
try {
	starts = Number(await Bun.file(${JSON.stringify(startCountPath)}).text());
} catch {}
starts += 1;
await Bun.write(${JSON.stringify(startCountPath)}, String(starts));
for await (const chunk of Bun.stdin.stream()) {
	const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
	if (message.method === "initialize") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
		if (starts === 1) {
			process.exit(0);
		}
	} else if (message.method === "shutdown") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
		process.exit(0);
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(async () => {
			return (
				(await readFile(startCountPath, "utf8")) === "2" &&
				runtime.daemons[0]?.state === "running"
			);
		});
		expect(runtime.daemons[0]?.state).toBe("running");
		expect(runtime.daemons[0]?.restartAttempts).toBe(1);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("skips a daemon that exits before initialize responds", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"early-exit",
			createModuleScript({ exitImmediately: true }),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		runtime.eventQueue.close();
		expect(runtime.daemons).toHaveLength(0);
	});

	test("skips a daemon when stdout closes before initialize responds", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"stdout-closed",
			createStdoutClosingShellScript(),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		runtime.eventQueue.close();
		expect(runtime.daemons).toHaveLength(0);
	});

	test("skips a daemon when initialize returns a JSON-RPC error", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"init-error",
			createModuleScript({
				initializeResponse: "undefined",
			}).replace(
				'console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: undefined }));',
				'console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "init failed" } }));',
			),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		runtime.eventQueue.close();
		expect(runtime.daemons).toHaveLength(0);
	});

	test("skips a daemon when initialize does not respond before the configured timeout", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"init-timeout",
			createModuleScript({ ignoreInitialize: true }),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			initializeTimeoutMs: 50,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		runtime.eventQueue.close();
		expect(runtime.daemons).toHaveLength(0);
	});

	test("registers spawned daemons before initialize completes", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"init-pending",
			createModuleScript({ ignoreInitialize: true }),
		);
		const startedDaemons: StartedDaemon[] = [];

		const bootstrap = bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			initializeTimeoutMs: 5_000,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			startedDaemons,
		});
		await waitUntil(() => startedDaemons.length === 1);
		await stopDaemons(startedDaemons);

		const runtime = await bootstrap;
		runtime.eventQueue.close();
		expect(runtime.daemons).toHaveLength(0);
	});

	test("marks a daemon failed when initialize fails", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"bad-init",
			createModuleScript({
				initializeResponse: '{"tools":"not-an-array"}',
			}),
		);
		const manifests = await discoverDaemonManifests(
			resolveModulesRoot(undefined, homeDir),
		);
		const manifest = manifests[0];
		if (!manifest) {
			throw new Error("Expected bad-init manifest");
		}
		let daemon: StartedDaemon | undefined;
		const queue = new EventQueue(path.join(homeDir, "events.db"));

		try {
			await expect(
				startDaemon(manifest, {
					queue,
					...createSessionContext(homeDir),
					sandboxFactory: async (manifest) =>
						createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
					onSpawned: (spawnedDaemon) => {
						daemon = spawnedDaemon;
					},
				}),
			).rejects.toThrow('initialize result "tools" must be an array');
		} finally {
			queue.close();
		}

		expect(daemon?.state).toBe("failed");
		await expect(daemon?.process.exited).resolves.toBeNumber();
	});

	test('skips a daemon when initialize result "tools" is not an array', async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const cleanupMarker = path.join(homeDir, "bad-tools-cleanup.txt");
		await writeDaemonModule(
			homeDir,
			"bad-tools",
			createModuleScript({
				initializeResponse: '{"tools":"not-an-array"}',
				shutdownSideEffectPath: cleanupMarker,
			}),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		runtime.eventQueue.close();
		expect(runtime.daemons).toHaveLength(0);
		await expect(readFile(cleanupMarker, "utf8")).resolves.toContain(
			"shutdown",
		);
	});

	test("skips a daemon when a tool entry has a non-string name", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"bad-tool-name",
			createModuleScript({
				initializeResponse:
					'{"tools":[{"description":"d","parameters":{"type":"object"}}]}',
			}),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		runtime.eventQueue.close();
		expect(runtime.daemons).toHaveLength(0);
	});

	test("skips a daemon when initialize result is an array", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"array-init",
			createModuleScript({
				initializeResponse: "[]",
			}),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		runtime.eventQueue.close();
		expect(runtime.daemons).toHaveLength(0);
	});

	test("skips a daemon when stdout emits malformed JSON", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"bad-json",
			createModuleScript({ malformedStdout: true }),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		runtime.eventQueue.close();
		expect(runtime.daemons).toHaveLength(0);
	});

	test("terminates a started daemon after stdout closes", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const startCountPath = path.join(homeDir, "stdout-closes-starts.txt");
		await writeDaemonModule(
			homeDir,
			"stdout-closes-late",
			`#!/bin/sh
starts=0
if [ -f ${startCountPath} ]; then starts=$(cat ${startCountPath}); fi
starts=$((starts + 1))
printf '%s' "$starts" > ${startCountPath}
IFS= read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
exec 1>&-
sleep 10
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemon = runtime.daemons[0];
		expect(daemon).toBeDefined();

		try {
			await expect(
				Promise.race([
					daemon?.process.exited,
					delay(3_000).then(() => {
						throw new Error("daemon was not terminated");
					}),
				]),
			).resolves.toBeNumber();
		} finally {
			if (daemon?.process.exitCode === null) {
				daemon.process.kill("SIGKILL");
			}
		}
		await waitUntil(async () => {
			return (await readFile(startCountPath, "utf8")) === "2";
		});
		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("kills a started daemon that ignores SIGTERM after stdout closes", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const startCountPath = path.join(homeDir, "stdout-stubborn-starts.txt");
		await writeDaemonModule(
			homeDir,
			"stdout-closes-stubborn",
			`#!/bin/sh
trap '' TERM
starts=0
if [ -f ${startCountPath} ]; then starts=$(cat ${startCountPath}); fi
starts=$((starts + 1))
printf '%s' "$starts" > ${startCountPath}
IFS= read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
if [ "$starts" -eq 1 ]; then
	exec 1>&-
	sleep 10
fi
while IFS= read -r line; do
	echo '{"jsonrpc":"2.0","id":2,"result":"ok"}'
	exit 0
done
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemon = runtime.daemons[0];
		expect(daemon).toBeDefined();

		try {
			await expect(
				Promise.race([
					daemon?.process.exited,
					delay(3_000).then(() => {
						throw new Error("daemon was not killed");
					}),
				]),
			).resolves.toBeNumber();
		} finally {
			if (daemon?.process.exitCode === null) {
				daemon.process.kill("SIGKILL");
			}
		}
		await waitUntil(async () => {
			return (
				(await readFile(startCountPath, "utf8")) === "2" &&
				runtime.daemons[0]?.state === "running"
			);
		});
		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("restarts a daemon that emits malformed stdout after initialize", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const startCountPath = path.join(homeDir, "malformed-starts.txt");
		await writeDaemonModule(
			homeDir,
			"malformed-after-init",
			`#!/usr/bin/env bun
let starts = 0;
try {
	starts = Number(await Bun.file(${JSON.stringify(startCountPath)}).text());
} catch {}
starts += 1;
await Bun.write(${JSON.stringify(startCountPath)}, String(starts));
for await (const chunk of Bun.stdin.stream()) {
	const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
	if (message.method === "initialize") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
		if (starts === 1) {
			console.log("{oops");
		}
	} else if (message.method === "shutdown") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
		process.exit(0);
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(async () => {
			return (
				(await readFile(startCountPath, "utf8")) === "2" &&
				runtime.daemons[0]?.state === "running" &&
				runtime.daemons[0]?.restartAttempts === 1
			);
		});
		expect(runtime.daemons[0]?.state).toBe("running");
		expect(runtime.daemons[0]?.restartAttempts).toBe(1);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("terminates stdout failures for direct startDaemon callers", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"direct-stdout-failure",
			`#!/bin/sh
IFS= read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
exec 1>&-
sleep 10
`,
		);
		const manifests = await discoverDaemonManifests(
			resolveModulesRoot(undefined, homeDir),
		);
		const manifest = manifests[0];
		if (!manifest) {
			throw new Error("Expected direct-stdout-failure manifest");
		}

		const queue = new EventQueue(path.join(homeDir, "events.db"));
		const daemon = await startDaemon(manifest, {
			queue,
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		queue.close();

		await expect(
			Promise.race([
				daemon.process.exited,
				delay(3_000).then(() => {
					throw new Error("daemon was not terminated");
				}),
			]),
		).resolves.toBeNumber();
		expect(daemon.state).toBe("failed");
	});

	test("keeps good daemons running when a later daemon fails to start", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(homeDir, "a-good", createModuleScript());
		await writeDaemonModule(
			homeDir,
			"z-bad",
			createModuleScript({ exitImmediately: true }),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		try {
			expect(runtime.daemons).toHaveLength(1);
			expect(runtime.daemons[0]?.manifest.name).toBe("a-good");
		} finally {
			await stopDaemons(runtime.daemons);
			runtime.eventQueue.close();
		}
	});

	test("kills a daemon when shutdown does not return", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"stubborn",
			createModuleScript({ ignoreShutdown: true }),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemon = runtime.daemons[0];
		expect(daemon).toBeDefined();

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();

		const processInfo = daemon?.process;
		expect(processInfo).toBeDefined();
		await expect(processInfo?.exited).resolves.toBeNumber();
	});

	test("does not restart a daemon during shutdown", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const startCountPath = path.join(homeDir, "shutdown-starts.txt");
		await writeDaemonModule(
			homeDir,
			"shutdown-no-restart",
			`#!/usr/bin/env bun
let starts = 0;
try {
	starts = Number(await Bun.file(${JSON.stringify(startCountPath)}).text());
} catch {}
starts += 1;
await Bun.write(${JSON.stringify(startCountPath)}, String(starts));
for await (const chunk of Bun.stdin.stream()) {
	const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
	if (message.method === "initialize") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
	} else if (message.method === "shutdown") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
		process.exit(0);
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
		await delay(100);

		expect(await readFile(startCountPath, "utf8")).toBe("1");
		expect(runtime.daemons[0]?.state).toBe("stopped");
	});

	test("removes a daemon from the registry when the restart also fails", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const startCountPath = path.join(homeDir, "restart-fails-starts.txt");
		await writeDaemonModule(
			homeDir,
			"restart-fails",
			`#!/usr/bin/env bun
let starts = 0;
try {
	starts = Number(await Bun.file(${JSON.stringify(startCountPath)}).text());
} catch {}
starts += 1;
await Bun.write(${JSON.stringify(startCountPath)}, String(starts));
for await (const chunk of Bun.stdin.stream()) {
	const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
	if (message.method === "initialize") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
		process.exit(0);
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(async () => {
			return (
				(await readFile(startCountPath, "utf8")) === "2" &&
				runtime.daemons.length === 0
			);
		});
		expect(runtime.daemons).toHaveLength(0);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("does not restart after the runtime abort signal is already aborted", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const startCountPath = path.join(homeDir, "aborted-restart-starts.txt");
		const triggerPath = path.join(homeDir, "trigger-exit");
		await writeDaemonModule(
			homeDir,
			"aborted-restart",
			`#!/usr/bin/env bun
let starts = 0;
try {
	starts = Number(await Bun.file(${JSON.stringify(startCountPath)}).text());
} catch {}
starts += 1;
await Bun.write(${JSON.stringify(startCountPath)}, String(starts));
for await (const chunk of Bun.stdin.stream()) {
	const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
	if (message.method === "initialize") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
		while (!(await Bun.file(${JSON.stringify(triggerPath)}).exists())) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		process.exit(0);
	} else if (message.method === "shutdown") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
		process.exit(0);
	}
}
`,
		);
		const abortController = new AbortController();

		const runtime = await bootstrapRuntime({
			abortSignal: abortController.signal,
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		abortController.abort();
		await writeFile(triggerPath, "exit");
		await waitUntil(() => runtime.daemons[0]?.state === "failed");
		await delay(100);

		expect(await readFile(startCountPath, "utf8")).toBe("1");
		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("does not let a pending restart outlive stopDaemons", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const startCountPath = path.join(homeDir, "pending-restart-starts.txt");
		await writeDaemonModule(
			homeDir,
			"pending-restart",
			`#!/usr/bin/env bun
let starts = 0;
try {
	starts = Number(await Bun.file(${JSON.stringify(startCountPath)}).text());
} catch {}
starts += 1;
await Bun.write(${JSON.stringify(startCountPath)}, String(starts));
for await (const chunk of Bun.stdin.stream()) {
	const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
	if (message.method === "initialize") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
		process.exit(0);
	} else if (message.method === "shutdown") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
		process.exit(0);
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) => {
				const startCount = Number(
					await readFile(startCountPath, "utf8").catch(() => "0"),
				);
				if (startCount === 1) {
					await delay(250);
				}
				return createUnsandboxedSpec(manifest.moduleDir, manifest.execPath);
			},
		});

		await waitUntil(async () => {
			return (
				(await readFile(startCountPath, "utf8")) === "1" &&
				runtime.daemons[0]?.state === "failed"
			);
		});
		const originalDaemon = runtime.daemons[0];
		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();

		expect(runtime.daemons[0]).toBe(originalDaemon);
		expect(runtime.daemons[0]?.state).toBe("stopped");
		expect(await readFile(startCountPath, "utf8")).toBe("1");
	});

	test("waits for a daemon to exit after a shutdown response", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const cleanupMarker = path.join(homeDir, "shutdown-cleanup.txt");
		await writeDaemonModule(
			homeDir,
			"async-shutdown",
			`#!/usr/bin/env bun
const chunks = [];
for await (const chunk of Bun.stdin.stream()) {
	chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8");
	const lines = text.split(/\\r?\\n/);
	while (lines.length > 1) {
		const line = lines.shift();
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.method === "initialize") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
		} else if (message.method === "shutdown") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
			await new Promise((resolve) => setTimeout(resolve, 100));
			await Bun.write(${JSON.stringify(cleanupMarker)}, "cleanup\\n");
			process.exit(0);
		}
	}
	chunks.length = 0;
	if (lines[0]) {
		chunks.push(Buffer.from(lines[0]));
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();

		await expect(readFile(cleanupMarker, "utf8")).resolves.toContain("cleanup");
	});

	test("kills a daemon with SIGKILL when it ignores shutdown and SIGTERM", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"sigkill-stubborn",
			createModuleScript({ ignoreShutdown: true, ignoreTerminate: true }),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemon = runtime.daemons[0];
		expect(daemon).toBeDefined();

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
		await expect(daemon?.process.exited).resolves.toBeNumber();
	});

	test("terminates daemon child processes on shutdown", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const childPidPath = path.join(homeDir, "child.pid");
		await writeDaemonModule(
			homeDir,
			"child-spawner",
			`#!/usr/bin/env bun
const child = Bun.spawn(["sleep", "10"]);
await Bun.write(${JSON.stringify(childPidPath)}, String(child.pid));
for await (const chunk of Bun.stdin.stream()) {
	const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
	if (message.method === "initialize") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
	} else if (message.method === "shutdown") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
		setInterval(() => {}, 1000);
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const childPid = Number(await readFile(childPidPath, "utf8"));
		expect(childPid).toBeGreaterThan(0);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();

		await waitUntil(() => {
			try {
				process.kill(childPid, 0);
				return false;
			} catch {
				return true;
			}
		});
	});

	test("terminates daemon child processes after graceful daemon exit", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const childPidPath = path.join(homeDir, "graceful-child.pid");
		await writeDaemonModule(
			homeDir,
			"graceful-child-spawner",
			`#!/bin/sh
sleep 10 &
echo "$!" > ${childPidPath}
IFS= read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
IFS= read -r line
echo '{"jsonrpc":"2.0","id":2,"result":"ok"}'
exit 0
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const childPid = Number(await readFile(childPidPath, "utf8"));
		expect(childPid).toBeGreaterThan(0);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();

		await waitUntil(() => {
			try {
				process.kill(childPid, 0);
				return false;
			} catch {
				return true;
			}
		});
	});

	test("prefixes module stderr output", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"stderr-module",
			createModuleScript({ stderrLine: "booted" }),
		);

		const messages: string[] = [];
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => {
			messages.push(args.join(" "));
		};

		try {
			const runtime = await bootstrapRuntime({
				homeDir,
				eventQueuePath: path.join(homeDir, "events.db"),
				...createSessionContext(homeDir),
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			});
			await stopDaemons(runtime.daemons);
			runtime.eventQueue.close();
		} finally {
			console.error = originalConsoleError;
		}

		expect(
			messages.some((message) => message.includes("[stderr-module] booted")),
		).toBe(true);
	});

	test("enqueues event.v1 notifications from daemon stdout", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"event-module",
			`#!/usr/bin/env bun
console.log(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "event.v1", kind: "message.received", text: "hello" } }));
for await (const chunk of Bun.stdin.stream()) {
	const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
	if (message.method === "initialize") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
	} else if (message.method === "shutdown") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
		process.exit(0);
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const queued = await runtime.eventQueue.next();
		expect(queued?.source).toBe("event-module");
		expect(queued?.params).toEqual({
			type: "event.v1",
			kind: "message.received",
			text: "hello",
		});
		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("resolveModulesRoot rejects empty HOME", () => {
		expect(() => resolveModulesRoot("", "")).toThrow(
			"HOME is not set and JUSTCLAW_HOME is not set",
		);
	});

	test("resolveModulesRoot prefers JUSTCLAW_HOME", () => {
		expect(resolveModulesRoot("/tmp/justclaw-home", "/tmp/ignored-home")).toBe(
			"/tmp/justclaw-home/modules",
		);
	});

	test("resolveModulesRoot returns an absolute path for relative JUSTCLAW_HOME", () => {
		expect(
			resolveModulesRoot("relative-justclaw-home", "/tmp/ignored-home"),
		).toBe(path.resolve("relative-justclaw-home", "modules"));
	});

	test("bootstrapRuntime respects JUSTCLAW_HOME", async () => {
		const justclawHome = await createTempDir("justclaw-home-override-");
		const originalJustclawHome = process.env.JUSTCLAW_HOME;
		const originalHome = process.env.HOME;
		process.env.JUSTCLAW_HOME = justclawHome;
		process.env.HOME = "/tmp/ignored-home";

		try {
			const moduleDir = path.join(justclawHome, "modules", "echo");
			await mkdir(moduleDir, { recursive: true });
			await writeFile(
				path.join(moduleDir, "module.json"),
				JSON.stringify({ name: "echo", exec: "./module.ts", mode: "daemon" }),
			);
			await writeFile(path.join(moduleDir, "module.ts"), createModuleScript());
			await chmod(path.join(moduleDir, "module.ts"), 0o755);

			const runtime = await bootstrapRuntime({
				eventQueuePath: path.join(justclawHome, "events.db"),
				...createSessionContext(justclawHome),
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			});
			expect(runtime.modulesRoot).toBe(path.join(justclawHome, "modules"));
			await stopDaemons(runtime.daemons);
			runtime.eventQueue.close();
		} finally {
			if (originalJustclawHome === undefined) {
				delete process.env.JUSTCLAW_HOME;
			} else {
				process.env.JUSTCLAW_HOME = originalJustclawHome;
			}
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	test("handles sessions.new.v1, sessions.list.v1, and sessions.get.v1 from a module", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-result.json");
		const historyDir = path.join(homeDir, "history");
		const sessionStore = new SessionStore(historyDir);
		const preExistingHistory = [{ role: "user", content: "hi" }];
		const existingId = "01900000-0000-7000-8000-00000000cafe";
		const unreadableId = "01900000-0000-7000-8000-00000000dead";
		await sessionStore.save(existingId, preExistingHistory as never);
		await writeFile(path.join(historyDir, `${unreadableId}.json`), "{");

		await writeDaemonModule(
			homeDir,
			"session-module",
			createJsonRpcStdinClientModuleScript(resultPath, [
				'const newResult = await sendRequest("sessions", { type: "sessions.new.v1" });',
				'const listResult = await sendRequest("sessions", { type: "sessions.list.v1" });',
				`const getResult = await sendRequest("sessions", { type: "sessions.get.v1", id: ${JSON.stringify(existingId)} });`,
				"await Bun.write(resultPath, JSON.stringify({ newResult, listResult, getResult }));",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			sessionStore,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			newResult: { id: string };
			listResult: { ids: string[] };
			getResult: { history: unknown[] };
		};

		expect(result.newResult.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(result.listResult.ids).toContain(result.newResult.id);
		expect(result.listResult.ids).toContain(existingId);
		expect(result.listResult.ids).not.toContain(unreadableId);
		expect(result.getResult.history).toEqual(preExistingHistory);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.get.v1 returns JSON-RPC error for invalid id format", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-get-invalid.json");

		await writeDaemonModule(
			homeDir,
			"session-get-invalid",
			createJsonRpcStdinClientModuleScript(resultPath, [
				"try {",
				'  await sendRequest("sessions", { type: "sessions.get.v1", id: "not-a-uuid" });',
				"  await Bun.write(resultPath, JSON.stringify({ ok: true }));",
				"} catch (e) {",
				"  await Bun.write(resultPath, JSON.stringify({ err: e instanceof Error ? e.message : String(e) }));",
				"}",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			ok?: boolean;
			err?: string;
		};

		expect(result.ok).toBeUndefined();
		expect(result.err).toContain("invalid session id");

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.get.v1 returns JSON-RPC error when session does not exist", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-get-missing.json");
		const missingId = "01900000-0000-7000-8000-00000000dead";

		await writeDaemonModule(
			homeDir,
			"session-get-missing",
			createJsonRpcStdinClientModuleScript(resultPath, [
				"try {",
				`  await sendRequest("sessions", { type: "sessions.get.v1", id: ${JSON.stringify(missingId)} });`,
				"  await Bun.write(resultPath, JSON.stringify({ ok: true }));",
				"} catch (e) {",
				"  await Bun.write(resultPath, JSON.stringify({ err: e instanceof Error ? e.message : String(e) }));",
				"}",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			ok?: boolean;
			err?: string;
		};

		expect(result.ok).toBeUndefined();
		expect(result.err).toContain("sessions.get.v1");
		expect(result.err).toContain("does not exist");

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.get.v1 returns JSON-RPC error when session file is unreadable", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-get-corrupt.json");
		const historyDir = path.join(homeDir, "history");
		const corruptId = "01900000-0000-7000-8000-00000000beef";
		await mkdir(historyDir, { recursive: true });
		await writeFile(path.join(historyDir, `${corruptId}.json`), "not-json");

		await writeDaemonModule(
			homeDir,
			"session-get-corrupt",
			createJsonRpcStdinClientModuleScript(resultPath, [
				"try {",
				`  await sendRequest("sessions", { type: "sessions.get.v1", id: ${JSON.stringify(corruptId)} });`,
				"  await Bun.write(resultPath, JSON.stringify({ ok: true }));",
				"} catch (e) {",
				"  await Bun.write(resultPath, JSON.stringify({ err: e instanceof Error ? e.message : String(e) }));",
				"}",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			ok?: boolean;
			err?: string;
		};

		expect(result.ok).toBeUndefined();
		expect(result.err).toContain("sessions.get.v1");
		expect(result.err).toContain("could not be read");

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.switch.v1 returns JSON-RPC error when session does not exist", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-switch-missing.json");
		const missingId = "01900000-0000-7000-8000-00000000dead";

		await writeDaemonModule(
			homeDir,
			"session-switch-missing",
			createJsonRpcStdinClientModuleScript(resultPath, [
				"try {",
				`  await sendRequest("sessions", { type: "sessions.switch.v1", id: ${JSON.stringify(missingId)} });`,
				"  await Bun.write(resultPath, JSON.stringify({ ok: true }));",
				"} catch (e) {",
				"  await Bun.write(resultPath, JSON.stringify({ err: e instanceof Error ? e.message : String(e) }));",
				"}",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			ok?: boolean;
			err?: string;
		};

		expect(result.ok).toBeUndefined();
		expect(result.err).toContain("sessions.switch.v1");
		expect(result.err).toContain("unreadable or does not exist");

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.active.v1 fails before any session is activated", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-active-result.json");
		const historyDir = path.join(homeDir, "history");
		const sessionStore = new SessionStore(historyDir);

		await writeDaemonModule(
			homeDir,
			"session-active-module",
			createJsonRpcStdinClientModuleScript(resultPath, [
				"try {",
				'  await sendRequest("sessions", { type: "sessions.active.v1" });',
				"  await Bun.write(resultPath, JSON.stringify({ ok: true }));",
				"} catch (e) {",
				"  await Bun.write(resultPath, JSON.stringify({ err: e instanceof Error ? e.message : String(e) }));",
				"}",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			sessionStore,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			ok?: boolean;
			err?: string;
		};

		expect(result.ok).toBeUndefined();
		expect(result.err).toContain("no active session");

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.active.v1 returns newest readable history id when LLM has not adopted", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-active-newest.json");
		const historyDir = path.join(homeDir, "history");
		const sessionStore = new SessionStore(historyDir);
		const older = "01900000-0000-7000-8000-000000000001";
		const newer = "01900000-0000-7000-8000-000000000002";
		await sessionStore.save(older, [] as never);
		await sessionStore.save(newer, [] as never);

		await writeDaemonModule(
			homeDir,
			"session-active-newest",
			createJsonRpcStdinClientModuleScript(resultPath, [
				'const activeResult = await sendRequest("sessions", { type: "sessions.active.v1" });',
				"await Bun.write(resultPath, JSON.stringify({ activeResult }));",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			sessionStore,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			activeResult: { id: string };
		};

		expect(result.activeResult.id).toBe(newer);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.active.v1 skips unreadable newest history id when LLM has not adopted", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(
			homeDir,
			"session-active-newest-readable.json",
		);
		const historyDir = path.join(homeDir, "history");
		const sessionStore = new SessionStore(historyDir);
		const readable = "01900000-0000-7000-8000-000000000001";
		const unreadableNewest = "01900000-0000-7000-8000-000000000002";
		await sessionStore.save(readable, [] as never);
		await writeFile(path.join(historyDir, `${unreadableNewest}.json`), "{");

		await writeDaemonModule(
			homeDir,
			"session-active-newest-readable",
			createJsonRpcStdinClientModuleScript(resultPath, [
				'const activeResult = await sendRequest("sessions", { type: "sessions.active.v1" });',
				"await Bun.write(resultPath, JSON.stringify({ activeResult }));",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			sessionStore,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			activeResult: { id: string };
		};

		expect(result.activeResult.id).toBe(readable);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.active.v1 returns meta active session id when readable", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-active-meta.json");
		const dbPath = path.join(homeDir, "events.db");
		const historyDir = path.join(homeDir, "history");
		const sessionStore = new SessionStore(historyDir);
		const older = "01900000-0000-7000-8000-000000000001";
		const newer = "01900000-0000-7000-8000-000000000002";
		await sessionStore.save(older, [] as never);
		await sessionStore.save(newer, [] as never);
		const seededQueue = new EventQueue(dbPath);
		seededQueue.setMeta("active_session_id", older);
		seededQueue.close();

		await writeDaemonModule(
			homeDir,
			"session-active-meta",
			createJsonRpcStdinClientModuleScript(resultPath, [
				'const activeResult = await sendRequest("sessions", { type: "sessions.active.v1" });',
				"await Bun.write(resultPath, JSON.stringify({ activeResult }));",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: dbPath,
			sessionStore,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			activeResult: { id: string };
		};

		expect(result.activeResult.id).toBe(older);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.new.v1 does not replace existing active session", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-new-keeps-active.json");
		const dbPath = path.join(homeDir, "events.db");
		const historyDir = path.join(homeDir, "history");
		const sessionStore = new SessionStore(historyDir);
		const activeId = "01900000-0000-7000-8000-000000000001";
		await sessionStore.save(activeId, [] as never);

		await writeDaemonModule(
			homeDir,
			"session-new-keeps-active",
			createJsonRpcStdinClientModuleScript(resultPath, [
				'const before = await sendRequest("sessions", { type: "sessions.active.v1" });',
				'const created = await sendRequest("sessions", { type: "sessions.new.v1" });',
				'const after = await sendRequest("sessions", { type: "sessions.active.v1" });',
				"await Bun.write(resultPath, JSON.stringify({ before, created, after }));",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: dbPath,
			sessionStore,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			before: { id: string };
			created: { id: string };
			after: { id: string };
		};

		expect(result.before.id).toBe(activeId);
		expect(result.created.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		expect(result.after.id).toBe(activeId);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.delete.v1 clears active metadata without auto-failover", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-delete-active.json");
		const dbPath = path.join(homeDir, "events.db");
		const historyDir = path.join(homeDir, "history");
		const sessionStore = new SessionStore(historyDir);
		const activeId = "01900000-0000-7000-8000-000000000001";
		await sessionStore.save(activeId, [] as never);
		const fallbackId = "01900000-0000-7000-8000-000000000002";
		await sessionStore.save(fallbackId, [] as never);
		const seededQueue = new EventQueue(dbPath);
		seededQueue.setMeta("active_session_id", activeId);
		seededQueue.close();

		await writeDaemonModule(
			homeDir,
			"session-delete-active",
			createJsonRpcStdinClientModuleScript(resultPath, [
				`await sendRequest("sessions", { type: "sessions.delete.v1", id: ${JSON.stringify(activeId)} });`,
				'const active = await sendRequest("sessions", { type: "sessions.active.v1" });',
				"await Bun.write(resultPath, JSON.stringify({ active }));",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: dbPath,
			sessionStore,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			active: { id: string };
		};

		expect(result.active.id).toBe(fallbackId);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.active.v1 falls back when active_session_id is invalid", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-active-invalid-meta.json");
		const dbPath = path.join(homeDir, "events.db");
		const historyDir = path.join(homeDir, "history");
		const sessionStore = new SessionStore(historyDir);
		const fallbackId = "01900000-0000-7000-8000-000000000002";
		await sessionStore.save(
			"01900000-0000-7000-8000-000000000001",
			[] as never,
		);
		await sessionStore.save(fallbackId, [] as never);
		const seededQueue = new EventQueue(dbPath);
		seededQueue.setMeta("active_session_id", "not-a-uuid");
		seededQueue.close();

		await writeDaemonModule(
			homeDir,
			"session-active-invalid-meta",
			createJsonRpcStdinClientModuleScript(resultPath, [
				'const activeResult = await sendRequest("sessions", { type: "sessions.active.v1" });',
				"await Bun.write(resultPath, JSON.stringify({ activeResult }));",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: dbPath,
			sessionStore,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());
		const result = JSON.parse(await readFile(resultPath, "utf8")) as {
			activeResult: { id: string };
		};

		expect(result.activeResult.id).toBe(fallbackId);

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("sessions.switch.v1 request is applied before subsequent event.v1 is processed by LLM loop", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const resultPath = path.join(homeDir, "session-switch-result.json");
		const historyDir = path.join(homeDir, "history");
		const sessionStore = new SessionStore(historyDir);
		const sessionId = "01900000-0000-7000-8000-00000000000b";
		const savedHistory: AgentInputItem[] = [
			{ role: "user", content: "hello from session B" } as AgentInputItem,
		];
		await sessionStore.save(sessionId, savedHistory);

		await writeDaemonModule(
			homeDir,
			"session-switch-module",
			createJsonRpcStdinClientModuleScript(resultPath, [
				`const switchResult = await sendRequest("sessions", { type: "sessions.switch.v1", id: ${JSON.stringify(sessionId)} });`,
				'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "event.v1", kind: "after-switch" } }) + "\\n");',
				"await Bun.write(resultPath, JSON.stringify({ switchResult }));",
			]),
		);

		let runtime:
			| {
					daemons: StartedDaemon[];
					eventQueue: EventQueue;
			  }
			| undefined;
		let loopTask: Promise<void> | undefined;

		try {
			runtime = await bootstrapRuntime({
				homeDir,
				eventQueuePath: path.join(homeDir, "events.db"),
				sessionStore,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			});

			await waitUntil(() => Bun.file(resultPath).exists());
			const moduleResult = JSON.parse(await readFile(resultPath, "utf8")) as {
				switchResult: string;
			};
			expect(moduleResult.switchResult).toBe("ok");

			let capturedInput: unknown;
			let runnerCallCount = 0;
			const mockRunner = {
				run: async (_agent: unknown, input: unknown) => {
					runnerCallCount++;
					capturedInput = input;
					return {
						finalOutput: null,
						history: savedHistory,
					};
				},
			} as unknown as Runner;

			loopTask = runLlmLoop(
				runtime.eventQueue,
				{ current: runtime.daemons },
				"test-model",
				{
					runner: mockRunner,
					sessionStore,
				},
			);

			await waitUntil(() => capturedInput !== undefined);

			expect(runnerCallCount).toBe(1);
			expect(Array.isArray(capturedInput)).toBe(true);
			const input = capturedInput as AgentInputItem[];
			expect(input[0]).toMatchObject({
				role: "user",
				content: "hello from session B",
			});
			const xmlInput = input[input.length - 1];
			expect(xmlInput).toMatchObject({
				role: "user",
			});
			expect(String((xmlInput as { content?: unknown }).content)).toContain(
				"<kind>after-switch</kind>",
			);
		} finally {
			runtime?.eventQueue.close();
			await loopTask;
			if (runtime) {
				await stopDaemons(runtime.daemons);
			}
		}
	});

	test("cleanup marker is absent before shutdown side effect runs", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const cleanupMarker = path.join(homeDir, "cleanup-marker.txt");
		await writeDaemonModule(
			homeDir,
			"idle",
			createModuleScript({
				shutdownSideEffectPath: cleanupMarker,
			}),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...createSessionContext(homeDir),
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		await expect(stat(cleanupMarker)).rejects.toThrow();
		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});
});

describe("INIT.md startup hook", () => {
	test("enqueues INIT event before ok when switching to a new empty session", async () => {
		const homeDir = await createTempDir("justclaw-init-switch-");
		const resultPath = path.join(homeDir, "result.json");
		const historyDir = path.join(homeDir, "history");
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await writeFile(path.join(characterDir, "INIT.md"), "run startup tasks");
		const sessionStore = new SessionStore(historyDir);
		await sessionStore.ensureDefaultSessionIfEmpty();

		await writeRawModule(
			homeDir,
			"mod",
			JSON.stringify({
				name: "mod",
				exec: "./module.ts",
				mode: "daemon",
				replyable: true,
			}),
			createJsonRpcStdinClientModuleScript(resultPath, [
				'const newId = (await sendRequest("sessions", { type: "sessions.new.v1" })).id;',
				`await sendRequest("sessions", { type: "sessions.switch.v1", id: newId });`,
				'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "event.v1", kind: "user-event" } }) + "\\n");',
				"await Bun.write(resultPath, JSON.stringify({ done: true }));",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			sessionStore,
			characterDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());

		const processedTexts: string[] = [];
		const mockRunner = {
			run: async (_agent: unknown, input: unknown) => {
				const text = typeof input === "string" ? input : JSON.stringify(input);
				processedTexts.push(text);
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(
			runtime.eventQueue,
			{ current: runtime.daemons },
			"test-model",
			{ runner: mockRunner, sessionStore, characterDir },
		);

		await waitUntil(() => processedTexts.length >= 2);
		runtime.eventQueue.close();
		await loopTask;
		await stopDaemons(runtime.daemons);

		// INIT runs before the user event
		expect(processedTexts[0]).toContain("run startup tasks");
		expect(processedTexts[1]).toContain("user-event");
	});

	test("does not enqueue INIT when switching to a non-empty session", async () => {
		const homeDir = await createTempDir("justclaw-init-nonempty-");
		const resultPath = path.join(homeDir, "result.json");
		const historyDir = path.join(homeDir, "history");
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await writeFile(path.join(characterDir, "INIT.md"), "run startup tasks");
		const sessionStore = new SessionStore(historyDir);
		const existingId = "01900000-0000-7000-8000-00000000000c";
		await sessionStore.save(existingId, [
			{ role: "user", content: "prior history" } as AgentInputItem,
		]);
		await sessionStore.ensureDefaultSessionIfEmpty();

		await writeRawModule(
			homeDir,
			"mod",
			JSON.stringify({
				name: "mod",
				exec: "./module.ts",
				mode: "daemon",
				replyable: true,
			}),
			createJsonRpcStdinClientModuleScript(resultPath, [
				`await sendRequest("sessions", { type: "sessions.switch.v1", id: ${JSON.stringify(existingId)} });`,
				'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "event.v1", kind: "user-event" } }) + "\\n");',
				"await Bun.write(resultPath, JSON.stringify({ done: true }));",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			sessionStore,
			characterDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());

		const processedTexts: string[] = [];
		const mockRunner = {
			run: async (_agent: unknown, input: unknown) => {
				const text = typeof input === "string" ? input : JSON.stringify(input);
				processedTexts.push(text);
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(
			runtime.eventQueue,
			{ current: runtime.daemons },
			"test-model",
			{ runner: mockRunner, sessionStore, characterDir },
		);

		await waitUntil(() => processedTexts.length >= 1);
		await delay(100); // ensure no extra INIT event arrives
		runtime.eventQueue.close();
		await loopTask;
		await stopDaemons(runtime.daemons);

		expect(processedTexts).toHaveLength(1);
		expect(processedTexts[0]).toContain("user-event");
		expect(processedTexts[0]).not.toContain("run startup tasks");
	});

	test("does not enqueue INIT when INIT.md is absent", async () => {
		const homeDir = await createTempDir("justclaw-init-absent-");
		const resultPath = path.join(homeDir, "result.json");
		const historyDir = path.join(homeDir, "history");
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		// No INIT.md written
		const sessionStore = new SessionStore(historyDir);
		await sessionStore.ensureDefaultSessionIfEmpty();

		await writeRawModule(
			homeDir,
			"mod",
			JSON.stringify({
				name: "mod",
				exec: "./module.ts",
				mode: "daemon",
				replyable: true,
			}),
			createJsonRpcStdinClientModuleScript(resultPath, [
				'const newId = (await sendRequest("sessions", { type: "sessions.new.v1" })).id;',
				`await sendRequest("sessions", { type: "sessions.switch.v1", id: newId });`,
				'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "event.v1", kind: "user-event" } }) + "\\n");',
				"await Bun.write(resultPath, JSON.stringify({ done: true }));",
			]),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			sessionStore,
			characterDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => Bun.file(resultPath).exists());

		const processedTexts: string[] = [];
		const mockRunner = {
			run: async (_agent: unknown, input: unknown) => {
				const text = typeof input === "string" ? input : JSON.stringify(input);
				processedTexts.push(text);
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(
			runtime.eventQueue,
			{ current: runtime.daemons },
			"test-model",
			{ runner: mockRunner, sessionStore, characterDir },
		);

		await waitUntil(() => processedTexts.length >= 1);
		await delay(100);
		runtime.eventQueue.close();
		await loopTask;
		await stopDaemons(runtime.daemons);

		expect(processedTexts).toHaveLength(1);
		expect(processedTexts[0]).toContain("user-event");
	});
});

describe("runLlmLoop restart_modules integration", () => {
	const toolSchema = {
		type: "object",
		properties: {},
		additionalProperties: false,
	};

	test("restart_modules with text enqueues one continuation event.v1", async () => {
		const homeDir = await createTempDir("justclaw-llm-rst-text-");
		await writeDaemonModule(homeDir, "mod", createModuleScript());
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("mod", { type: "event.v1", kind: "first" });

		const rc = new RunContext();
		let runCount = 0;
		const mockRunner = {
			run: async (agent: Agent) => {
				runCount++;
				const restart = findRestartModulesTool(agent);
				if (runCount === 1) {
					const out = await restart.invoke(
						rc,
						JSON.stringify({ continuation: "continue" }),
					);
					expect(String(out)).toContain("ok:");
				}
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => runCount >= 2);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		expect(runCount).toBe(2);
	});

	test("restart_modules without text does not enqueue a follow-up event", async () => {
		const homeDir = await createTempDir("justclaw-llm-rst-notext-");
		await writeDaemonModule(homeDir, "mod", createModuleScript());
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("mod", { type: "event.v1", kind: "first" });

		const rc = new RunContext();
		let runCount = 0;
		const mockRunner = {
			run: async (agent: Agent) => {
				runCount++;
				const restart = findRestartModulesTool(agent);
				if (runCount === 1) {
					await restart.invoke(rc, JSON.stringify({ continuation: "" }));
				}
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await delay(120);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		expect(runCount).toBe(1);
	});

	test("restart_modules does not enqueue after reload failure", async () => {
		const homeDir = await createTempDir("justclaw-llm-rst-fail-");
		await writeDaemonModule(homeDir, "mod", createModuleScript());
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("mod", { type: "event.v1", kind: "first" });

		const badRoot = path.join(homeDir, "not-a-modules-dir");
		const rc = new RunContext();
		let runCount = 0;
		const mockRunner = {
			run: async (agent: Agent) => {
				runCount++;
				const restart = findRestartModulesTool(agent);
				if (runCount === 1) {
					const out = await restart.invoke(
						rc,
						JSON.stringify({ continuation: "should-not-queue" }),
					);
					expect(String(out)).toContain("error:");
				}
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: badRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await delay(120);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		expect(runCount).toBe(1);
	});

	test("next event uses reloaded module set in instructions and tools", async () => {
		const homeDir = await createTempDir("justclaw-llm-rst-prompt-");
		const initV1 = JSON.stringify({
			tools: [
				{
					name: "oldtool",
					description: "x",
					parameters: toolSchema,
				},
			],
		});
		const initV2 = JSON.stringify({
			tools: [
				{
					name: "newtool",
					description: "y",
					parameters: toolSchema,
				},
			],
		});
		await writeDaemonModule(
			homeDir,
			"v1",
			createModuleScript({ initializeResponse: initV1 }),
		);
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();

		await rm(path.join(runtime.modulesRoot, "v1"), { recursive: true });
		await writeDaemonModule(
			homeDir,
			"v2",
			createModuleScript({ initializeResponse: initV2 }),
		);

		queue.enqueue("v1", { type: "event.v1", kind: "k" });

		const rc = new RunContext();
		const instructions: string[] = [];
		let runCount = 0;
		const mockRunner = {
			run: async (agent: Agent) => {
				instructions.push(
					typeof agent.instructions === "string" ? agent.instructions : "",
				);
				runCount++;
				const restart = findRestartModulesTool(agent);
				if (runCount === 1) {
					await restart.invoke(rc, JSON.stringify({ continuation: "go" }));
				}
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => runCount >= 2);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		expect(instructions[0]).toContain("| v1 |");
		expect(instructions[0]).toContain("oldtool");
		expect(instructions[1]).toContain("| v2 |");
		expect(instructions[1]).toContain("newtool");
		expect(instructions[1]).not.toContain("| v1 |");
	});

	test("after restart_modules, route_message tool is still available", async () => {
		const homeDir = await createTempDir("justclaw-llm-rst-stale-send-");
		await writeRawModule(
			homeDir,
			"mod",
			JSON.stringify({
				name: "mod",
				exec: "./module.ts",
				mode: "daemon",
				replyable: true,
			}),
			createModuleScript(),
		);
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("mod", { type: "event.v1", kind: "k" });

		const rc = new RunContext();
		const mockRunner = {
			run: async (agent: Agent) => {
				await findRestartModulesTool(agent).invoke(
					rc,
					JSON.stringify({ continuation: "" }),
				);
				const out = await findFunctionTool(agent, "route_message").invoke(
					rc,
					JSON.stringify({ module: "mod", text: "hi" }),
				);
				// "mod" is the current delivery target; guard rejects routing to self
				expect(String(out)).toContain("already the current delivery target");
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await delay(200);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);
	});

	test("after restart_modules, empty finalOutput matches a terminated LLM turn", async () => {
		const homeDir = await createTempDir("justclaw-llm-rst-no-final-");
		await writeRawModule(
			homeDir,
			"mod",
			JSON.stringify({
				name: "mod",
				exec: "./module.ts",
				mode: "daemon",
				replyable: true,
			}),
			createModuleScript(),
		);
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("mod", { type: "event.v1", kind: "k" });

		const rc = new RunContext();
		const sends: unknown[] = [];
		const mockRunner = {
			run: async (agent: Agent) => {
				await findRestartModulesTool(agent).invoke(
					rc,
					JSON.stringify({ continuation: "" }),
				);
				for (const d of daemonsRef.current) {
					const orig = d.peer.notify.bind(d.peer);
					d.peer.notify = (method: string, params: unknown) => {
						if (
							method === "event" &&
							typeof params === "object" &&
							params !== null &&
							(params as { type?: string }).type === "message.send.v1"
						) {
							sends.push(params);
						}
						return orig(method, params);
					};
				}
				// Real Runner ends the turn with finalOutput "" after successful restart_modules.
				return { finalOutput: "", history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await delay(200);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		expect(sends).toHaveLength(0);
	});

	// restart_modules stops old module processes immediately (SIGINT). Any tool calls that reach
	// a stopped process in the same LLM turn fail with a process error — this is the expected
	// behavior. Cleanup on SIGINT is the module's responsibility, not the core's.
	test("tool calls to old modules in the same turn fail naturally after restart_modules", async () => {
		const homeDir = await createTempDir("justclaw-llm-rst-stopped-peer-");
		await writeDaemonModule(homeDir, "mod", createModuleScriptWithPingTool());
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("mod", { type: "event.v1", kind: "k" });

		const rc = new RunContext();
		const mockRunner = {
			run: async (agent: Agent) => {
				await findRestartModulesTool(agent).invoke(
					rc,
					JSON.stringify({ continuation: "" }),
				);
				// Simulates a parallel tool call to the now-stopped old module.
				const out = await findFunctionTool(agent, "mod__ping").invoke(rc, "{}");
				expect(String(out)).toMatch(/stdout closed unexpectedly/);
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await delay(200);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);
	});
});

describe("route_message", () => {
	test("returns error when routing to the current delivery target", async () => {
		const homeDir = await createTempDir("justclaw-llm-route-self-");
		await writeRawModule(
			homeDir,
			"mod",
			JSON.stringify({
				name: "mod",
				exec: "./module.ts",
				mode: "daemon",
				replyable: true,
			}),
			createModuleScript(),
		);
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("mod", { type: "event.v1", kind: "k" });

		const rc = new RunContext();
		let result: unknown;
		const mockRunner = {
			run: async (agent: Agent) => {
				result = await findFunctionTool(agent, "route_message").invoke(
					rc,
					JSON.stringify({ module: "mod", text: "hi" }),
				);
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await delay(120);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		expect(String(result)).toContain("already the current delivery target");
	});

	test("returns error when target module is not replyable", async () => {
		const homeDir = await createTempDir("justclaw-llm-route-nonreplyable-");
		await writeRawModule(
			homeDir,
			"src",
			JSON.stringify({
				name: "src",
				exec: "./module.ts",
				mode: "daemon",
				replyable: true,
			}),
			createModuleScript(),
		);
		await writeDaemonModule(homeDir, "sink", createModuleScript());
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("src", { type: "event.v1", kind: "k" });

		const rc = new RunContext();
		let result: unknown;
		const mockRunner = {
			run: async (agent: Agent) => {
				result = await findFunctionTool(agent, "route_message").invoke(
					rc,
					JSON.stringify({ module: "sink", text: "hi" }),
				);
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await delay(120);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		expect(String(result)).toBe('error: module "sink" is not replyable');
	});

	test("succeeds when routing to a different replyable module", async () => {
		const homeDir = await createTempDir("justclaw-llm-route-replyable-");
		await writeRawModule(
			homeDir,
			"src",
			JSON.stringify({
				name: "src",
				exec: "./module.ts",
				mode: "daemon",
				replyable: true,
			}),
			createModuleScript(),
		);
		await writeRawModule(
			homeDir,
			"dst",
			JSON.stringify({
				name: "dst",
				exec: "./module.ts",
				mode: "daemon",
				replyable: true,
			}),
			createModuleScript(),
		);
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("src", { type: "event.v1", kind: "k" });

		const rc = new RunContext();
		let result: unknown;
		const mockRunner = {
			run: async (agent: Agent) => {
				result = await findFunctionTool(agent, "route_message").invoke(
					rc,
					JSON.stringify({ module: "dst", text: "hi" }),
				);
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await delay(120);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		expect(result).toBe("ok");
	});
});

describe("turn_end", () => {
	test("tool is available in agent and returns ok", async () => {
		const homeDir = await createTempDir("justclaw-llm-turn-end-");
		await writeDaemonModule(homeDir, "mod", createModuleScript());
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("mod", { type: "event.v1", kind: "background-task" });
		const notifications: unknown[] = [];
		const daemon = daemonsRef.current[0];
		if (!daemon) {
			throw new Error("expected started daemon");
		}
		const origNotify = daemon.peer.notify.bind(daemon.peer);
		daemon.peer.notify = (method: string, params: unknown) => {
			if (method === "event") {
				notifications.push(params);
			}
			return origNotify(method, params);
		};

		const rc = new RunContext();
		let toolResult: unknown;
		const mockRunner = {
			run: async (agent: Agent) => {
				toolResult = await findFunctionTool(agent, "turn_end").invoke(
					rc,
					JSON.stringify({}),
				);
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await delay(120);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		expect(toolResult).toBe("ok");
		expect(notifications).toContainEqual({
			type: "tool_call.v1",
			tool: "turn_end",
			input: {},
			output: "ok",
		});
	});
});

describe("module tool media results", () => {
	test("converts reserved json, image, and file results for the LLM", async () => {
		process.env.JUSTCLAW_OPENAI_API = "responses";
		const homeDir = await createTempDir("justclaw-llm-module-media-");
		const imagePath = path.join(homeDir, "image.png");
		const filePath = path.join(homeDir, "note.txt");
		const imageBytes = Buffer.from("image-bytes");
		const fileBytes = Buffer.from("file-bytes");
		await writeFile(imagePath, imageBytes);
		await writeFile(filePath, fileBytes);
		const initializeResponse = JSON.stringify({
			tools: [
				{
					name: "media",
					description: "return media",
					parameters: {
						type: "object",
						properties: { kind: { type: "string" } },
						required: ["kind"],
						additionalProperties: false,
					},
				},
			],
		});
		await writeDaemonModule(
			homeDir,
			"mod",
			`#!/usr/bin/env bun
const lines = [];
for await (const chunk of Bun.stdin.stream()) {
	lines.push(chunk);
	const text = Buffer.concat(lines).toString("utf8");
	const inputLines = text.split(/\\r?\\n/);
	while (inputLines.length > 1) {
		const line = inputLines.shift();
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.method === "initialize") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: ${initializeResponse} }));
		} else if (message.method === "shutdown") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
			process.exit(0);
		} else if (message.method === "tool/media") {
			if (message.params.kind === "json") {
				console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { type: "json", data: { ok: true } } }));
			} else if (message.params.kind === "image") {
				console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { type: "image", image: { data: ${JSON.stringify(imageBytes.toString("base64"))}, mediaType: "image/png", link: ${JSON.stringify(imagePath)} } } }));
			} else {
				console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { type: "file", file: { data: ${JSON.stringify(fileBytes.toString("base64"))}, mediaType: "text/plain", filename: "note.txt", link: ${JSON.stringify(filePath)} } } }));
			}
		}
	}
	lines.length = 0;
	if (inputLines[0]) lines.push(Buffer.from(inputLines[0]));
}
`,
		);
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("mod", { type: "event.v1", kind: "k" });

		const rc = new RunContext();
		let jsonResult: unknown;
		let imageResult: unknown;
		let fileResult: unknown;
		const mockRunner = {
			run: async (agent: Agent) => {
				const media = findFunctionTool(agent, "mod__media");
				jsonResult = await media.invoke(rc, JSON.stringify({ kind: "json" }));
				imageResult = await media.invoke(rc, JSON.stringify({ kind: "image" }));
				fileResult = await media.invoke(rc, JSON.stringify({ kind: "file" }));
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await delay(200);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		const imageSha = new Bun.CryptoHasher("sha256")
			.update(imageBytes)
			.digest("hex");
		const fileSha = new Bun.CryptoHasher("sha256")
			.update(fileBytes)
			.digest("hex");
		expect(jsonResult).toBe(JSON.stringify({ ok: true }));
		expect(imageResult).toEqual({
			type: "image",
			image: {
				data: imageBytes.toString("base64"),
				mediaType: "image/png",
				size: imageBytes.byteLength,
				sha256: imageSha,
				link: imagePath,
			},
			providerData: {
				justclaw: {
					metadata: {
						type: "image",
						mediaType: "image/png",
						size: imageBytes.byteLength,
						sha256: imageSha,
						link: imagePath,
						attachable: true,
					},
				},
			},
		});
		expect(fileResult).toEqual({
			type: "file",
			file: {
				data: fileBytes.toString("base64"),
				mediaType: "text/plain",
				filename: "note.txt",
				size: fileBytes.byteLength,
				sha256: fileSha,
				link: filePath,
			},
			providerData: {
				justclaw: {
					metadata: {
						type: "file",
						filename: "note.txt",
						mediaType: "text/plain",
						size: fileBytes.byteLength,
						sha256: fileSha,
						link: filePath,
						attachable: true,
					},
				},
			},
		});
	});
});

describe("module tool without parameters", () => {
	test("a tool omitting parameters is usable and later events still process", async () => {
		const homeDir = await createTempDir("justclaw-llm-no-params-");
		await writeDaemonModule(
			homeDir,
			"mod",
			createModuleScript({
				initializeResponse: JSON.stringify({ tools: [{ name: "ping" }] }),
			}),
		);
		const ctx = createSessionContext(homeDir);
		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: path.join(homeDir, "events.db"),
			...ctx,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		// parseInitializeResult must default the missing "parameters" field so the
		// SDK's tool() call below (buildModuleTools, outside the per-event try) does
		// not throw "Input type is not a ZodObject or a valid JSON schema".
		expect(runtime.daemons[0]?.tools).toHaveLength(1);
		expect(runtime.daemons[0]?.tools[0]?.name).toBe("ping");
		expect(runtime.daemons[0]?.tools[0]?.parameters).toEqual({
			type: "object",
			properties: {},
		});

		const daemonsRef = { current: runtime.daemons };
		const queue = runtime.eventQueue;
		const characterDir = path.join(homeDir, "character");
		await mkdir(characterDir, { recursive: true });
		await ctx.sessionStore.ensureDefaultSessionIfEmpty();
		queue.enqueue("mod", { type: "event.v1", kind: "first" });
		queue.enqueue("mod", { type: "event.v1", kind: "second" });

		let runCount = 0;
		const mockRunner = {
			run: async (agent: Agent) => {
				runCount++;
				findFunctionTool(agent, "mod__ping");
				return { finalOutput: null, history: [] };
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemonsRef, "test-model", {
			runner: mockRunner,
			sessionStore: ctx.sessionStore,
			workspaceDir: "/tmp/ws",
			historyDir: path.join(homeDir, "history"),
			characterDir,
			modulesRoot: runtime.modulesRoot,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await waitUntil(() => runCount >= 2);
		queue.close();
		await loopTask;
		await stopDaemons(daemonsRef.current);

		expect(runCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// fireTimer
// ---------------------------------------------------------------------------

function createTimerScript(
	event: Record<string, unknown> = { kind: "tick", text: "fired" },
): string {
	return `#!/usr/bin/env bun
const event = ${JSON.stringify(event)};
const lines = [];
for await (const chunk of Bun.stdin.stream()) {
  lines.push(chunk);
  const text = Buffer.concat(lines).toString("utf8");
  const inputLines = text.split(/\\r?\\n/);
  while (inputLines.length > 1) {
    const line = inputLines.shift();
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "event.v1", ...event } }) + "\\n");
      process.exit(0);
    }
  }
  lines.length = 0;
  if (inputLines[0]) lines.push(Buffer.from(inputLines[0]));
}
`;
}

async function writeTimerModule(
	homeDir: string,
	moduleName: string,
	script: string,
): Promise<TimerModuleManifest> {
	const modulesRoot = resolveModulesRoot(undefined, homeDir);
	const moduleDir = path.join(modulesRoot, moduleName);
	await mkdir(moduleDir, { recursive: true });
	await writeFile(
		path.join(moduleDir, "module.json"),
		JSON.stringify({
			name: moduleName,
			mode: "timer",
			exec: "./module.ts",
			cron: "* * * * *",
		}),
	);
	const scriptPath = path.join(moduleDir, "module.ts");
	await writeFile(scriptPath, script);
	await chmod(scriptPath, 0o755);
	return {
		name: moduleName,
		mode: "timer",
		exec: "./module.ts",
		moduleDir,
		execPath: scriptPath,
		cron: "* * * * *",
	};
}

describe("fireTimer", () => {
	test("emits event to queue when module fires and exits", async () => {
		const homeDir = await createTempDir("justclaw-timer-fire-");
		const ctx = createSessionContext(homeDir);
		const queue = new EventQueue(path.join(homeDir, "events.db"));
		const manifest = await writeTimerModule(
			homeDir,
			"tick",
			createTimerScript({ kind: "tick", text: "hello" }),
		);
		const state: { process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null } = {
			process: null,
		};

		try {
			// Register waiter before firing so enqueue() delivers as 'running'
			const eventPromise = queue.next();
			await fireTimer(manifest, state, queue, ctx.sessionStore, {
				sandboxFactory: async (m) =>
					createUnsandboxedSpec(m.moduleDir, m.execPath),
			});

			const event = await eventPromise;
			expect(event?.source).toBe("tick");
			expect(event?.params.type).toBe("event.v1");
			expect(event?.params.text).toBe("hello");
		} finally {
			queue.close();
		}
	});

	test("kills previous process before spawning when fired again", async () => {
		const homeDir = await createTempDir("justclaw-timer-kill-");
		const ctx = createSessionContext(homeDir);
		const queue = new EventQueue(path.join(homeDir, "events.db"));
		const manifest = await writeTimerModule(
			homeDir,
			"tick",
			createTimerScript(),
		);

		// Pre-populate state with a hanging process to simulate a previous run still active
		const prevProc = Bun.spawn({
			cmd: ["sleep", "30"],
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const state = {
			process: prevProc as unknown as Bun.Subprocess<
				"pipe",
				"pipe",
				"pipe"
			> | null,
		};

		try {
			const eventPromise = queue.next();
			await fireTimer(manifest, state, queue, ctx.sessionStore, {
				sandboxFactory: async (m) =>
					createUnsandboxedSpec(m.moduleDir, m.execPath),
			});

			// Previous process must have been killed
			await expect(prevProc.exited).resolves.toBeNumber();
			// New run emits its event
			const event = await eventPromise;
			expect(event?.source).toBe("tick");
		} finally {
			queue.close();
			if (prevProc.exitCode === null) prevProc.kill("SIGKILL");
		}
	});

	test("serializes overlapping fires instead of spawning concurrently", async () => {
		const homeDir = await createTempDir("justclaw-timer-overlap-");
		const ctx = createSessionContext(homeDir);
		const queue = new EventQueue(path.join(homeDir, "events.db"));
		const manifest = await writeTimerModule(
			homeDir,
			"tick",
			createTimerScript(),
		);
		const state: { process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null } = {
			process: null,
		};

		// sandboxFactory is awaited inside fireTimer's kill-previous/spawn
		// critical section. If two overlapping fires can both enter that
		// section at once (the bug), their sandboxFactory calls overlap too;
		// the lock must keep this at 1.
		let concurrentFactoryCalls = 0;
		let maxConcurrentFactoryCalls = 0;
		const sandboxFactory = async (m: TimerModuleManifest) => {
			concurrentFactoryCalls++;
			maxConcurrentFactoryCalls = Math.max(
				maxConcurrentFactoryCalls,
				concurrentFactoryCalls,
			);
			await delay(30);
			concurrentFactoryCalls--;
			return createUnsandboxedSpec(m.moduleDir, m.execPath);
		};

		try {
			const p1 = fireTimer(manifest, state, queue, ctx.sessionStore, {
				sandboxFactory,
			});
			const p2 = fireTimer(manifest, state, queue, ctx.sessionStore, {
				sandboxFactory,
			});
			await Promise.all([p1, p2]);

			expect(maxConcurrentFactoryCalls).toBe(1);
		} finally {
			queue.close();
		}
	});

	test("logs and returns when initialize times out", async () => {
		const homeDir = await createTempDir("justclaw-timer-timeout-");
		const ctx = createSessionContext(homeDir);
		const queue = new EventQueue(path.join(homeDir, "events.db"));
		// Script that never responds to initialize (hangs reading stdin)
		const manifest = await writeTimerModule(
			homeDir,
			"slow",
			"#!/usr/bin/env bun\nfor await (const _ of Bun.stdin.stream()) {}\n",
		);
		const state: { process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null } = {
			process: null,
		};

		try {
			await fireTimer(manifest, state, queue, ctx.sessionStore, {
				sandboxFactory: async (m) =>
					createUnsandboxedSpec(m.moduleDir, m.execPath),
				initializeTimeoutMs: 50,
			});

			// The initialize handshake, its timeout, and cleanup run detached from
			// fireTimer's return (so a slow module can't block the next tick), so
			// poll for the cleanup to land instead of asserting immediately.
			for (let i = 0; state.process !== null && i < 50; i++) {
				await delay(10);
			}
			expect(state.process).toBeNull();
			expect(queue.stale()).toHaveLength(0);
		} finally {
			queue.close();
		}
	});
});
