import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventQueue } from "./event-queue";
import {
	resolveModulesRoot,
	type TimerModuleManifest,
} from "./module-manifest";
import type { SandboxLaunchSpec } from "./sandbox";
import { SessionStore } from "./session-store";
import { fireTimer, registerInProcessCron } from "./timer-runner";

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

function createSessionContext(homeDir: string): { sessionStore: SessionStore } {
	return { sessionStore: new SessionStore(path.join(homeDir, "history")) };
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

// Timer module that answers initialize, prints a non-JSON line, then a valid
// event.v1, then exits. Exercises the malformed-line path (F1).
function createBadLineTimerScript(): string {
	return `#!/usr/bin/env bun
const chunks = [];
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  const lines = text.split(/\\r?\\n/);
  while (lines.length > 1) {
    const line = lines.shift();
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
      process.stdout.write("this is not json\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "event.v1", kind: "tick", text: "after-bad-line" } }) + "\\n");
      process.exit(0);
    }
  }
  chunks.length = 0;
  if (lines[0]) chunks.push(Buffer.from(lines[0]));
}
`;
}

describe("registerInProcessCron (F4: long-delay clamp)", () => {
	test("a yearly cron does not fire in a storm within the clamp window", async () => {
		// "0 0 1 1 *" (next Jan 1) is always > 2**31-1 ms away, so setTimeout would
		// clamp the delay to 1ms and fire repeatedly. The clamp path must instead
		// re-evaluate without firing.
		let fires = 0;
		const job = registerInProcessCron("0 0 1 1 *", () => {
			fires += 1;
		});
		try {
			await delay(300);
			expect(fires).toBeLessThanOrEqual(1);
		} finally {
			job.stop();
		}
	});
});

describe("runTimerLifecycle (F1: malformed line)", () => {
	test("a non-JSON line does not tear down the stream; the following event still enqueues", async () => {
		const homeDir = await createTempDir("justclaw-timer-badline-");
		const ctx = createSessionContext(homeDir);
		const queue = new EventQueue(path.join(homeDir, "events.db"));
		const manifest = await writeTimerModule(
			homeDir,
			"tick",
			createBadLineTimerScript(),
		);
		const state: { process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null } = {
			process: null,
		};

		try {
			const eventPromise = queue.next();
			await fireTimer(manifest, state, queue, ctx.sessionStore, {
				sandboxFactory: async (m) =>
					createUnsandboxedSpec(m.moduleDir, m.execPath),
			});

			const event = await Promise.race([
				eventPromise,
				delay(2000).then(() => null),
			]);
			expect(event).not.toBeNull();
			expect(event?.source).toBe("tick");
			expect(event?.params.type).toBe("event.v1");
			expect(event?.params.text).toBe("after-bad-line");
		} finally {
			queue.close();
		}
	});
});
