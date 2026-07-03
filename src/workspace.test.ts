import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	resolveWorkspaceDir,
	runReadFileBase64,
	WorkspaceEditor,
} from "./workspace";

const hasBwrap = Boolean(Bun.which("bwrap"));
// runReadFileBase64 runs under whichever sandbox backend the platform provides
// (bwrap on Linux, sandbox-exec on macOS), so gate on either being present.
const hasSandbox =
	hasBwrap ||
	(process.platform === "darwin" && Boolean(Bun.which("sandbox-exec")));

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

describe("resolveWorkspaceDir", () => {
	test("prefers JUSTCLAW_WORKSPACE", () => {
		const base = "/tmp/jc-home";
		expect(resolveWorkspaceDir(base, "/override/ws", "/Users/x")).toBe(
			path.resolve("/override/ws"),
		);
	});

	test("uses JUSTCLAW_HOME/workspace when override unset", () => {
		const home = "/tmp/jc-home";
		expect(resolveWorkspaceDir(home, undefined, "/Users/x")).toBe(
			path.join(home, "workspace"),
		);
	});

	test("uses ~/justclaw/workspace when only HOME is set", () => {
		expect(resolveWorkspaceDir(undefined, undefined, "/Users/alice")).toBe(
			path.resolve("/Users/alice", "justclaw", "workspace"),
		);
	});

	test("throws when no workspace can be resolved", () => {
		expect(() => resolveWorkspaceDir("", "", "")).toThrow(
			/JUSTCLAW_HOME is not set/,
		);
	});
});

function historyDirForWorkspace(root: string): string {
	return path.join(root, "history");
}

describe("WorkspaceEditor", () => {
	test.skipIf(!hasBwrap)("createFile writes file content", async () => {
		const root = await createTempDir("justclaw-ws-");
		const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
		const filePath = path.join(root, "hello.txt");
		const r = await editor.createFile({
			type: "create_file",
			path: filePath,
			diff: "hello\n",
		});
		expect(r.status).toBe("completed");
		expect(await Bun.file(filePath).text()).toBe("hello\n");
	});

	test.skipIf(!hasBwrap)("deleteFile fails for missing files", async () => {
		const root = await createTempDir("justclaw-ws-");
		const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
		const r = await editor.deleteFile({
			type: "delete_file",
			path: path.join(root, "nope.txt"),
		});
		expect(r.status).toBe("failed");
	});

	test.skipIf(!hasBwrap)("editFile fails when target is missing", async () => {
		const root = await createTempDir("justclaw-ws-");
		const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
		const r = await editor.editFile({
			type: "edit_file",
			path: path.join(root, "missing.txt"),
			old: "x",
			new: "y",
		});
		expect(r.status).toBe("failed");
		expect(r.output).toMatch(/not found/);
	});

	test.skipIf(!hasBwrap)("editFile replaces a unique old string", async () => {
		const root = await createTempDir("justclaw-ws-");
		const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
		const filePath = path.join(root, "doc.txt");
		await editor.createFile({
			type: "create_file",
			path: filePath,
			diff: "alpha\nbeta\ngamma\n",
		});
		const r = await editor.editFile({
			type: "edit_file",
			path: filePath,
			old: "beta",
			new: "BETA",
		});
		expect(r.status).toBe("completed");
		expect(await Bun.file(filePath).text()).toBe("alpha\nBETA\ngamma\n");
	});

	test.skipIf(!hasBwrap)(
		"editFile fails when old string is absent",
		async () => {
			const root = await createTempDir("justclaw-ws-");
			const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
			const filePath = path.join(root, "doc.txt");
			await editor.createFile({
				type: "create_file",
				path: filePath,
				diff: "only one line\n",
			});
			const r = await editor.editFile({
				type: "edit_file",
				path: filePath,
				old: "missing",
				new: "x",
			});
			expect(r.status).toBe("failed");
			expect(r.output).toMatch(/old string not found/);
		},
	);

	test.skipIf(!hasBwrap)(
		"editFile fails when old string is not unique",
		async () => {
			const root = await createTempDir("justclaw-ws-");
			const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
			const filePath = path.join(root, "doc.txt");
			await editor.createFile({
				type: "create_file",
				path: filePath,
				diff: "foo foo foo\n",
			});
			const r = await editor.editFile({
				type: "edit_file",
				path: filePath,
				old: "foo",
				new: "bar",
			});
			expect(r.status).toBe("failed");
			expect(r.output).toMatch(/not unique \(3 occurrences\)/);
		},
	);

	test.skipIf(!hasBwrap)(
		"concurrent editFile calls on the same file both land",
		async () => {
			// Regression: editFile's read-modify-write (runReadFile then runCreateFile)
			// was not serialized, so two overlapping edit_file tool calls on the same
			// file could both read the pre-edit content and the second write would
			// silently clobber the first.
			const root = await createTempDir("justclaw-ws-");
			const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
			const filePath = path.join(root, "doc.txt");
			await editor.createFile({
				type: "create_file",
				path: filePath,
				diff: "alpha\nbeta\n",
			});
			const [r1, r2] = await Promise.all([
				editor.editFile({
					type: "edit_file",
					path: filePath,
					old: "alpha",
					new: "ALPHA",
				}),
				editor.editFile({
					type: "edit_file",
					path: filePath,
					old: "beta",
					new: "BETA",
				}),
			]);
			expect(r1.status).toBe("completed");
			expect(r2.status).toBe("completed");
			expect(await Bun.file(filePath).text()).toBe("ALPHA\nBETA\n");
		},
	);

	test.skipIf(!hasSandbox)(
		"runReadFileBase64 round-trips binary bytes (attach_image/attach_file)",
		async () => {
			// Regression: BSD base64 (macOS) rejects `base64 FILE` and the old
			// `base64 | tr` pipeline masked the failure behind tr's zero exit, so
			// attach_image/attach_file silently produced empty data on macOS.
			const root = await createTempDir("justclaw-ws-");
			// 1x1 transparent PNG.
			const expected =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
			const filePath = path.join(root, "pixel.png");
			await writeFile(filePath, Buffer.from(expected, "base64"));
			const r = await runReadFileBase64(
				root,
				historyDirForWorkspace(root),
				process.platform,
				path.resolve(filePath),
			);
			expect(r.ok).toBe(true);
			expect(r.content).toBe(expected);
		},
	);

	test.skipIf(!hasSandbox)(
		"runReadFileBase64 reports failure for a missing file",
		async () => {
			const root = await createTempDir("justclaw-ws-");
			const r = await runReadFileBase64(
				root,
				historyDirForWorkspace(root),
				process.platform,
				path.join(root, "does-not-exist.png"),
			);
			expect(r.ok).toBe(false);
		},
	);
});
