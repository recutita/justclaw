import { readInitContent } from "./agent-context";
import {
	type EventDropDaemon,
	notifyDropped,
	notifyEventDropped,
} from "./event-dropped";
import {
	ACTIVE_SESSION_META_KEY,
	type EventQueue,
	formatLocalTimestamp,
} from "./event-queue";
import type { SessionStore } from "./session-store";

export type EventParams = Record<string, unknown> & {
	type: "event.v1" | "image.send.v1" | "file.send.v1" | "audio.send.v1";
};

export function parseEventNotificationParams(
	moduleName: string,
	params: unknown,
): EventParams {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new Error(`${moduleName}: event params must be an object`);
	}

	const record = params as Record<string, unknown>;
	if (
		record.type !== "event.v1" &&
		record.type !== "image.send.v1" &&
		record.type !== "file.send.v1" &&
		record.type !== "audio.send.v1"
	) {
		throw new Error(
			`${moduleName}: event type must be "event.v1", "image.send.v1", "file.send.v1", or "audio.send.v1"`,
		);
	}

	return record as EventParams;
}

function requireParamsId(
	manifestName: string,
	params: unknown,
	type: string,
): string {
	if (
		typeof params !== "object" ||
		params === null ||
		typeof (params as Record<string, unknown>).id !== "string" ||
		(params as Record<string, unknown>).id === ""
	) {
		throw new Error(
			`${manifestName}: ${type} requires a non-empty string "id"`,
		);
	}
	return (params as Record<string, unknown>).id as string;
}

async function resolveReadableOrFallbackActiveSessionId(
	queue: EventQueue,
	sessionStore: SessionStore,
): Promise<string | null> {
	const metaId = queue.getMeta(ACTIVE_SESSION_META_KEY);
	if (metaId !== null) {
		try {
			const history = await sessionStore.load(metaId);
			if (history !== null) {
				return metaId;
			}
			console.warn(
				`[core] active_session_id "${metaId}" is missing, unreadable, or invalid; falling back to newest readable session`,
			);
		} catch (error) {
			console.warn(
				`[core] active_session_id metadata lookup: session "${metaId}" is invalid or unreadable (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}

	const fallbackId = sessionStore.newestReadableSessionId();
	return fallbackId;
}

export function createSessionRequestHandler(
	manifestName: string,
	queue: EventQueue,
	sessionStore: SessionStore,
	characterDir?: string,
	daemonsRef?: { current: EventDropDaemon[] },
): (method: string, params: unknown) => Promise<unknown> {
	return async (method, params) => {
		if (method === "sessions") {
			const type =
				typeof params === "object" && params !== null
					? (params as Record<string, unknown>).type
					: undefined;

			if (type === "sessions.new.v1") {
				const id = Bun.randomUUIDv7();
				await sessionStore.create(id);
				return { id };
			}

			if (type === "sessions.switch.v1") {
				const id = requireParamsId(manifestName, params, "sessions.switch.v1");
				// Pre-check: reject immediately if the session does not exist, so the module
				// gets a synchronous error rather than a later event.dropped.v1.
				// The LLM loop loads the file again at apply time because the file may be
				// removed or become unreadable between this check and the queue drain.
				const history = await sessionStore.load(id);
				if (history === null) {
					throw new Error(
						`${manifestName}: sessions.switch.v1: session "${id}" is unreadable or does not exist`,
					);
				}
				queue.enqueue(manifestName, { type: "sessions.switch.v1", id });
				// Enqueue INIT before returning "ok" so it is ahead of any event the caller
				// sends after receiving the response. Only fires for empty (new) sessions.
				if (history.length === 0 && characterDir) {
					const initText = await readInitContent(characterDir);
					if (initText) {
						queue.enqueue(manifestName, { type: "event.v1", text: initText });
					}
				}
				return "ok";
			}

			if (type === "sessions.active.v1") {
				const activeId = await resolveReadableOrFallbackActiveSessionId(
					queue,
					sessionStore,
				);
				if (activeId !== null) {
					return { id: activeId };
				}

				throw new Error(
					`${manifestName}: sessions.active.v1: no active session`,
				);
			}

			if (type === "sessions.list.v1") {
				return { ids: sessionStore.list() };
			}

			if (type === "sessions.delete.v1") {
				const id = requireParamsId(manifestName, params, "sessions.delete.v1");
				await sessionStore.delete(id);
				if (id === queue.getMeta(ACTIVE_SESSION_META_KEY)) {
					queue.deleteMeta(ACTIVE_SESSION_META_KEY);
				}
				return "ok";
			}

			if (type === "sessions.get.v1") {
				const id = requireParamsId(manifestName, params, "sessions.get.v1");
				const history = await sessionStore.load(id);
				if (history === null) {
					throw new Error(
						`${manifestName}: sessions.get.v1: session "${id}" does not exist or could not be read`,
					);
				}
				return { history };
			}

			if (type === "sessions.interrupt.v1") {
				if (typeof params !== "object" || params === null) {
					throw new Error(
						`${manifestName}: sessions.interrupt.v1 requires an object params`,
					);
				}
				const { type: _type, ...payload } = params as Record<string, unknown>;
				const previous = queue.setInterrupt(manifestName, {
					type: "event.v1",
					...payload,
				});
				if (previous && daemonsRef) {
					// The interrupt slot has no UUIDv7 id, so the timestamp comes from
					// wall-clock time rather than the event id (see notifyDropped).
					notifyDropped(
						daemonsRef.current,
						previous.source,
						previous.params,
						formatLocalTimestamp(Date.now()),
					);
				}
				return "ok";
			}

			if (type === "sessions.skip.v1") {
				const aborted = queue.abortCurrentRun();
				return aborted ? "ok" : "no-op";
			}

			if (type === "sessions.kill.v1") {
				const killed = queue.killPending();
				if (daemonsRef) {
					for (const event of killed) {
						notifyEventDropped(daemonsRef.current, event);
					}
				}
				return "ok";
			}

			throw new Error(
				`${manifestName}: unsupported sessions type "${String(type)}"`,
			);
		}

		throw new Error(`${manifestName}: unsupported method "${method}"`);
	};
}
