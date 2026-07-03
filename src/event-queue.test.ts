import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	EventQueue,
	formatLocalTimestamp,
	resolveEventQueuePath,
	timestampFromUUIDv7,
} from "./event-queue";
import { resolveModulesRoot } from "./module-manifest";
import { bootstrapRuntime, stopDaemons } from "./runtime";
import type { SandboxLaunchSpec } from "./sandbox";
import { SessionStore } from "./session-store";

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

const tempDirs: string[] = [];

afterEach(async () => {
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

async function writeDaemonModule(
	homeDir: string,
	moduleName: string,
	script: string,
): Promise<void> {
	const moduleDir = path.join(
		resolveModulesRoot(undefined, homeDir),
		moduleName,
	);
	await mkdir(moduleDir, { recursive: true });
	await writeFile(
		path.join(moduleDir, "module.json"),
		JSON.stringify({
			name: moduleName,
			exec: "./module.ts",
			mode: "daemon",
		}),
	);
	const scriptPath = path.join(moduleDir, "module.ts");
	await writeFile(scriptPath, script);
	await chmod(scriptPath, 0o755);
}

describe("EventQueue", () => {
	test("enqueue then next returns FIFO order (UUIDv7 lexicographic)", async () => {
		const homeDir = await createTempDir("jq-fifo-");
		const dbPath = path.join(homeDir, "events.db");
		const queue = new EventQueue(dbPath);
		queue.enqueue("a", { type: "event.v1", n: 1 });
		await delay(2);
		queue.enqueue("a", { type: "event.v1", n: 2 });

		const first = await queue.next();
		const second = await queue.next();
		expect(first?.params.n).toBe(1);
		expect(second?.params.n).toBe(2);
		expect((first?.id ?? "") < (second?.id ?? "")).toBe(true);

		queue.close();
	});

	test("next blocks until enqueue resolves the waiter", async () => {
		const homeDir = await createTempDir("jq-block-");
		const queue = new EventQueue(path.join(homeDir, "events.db"));

		const pending = queue.next();
		queue.enqueue("src", { type: "event.v1", k: "v" });
		await expect(pending).resolves.toEqual({
			source: "src",
			params: { type: "event.v1", k: "v" },
			id: expect.any(String),
		});

		queue.close();
	});

	test("complete removes the row", async () => {
		const homeDir = await createTempDir("jq-complete-");
		const queue = new EventQueue(path.join(homeDir, "events.db"));
		queue.enqueue("s", { type: "event.v1" });
		const item = await queue.next();
		expect(item).toBeDefined();
		queue.complete(item?.id ?? "");

		const after = await Promise.race([
			queue.next(),
			delay(50).then(() => "timeout"),
		]);
		expect(after).toBe("timeout");

		queue.close();
	});

	test("stale returns running rows in id order", async () => {
		const homeDir = await createTempDir("jq-stale-");
		const dbPath = path.join(homeDir, "events.db");
		const queue = new EventQueue(dbPath);

		const raw = new Database(dbPath);
		raw.run(
			`INSERT INTO events (id, source, params, state, running_since) VALUES (?, ?, ?, 'running', ?)`,
			[
				"018f0e68-6768-7b89-8abc-111111111111",
				"m1",
				JSON.stringify({ type: "event.v1", x: 1 }),
				new Date().toISOString(),
			],
		);
		raw.run(
			`INSERT INTO events (id, source, params, state, running_since) VALUES (?, ?, ?, 'running', ?)`,
			[
				"018f0e68-6768-7b89-8abc-222222222222",
				"m2",
				JSON.stringify({ type: "event.v1", x: 2 }),
				new Date().toISOString(),
			],
		);
		raw.close();

		const rows = queue.stale();
		expect(rows).toHaveLength(2);
		expect(rows[0]?.source).toBe("m1");
		expect(rows[1]?.source).toBe("m2");

		queue.close();
	});

	test("close then awaiting next resolves undefined without throwing", async () => {
		const homeDir = await createTempDir("jq-close-next-");
		const queue = new EventQueue(path.join(homeDir, "events.db"));

		const pending = queue.next();
		queue.close();
		await expect(pending).resolves.toBeUndefined();
	});

	test("enqueue after close does not throw and logs the loss", async () => {
		const homeDir = await createTempDir("jq-drop-");
		const queue = new EventQueue(path.join(homeDir, "events.db"));
		queue.close();

		const orig = console.error;
		const lines: string[] = [];
		console.error = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			expect(() => queue.enqueue("s", { type: "event.v1" })).not.toThrow();
			expect(
				lines.some(
					(line) => line.includes("event lost") && line.includes("source=s"),
				),
			).toBe(true);
		} finally {
			console.error = orig;
		}
	});

	test("setInterrupt after close does not strand the slot silently", async () => {
		const homeDir = await createTempDir("jq-interrupt-closed-");
		const queue = new EventQueue(path.join(homeDir, "events.db"));
		queue.close();

		const orig = console.error;
		const lines: string[] = [];
		console.error = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			const result = queue.setInterrupt("s", { type: "event.v1" });
			expect(result).toBeNull();
			expect(
				lines.some(
					(line) =>
						line.includes("interrupt lost") && line.includes("source=s"),
				),
			).toBe(true);
		} finally {
			console.error = orig;
		}
	});

	test("next on empty closed queue returns undefined", async () => {
		const homeDir = await createTempDir("jq-next-closed-");
		const queue = new EventQueue(path.join(homeDir, "events.db"));
		queue.close();
		await expect(queue.next()).resolves.toBeUndefined();
	});

	test("meta helpers read, upsert, and delete values", () => {
		const homeDir = path.join(os.tmpdir(), `jq-meta-${Bun.randomUUIDv7()}`);
		tempDirs.push(homeDir);
		const queue = new EventQueue(path.join(homeDir, "events.db"));

		expect(queue.getMeta("active_session_id")).toBeNull();
		queue.setMeta("active_session_id", "session-a");
		expect(queue.getMeta("active_session_id")).toBe("session-a");
		queue.setMeta("active_session_id", "session-b");
		expect(queue.getMeta("active_session_id")).toBe("session-b");
		queue.deleteMeta("active_session_id");
		expect(queue.getMeta("active_session_id")).toBeNull();

		queue.close();
	});
});

describe("resolveEventQueuePath", () => {
	test("prefers JUSTCLAW_HOME when set", () => {
		expect(resolveEventQueuePath("/tmp/jc-home", "/tmp/user-home")).toBe(
			path.resolve("/tmp/jc-home", "events.db"),
		);
	});

	test("uses ~/justclaw/events.db when only homeDir is set", () => {
		expect(resolveEventQueuePath(undefined, "/tmp/user")).toBe(
			path.resolve("/tmp/user", "justclaw", "events.db"),
		);
	});

	test("throws when neither home nor JUSTCLAW_HOME is available", () => {
		const prevHome = process.env.HOME;
		const prevJustclaw = process.env.JUSTCLAW_HOME;
		delete process.env.HOME;
		delete process.env.JUSTCLAW_HOME;
		try {
			expect(() => resolveEventQueuePath()).toThrow(
				"HOME is not set and JUSTCLAW_HOME is not set; cannot resolve event queue path",
			);
		} finally {
			if (prevHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = prevHome;
			}
			if (prevJustclaw === undefined) {
				delete process.env.JUSTCLAW_HOME;
			} else {
				process.env.JUSTCLAW_HOME = prevJustclaw;
			}
		}
	});
});

describe("bootstrapRuntime stale recovery", () => {
	test("notifies running daemon with event.dropped.v1 and UUIDv7 timestamp", async () => {
		const homeDir = await createTempDir("jq-stale-daemon-");
		const dbPath = path.join(homeDir, "events.db");
		const dropLog = path.join(homeDir, "drops.ndjson");
		const eventId = "018f0e68-6768-7b89-8abc-aaaaaaaaaaaa";
		const expectedTs = timestampFromUUIDv7(eventId);

		const raw = new Database(dbPath);
		raw.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id            TEXT PRIMARY KEY,
				source        TEXT NOT NULL,
				params        TEXT NOT NULL,
				state         TEXT NOT NULL DEFAULT 'pending',
				running_since TEXT
			);
		`);
		raw.run(
			`INSERT INTO events (id, source, params, state, running_since) VALUES (?, ?, ?, 'running', ?)`,
			[
				eventId,
				"stale-mod",
				JSON.stringify({ type: "event.v1", payload: 42 }),
				new Date().toISOString(),
			],
		);
		raw.close();

		await writeDaemonModule(
			homeDir,
			"stale-mod",
			`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const log = ${JSON.stringify(dropLog)};
const lines = [];
for await (const chunk of Bun.stdin.stream()) {
	lines.push(chunk);
	const text = Buffer.concat(lines).toString("utf8");
	const inputLines = text.split(/\\r?\\n/);
	while (inputLines.length > 1) {
		const line = inputLines.shift();
		if (!line) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg.method && msg.id === undefined) {
			appendFileSync(log, line + "\\n");
		}
		if (msg.method === "initialize") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }));
		} else if (msg.method === "shutdown") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "ok" }));
			process.exit(0);
		}
	}
	lines.length = 0;
	if (inputLines[0]) {
		lines.push(Buffer.from(inputLines[0]));
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			eventQueuePath: dbPath,
			sessionStore: new SessionStore(path.join(homeDir, "history")),
			sandboxFactory: async (m) =>
				createUnsandboxedSpec(m.moduleDir, m.execPath),
		});

		await waitUntil(async () => Bun.file(dropLog).exists());
		const lines = (await Bun.file(dropLog).text()).trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(1);
		const notification = JSON.parse(lines[0] ?? "{}");
		expect(notification.method).toBe("event");
		expect(notification.params).toEqual({
			type: "event.dropped.v1",
			source: "stale-mod",
			timestamp: expectedTs,
			params: { type: "event.v1", payload: 42 },
		});

		await stopDaemons(runtime.daemons);
		runtime.eventQueue.close();
	});

	test("logs event lost when source daemon is missing", async () => {
		const homeDir = await createTempDir("jq-stale-missing-");
		const dbPath = path.join(homeDir, "events.db");

		const raw = new Database(dbPath);
		raw.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id            TEXT PRIMARY KEY,
				source        TEXT NOT NULL,
				params        TEXT NOT NULL,
				state         TEXT NOT NULL DEFAULT 'pending',
				running_since TEXT
			);
		`);
		raw.run(
			`INSERT INTO events (id, source, params, state, running_since) VALUES (?, ?, ?, 'running', ?)`,
			[
				"018f0e68-6768-7b89-8abc-bbbbbbbbbbbb",
				"ghost-mod",
				JSON.stringify({ type: "event.v1" }),
				new Date().toISOString(),
			],
		);
		raw.close();

		await writeDaemonModule(
			homeDir,
			"only-mod",
			`#!/usr/bin/env bun
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

		const messages: string[] = [];
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => {
			messages.push(args.join(" "));
		};

		try {
			const runtime = await bootstrapRuntime({
				homeDir,
				eventQueuePath: dbPath,
				sessionStore: new SessionStore(path.join(homeDir, "history")),
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			});

			expect(
				messages.some((m) =>
					m.includes("[core] event lost: source=ghost-mod id="),
				),
			).toBe(true);

			await stopDaemons(runtime.daemons);
			runtime.eventQueue.close();
		} finally {
			console.error = originalConsoleError;
		}
	});
});

describe("formatLocalTimestamp", () => {
	const originalTz = process.env.TZ;

	afterEach(() => {
		// Reassign (rather than `delete`) to restore: Bun/JSC's local-time cache
		// does not invalidate correctly across a `delete process.env.TZ`, which
		// left later tests seeing the first test's zone.
		process.env.TZ = originalTz;
	});

	test("renders JST with a positive offset", () => {
		process.env.TZ = "Asia/Tokyo";
		const ms = Date.parse("2026-07-03T02:37:00.000Z");
		expect(formatLocalTimestamp(ms)).toBe("2026-07-03T11:37:00+09:00");
	});

	test("renders +00:00 (never Z) when TZ is UTC", () => {
		process.env.TZ = "UTC";
		const ms = Date.parse("2026-07-03T02:37:00.000Z");
		const result = formatLocalTimestamp(ms);
		expect(result).toBe("2026-07-03T02:37:00+00:00");
		expect(result).not.toContain("Z");
	});
});
