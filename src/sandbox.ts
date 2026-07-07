import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type {
	DaemonModuleManifest,
	TimerModuleManifest,
} from "./module-manifest";

export type SandboxBackend = "bwrap" | "sandbox-exec";

export type SandboxLaunchSpec = {
	backend: SandboxBackend;
	cmd: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
};

type SandboxOptions = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	lookupExecutable?: (
		command: string,
		env: NodeJS.ProcessEnv,
	) => Promise<string | null>;
	pathExists?: (path: string) => Promise<boolean>;
	realPath?: (path: string) => Promise<string>;
};

type LinuxBubblewrapOptions = {
	env?: NodeJS.ProcessEnv;
	pathExists?: (path: string) => Promise<boolean>;
	realPath?: (path: string) => Promise<string>;
};

export type LinuxWorkspaceBwrapOptions = {
	env?: NodeJS.ProcessEnv;
	pathExists?: (path: string) => Promise<boolean>;
	realPath?: (path: string) => Promise<string>;
	/** When false, skip --ro-bind for history (directory missing on host). */
	bindHistoryDir?: boolean;
	/** Optional agent `character/` directory; rw-mounted when present on the host. */
	characterDir?: string;
	/** Runtime modules root; rw-mounted when present on the host (same visibility as characterDir). */
	modulesRoot?: string;
	/** Skills directory; rw-mounted when present on the host (same visibility as characterDir). */
	skillsDir?: string;
};

export type WorkspaceSandboxBaseOptions = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	pathExists?: (path: string) => Promise<boolean>;
	realPath?: (path: string) => Promise<string>;
	lookupExecutable?: (
		command: string,
		env: NodeJS.ProcessEnv,
	) => Promise<string | null>;
	/** Optional agent `character/` directory; rw-mounted in the workspace sandbox when set. */
	characterDir?: string;
	/** Runtime modules root; rw-mounted in the workspace sandbox when set. */
	modulesRoot?: string;
	/** Skills directory; rw-mounted in the workspace sandbox when set. */
	skillsDir?: string;
};

const DARWIN_TMP_PATHS = ["/tmp", "/private/tmp"] as const;
const DARWIN_READONLY_PATHS = [
	"/System",
	"/usr",
	"/bin",
	"/sbin",
	"/opt",
	"/Library",
	"/private/etc",
	"/private/var/run",
	// Nix installs interpreters and their shared libraries under /nix/store. On a
	// nix-on-macOS setup `sh`/`base64`/module interpreters resolve there and fail
	// to load their libraries unless the store is readable. Mirrors LINUX_READONLY_PATHS.
	"/nix",
] as const;
const LINUX_READONLY_PATHS = [
	"/bin",
	"/sbin",
	"/usr",
	"/usr/local",
	"/usr/sbin",
	"/opt",
	"/etc",
	"/lib",
	"/lib64",
	"/nix",
] as const;

async function defaultPathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function defaultLookupExecutable(
	command: string,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	if (command.includes("/")) {
		try {
			await access(command, constants.X_OK);
			return command;
		} catch {
			return null;
		}
	}

	const pathEnv = env.PATH ?? "";
	for (const dir of pathEnv.split(":")) {
		if (!dir) {
			continue;
		}

		const candidate = `${dir}/${command}`;
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}

	return null;
}

async function defaultRealPath(path: string): Promise<string> {
	return realpath(path);
}

export function resolveSandboxBackend(
	platform: NodeJS.Platform,
): SandboxBackend {
	switch (platform) {
		case "darwin":
			return "sandbox-exec";
		case "linux":
			return "bwrap";
		default:
			throw new Error(`Unsupported sandbox platform: ${platform}`);
	}
}

function quoteSandboxString(value: string): string {
	return JSON.stringify(value);
}

function normalizeDarwinTempPath(tempPath: string): string[] {
	const normalized = tempPath.endsWith("/") ? tempPath.slice(0, -1) : tempPath;
	if (normalized.length === 0) {
		return [];
	}

	if (normalized.startsWith("/private/")) {
		return [normalized, normalized.slice("/private".length)];
	}

	if (normalized.startsWith("/var/")) {
		return [normalized, `/private${normalized}`];
	}

	return [normalized];
}

function getDarwinTempPaths(env: NodeJS.ProcessEnv): string[] {
	const tempPaths = new Set<string>(DARWIN_TMP_PATHS);
	if (!env.TMPDIR) {
		return [...tempPaths];
	}

	for (const tempPath of normalizeDarwinTempPath(env.TMPDIR)) {
		tempPaths.add(tempPath);
	}

	return [...tempPaths];
}

export function createDarwinSandboxProfile(
	moduleDir: string,
	env: NodeJS.ProcessEnv = process.env,
	/** Operator-configured or core-runtime read-only paths (JUSTCLAW_SANDBOX_RO_PATHS, core runtime dir). */
	extraReadonlyPaths: string[] = [],
	/** Operator-configured read-write paths (JUSTCLAW_SANDBOX_RW_PATHS). */
	extraReadWritePaths: string[] = [],
): string {
	// sandbox-exec's (subpath moduleDir) does not grant read access to parent
	// directories themselves, but Bun reads ancestor directories on startup.
	// Use (literal …) for each ancestor up to the filesystem root (excluding /).
	const moduleDirAncestorLiterals = collectDarwinAncestorLiterals(moduleDir);
	const extraReadWriteAncestorLiterals = extraReadWritePaths.flatMap((p) =>
		collectDarwinAncestorLiterals(p),
	);

	const allowedReadonlySubpaths = [
		moduleDir,
		...DARWIN_READONLY_PATHS,
		...getDarwinTempPaths(env),
		...extraReadonlyPaths,
		...extraReadWritePaths,
	]
		.map((readonlyPath) => `  (subpath ${quoteSandboxString(readonlyPath)})`)
		.join("\n");
	const allowedTempSubpaths = getDarwinTempPaths(env)
		.map((tempPath) => `  (subpath ${quoteSandboxString(tempPath)})`)
		.join("\n");
	const allowedReadWriteSubpaths = extraReadWritePaths
		.map((p) => `  (subpath ${quoteSandboxString(p)})`)
		.join("\n");

	return [
		"(version 1)",
		"(deny default)",
		'(import "system.sb")',
		"(allow process*)",
		"(allow file-read-metadata)",
		"(allow file-read* file-map-executable",
		allowedReadonlySubpaths,
		...moduleDirAncestorLiterals,
		...extraReadWriteAncestorLiterals,
		")",
		"(allow file-write*",
		`  (subpath ${quoteSandboxString(moduleDir)})`,
		allowedTempSubpaths,
		allowedReadWriteSubpaths,
		")",
		"(allow network*)",
	].join("\n");
}

function collectDarwinAncestorLiterals(dir: string): string[] {
	const literals: string[] = [];
	let ancestor = path.dirname(dir);
	while (ancestor !== path.dirname(ancestor)) {
		literals.push(`  (literal ${quoteSandboxString(ancestor)})`);
		ancestor = path.dirname(ancestor);
	}
	return literals;
}

/**
 * sandbox-exec profile for a workspace (rw) and optional session history (ro).
 * When {@link includeHistoryDir} is false, {@link historyDir} is omitted from the profile
 * (host directory does not exist yet).
 */
export function createDarwinWorkspaceSandboxProfile(
	workspaceDir: string,
	historyDir: string,
	env: NodeJS.ProcessEnv = process.env,
	includeHistoryDir = true,
	characterDir?: string,
	modulesRoot?: string,
	skillsDir?: string,
	/** Operator-configured read-only paths (JUSTCLAW_SANDBOX_RO_PATHS). */
	extraReadonlyPaths: string[] = [],
	/** Operator-configured read-write paths (JUSTCLAW_SANDBOX_RW_PATHS). */
	extraReadWritePaths: string[] = [],
): string {
	const workspaceAncestors = collectDarwinAncestorLiterals(workspaceDir);
	const historyAncestors = includeHistoryDir
		? collectDarwinAncestorLiterals(historyDir)
		: [];
	const characterAncestors = characterDir
		? collectDarwinAncestorLiterals(characterDir)
		: [];
	const modulesAncestors = modulesRoot
		? collectDarwinAncestorLiterals(modulesRoot)
		: [];
	const skillsAncestors = skillsDir
		? collectDarwinAncestorLiterals(skillsDir)
		: [];
	const extraReadWriteAncestors = extraReadWritePaths.flatMap((p) =>
		collectDarwinAncestorLiterals(p),
	);

	const readonlySubpathEntries = [
		workspaceDir,
		...(includeHistoryDir ? [historyDir] : []),
		...(characterDir ? [characterDir] : []),
		...(modulesRoot ? [modulesRoot] : []),
		...(skillsDir ? [skillsDir] : []),
		...DARWIN_READONLY_PATHS,
		...getDarwinTempPaths(env),
		...extraReadonlyPaths,
		...extraReadWritePaths,
	]
		.map((p) => `  (subpath ${quoteSandboxString(p)})`)
		.join("\n");
	const allowedTempSubpaths = getDarwinTempPaths(env)
		.map((tempPath) => `  (subpath ${quoteSandboxString(tempPath)})`)
		.join("\n");
	const allowedReadWriteSubpaths = extraReadWritePaths
		.map((p) => `  (subpath ${quoteSandboxString(p)})`)
		.join("\n");

	return [
		"(version 1)",
		"(deny default)",
		'(import "system.sb")',
		"(allow process*)",
		"(allow file-read-metadata)",
		"(allow file-read* file-map-executable",
		readonlySubpathEntries,
		...workspaceAncestors,
		...historyAncestors,
		...characterAncestors,
		...modulesAncestors,
		...skillsAncestors,
		...extraReadWriteAncestors,
		")",
		"(allow file-write*",
		`  (subpath ${quoteSandboxString(workspaceDir)})`,
		...(characterDir
			? [`  (subpath ${quoteSandboxString(characterDir)})`]
			: []),
		...(modulesRoot ? [`  (subpath ${quoteSandboxString(modulesRoot)})`] : []),
		...(skillsDir ? [`  (subpath ${quoteSandboxString(skillsDir)})`] : []),
		allowedTempSubpaths,
		allowedReadWriteSubpaths,
		")",
		"(allow network*)",
	].join("\n");
}

function isPathCovered(
	candidatePath: string,
	mountedRoots: Iterable<string>,
): boolean {
	for (const root of mountedRoots) {
		if (candidatePath === root || candidatePath.startsWith(`${root}/`)) {
			return true;
		}
	}

	return false;
}

function isPathCoveredByAny(
	candidatePath: string,
	...rootSets: Iterable<string>[]
): boolean {
	return rootSets.some((roots) => isPathCovered(candidatePath, roots));
}

/**
 * Parses a colon-separated env var (JUSTCLAW_SANDBOX_RO_PATHS / _RW_PATHS) into
 * a list of absolute, normalized, existing paths. These come from the operator
 * (not module input), but are still validated to fail closed on misconfiguration:
 * relative paths, "..", "//", "/." and "/" itself are rejected, and paths that
 * don't exist on the host are skipped rather than passed to bwrap/sandbox-exec.
 */
async function resolveOperatorSandboxPaths(
	rawValue: string | undefined,
	envVarName: string,
	pathExists: (path: string) => Promise<boolean>,
): Promise<string[]> {
	const candidates = (rawValue ?? "")
		.split(":")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	const resolved: string[] = [];
	for (const candidate of candidates) {
		if (
			!path.isAbsolute(candidate) ||
			path.resolve(candidate) !== candidate ||
			candidate === "/"
		) {
			console.error(
				`${envVarName}: ignoring malformed path "${candidate}" (must be an absolute, normalized path other than "/")`,
			);
			continue;
		}
		if (!(await pathExists(candidate))) {
			console.error(
				`${envVarName}: ignoring path "${candidate}" (does not exist on host)`,
			);
			continue;
		}
		resolved.push(candidate);
	}
	return resolved;
}

async function resolveOperatorSandboxMounts(
	env: NodeJS.ProcessEnv,
	pathExists: (path: string) => Promise<boolean>,
): Promise<{ readonlyPaths: string[]; readWritePaths: string[] }> {
	const [readonlyPaths, readWritePaths] = await Promise.all([
		resolveOperatorSandboxPaths(
			env.JUSTCLAW_SANDBOX_RO_PATHS,
			"JUSTCLAW_SANDBOX_RO_PATHS",
			pathExists,
		),
		resolveOperatorSandboxPaths(
			env.JUSTCLAW_SANDBOX_RW_PATHS,
			"JUSTCLAW_SANDBOX_RW_PATHS",
			pathExists,
		),
	]);
	return { readonlyPaths, readWritePaths };
}

// Variable names always let through the workspace sandbox: enough for a shell to
// find its interpreter, know its home/temp/locale, and resolve JUSTCLAW_HOME. Any
// LC_* variable is also let through since locale customization uses an open-ended
// set of names (LC_ALL, LC_TIME, LC_COLLATE, ...).
const WORKSPACE_SANDBOX_ENV_ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"TMPDIR",
	"LANG",
	"TZ",
	"TERM",
	"USER",
	"LOGNAME",
	"JUSTCLAW_HOME",
]);

/**
 * Parses JUSTCLAW_SANDBOX_ENV (colon-separated variable names) into a list of
 * names to additionally let through the workspace sandbox allowlist. Unlike
 * JUSTCLAW_SANDBOX_RO_PATHS/_RW_PATHS this only names variables, not paths, so
 * there is nothing on the host to validate; a name absent from envBase is
 * silently dropped when the allowlist filter runs.
 */
function parseSandboxEnvAllowlist(rawValue: string | undefined): string[] {
	return (rawValue ?? "")
		.split(":")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * The workspace sandbox is the shell boundary the LLM drives directly (via
 * `sh -c`), unlike createSandboxLaunchSpec's module/timer processes, which are
 * legitimate consumers of secrets such as JUSTCLAW_OPENAI_API_KEY. Passing the
 * parent env through unfiltered here would let the LLM read those secrets with
 * `printenv`. Filter to a small allowlist instead; JUSTCLAW_SANDBOX_ENV lets an
 * operator extend it for tools the LLM legitimately needs (e.g. BRAVE_API_KEY
 * for a search tool invoked from the workspace shell).
 */
function filterWorkspaceSandboxEnv(
	envBase: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const extraNames = parseSandboxEnvAllowlist(envBase.JUSTCLAW_SANDBOX_ENV);
	const allowed = new Set([...WORKSPACE_SANDBOX_ENV_ALLOWLIST, ...extraNames]);

	const filtered: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(envBase)) {
		if (value === undefined) {
			continue;
		}
		if (allowed.has(key) || key.startsWith("LC_")) {
			filtered[key] = value;
		}
	}
	return filtered;
}

function appendReadonlyMount(cmd: string[], mountPath: string): void {
	appendDestinationAncestors(cmd, mountPath);
	cmd.push("--ro-bind", mountPath, mountPath);
}

function appendReadonlyFileMount(cmd: string[], mountPath: string): void {
	appendDestinationAncestors(cmd, path.dirname(mountPath));
	cmd.push("--ro-bind", mountPath, mountPath);
}

function appendWritableMount(cmd: string[], mountPath: string): void {
	appendDestinationAncestors(cmd, mountPath);
	cmd.push("--bind", mountPath, mountPath);
}

function appendDestinationAncestors(
	cmd: string[],
	destinationPath: string,
): void {
	const ancestors = destinationPath
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((_, index, segments) => `/${segments.slice(0, index + 1).join("/")}`);

	for (const ancestor of ancestors) {
		cmd.push("--dir", ancestor);
	}
}

export async function createLinuxBubblewrapCommand(
	bwrapPath: string,
	manifest: DaemonModuleManifest | TimerModuleManifest,
	options: LinuxBubblewrapOptions = {},
): Promise<string[]> {
	const env = options.env ?? process.env;
	const pathExists = options.pathExists ?? defaultPathExists;
	const realPath = options.realPath ?? defaultRealPath;
	const cmd = [
		bwrapPath,
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
	];
	// Tracked separately (rather than one combined set) so an operator RW path
	// nested under a standard RO root (e.g. /etc/myagent under /etc) is not
	// mistaken for "already covered" and silently downgraded to read-only.
	const roRoots = new Set<string>();
	const rwRoots = new Set<string>();

	for (const readonlyPath of LINUX_READONLY_PATHS) {
		if (await pathExists(readonlyPath)) {
			appendReadonlyMount(cmd, readonlyPath);
			roRoots.add(readonlyPath);
		}
	}

	if (await pathExists("/etc/resolv.conf")) {
		try {
			const resolverPath = await realPath("/etc/resolv.conf");
			if (!isPathCoveredByAny(resolverPath, roRoots, rwRoots)) {
				appendReadonlyFileMount(cmd, resolverPath);
				roRoots.add(resolverPath);
			}
		} catch {}
	}

	for (const writablePath of [...new Set(["/tmp", manifest.moduleDir])]) {
		if (!(await pathExists(writablePath))) {
			throw new Error(
				`Required writable sandbox path is unavailable: ${writablePath}`,
			);
		}
		appendWritableMount(cmd, writablePath);
		rwRoots.add(writablePath);
	}

	// Covers the common case of a module written in the same runtime as the
	// core (e.g. `#!/usr/bin/env bun` resolving to ~/.bun/bin/bun) without
	// parsing module-controlled shebangs.
	const coreRuntimeDir = path.dirname(process.execPath);
	if (
		!isPathCoveredByAny(coreRuntimeDir, roRoots, rwRoots) &&
		(await pathExists(coreRuntimeDir))
	) {
		appendReadonlyMount(cmd, coreRuntimeDir);
		roRoots.add(coreRuntimeDir);
	}

	const operatorMounts = await resolveOperatorSandboxMounts(env, pathExists);
	for (const readonlyPath of operatorMounts.readonlyPaths) {
		if (!isPathCoveredByAny(readonlyPath, roRoots, rwRoots)) {
			appendReadonlyMount(cmd, readonlyPath);
			roRoots.add(readonlyPath);
		}
	}
	for (const readWritePath of operatorMounts.readWritePaths) {
		if (isPathCovered(readWritePath, rwRoots)) {
			continue;
		}
		// Covered only by a RO root (e.g. operator asked for /etc/myagent rw,
		// but /etc is already ro-bound): still emit the --bind. bwrap applies
		// binds in order, so this later --bind makes the subpath writable,
		// overriding the earlier --ro-bind of its parent.
		if (isPathCovered(readWritePath, roRoots)) {
			console.error(
				`JUSTCLAW_SANDBOX_RW_PATHS: "${readWritePath}" overlaps a read-only sandbox root; mounting it read-write (overrides the read-only parent for this subpath)`,
			);
		}
		appendWritableMount(cmd, readWritePath);
		rwRoots.add(readWritePath);
	}

	cmd.push(
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--chdir",
		manifest.moduleDir,
		"--",
		manifest.execPath,
	);

	return cmd;
}

export async function createLinuxWorkspaceBwrapCommand(
	bwrapPath: string,
	workspaceDir: string,
	historyDir: string,
	options: LinuxWorkspaceBwrapOptions = {},
): Promise<string[]> {
	const env = options.env ?? process.env;
	const pathExists = options.pathExists ?? defaultPathExists;
	const realPath = options.realPath ?? defaultRealPath;
	const bindHistoryDir = options.bindHistoryDir ?? true;

	const cmd = [
		bwrapPath,
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
	];
	// Tracked separately (rather than one combined set) so an operator RW path
	// nested under a standard RO root (e.g. /etc/myagent under /etc) is not
	// mistaken for "already covered" and silently downgraded to read-only.
	const roRoots = new Set<string>();
	const rwRoots = new Set<string>();

	for (const readonlyPath of LINUX_READONLY_PATHS) {
		if (await pathExists(readonlyPath)) {
			appendReadonlyMount(cmd, readonlyPath);
			roRoots.add(readonlyPath);
		}
	}

	if (await pathExists("/etc/resolv.conf")) {
		try {
			const resolverPath = await realPath("/etc/resolv.conf");
			if (!isPathCoveredByAny(resolverPath, roRoots, rwRoots)) {
				appendReadonlyFileMount(cmd, resolverPath);
				roRoots.add(resolverPath);
			}
		} catch {}
	}

	if (!(await pathExists(workspaceDir))) {
		throw new Error(
			`Required workspace sandbox path is unavailable: ${workspaceDir}`,
		);
	}
	appendWritableMount(cmd, workspaceDir);
	rwRoots.add(workspaceDir);

	const characterDir = options.characterDir;
	if (
		characterDir !== undefined &&
		characterDir !== "" &&
		(await pathExists(characterDir))
	) {
		appendWritableMount(cmd, characterDir);
		rwRoots.add(characterDir);
	}

	const modulesRoot = options.modulesRoot;
	if (
		modulesRoot !== undefined &&
		modulesRoot !== "" &&
		(await pathExists(modulesRoot))
	) {
		appendWritableMount(cmd, modulesRoot);
		rwRoots.add(modulesRoot);
	}

	const skillsDir = options.skillsDir;
	if (
		skillsDir !== undefined &&
		skillsDir !== "" &&
		(await pathExists(skillsDir))
	) {
		appendWritableMount(cmd, skillsDir);
		rwRoots.add(skillsDir);
	}

	if (bindHistoryDir) {
		if (await pathExists(historyDir)) {
			appendReadonlyMount(cmd, historyDir);
			roRoots.add(historyDir);
		}
	}

	const tmpPath = "/tmp";
	if (!(await pathExists(tmpPath))) {
		throw new Error(
			`Required writable sandbox path is unavailable: ${tmpPath}`,
		);
	}
	appendWritableMount(cmd, tmpPath);
	rwRoots.add(tmpPath);

	const operatorMounts = await resolveOperatorSandboxMounts(env, pathExists);
	for (const readonlyPath of operatorMounts.readonlyPaths) {
		if (!isPathCoveredByAny(readonlyPath, roRoots, rwRoots)) {
			appendReadonlyMount(cmd, readonlyPath);
			roRoots.add(readonlyPath);
		}
	}
	for (const readWritePath of operatorMounts.readWritePaths) {
		if (isPathCovered(readWritePath, rwRoots)) {
			continue;
		}
		// Covered only by a RO root (e.g. operator asked for /etc/myagent rw,
		// but /etc is already ro-bound): still emit the --bind. bwrap applies
		// binds in order, so this later --bind makes the subpath writable,
		// overriding the earlier --ro-bind of its parent.
		if (isPathCovered(readWritePath, roRoots)) {
			console.error(
				`JUSTCLAW_SANDBOX_RW_PATHS: "${readWritePath}" overlaps a read-only sandbox root; mounting it read-write (overrides the read-only parent for this subpath)`,
			);
		}
		appendWritableMount(cmd, readWritePath);
		rwRoots.add(readWritePath);
	}

	cmd.push("--proc", "/proc", "--dev", "/dev", "--chdir", workspaceDir, "--");

	return cmd;
}

export async function createWorkspaceSandboxBaseCommand(
	workspaceDir: string,
	historyDir: string,
	options: WorkspaceSandboxBaseOptions = {},
): Promise<{
	backend: SandboxBackend;
	cmdPrefix: string[];
	env: NodeJS.ProcessEnv;
}> {
	const platform = options.platform ?? process.platform;
	const envBase = options.env ?? process.env;
	const pathExists = options.pathExists ?? defaultPathExists;
	const lookupExecutable = options.lookupExecutable ?? defaultLookupExecutable;
	const realPath = options.realPath ?? defaultRealPath;
	const characterDir = options.characterDir;
	const modulesRoot = options.modulesRoot;
	const skillsDir = options.skillsDir;

	const historyExists = await pathExists(historyDir);

	if (platform === "darwin") {
		const env = filterWorkspaceSandboxEnv(envBase);
		const sandboxExecPath = await lookupExecutable("sandbox-exec", env);
		if (!sandboxExecPath) {
			throw new Error("sandbox-exec backend is unavailable");
		}
		// Operator path allowlists live in envBase (JUSTCLAW_SANDBOX_RO/RW_PATHS
		// are not themselves in the workspace env allowlist, so they don't survive
		// filterWorkspaceSandboxEnv above).
		const operatorMounts = await resolveOperatorSandboxMounts(
			envBase,
			pathExists,
		);
		const profile = createDarwinWorkspaceSandboxProfile(
			workspaceDir,
			historyDir,
			env,
			historyExists,
			characterDir,
			modulesRoot,
			skillsDir,
			operatorMounts.readonlyPaths,
			operatorMounts.readWritePaths,
		);
		return {
			backend: "sandbox-exec",
			cmdPrefix: [sandboxExecPath, "-p", profile, "--"],
			env,
		};
	}

	if (platform === "linux") {
		// The host TMPDIR may point at a path that does not exist inside the
		// bwrap root; /tmp is always mounted writable, so pin TMPDIR to it.
		const env = { ...filterWorkspaceSandboxEnv(envBase), TMPDIR: "/tmp" };
		const bwrapPath = await lookupExecutable("bwrap", env);
		if (!bwrapPath) {
			throw new Error("bwrap backend is unavailable");
		}
		const cmdPrefix = await createLinuxWorkspaceBwrapCommand(
			bwrapPath,
			workspaceDir,
			historyDir,
			{
				// Same reasoning as the darwin branch above: pass the unfiltered
				// envBase so resolveOperatorSandboxMounts (called inside) still sees
				// JUSTCLAW_SANDBOX_RO/RW_PATHS. The filtered `env` above is only for
				// the spawned process's environment.
				env: envBase,
				pathExists,
				realPath,
				bindHistoryDir: historyExists,
				characterDir,
				modulesRoot,
				skillsDir,
			},
		);
		return {
			backend: "bwrap",
			cmdPrefix,
			env,
		};
	}

	throw new Error(`Unsupported sandbox platform: ${platform}`);
}

function ensurePathContainsDir(env: NodeJS.ProcessEnv, dir: string): void {
	const pathEntries = (env.PATH ?? "")
		.split(":")
		.filter((entry) => entry.length > 0);
	if (!pathEntries.includes(dir)) {
		env.PATH = [dir, ...pathEntries].join(":");
	}
}

export async function createSandboxLaunchSpec(
	manifest: DaemonModuleManifest | TimerModuleManifest,
	options: SandboxOptions = {},
): Promise<SandboxLaunchSpec> {
	const platform = options.platform ?? process.platform;
	// On Linux the host TMPDIR may point at a path that does not exist inside
	// the bwrap root; /tmp is always mounted writable, so pin TMPDIR to it.
	// On darwin the host paths remain visible, so the sandbox profile allows
	// the host TMPDIR instead (see getDarwinTempPaths).
	const env =
		platform === "linux"
			? { ...(options.env ?? process.env), TMPDIR: "/tmp" }
			: { ...(options.env ?? process.env) };
	const lookupExecutable = options.lookupExecutable ?? defaultLookupExecutable;
	const pathExists = options.pathExists ?? defaultPathExists;
	const backend = resolveSandboxBackend(platform);

	// An interpreter named by a module's shebang (e.g. `#!/usr/bin/env bun`)
	// must resolve via PATH at exec time, since the core no longer parses
	// module shebangs to derive mounts (see resolveOperatorSandboxMounts).
	const coreRuntimeDir = path.dirname(process.execPath);
	ensurePathContainsDir(env, coreRuntimeDir);

	if (backend === "sandbox-exec") {
		const sandboxExecPath = await lookupExecutable("sandbox-exec", env);
		if (!sandboxExecPath) {
			throw new Error("sandbox-exec backend is unavailable");
		}
		const standardCovered = [
			manifest.moduleDir,
			...DARWIN_READONLY_PATHS,
			...getDarwinTempPaths(env),
		];
		const extraReadonlyPaths = (await pathExists(coreRuntimeDir))
			? [coreRuntimeDir].filter((p) => !isPathCovered(p, standardCovered))
			: [];
		const operatorMounts = await resolveOperatorSandboxMounts(env, pathExists);
		for (const readonlyPath of operatorMounts.readonlyPaths) {
			if (
				!isPathCovered(readonlyPath, [
					...standardCovered,
					...extraReadonlyPaths,
				])
			) {
				extraReadonlyPaths.push(readonlyPath);
			}
		}
		const extraReadWritePaths = operatorMounts.readWritePaths.filter(
			(p) => !isPathCovered(p, standardCovered),
		);

		return {
			backend,
			cmd: [
				sandboxExecPath,
				"-p",
				createDarwinSandboxProfile(
					manifest.moduleDir,
					env,
					extraReadonlyPaths,
					extraReadWritePaths,
				),
				"--",
				manifest.execPath,
			],
			cwd: manifest.moduleDir,
			env,
		};
	}

	const bwrapPath = await lookupExecutable("bwrap", env);
	if (!bwrapPath) {
		throw new Error("bwrap backend is unavailable");
	}

	return {
		backend,
		cmd: await createLinuxBubblewrapCommand(bwrapPath, manifest, {
			env,
			pathExists,
			realPath: options.realPath ?? defaultRealPath,
		}),
		cwd: manifest.moduleDir,
		env,
	};
}
