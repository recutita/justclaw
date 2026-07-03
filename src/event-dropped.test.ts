import { describe, expect, test } from "bun:test";
import { notifyEventDropped } from "./event-dropped";
import { timestampFromUUIDv7 } from "./event-queue";

describe("notifyEventDropped", () => {
	test("sends event.dropped.v1 to the source daemon", () => {
		const recorded: { method: string; params: unknown }[] = [];
		const daemons = [
			{
				manifest: { name: "m1" },
				peer: {
					notify: (method: string, params: unknown) => {
						recorded.push({ method, params });
					},
				},
			},
		];

		const id = Bun.randomUUIDv7();
		const params = { type: "event.v1" as const, kind: "probe" };
		notifyEventDropped(daemons, { id, source: "m1", params });

		expect(recorded).toEqual([
			{
				method: "event",
				params: {
					type: "event.dropped.v1",
					source: "m1",
					timestamp: timestampFromUUIDv7(id),
					params,
				},
			},
		]);
	});

	test("logs when the source daemon is not in the list", () => {
		const orig = console.error;
		const lines: string[] = [];
		console.error = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			const id = Bun.randomUUIDv7();
			notifyEventDropped([], {
				id,
				source: "missing",
				params: { type: "event.v1" },
			});

			expect(lines.some((line) => line.includes("event lost"))).toBe(true);
			expect(lines.some((line) => line.includes("missing"))).toBe(true);
			expect(lines.some((line) => line.includes(id))).toBe(true);
		} finally {
			console.error = orig;
		}
	});

	test("logs when the source daemon's peer is closed instead of swallowing the notification", () => {
		const recorded: { method: string; params: unknown }[] = [];
		const daemons = [
			{
				manifest: { name: "m1" },
				// Simulates a daemon whose peer.close() already ran (e.g. mid-restart
				// after an unexpected exit): notify() would be a silent no-op here.
				state: "failed",
				peer: {
					notify: (method: string, params: unknown) => {
						recorded.push({ method, params });
					},
				},
			},
		];

		const orig = console.error;
		const lines: string[] = [];
		console.error = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			const id = Bun.randomUUIDv7();
			notifyEventDropped(daemons, {
				id,
				source: "m1",
				params: { type: "event.v1" },
			});

			expect(recorded).toEqual([]);
			expect(lines.some((line) => line.includes("event lost"))).toBe(true);
			expect(lines.some((line) => line.includes("m1"))).toBe(true);
		} finally {
			console.error = orig;
		}
	});
});
