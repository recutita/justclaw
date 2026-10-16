import { mkdirSync } from "node:fs";
import path from "node:path";
import {
	readInitContent,
	resolveCharacterDir,
	resolveSkillsDir,
} from "./agent-context";
import { resolveModelConfig, runLlmLoop } from "./llm-loop";
import {
	bootstrapRuntime,
	type StartedDaemon,
	stopDaemons,
	type TimerScheduler,
} from "./runtime";
import { removeSandboxTmpDir } from "./sandbox";
import { resolveHistoryDir, SessionStore } from "./session-store";
import {
	createSandboxedFileReader,
	createWorkspaceTools,
	resolveWorkspaceDir,
} from "./workspace";

function createShutdownSignal(): {
	dispose: () => void;
	promise: Promise<void>;
} {
	let resolved = false;
	let finish = () => {};
	const promise = new Promise<void>((resolve) => {
		finish = () => {
			if (!resolved) {
				resolved = true;
				resolve();
			}
		};
	});
	const dispose = () => {
		process.off("SIGINT", finish);
		process.off("SIGTERM", finish);
	};

	// Use `on`, not `once`: @openai/agents' tracing provider installs its own
	// SIGINT/SIGTERM handlers that call process.exit() unless another listener
	// is still registered (it checks process.listeners(sig).length > 1). A
	// `once` listener removes itself the moment the signal fires, so by the time
	// the SDK handler runs it sees no other listener and exits the process —
	// killing the core before stopDaemons can stop the module subprocesses,
	// orphaning them. `finish` is idempotent, so a persistent listener is safe.
	process.on("SIGINT", finish);
	process.on("SIGTERM", finish);

	return { dispose, promise };
}

async function main(): Promise<void> {
	const daemonsRef: { current: StartedDaemon[] } = { current: [] };
	let eventQueue:
		| Awaited<ReturnType<typeof bootstrapRuntime>>["eventQueue"]
		| undefined;
	const timerSchedulerRef: { current: TimerScheduler | undefined } = {
		current: undefined,
	};
	const shutdown = createShutdownSignal();
	const abortController = new AbortController();
	const shutdownTask = shutdown.promise.then(async () => {
		abortController.abort();
		await timerSchedulerRef.current?.stop();
		eventQueue?.close();
		await stopDaemons(daemonsRef.current);
	});

	try {
		const model = resolveModelConfig();
		const workspaceDir = resolveWorkspaceDir();
		const historyDir = resolveHistoryDir();
		const characterDir = resolveCharacterDir();
		const skillsDir = resolveSkillsDir();
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(characterDir, { recursive: true });
		mkdirSync(skillsDir, { recursive: true });
		const sessionStore = new SessionStore(historyDir);
		await sessionStore.ensureDefaultSessionIfEmpty();
		const readAgentFile = createSandboxedFileReader(
			workspaceDir,
			historyDir,
			process.platform,
			characterDir,
			skillsDir,
		);
		const result = await bootstrapRuntime({
			abortSignal: abortController.signal,
			startedDaemons: daemonsRef.current,
			sessionStore,
			readInit: () => readInitContent(characterDir, readAgentFile),
		});
		eventQueue = result.eventQueue;
		timerSchedulerRef.current = result.timerScheduler;
		const homeDir = path.dirname(result.modulesRoot);
		const workspaceTools = createWorkspaceTools(
			workspaceDir,
			historyDir,
			process.platform,
			characterDir,
			result.modulesRoot,
			skillsDir,
		);

		// If shutdown wins the race, we do not await runLlmLoop afterward. Main
		// returns once shutdownTask finishes; runLlmLoop may still be blocked on
		// runner.run (closing the queue does not cancel an in-flight LLM call).
		// The event row can stay `running` until the next start, when stale
		// recovery emits event.dropped.v1. Acceptable by design.
		await Promise.race([
			runLlmLoop(eventQueue, daemonsRef, model, {
				sessionStore,
				workspaceTools,
				workspaceDir,
				historyDir,
				characterDir,
				readAgentFile,
				homeDir,
				modulesRoot: result.modulesRoot,
				skillsDir,
				abortSignal: abortController.signal,
				timerSchedulerRef: timerSchedulerRef as { current: TimerScheduler },
			}),
			shutdownTask,
		]);
	} catch (error) {
		abortController.abort();
		await timerSchedulerRef.current?.stop();
		eventQueue?.close();
		await stopDaemons(daemonsRef.current);
		throw error;
	} finally {
		shutdown.dispose();
		removeSandboxTmpDir();
	}
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
