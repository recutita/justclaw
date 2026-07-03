import { type QueuedEvent, timestampFromUUIDv7 } from "./event-queue";

/** Minimal daemon shape so this module does not depend on `./runtime` (avoids cycles). */
export type EventDropDaemon = {
	manifest: { name: string };
	peer: { notify(method: string, params: unknown): void };
	// Optional lifecycle state (matches runtime.ts's DaemonState). When present
	// and not "running", the daemon's peer transport has already been closed
	// (see handleDaemonFailure), so peer.notify would be a silent no-op rather
	// than an actual delivery. Structurally compatible with the real daemon
	// records passed in from runtime.ts without importing that module here.
	state?: string;
};

// Omit binary data fields from dropped notifications to avoid sending large
// payloads (e.g. base64 image/file/audio contents) back through the module channel.
function sanitizeParams(params: unknown): unknown {
	if (typeof params !== "object" || params === null) return params;
	const record = params as Record<string, unknown>;
	if (
		record.type !== "image.send.v1" &&
		record.type !== "file.send.v1" &&
		record.type !== "audio.send.v1"
	) {
		return params;
	}
	const { data: _data, ...rest } = record;
	return rest;
}

// Send an event.dropped.v1 notification to the source module, or log the loss
// if that module is not available. The timestamp is supplied by the caller:
// dropped queue events derive it from their UUIDv7 id, while interrupt-slot
// events have no id and use wall-clock time. `idForLog` is optional for the
// same reason (interrupt slots have no id to log).
export function notifyDropped(
	daemons: EventDropDaemon[],
	source: string,
	params: unknown,
	timestamp: string,
	idForLog?: string,
): void {
	const daemon = daemons.find((d) => d.manifest.name === source);
	// A daemon with a defined, non-"running" state has already had its peer
	// closed (e.g. mid-restart after an unexpected exit); notify() on a closed
	// peer is a silent no-op, so treat it the same as "daemon not found".
	if (daemon && (daemon.state === undefined || daemon.state === "running")) {
		daemon.peer.notify("event", {
			type: "event.dropped.v1",
			source,
			timestamp,
			params: sanitizeParams(params),
		});
	} else {
		const idSuffix = idForLog ? ` id=${idForLog}` : "";
		console.error(`[core] event lost: source=${source}${idSuffix}`);
	}
}

export function notifyEventDropped(
	daemons: EventDropDaemon[],
	event: QueuedEvent,
): void {
	notifyDropped(
		daemons,
		event.source,
		event.params,
		timestampFromUUIDv7(event.id),
		event.id,
	);
}
