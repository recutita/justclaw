import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeSandboxTmpDir } from "./sandbox";

const hasBwrap = Boolean(Bun.which("bwrap"));

// Sandboxes spawned or built here create the process-wide temp dir on first use.
afterAll(() => {
	removeSandboxTmpDir();
});

describe("WorkspaceShell", () => {
	test.skipIf(!hasBwrap)("runs sh -c commands and returns output", async () => {
		const { WorkspaceShell } = await import("./workspace");
		const root = await mkdtemp(path.join(os.tmpdir(), "justclaw-sh-"));
		const hist = path.join(root, "h");
		await mkdir(hist, { recursive: true });
		try {
			const shell = new WorkspaceShell(root, hist, "linux");
			const result = await shell.run({ commands: ["echo marker"] });
			expect(result.output).toHaveLength(1);
			expect(result.output[0]?.stdout.trim()).toBe("marker");
			expect(result.output[0]?.outcome).toEqual({
				type: "exit",
				exitCode: 0,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("shell tool", () => {
	test("returns the expected shape for malformed arguments", async () => {
		const { RunContext } = await import("@openai/agents");
		const { createWorkspaceTools } = await import("./workspace");
		const [shell] = createWorkspaceTools("/nonexistent", "/nonexistent");
		if (shell?.type !== "function") throw new Error("expected function tool");
		for (const args of [
			"{}",
			'{"arguments":"ls"}',
			'{"commands":["echo hi"]}',
		]) {
			const output = await shell.invoke(new RunContext(), args);
			expect(output).toBe(
				'shell: "command" must be a string, e.g. {"command": "ls -la"}',
			);
		}
	});
});
