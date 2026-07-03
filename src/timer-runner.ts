import type { EventQueue } from "./event-queue";
import { consumeLines, type JsonRpcNotification, JsonRpcPeer } from "./jsonrpc";
import type { TimerModuleManifest } from "./module-manifest";
import {
	createSessionRequestHandler,
	parseEventNotificationParams,
} from "./module-peer";
import { createSandboxLaunchSpec, type SandboxLaunchSpec } from "./sandbox";
import type { SessionStore } from "./session-store";

const INITIALIZE_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 1_000;
// setTimeout clamps any delay above this to 1ms and fires immediately. A cron
// whose next match is farther out (e.g. "0 0 1 1 *", ~1 year) would otherwise
// fire in a tight loop, so long delays are split into re-evaluation hops.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Schedules timer firings in-process with {@link Bun.cron.parse} (UTC) and
 * `setTimeout`, matching docs/spec.md.
 *
 * OS-level `Bun.cron(path, schedule, title)` runs a file on a schedule and
 * cannot hold references to this process's event queue, session store, or
 * sandbox launch spec. Timer modules must enqueue into the same runtime as
 * daemons, so the core owns the schedule and spawns the module subprocess on
 * each tick.
 */
export function registerInProcessCron(
	cronExpression: string,
	onFire: () => void,
): { stop(): void } {
	let stopped = false;
	let handle: ReturnType<typeof setTimeout> | undefined;

	function scheduleFrom(anchorMs: number): void {
		if (stopped) {
			return;
		}
		const next = Bun.cron.parse(cronExpression, anchorMs);
		if (next === null) {
			console.error(
				`[timer] cron "${cronExpression}" has no upcoming match; stopping schedule`,
			);
			return;
		}
		const delay = next.getTime() - Date.now();
		if (delay > MAX_TIMEOUT_MS) {
			// Too far out to arm directly. Sleep the max safe span, then recompute
			// against the wall clock without firing, so the tick lands on time
			// instead of storming at the clamped 1ms delay.
			handle = setTimeout(() => {
				scheduleFrom(Date.now());
			}, MAX_TIMEOUT_MS);
			return;
		}
		handle = setTimeout(
			() => {
				if (stopped) {
					return;
				}
				onFire();
				// Recompute from the current wall clock, not next.getTime(): timer
				// modules are idempotent, so a late wake collapses missed ticks to a
				// single fire here instead of replaying the backlog with delay 0.
				scheduleFrom(Date.now());
			},
			Math.max(0, delay),
		);
	}

	scheduleFrom(Date.now());

	return {
		stop() {
			stopped = true;
			if (handle !== undefined) {
				clearTimeout(handle);
			}
		},
	};
}

async function killProcess(proc: Bun.Subprocess): Promise<void> {
	if (proc.exitCode !== null) {
		await proc.exited;
		return;
	}
	proc.kill("SIGTERM");
	await Promise.race([proc.exited, sleep(KILL_TIMEOUT_MS)]);
	if (proc.exitCode === null) {
		proc.kill("SIGKILL");
	}
	await proc.exited;
}

function createTimerModulePeer(
	manifest: TimerModuleManifest,
	process: Bun.Subprocess<"pipe", "pipe", "pipe">,
	queue: EventQueue,
	sessionStore: SessionStore,
): JsonRpcPeer {
	return new JsonRpcPeer({
		name: manifest.name,
		sendLine: (line) => {
			void process.stdin.write(`${line}\n`);
		},
		onNotification: (message: JsonRpcNotification) => {
			if (message.method === "event") {
				const params = parseEventNotificationParams(
					manifest.name,
					message.params,
				);
				queue.enqueue(manifest.name, params);
				return;
			}

			console.error(
				`[${manifest.name}] ignoring unsupported notification ${message.method}`,
			);
		},
		onRequest: createSessionRequestHandler(manifest.name, queue, sessionStore),
	});
}

/**
 * Runs the initialize handshake, waits for the module to exit, and cleans up
 * its peer/state. Kicked off detached from the spawn critical section (see
 * `fireTimer`) so a slow-initializing or long-lived module never blocks the
 * next tick's kill-previous/spawn.
 */
async function runTimerLifecycle(
	manifest: TimerModuleManifest,
	proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
	queue: EventQueue,
	sessionStore: SessionStore,
	state: { process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null },
	initializeTimeoutMs: number,
): Promise<void> {
	const peer = createTimerModulePeer(manifest, proc, queue, sessionStore);
	const stdoutTask = consumeLines(proc.stdout, (line) => {
		// A single malformed line (invalid JSON, bad envelope) must never tear
		// down the stream: handleLine throws on such lines, and an unhandled
		// rejection from consumeLines would crash the core before the finally
		// block below can await it. Log and keep consuming subsequent lines.
		try {
			peer.handleLine(line);
		} catch (error) {
			console.error(
				`[${manifest.name}] ignoring malformed line: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});
	// Attach a handler immediately so a stream-level rejection (distinct from
	// the per-line throw already caught above) is never unhandled while the
	// initialize/exit awaits below are still pending. The finally block awaits
	// the same task for ordering.
	stdoutTask.catch(() => {});
	void consumeLines(proc.stderr, (line) => {
		console.error(`[${manifest.name}] ${line}`);
	});

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const initTimeout = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			reject(new Error(`${manifest.name}: initialize timed out`));
		}, initializeTimeoutMs);
	});

	try {
		await Promise.race([peer.request("initialize"), initTimeout]);
		if (timeoutHandle !== undefined) {
			clearTimeout(timeoutHandle);
		}
		await proc.exited;
	} catch (error) {
		console.error(
			`[${manifest.name}] ${error instanceof Error ? error.message : String(error)}`,
		);
		if (proc.exitCode === null) {
			proc.kill("SIGKILL");
		}
	} finally {
		if (timeoutHandle !== undefined) {
			clearTimeout(timeoutHandle);
		}
		await stdoutTask.catch(() => {});
		peer.close(new Error(`${manifest.name}: timer module process ended`));
		if (state.process === proc) {
			state.process = null;
		}
	}
}

export async function fireTimer(
	manifest: TimerModuleManifest,
	state: {
		process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null;
		// Serializes kill-previous -> spawn -> record across overlapping ticks.
		// Without this, two ticks firing close together (e.g. a slow
		// sandboxFactory) can both observe `state.process === null` and spawn
		// concurrently. Chaining onto this promise makes that section atomic
		// per state, while the rest of the lifecycle (initialize handshake,
		// awaiting exit, cleanup) stays detached below so it never delays the
		// next tick's kill-previous/spawn.
		lock?: Promise<Bun.Subprocess<"pipe", "pipe", "pipe"> | null>;
	},
	queue: EventQueue,
	sessionStore: SessionStore,
	options: {
		sandboxFactory?: (
			manifest: TimerModuleManifest,
		) => Promise<SandboxLaunchSpec>;
		initializeTimeoutMs?: number;
	},
): Promise<void> {
	const lock = (state.lock ?? Promise.resolve(null)).then(async () => {
		// A rejection here would poison state.lock forever: every later tick's
		// `.then` chains onto a rejected promise and never runs, silently
		// killing the schedule. killProcess() isn't expected to throw, but
		// catch defensively so a surprise failure just skips this tick.
		try {
			if (state.process !== null) {
				await killProcess(state.process);
			}
		} catch (error) {
			console.error(
				`[${manifest.name}] failed to kill previous process: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}

		let sandboxSpec: SandboxLaunchSpec;
		try {
			sandboxSpec = await (options.sandboxFactory ?? createSandboxLaunchSpec)(
				manifest,
			);
		} catch (error) {
			console.error(
				`[${manifest.name}] failed to create sandbox: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}

		let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
		try {
			proc = Bun.spawn({
				cmd: sandboxSpec.cmd,
				cwd: sandboxSpec.cwd,
				env: sandboxSpec.env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			console.error(
				`[${manifest.name}] failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}

		state.process = proc;
		return proc;
	});
	state.lock = lock;

	const proc = await lock;
	if (proc === null) {
		return;
	}

	const initTimeoutMs = options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
	void runTimerLifecycle(
		manifest,
		proc,
		queue,
		sessionStore,
		state,
		initTimeoutMs,
	);
}

export type TimerScheduler = { stop(): Promise<void> };

export function startTimerSchedulers(
	manifests: TimerModuleManifest[],
	queue: EventQueue,
	sessionStore: SessionStore,
	options: {
		sandboxFactory?: (
			manifest: TimerModuleManifest,
		) => Promise<SandboxLaunchSpec>;
		initializeTimeoutMs?: number;
	} = {},
): TimerScheduler {
	if (manifests.length === 0) {
		return { async stop() {} };
	}

	const states: { process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null }[] =
		[];
	const cronJobs: { stop(): void }[] = [];

	for (const manifest of manifests) {
		const state: {
			process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null;
		} = { process: null };
		states.push(state);
		cronJobs.push(
			registerInProcessCron(manifest.cron, () => {
				void fireTimer(manifest, state, queue, sessionStore, options);
			}),
		);
	}

	return {
		async stop() {
			for (const job of cronJobs) {
				job.stop();
			}
			await Promise.all(
				states.map((state) => {
					const proc = state.process;
					return proc !== null ? killProcess(proc) : Promise.resolve();
				}),
			);
		},
	};
}
