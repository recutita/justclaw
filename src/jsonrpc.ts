export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
};

export type JsonRpcSuccessResponse = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
};

export type JsonRpcErrorResponse = {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
};

export type JsonRpcNotification = {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

type JsonRpcPeerOptions = {
	name: string;
	sendLine: (line: string) => void;
	onNotification?: (message: JsonRpcNotification) => void;
	onRequest?: (
		method: string,
		params: unknown,
		id: JsonRpcId,
	) => unknown | Promise<unknown>;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatRemoteError(error: JsonRpcErrorResponse["error"]): string {
	return `${error.code}: ${error.message}`;
}

export class JsonRpcPeer {
	#name: string;
	#sendLine: (line: string) => void;
	#onNotification?: (message: JsonRpcNotification) => void;
	#onRequest?: (
		method: string,
		params: unknown,
		id: JsonRpcId,
	) => unknown | Promise<unknown>;
	#nextId = 1;
	// JsonRpcId includes null for parsed wire messages; outbound requests never use null ids, so pending keys are string | number only.
	#pending = new Map<string | number, PendingRequest>();
	#closedError: Error | null = null;

	constructor(options: JsonRpcPeerOptions) {
		this.#name = options.name;
		this.#sendLine = options.sendLine;
		this.#onNotification = options.onNotification;
		this.#onRequest = options.onRequest;
	}

	request(method: string, params?: unknown): Promise<unknown> {
		if (this.#closedError) {
			return Promise.reject(this.#closedError);
		}

		const id = this.#nextId++;
		const request: JsonRpcRequest = { jsonrpc: "2.0", id, method };

		if (params !== undefined) {
			request.params = params;
		}

		const promise = new Promise<unknown>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
		});

		try {
			this.#sendLine(JSON.stringify(request));
		} catch (error) {
			this.#pending.delete(id);
			const sendError =
				error instanceof Error
					? error
					: new Error(`${this.#name}: failed to send request`);
			return Promise.reject(sendError);
		}

		return promise;
	}

	notify(method: string, params?: unknown): void {
		if (this.#closedError) {
			return;
		}

		const notification: JsonRpcNotification = { jsonrpc: "2.0", method };
		if (params !== undefined) {
			notification.params = params;
		}

		try {
			this.#sendLine(JSON.stringify(notification));
		} catch {
			// Same as best-effort outbound path: avoid throwing from notify.
		}
	}

	handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			throw new Error(`${this.#name}: received invalid JSON-RPC line`);
		}

		if (!isObject(message) || message.jsonrpc !== "2.0") {
			throw new Error(`${this.#name}: received invalid JSON-RPC message`);
		}

		if ("method" in message) {
			this.#handleInboundMessage(message);
			return;
		}

		this.#handleResponse(message);
	}

	close(error: Error): void {
		if (this.#closedError) {
			return;
		}

		this.#closedError = error;
		for (const [id, pending] of this.#pending) {
			pending.reject(error);
			this.#pending.delete(id);
		}
	}

	#handleInboundMessage(message: Record<string, unknown>): void {
		if (typeof message.method !== "string") {
			throw new Error(`${this.#name}: notification method must be a string`);
		}

		if ("id" in message) {
			if (
				typeof message.id !== "string" &&
				typeof message.id !== "number" &&
				message.id !== null
			) {
				throw new Error(
					`${this.#name}: request id must be a string, number, or null`,
				);
			}
			if (!this.#onRequest) {
				if (!this.#closedError) {
					this.#sendLine(
						JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32601, message: "Method not found" },
						}),
					);
				}
				return;
			}
			void this.#handleInboundRequest(
				message.id,
				message.method,
				message.params,
			);
			return;
		}

		this.#onNotification?.({
			jsonrpc: "2.0",
			method: message.method,
			params: message.params,
		});
	}

	async #handleInboundRequest(
		id: JsonRpcId,
		method: string,
		params: unknown,
	): Promise<void> {
		try {
			const result = await this.#onRequest?.(method, params, id);
			if (!this.#closedError) {
				this.#sendLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
			}
		} catch (error) {
			if (!this.#closedError) {
				const msg = error instanceof Error ? error.message : String(error);
				this.#sendLine(
					JSON.stringify({
						jsonrpc: "2.0",
						id,
						error: { code: -32000, message: msg },
					}),
				);
			}
		}
	}

	#handleResponse(message: Record<string, unknown>): void {
		if (
			typeof message.id !== "string" &&
			typeof message.id !== "number" &&
			message.id !== null
		) {
			throw new Error(
				`${this.#name}: response id must be a string, number, or null`,
			);
		}

		if (message.id === null) {
			// JSON-RPC 2.0: responses use id null when the request id could not be
			// recovered (e.g. parse error on the peer). Never throw from handleLine:
			// a buggy module must not tear down the core transport.
			if ("error" in message) {
				const remoteError = message.error;
				if (
					isObject(remoteError) &&
					typeof remoteError.code === "number" &&
					typeof remoteError.message === "string"
				) {
					console.error(
						`[${this.#name}] ignoring JSON-RPC response with null id: ${formatRemoteError(remoteError as JsonRpcErrorResponse["error"])}`,
					);
				} else {
					console.error(
						`[${this.#name}] ignoring JSON-RPC response with null id (malformed error object)`,
					);
				}
			} else {
				console.error(
					`[${this.#name}] ignoring JSON-RPC response with null id`,
				);
			}
			return;
		}

		const pending = this.#pending.get(message.id);
		if (!pending) {
			// An uncorrelated response (e.g. a stale reply after the request
			// already timed out) must not tear down the transport: never throw
			// from handleLine for a malformed-but-not-fatal peer message.
			console.error(
				`[${this.#name}] ignoring JSON-RPC response for unknown request id ${message.id}`,
			);
			return;
		}

		this.#pending.delete(message.id);

		if ("error" in message) {
			const remoteError = message.error;
			if (
				!isObject(remoteError) ||
				typeof remoteError.code !== "number" ||
				typeof remoteError.message !== "string"
			) {
				pending.reject(
					new Error(
						`${this.#name}: received malformed JSON-RPC error response`,
					),
				);
				return;
			}

			pending.reject(
				new Error(
					`${this.#name}: ${formatRemoteError({
						code: remoteError.code,
						message: remoteError.message,
						data: remoteError.data,
					})}`,
				),
			);
			return;
		}

		if (!("result" in message)) {
			pending.reject(new Error(`${this.#name}: response missing result`));
			return;
		}

		pending.resolve(message.result);
	}
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

// A generous cap, not a protocol limit: legitimate image.send.v1/file.send.v1
// events are single NDJSON lines carrying multi-MB base64 payloads. Without a
// cap, a module that never emits a newline (buggy or malicious) would grow
// `buffer` without bound and OOM the core.
function resolveMaxLineBytes(): number {
	const raw = process.env.JUSTCLAW_MAX_LINE_BYTES;
	if (raw === undefined || raw === "") {
		return DEFAULT_MAX_LINE_BYTES;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		console.error(
			`JUSTCLAW_MAX_LINE_BYTES must be a positive integer, got ${JSON.stringify(raw)}; using default ${DEFAULT_MAX_LINE_BYTES}`,
		);
		return DEFAULT_MAX_LINE_BYTES;
	}
	return parsed;
}

export async function consumeLines(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const maxLineBytes = resolveMaxLineBytes();
	let buffer = "";
	// True while the current (undelimited) line has already exceeded the
	// limit and is being dropped up to the next newline.
	let discardingLine = false;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });

		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const rawLine = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (discardingLine) {
				// The rest of an already-oversized line; drop it too.
				discardingLine = false;
			} else if (Buffer.byteLength(rawLine) > maxLineBytes) {
				// The line arrived complete (newline included) in one chunk,
				// so it was never caught by the growing-buffer check below.
				console.error(
					`jsonrpc: line exceeds ${maxLineBytes} bytes; discarding and resuming at next newline`,
				);
			} else {
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				if (line.length > 0) {
					onLine(line);
				}
			}
			newlineIndex = buffer.indexOf("\n");
		}

		if (discardingLine) {
			// No newline yet for the line being discarded; drop what we have
			// so the buffer doesn't keep growing while we wait for one.
			buffer = "";
		} else if (Buffer.byteLength(buffer) > maxLineBytes) {
			console.error(
				`jsonrpc: line exceeds ${maxLineBytes} bytes; discarding and resuming at next newline`,
			);
			buffer = "";
			discardingLine = true;
		}
	}

	if (!discardingLine) {
		buffer += decoder.decode();
		const finalLine = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
		if (finalLine.length > 0) {
			onLine(finalLine);
		}
	}
}
