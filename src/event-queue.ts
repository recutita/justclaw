import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type QueuedEvent = {
	id: string;
	source: string;
	params: Record<string, unknown>;
};

export const ACTIVE_SESSION_META_KEY = "active_session_id";
export const LAST_REPLYABLE_TARGET_META_KEY = "last_replyable_target";

export function timestampFromUUIDv7(uuid: string): string {
	return new Date(
		parseInt(uuid.replace(/-/g, "").slice(0, 12), 16),
	).toISOString();
}

export function resolveEventQueuePath(
	justclawHome = process.env.JUSTCLAW_HOME,
	homeDir = process.env.HOME,
): string {
	if (justclawHome) {
		return path.resolve(justclawHome, "events.db");
	}

	if (!homeDir) {
		throw new Error(
			"HOME is not set and JUSTCLAW_HOME is not set; cannot resolve event queue path",
		);
	}

	return path.resolve(homeDir, "justclaw", "events.db");
}

type Waiter = (value: QueuedEvent | undefined) => void;

type InterruptSlot = {
	source: string;
	params: Record<string, unknown>;
};

export class EventQueue {
	#db: Database;
	#closed = false;
	#waiter: Waiter | null = null;
	#runController: AbortController | null = null;
	#interrupt: InterruptSlot | null = null;

	get closed(): boolean {
		return this.#closed;
	}

	constructor(dbPath: string) {
		// SQLite opens the file path as-is; it does not create missing parents.
		mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
		this.#db = new Database(dbPath);
		this.#db.exec("PRAGMA journal_mode=WAL;");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id            TEXT PRIMARY KEY,
				source        TEXT NOT NULL,
				params        TEXT NOT NULL,
				state         TEXT NOT NULL DEFAULT 'pending',
				running_since TEXT
			);
		`);
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS meta (
				key   TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
	}

	enqueue(source: string, params: Record<string, unknown>): void {
		if (this.#closed) {
			// Nothing will ever call next() again once the queue is closed, so
			// this event can never be delivered. Log the loss instead of a
			// silent discard (matches the "log the loss" convention used
			// elsewhere, e.g. notifyDropped's missing-daemon case).
			console.error(`[core] event lost: source=${source} (queue closed)`);
			return;
		}

		const id = Bun.randomUUIDv7();
		const paramsJson = JSON.stringify(params);
		const waiter = this.#waiter;
		if (waiter) {
			const runningSince = new Date().toISOString();
			this.#db.run(
				"INSERT INTO events (id, source, params, state, running_since) VALUES (?, ?, ?, 'running', ?)",
				[id, source, paramsJson, runningSince],
			);
			this.#waiter = null;
			waiter({ id, source, params });
		} else {
			this.#db.run("INSERT INTO events (id, source, params) VALUES (?, ?, ?)", [
				id,
				source,
				paramsJson,
			]);
		}
	}

	async next(): Promise<QueuedEvent | undefined> {
		if (this.#closed) {
			return undefined;
		}

		const row = this.#db
			.query(
				"SELECT id, source, params FROM events WHERE state = 'pending' ORDER BY id ASC LIMIT 1",
			)
			.get() as { id: string; source: string; params: string } | null;

		if (row) {
			const runningSince = new Date().toISOString();
			this.#db.run(
				"UPDATE events SET state = 'running', running_since = ? WHERE id = ?",
				[runningSince, row.id],
			);
			return {
				id: row.id,
				source: row.source,
				params: JSON.parse(row.params) as QueuedEvent["params"],
			};
		}

		if (this.#closed) {
			return undefined;
		}

		return new Promise<QueuedEvent | undefined>((resolve) => {
			if (this.#closed) {
				resolve(undefined);
				return;
			}
			this.#waiter = resolve;
		});
	}

	complete(id: string): void {
		if (this.#closed) return;
		this.#db.run("DELETE FROM events WHERE id = ?", [id]);
	}

	getMeta(key: string): string | null {
		if (this.#closed) return null;
		const row = this.#db
			.query("SELECT value FROM meta WHERE key = ?")
			.get(key) as { value: string } | null;
		return row?.value ?? null;
	}

	setMeta(key: string, value: string): void {
		if (this.#closed) return;
		this.#db.run(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			[key, value],
		);
	}

	deleteMeta(key: string): void {
		if (this.#closed) return;
		this.#db.run("DELETE FROM meta WHERE key = ?", [key]);
	}

	stale(): QueuedEvent[] {
		const rows = this.#db
			.query(
				"SELECT id, source, params FROM events WHERE state = 'running' ORDER BY id ASC",
			)
			.all() as { id: string; source: string; params: string }[];

		return rows.map((row) => ({
			id: row.id,
			source: row.source,
			params: JSON.parse(row.params) as QueuedEvent["params"],
		}));
	}

	// Set the in-memory interrupt slot. Returns the previously set slot if any
	// (caller is responsible for emitting event.dropped.v1 for it).
	setInterrupt(
		source: string,
		params: Record<string, unknown>,
	): InterruptSlot | null {
		if (this.#closed) {
			// The loop's next() has already returned undefined for good, so no
			// future consumeInterrupt() call will ever pick this slot up. Log
			// both the new interrupt and any previously set one instead of
			// stranding them silently.
			console.error(`[core] interrupt lost: source=${source} (queue closed)`);
			if (this.#interrupt) {
				console.error(
					`[core] interrupt lost: source=${this.#interrupt.source} (queue closed)`,
				);
			}
			return null;
		}

		const previous = this.#interrupt;
		this.#interrupt = { source, params };
		// If the loop is parked in next() on an empty queue, wake it so the
		// interrupt slot is consumed promptly instead of waiting for the next
		// queued event (which may never arrive).
		const waiter = this.#waiter;
		if (waiter) {
			this.#waiter = null;
			waiter(undefined);
		}
		return previous;
	}

	// Consume and clear the interrupt slot. Returns null if no interrupt is set.
	consumeInterrupt(): InterruptSlot | null {
		const slot = this.#interrupt;
		this.#interrupt = null;
		return slot;
	}

	// Delete all pending events and return them. Caller is responsible for
	// emitting event.dropped.v1 to each source.
	killPending(): QueuedEvent[] {
		const rows = this.#db
			.query(
				"SELECT id, source, params FROM events WHERE state = 'pending' ORDER BY id ASC",
			)
			.all() as { id: string; source: string; params: string }[];
		if (rows.length > 0) {
			this.#db.run("DELETE FROM events WHERE state = 'pending'");
		}
		return rows.map((row) => ({
			id: row.id,
			source: row.source,
			params: JSON.parse(row.params) as QueuedEvent["params"],
		}));
	}

	// Register the AbortController for the currently running LLM cycle so that
	// sessions.skip.v1 can abort it.
	setRunController(ctrl: AbortController | null): void {
		this.#runController = ctrl;
	}

	// Abort the current LLM run. Returns true if a run was active, false otherwise.
	abortCurrentRun(): boolean {
		const ctrl = this.#runController;
		if (!ctrl) {
			return false;
		}
		this.#runController = null;
		ctrl.abort();
		return true;
	}

	close(): void {
		if (this.#closed) {
			return;
		}

		this.#closed = true;
		const waiter = this.#waiter;
		if (waiter) {
			this.#waiter = null;
			waiter(undefined);
		}
		this.#db.close();
	}
}
