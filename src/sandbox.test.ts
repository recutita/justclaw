import { describe, expect, test } from "bun:test";
import type { DaemonModuleManifest } from "./module-manifest";
import {
	createDarwinWorkspaceSandboxProfile,
	createLinuxBubblewrapCommand,
	createLinuxWorkspaceBwrapCommand,
	createWorkspaceSandboxBaseCommand,
} from "./sandbox";

describe("workspace sandbox profiles", () => {
	test("darwin workspace profile includes workspace and history read, workspace write", () => {
		const ws = "/Users/dev/justclaw/workspace";
		const hist = "/Users/dev/justclaw/history";
		const profile = createDarwinWorkspaceSandboxProfile(
			ws,
			hist,
			process.env,
			true,
		);
		expect(profile).toContain(`(subpath ${JSON.stringify(ws)})`);
		expect(profile).toContain(`(subpath ${JSON.stringify(hist)})`);
		const writeSection = profile.slice(profile.indexOf("(allow file-write*"));
		expect(writeSection).toContain(`(subpath ${JSON.stringify(ws)})`);
		expect(writeSection).not.toContain(`(subpath ${JSON.stringify(hist)})`);
		expect(profile).toContain("(allow network*)");
	});

	test("darwin workspace profile grants read-write on optional character dir", () => {
		const ws = "/Users/dev/justclaw/workspace";
		const hist = "/Users/dev/justclaw/history";
		const ch = "/Users/dev/justclaw/character";
		const profile = createDarwinWorkspaceSandboxProfile(
			ws,
			hist,
			process.env,
			true,
			ch,
		);
		expect(profile).toContain(`(subpath ${JSON.stringify(ch)})`);
		const writeSection = profile.slice(profile.indexOf("(allow file-write*"));
		expect(writeSection).toContain(`(subpath ${JSON.stringify(ch)})`);
	});

	test("darwin workspace profile grants read-write on optional modules dir", () => {
		const ws = "/Users/dev/justclaw/workspace";
		const hist = "/Users/dev/justclaw/history";
		const mods = "/Users/dev/justclaw/modules";
		const profile = createDarwinWorkspaceSandboxProfile(
			ws,
			hist,
			process.env,
			true,
			undefined,
			mods,
		);
		expect(profile).toContain(`(subpath ${JSON.stringify(mods)})`);
		const writeSection = profile.slice(profile.indexOf("(allow file-write*"));
		expect(writeSection).toContain(`(subpath ${JSON.stringify(mods)})`);
	});

	test("darwin workspace profile omits history when includeHistoryDir is false", () => {
		const ws = "/tmp/ws";
		const hist = "/tmp/hist";
		const profile = createDarwinWorkspaceSandboxProfile(
			ws,
			hist,
			process.env,
			false,
		);
		expect(profile).toContain(`(subpath ${JSON.stringify(ws)})`);
		expect(profile).not.toContain(`(subpath ${JSON.stringify(hist)})`);
	});

	test("linux workspace bwrap command binds workspace and optional history", async () => {
		const pathExists = async (p: string) =>
			p === "/bin" ||
			p === "/tmp" ||
			p === "/etc/resolv.conf" ||
			p === "/ws" ||
			p === "/hist";
		const cmd = await createLinuxWorkspaceBwrapCommand(
			"/usr/bin/bwrap",
			"/ws",
			"/hist",
			{
				pathExists,
				realPath: async (p) => p,
				bindHistoryDir: true,
			},
		);
		const joined = cmd.join(" ");
		// Linux workspace bwrap uses the same host path inside the sandbox (no /workspace remap).
		expect(joined).toContain("--bind /ws /ws");
		expect(joined).toContain("--ro-bind /hist /hist");
		expect(joined).toContain("--chdir /ws");
		expect(cmd[cmd.length - 1]).toBe("--");
	});

	test("linux workspace bwrap command rw-binds character dir when present", async () => {
		const pathExists = async (p: string) =>
			p === "/bin" ||
			p === "/tmp" ||
			p === "/ws" ||
			p === "/hist" ||
			p === "/char";
		const cmd = await createLinuxWorkspaceBwrapCommand(
			"/usr/bin/bwrap",
			"/ws",
			"/hist",
			{
				pathExists,
				realPath: async (p) => p,
				bindHistoryDir: true,
				characterDir: "/char",
			},
		);
		expect(cmd.join(" ")).toContain("--bind /char /char");
	});

	test("linux workspace bwrap command rw-binds modules dir when present", async () => {
		const pathExists = async (p: string) =>
			p === "/bin" ||
			p === "/tmp" ||
			p === "/ws" ||
			p === "/hist" ||
			p === "/mods";
		const cmd = await createLinuxWorkspaceBwrapCommand(
			"/usr/bin/bwrap",
			"/ws",
			"/hist",
			{
				pathExists,
				realPath: async (p) => p,
				bindHistoryDir: true,
				modulesRoot: "/mods",
			},
		);
		expect(cmd.join(" ")).toContain("--bind /mods /mods");
	});

	test("linux workspace bwrap command skips history ro-bind when bindHistoryDir is false", async () => {
		const pathExists = async (p: string) =>
			p === "/bin" || p === "/tmp" || p === "/ws";
		const cmd = await createLinuxWorkspaceBwrapCommand(
			"/usr/bin/bwrap",
			"/ws",
			"/hist",
			{
				pathExists,
				realPath: async (p) => p,
				bindHistoryDir: false,
			},
		);
		expect(cmd.join(" ")).not.toContain("--ro-bind /hist /hist");
	});

	test("createWorkspaceSandboxBaseCommand returns sandbox-exec prefix on darwin", async () => {
		const spec = await createWorkspaceSandboxBaseCommand(
			"/tmp/ws",
			"/tmp/hist",
			{
				platform: "darwin",
				pathExists: async () => true,
				lookupExecutable: async (command) =>
					command === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null,
			},
		);
		expect(spec.backend).toBe("sandbox-exec");
		expect(spec.cmdPrefix[0]).toBe("/usr/bin/sandbox-exec");
		expect(spec.cmdPrefix[1]).toBe("-p");
		expect(spec.cmdPrefix[spec.cmdPrefix.length - 1]).toBe("--");
	});

	test("operator RW path nested under a standard RO root still gets a --bind, with a warning (module sandbox)", async () => {
		const manifest: DaemonModuleManifest = {
			name: "mod",
			mode: "daemon",
			exec: "run.ts",
			moduleDir: "/modules/mod",
			execPath: "/modules/mod/run.ts",
			replyable: false,
		};
		const pathExists = async (p: string) =>
			p === "/bin" ||
			p === "/etc" ||
			p === "/tmp" ||
			p === "/modules/mod" ||
			p === "/etc/myagent";
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
					pathExists,
					realPath: async (p) => p,
					env: { JUSTCLAW_SANDBOX_RW_PATHS: "/etc/myagent" },
				},
			);
			const joined = cmd.join(" ");
			expect(joined).toContain("--ro-bind /etc /etc");
			expect(joined).toContain("--bind /etc/myagent /etc/myagent");
			expect(
				errors.some((args) =>
					String(args[0]).includes("JUSTCLAW_SANDBOX_RW_PATHS"),
				),
			).toBe(true);
		} finally {
			console.error = originalConsoleError;
		}
	});

	test("operator RW path nested under a standard RO root still gets a --bind, with a warning (workspace sandbox)", async () => {
		const pathExists = async (p: string) =>
			p === "/bin" ||
			p === "/etc" ||
			p === "/tmp" ||
			p === "/ws" ||
			p === "/etc/myagent";
		const originalConsoleError = console.error;
		const errors: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		try {
			const cmd = await createLinuxWorkspaceBwrapCommand(
				"/usr/bin/bwrap",
				"/ws",
				"/hist",
				{
					pathExists,
					realPath: async (p) => p,
					bindHistoryDir: false,
					env: { JUSTCLAW_SANDBOX_RW_PATHS: "/etc/myagent" },
				},
			);
			const joined = cmd.join(" ");
			expect(joined).toContain("--ro-bind /etc /etc");
			expect(joined).toContain("--bind /etc/myagent /etc/myagent");
			expect(
				errors.some((args) =>
					String(args[0]).includes("JUSTCLAW_SANDBOX_RW_PATHS"),
				),
			).toBe(true);
		} finally {
			console.error = originalConsoleError;
		}
	});

	test("createWorkspaceSandboxBaseCommand returns bwrap prefix on linux", async () => {
		const spec = await createWorkspaceSandboxBaseCommand("/ws", "/hist", {
			platform: "linux",
			pathExists: async (p) =>
				p === "/bin" ||
				p === "/tmp" ||
				p === "/ws" ||
				p === "/hist" ||
				p === "/etc/resolv.conf",
			realPath: async (p) => p,
			lookupExecutable: async (command) =>
				command === "bwrap" ? "/usr/bin/bwrap" : null,
		});
		expect(spec.backend).toBe("bwrap");
		expect(spec.env.TMPDIR).toBe("/tmp");
		expect(spec.cmdPrefix[0]).toBe("/usr/bin/bwrap");
		expect(spec.cmdPrefix[spec.cmdPrefix.length - 1]).toBe("--");
	});
});

describe("workspace sandbox environment allowlist", () => {
	test("filters secrets out of the darwin workspace sandbox env", async () => {
		const spec = await createWorkspaceSandboxBaseCommand(
			"/tmp/ws",
			"/tmp/hist",
			{
				platform: "darwin",
				env: { PATH: "/usr/bin", JUSTCLAW_OPENAI_API_KEY: "secret" },
				pathExists: async () => true,
				lookupExecutable: async (command) =>
					command === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null,
			},
		);
		expect(spec.env.JUSTCLAW_OPENAI_API_KEY).toBeUndefined();
		expect(spec.env.PATH).toBe("/usr/bin");
	});

	test("filters secrets out of the linux workspace sandbox env", async () => {
		const spec = await createWorkspaceSandboxBaseCommand("/ws", "/hist", {
			platform: "linux",
			env: { PATH: "/usr/bin", JUSTCLAW_OPENAI_API_KEY: "secret" },
			pathExists: async (p) =>
				p === "/bin" ||
				p === "/tmp" ||
				p === "/ws" ||
				p === "/hist" ||
				p === "/etc/resolv.conf",
			realPath: async (p) => p,
			lookupExecutable: async (command) =>
				command === "bwrap" ? "/usr/bin/bwrap" : null,
		});
		expect(spec.env.JUSTCLAW_OPENAI_API_KEY).toBeUndefined();
		expect(spec.env.PATH).toBe("/usr/bin");
	});

	test("allows the default allowlist and LC_ prefixed variables through", async () => {
		const spec = await createWorkspaceSandboxBaseCommand(
			"/tmp/ws",
			"/tmp/hist",
			{
				platform: "darwin",
				env: {
					PATH: "/usr/bin",
					HOME: "/home/dev",
					LANG: "en_US.UTF-8",
					TZ: "UTC",
					TERM: "xterm",
					USER: "dev",
					LOGNAME: "dev",
					JUSTCLAW_HOME: "/home/dev/justclaw",
					LC_ALL: "en_US.UTF-8",
					RANDOM_SECRET: "nope",
				},
				pathExists: async () => true,
				lookupExecutable: async (command) =>
					command === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null,
			},
		);
		expect(spec.env.PATH).toBe("/usr/bin");
		expect(spec.env.HOME).toBe("/home/dev");
		expect(spec.env.LANG).toBe("en_US.UTF-8");
		expect(spec.env.TZ).toBe("UTC");
		expect(spec.env.TERM).toBe("xterm");
		expect(spec.env.USER).toBe("dev");
		expect(spec.env.LOGNAME).toBe("dev");
		expect(spec.env.JUSTCLAW_HOME).toBe("/home/dev/justclaw");
		expect(spec.env.LC_ALL).toBe("en_US.UTF-8");
		expect(spec.env.RANDOM_SECRET).toBeUndefined();
	});

	test("JUSTCLAW_SANDBOX_ENV lets additional named variables through, ignoring empty and unset entries", async () => {
		const spec = await createWorkspaceSandboxBaseCommand(
			"/tmp/ws",
			"/tmp/hist",
			{
				platform: "darwin",
				env: {
					PATH: "/usr/bin",
					JUSTCLAW_SANDBOX_ENV: "FOO::BAR:MISSING",
					FOO: "foo-value",
					BAR: "bar-value",
				},
				pathExists: async () => true,
				lookupExecutable: async (command) =>
					command === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null,
			},
		);
		expect(spec.env.FOO).toBe("foo-value");
		expect(spec.env.BAR).toBe("bar-value");
		expect(spec.env.MISSING).toBeUndefined();
		// JUSTCLAW_SANDBOX_ENV names variables to let through; it does not name itself.
		expect(spec.env.JUSTCLAW_SANDBOX_ENV).toBeUndefined();
	});

	test("linux workspace sandbox still forces TMPDIR to /tmp regardless of host TMPDIR", async () => {
		const spec = await createWorkspaceSandboxBaseCommand("/ws", "/hist", {
			platform: "linux",
			env: { PATH: "/usr/bin", TMPDIR: "/custom/tmp" },
			pathExists: async (p) =>
				p === "/bin" ||
				p === "/tmp" ||
				p === "/ws" ||
				p === "/hist" ||
				p === "/etc/resolv.conf",
			realPath: async (p) => p,
			lookupExecutable: async (command) =>
				command === "bwrap" ? "/usr/bin/bwrap" : null,
		});
		expect(spec.env.TMPDIR).toBe("/tmp");
	});

	test("JUSTCLAW_SANDBOX_RO_PATHS still reaches the mount resolver after the env allowlist filter (linux)", async () => {
		const pathExists = async (p: string) =>
			p === "/tmp" || p === "/ws" || p === "/srv/extra";
		const spec = await createWorkspaceSandboxBaseCommand("/ws", "/hist", {
			platform: "linux",
			env: { PATH: "/usr/bin", JUSTCLAW_SANDBOX_RO_PATHS: "/srv/extra" },
			pathExists,
			realPath: async (p) => p,
			lookupExecutable: async (command) =>
				command === "bwrap" ? "/usr/bin/bwrap" : null,
		});
		const joined = spec.cmdPrefix.join(" ");
		expect(joined).toContain("--ro-bind /srv/extra /srv/extra");
		// The path env vars themselves are not part of the filtered spawn env.
		expect(spec.env.JUSTCLAW_SANDBOX_RO_PATHS).toBeUndefined();
	});
});
