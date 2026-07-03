import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { consumeLines } from "./jsonrpc";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[index]));
			index += 1;
		},
	});
}

describe("consumeLines", () => {
	const originalMaxLineBytes = process.env.JUSTCLAW_MAX_LINE_BYTES;
	let errors: unknown[][];
	let originalConsoleError: typeof console.error;

	beforeEach(() => {
		errors = [];
		originalConsoleError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
	});

	afterEach(() => {
		console.error = originalConsoleError;
		if (originalMaxLineBytes === undefined) {
			delete process.env.JUSTCLAW_MAX_LINE_BYTES;
		} else {
			process.env.JUSTCLAW_MAX_LINE_BYTES = originalMaxLineBytes;
		}
	});

	test("parses normal newline-delimited lines", async () => {
		const lines: string[] = [];
		await consumeLines(streamOf(['{"a":1}\n', '{"b":2}\n']), (line) => {
			lines.push(line);
		});
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("delivers a large-but-under-limit single line", async () => {
		process.env.JUSTCLAW_MAX_LINE_BYTES = "1000";
		const payload = `{"data":"${"a".repeat(900)}"}`;
		const lines: string[] = [];
		await consumeLines(streamOf([`${payload}\n`]), (line) => {
			lines.push(line);
		});
		expect(lines).toEqual([payload]);
		expect(errors).toEqual([]);
	});

	test("bounds a line that never sees a newline past the limit, logs, and resumes", async () => {
		process.env.JUSTCLAW_MAX_LINE_BYTES = "1000";
		// Feed the oversized, newline-less line in small chunks so a naive
		// per-chunk check (rather than a running total) would miss it.
		const overflowChunks = Array(50).fill("x".repeat(100));
		const chunks = [...overflowChunks, "\n", '{"ok":true}\n'];

		const lines: string[] = [];
		await consumeLines(streamOf(chunks), (line) => {
			lines.push(line);
		});

		expect(lines).toEqual(['{"ok":true}']);
		expect(errors.length).toBe(1);
		expect(String(errors[0]?.[0])).toContain("exceeds");
	});

	test("uses JUSTCLAW_MAX_LINE_BYTES override", async () => {
		process.env.JUSTCLAW_MAX_LINE_BYTES = "10";
		const lines: string[] = [];
		await consumeLines(
			streamOf(["this-line-is-longer-than-ten-bytes\n"]),
			(line) => {
				lines.push(line);
			},
		);
		expect(lines).toEqual([]);
		expect(errors.length).toBe(1);
	});
});
