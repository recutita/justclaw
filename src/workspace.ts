import path from "node:path";
import {
	type ApplyPatchOperation,
	type ApplyPatchResult,
	type Shell,
	type ShellAction,
	type ShellOutputResult,
	type ShellResult,
	type Tool,
	tool,
} from "@openai/agents";
import { createWorkspaceSandboxBaseCommand } from "./sandbox";

export function resolveWorkspaceDir(
	justclawHome = process.env.JUSTCLAW_HOME,
	override = process.env.JUSTCLAW_WORKSPACE,
	homeDir = process.env.HOME,
): string {
	if (override) {
		return path.resolve(override);
	}
	if (justclawHome) {
		return path.resolve(justclawHome, "workspace");
	}
	if (homeDir) {
		return path.resolve(homeDir, "justclaw", "workspace");
	}
	throw new Error(
		"JUSTCLAW_HOME is not set; cannot resolve workspace directory",
	);
}

function truncateStreams(
	stdout: string,
	stderr: string,
	maxLen: number,
): { stdout: string; stderr: string; truncated: boolean } {
	const total = stdout.length + stderr.length;
	if (total <= maxLen) {
		return { stdout, stderr, truncated: false };
	}
	let budget = maxLen;
	let outS = "";
	if (budget > 0 && stdout.length > 0) {
		const take = Math.min(stdout.length, budget);
		outS = stdout.slice(0, take);
		budget -= take;
	}
	let errS = "";
	if (budget > 0 && stderr.length > 0) {
		errS = stderr.slice(0, budget);
	}
	return { stdout: outS, stderr: errS, truncated: true };
}

export class WorkspaceShell implements Shell {
	readonly #workspaceDir: string;
	readonly #historyDir: string;
	readonly #platform: NodeJS.Platform;
	readonly #characterDir?: string;
	readonly #modulesRoot?: string;
	readonly #skillsDir?: string;

	constructor(
		workspaceDir: string,
		historyDir: string,
		platform: NodeJS.Platform = process.platform,
		characterDir?: string,
		modulesRoot?: string,
		skillsDir?: string,
	) {
		this.#workspaceDir = workspaceDir;
		this.#historyDir = historyDir;
		this.#platform = platform;
		this.#characterDir = characterDir;
		this.#modulesRoot = modulesRoot;
		this.#skillsDir = skillsDir;
	}

	async run(action: ShellAction): Promise<ShellResult> {
		const output: ShellOutputResult[] = [];
		let anyTruncated = false;
		const timeoutMs = action.timeoutMs ?? 30_000;
		const maxOutputLength = action.maxOutputLength;

		for (const command of action.commands) {
			const spec = await createWorkspaceSandboxBaseCommand(
				this.#workspaceDir,
				this.#historyDir,
				{
					platform: this.#platform,
					characterDir: this.#characterDir,
					modulesRoot: this.#modulesRoot,
					skillsDir: this.#skillsDir,
				},
			);
			const cmd = [...spec.cmdPrefix, "sh", "-c", command];
			const proc = Bun.spawn({
				cmd,
				cwd: this.#workspaceDir,
				stdout: "pipe",
				stderr: "pipe",
				env: spec.env,
			});

			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<"timeout">((resolve) => {
				timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
			});
			const race = await Promise.race([
				proc.exited.then(() => "exited" as const),
				timeoutPromise,
			]);
			clearTimeout(timeoutHandle);

			let stdoutText: string;
			let stderrText: string;
			if (race === "timeout") {
				proc.kill("SIGKILL");
				await proc.exited;
				stdoutText = await new Response(proc.stdout).text();
				stderrText = await new Response(proc.stderr).text();
				let truncated = false;
				if (maxOutputLength !== undefined) {
					const t = truncateStreams(stdoutText, stderrText, maxOutputLength);
					stdoutText = t.stdout;
					stderrText = t.stderr;
					truncated = t.truncated;
				}
				if (truncated) {
					anyTruncated = true;
				}
				output.push({
					stdout: stdoutText,
					stderr: stderrText,
					outcome: { type: "timeout" },
				});
				continue;
			}

			stdoutText = await new Response(proc.stdout).text();
			stderrText = await new Response(proc.stderr).text();
			if (maxOutputLength !== undefined) {
				const t = truncateStreams(stdoutText, stderrText, maxOutputLength);
				stdoutText = t.stdout;
				stderrText = t.stderr;
				if (t.truncated) {
					anyTruncated = true;
				}
			}

			output.push({
				stdout: stdoutText,
				stderr: stderrText,
				outcome: {
					type: "exit",
					exitCode: proc.exitCode,
				},
			});
		}

		return {
			output,
			...(anyTruncated && action.maxOutputLength !== undefined
				? { maxOutputLength: action.maxOutputLength }
				: {}),
		};
	}
}

// Path boundary enforcement is delegated to the platform sandbox (bwrap / sandbox-exec).
// The sandbox grants rw access to the workspace, character, and modules directories, and the kernel
// enforces it. createFile and deleteFile run inside the sandbox for the same reason as
// editFile (string replace then runCreateFile): host-side Bun.write / Bun.file().delete() bypass that enforcement.

async function runCreateFile(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform,
	absPath: string,
	content: string,
	characterDir?: string,
	modulesRoot?: string,
	skillsDir?: string,
): Promise<{ ok: boolean; stderr: string }> {
	const spec = await createWorkspaceSandboxBaseCommand(
		workspaceDir,
		historyDir,
		{ platform, characterDir, modulesRoot, skillsDir },
	);
	// Pass dirname and path as positional args to avoid shell-quoting the values.
	const proc = Bun.spawn({
		cmd: [
			...spec.cmdPrefix,
			"sh",
			"-c",
			'mkdir -p "$1" && cat > "$2"',
			"--",
			path.dirname(absPath),
			absPath,
		],
		cwd: workspaceDir,
		stdin: new TextEncoder().encode(content),
		stdout: "pipe",
		stderr: "pipe",
		env: spec.env,
	});
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	return { ok: proc.exitCode === 0, stderr };
}

async function runDeleteFile(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform,
	absPath: string,
	characterDir?: string,
	modulesRoot?: string,
	skillsDir?: string,
): Promise<{ ok: boolean; stderr: string }> {
	const spec = await createWorkspaceSandboxBaseCommand(
		workspaceDir,
		historyDir,
		{ platform, characterDir, modulesRoot, skillsDir },
	);
	const proc = Bun.spawn({
		cmd: [...spec.cmdPrefix, "rm", absPath],
		cwd: workspaceDir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: spec.env,
	});
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	return { ok: proc.exitCode === 0, stderr };
}

async function runReadFile(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform,
	absPath: string,
	characterDir?: string,
	modulesRoot?: string,
	skillsDir?: string,
): Promise<{ ok: boolean; content: string; stderr: string }> {
	const spec = await createWorkspaceSandboxBaseCommand(
		workspaceDir,
		historyDir,
		{ platform, characterDir, modulesRoot, skillsDir },
	);
	const proc = Bun.spawn({
		cmd: [...spec.cmdPrefix, "cat", absPath],
		cwd: workspaceDir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: spec.env,
	});
	const [content, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { ok: proc.exitCode === 0, content, stderr };
}

/** Like {@link runReadFile}, but returns raw file bytes as a single-line base64 string via sandboxed `base64`. */
export async function runReadFileBase64(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform,
	absPath: string,
	characterDir?: string,
	modulesRoot?: string,
	skillsDir?: string,
): Promise<{ ok: boolean; content: string; stderr: string }> {
	const spec = await createWorkspaceSandboxBaseCommand(
		workspaceDir,
		historyDir,
		{ platform, characterDir, modulesRoot, skillsDir },
	);
	// Read the file via stdin redirect rather than `base64 "$1"`: BSD base64
	// (macOS) rejects a positional file argument and only accepts stdin or -i,
	// while GNU base64 (Linux) accepts both. The redirect is portable across both
	// and also makes the exit code reflect base64/open failures -- a `base64 | tr`
	// pipeline would mask them behind tr's always-zero exit. Newlines (GNU wraps
	// at 76 columns) are stripped in JS so no second piped process is needed.
	const proc = Bun.spawn({
		cmd: [...spec.cmdPrefix, "sh", "-c", 'base64 < "$1"', "--", absPath],
		cwd: workspaceDir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: spec.env,
	});
	const [content, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return {
		ok: proc.exitCode === 0,
		content: content.replace(/\r?\n/g, ""),
		stderr,
	};
}

async function runEditFile(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform,
	absPath: string,
	old: string,
	new_: string,
	characterDir?: string,
	modulesRoot?: string,
	skillsDir?: string,
): Promise<ApplyPatchResult> {
	if (old.length === 0) {
		return { status: "failed", output: "old string must not be empty" };
	}
	const read = await runReadFile(
		workspaceDir,
		historyDir,
		platform,
		absPath,
		characterDir,
		modulesRoot,
		skillsDir,
	);
	if (!read.ok) {
		return { status: "failed", output: "file not found" };
	}
	const content = read.content;
	const count = content.split(old).length - 1;
	if (count === 0) {
		return { status: "failed", output: "old string not found" };
	}
	if (count > 1) {
		return {
			status: "failed",
			output: `old string is not unique (${count} occurrences)`,
		};
	}
	const updated = content.replace(old, new_);
	const w = await runCreateFile(
		workspaceDir,
		historyDir,
		platform,
		absPath,
		updated,
		characterDir,
		modulesRoot,
		skillsDir,
	);
	if (!w.ok) {
		return {
			status: "failed",
			output: w.stderr.trim() || "write failed",
		};
	}
	return { status: "completed" };
}

export class WorkspaceEditor {
	readonly #workspaceDir: string;
	readonly #historyDir: string;
	readonly #platform: NodeJS.Platform;
	readonly #characterDir?: string;
	readonly #modulesRoot?: string;
	readonly #skillsDir?: string;
	// The agents SDK may execute tool calls in parallel, but editFile's read-modify-write
	// (runReadFile then runCreateFile) is not atomic. Chaining every mutating op through
	// this promise serializes them so concurrent calls apply in order instead of racing.
	#queue: Promise<unknown> = Promise.resolve();

	constructor(
		workspaceDir: string,
		historyDir: string,
		platform: NodeJS.Platform = process.platform,
		characterDir?: string,
		modulesRoot?: string,
		skillsDir?: string,
	) {
		this.#workspaceDir = workspaceDir;
		this.#historyDir = historyDir;
		this.#platform = platform;
		this.#characterDir = characterDir;
		this.#modulesRoot = modulesRoot;
		this.#skillsDir = skillsDir;
	}

	#serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn, fn);
		// Keep the chain alive even if this op failed; the failure is still
		// delivered to this call's caller via `run`.
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async createFile(
		op: Extract<ApplyPatchOperation, { type: "create_file" }>,
	): Promise<ApplyPatchResult> {
		return this.#serialize(async () => {
			const resolved = path.resolve(op.path);
			// op.diff carries the file content for create_file (passed as the "content" field
			// by createWorkspaceTools; the Editor interface reuses the diff field).
			const result = await runCreateFile(
				this.#workspaceDir,
				this.#historyDir,
				this.#platform,
				resolved,
				op.diff,
				this.#characterDir,
				this.#modulesRoot,
				this.#skillsDir,
			);
			if (!result.ok) {
				return {
					status: "failed",
					output: result.stderr.trim() || "create failed",
				};
			}
			return { status: "completed" };
		});
	}

	async editFile(op: {
		type: "edit_file";
		path: string;
		old: string;
		new: string;
	}): Promise<ApplyPatchResult> {
		return this.#serialize(() => {
			const resolved = path.resolve(op.path);
			return runEditFile(
				this.#workspaceDir,
				this.#historyDir,
				this.#platform,
				resolved,
				op.old,
				op.new,
				this.#characterDir,
				this.#modulesRoot,
				this.#skillsDir,
			);
		});
	}

	async deleteFile(
		op: Extract<ApplyPatchOperation, { type: "delete_file" }>,
	): Promise<ApplyPatchResult> {
		return this.#serialize(async () => {
			const resolved = path.resolve(op.path);
			const result = await runDeleteFile(
				this.#workspaceDir,
				this.#historyDir,
				this.#platform,
				resolved,
				this.#characterDir,
				this.#modulesRoot,
				this.#skillsDir,
			);
			if (!result.ok) {
				return {
					status: "failed",
					output: result.stderr.trim() || "delete failed",
				};
			}
			return { status: "completed" };
		});
	}
}

export function createWorkspaceTools(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform = process.platform,
	characterDir?: string,
	modulesRoot?: string,
	skillsDir?: string,
): Tool[] {
	const shell = new WorkspaceShell(
		workspaceDir,
		historyDir,
		platform,
		characterDir,
		modulesRoot,
		skillsDir,
	);
	const editor = new WorkspaceEditor(
		workspaceDir,
		historyDir,
		platform,
		characterDir,
		modulesRoot,
		skillsDir,
	);

	const shellFunctionTool = tool({
		name: "shell",
		description:
			"Execute shell commands sequentially in the workspace sandbox. Each command runs as `sh -c <command>`. Commands do not share state between calls.",
		parameters: {
			type: "object",
			properties: {
				commands: {
					type: "array",
					items: { type: "string" },
					description: "Shell commands to execute in order",
				},
				timeout_ms: {
					type: "number",
					description: "Per-command timeout in milliseconds (default: 30000)",
				},
			},
			required: ["commands"],
			additionalProperties: false,
			// biome-ignore lint/suspicious/noExplicitAny: avoid @openai/agents-core subpath types for parameters
		} as any,
		strict: false as false,
		execute: async (input: unknown) => {
			const { commands, timeout_ms } = input as {
				commands: string[];
				timeout_ms?: number;
			};
			const action: ShellAction = {
				commands,
				...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
			};
			const result = await shell.run(action);
			return JSON.stringify(result);
		},
	});

	const createFileTool = tool({
		name: "create_file",
		description:
			"Write a new file at an absolute path inside the workspace sandbox. " +
			"Use absolute host paths (e.g. the path you see in the shell). " +
			"Overwrites the file if it already exists.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path to the file" },
				content: { type: "string", description: "Full file content" },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		strict: true,
		execute: async (input: unknown) => {
			const { path: filePath, content } = input as {
				path: string;
				content: string;
			};
			// Reuse ApplyPatchOperation shape: pass content via the diff field.
			const result = await editor.createFile({
				type: "create_file",
				path: filePath,
				diff: content,
			});
			return JSON.stringify(result);
		},
	});

	const editFileTool = tool({
		name: "edit_file",
		description:
			"Replace an exact substring in an existing file inside the workspace sandbox. " +
			"old must appear exactly once in the file; if it is not unique, include more surrounding context. " +
			"Use absolute host paths (e.g. the path you see in the shell).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path to the file" },
				old: {
					type: "string",
					description: "Exact substring to replace (must appear exactly once)",
				},
				new: { type: "string", description: "Replacement text" },
			},
			required: ["path", "old", "new"],
			additionalProperties: false,
		},
		strict: true,
		execute: async (input: unknown) => {
			const {
				path: filePath,
				old,
				new: newText,
			} = input as {
				path: string;
				old: string;
				new: string;
			};
			const result = await editor.editFile({
				type: "edit_file",
				path: filePath,
				old,
				new: newText,
			});
			return JSON.stringify(result);
		},
	});

	const deleteFileTool = tool({
		name: "delete_file",
		description:
			"Delete a file at an absolute path inside the workspace sandbox. " +
			"Use absolute host paths (e.g. the path you see in the shell).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path to the file" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		strict: true,
		execute: async (input: unknown) => {
			const { path: filePath } = input as { path: string };
			const result = await editor.deleteFile({
				type: "delete_file",
				path: filePath,
			});
			return JSON.stringify(result);
		},
	});

	return [shellFunctionTool, createFileTool, editFileTool, deleteFileTool];
}
