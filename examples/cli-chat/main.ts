#!/usr/bin/env bun
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";

const justclawHome = process.env.JUSTCLAW_HOME;
if (!justclawHome) {
	console.error("cli-chat: JUSTCLAW_HOME is not set");
	process.exit(1);
}
// Matches the module layout under the runtime: $JUSTCLAW_HOME/modules/cli-chat/
const socketPath = path.join(
	justclawHome,
	"modules",
	"cli-chat",
	"cli-chat.sock",
);

let currentClient: Bun.Socket<undefined> | null = null;
const pendingMessages: string[] = [];
let socketLineBuffer = "";
/** Replaced in open() so each accepted socket gets a fresh stream decoder. */
let socketUtf8Decoder = new TextDecoder();
let nextRequestId = 10_000;
const pendingRpc = new Map<
	number,
	{
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
	}
>();

const stdinUtf8Decoder = new TextDecoder();

function appendSocketLines(chunk: string): void {
	socketLineBuffer += chunk;
	let newlineIndex = socketLineBuffer.indexOf("\n");
	while (newlineIndex >= 0) {
		const rawLine = socketLineBuffer.slice(0, newlineIndex);
		socketLineBuffer = socketLineBuffer.slice(newlineIndex + 1);
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length > 0) {
			if (line.startsWith("/")) {
				void handleSlashCommand(line);
			} else {
				emitEvent({ kind: "message.received", text: line });
			}
		}
		newlineIndex = socketLineBuffer.indexOf("\n");
	}
}

function writeLine(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitEvent(params: Record<string, unknown>): void {
	writeLine({
		jsonrpc: "2.0",
		method: "event",
		params: { type: "event.v1", ...params },
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function rpcRequest(
	method: string,
	params?: Record<string, unknown>,
): Promise<unknown> {
	const id = nextRequestId++;
	writeLine(
		params === undefined
			? { jsonrpc: "2.0", id, method }
			: { jsonrpc: "2.0", id, method, params },
	);
	return new Promise((resolve, reject) => {
		pendingRpc.set(id, { resolve, reject });
	});
}

function rpcErrorMessage(error: unknown): string {
	if (!isRecord(error) || typeof error.message !== "string") {
		return "unknown error";
	}
	return error.message;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function formatHistoryItem(item: unknown): string {
	if (!isRecord(item)) {
		return JSON.stringify(item);
	}

	const role = typeof item.role === "string" ? item.role : "unknown";
	if (typeof item.content === "string") {
		return `${role}: ${oneLine(item.content)}`;
	}

	if (Array.isArray(item.content)) {
		const parts: string[] = [];
		for (const chunk of item.content) {
			if (!isRecord(chunk)) {
				continue;
			}
			if (typeof chunk.text === "string") {
				parts.push(oneLine(chunk.text));
				continue;
			}
			if (typeof chunk.input_text === "string") {
				parts.push(oneLine(chunk.input_text));
			}
		}
		if (parts.length > 0) {
			return `${role}: ${parts.join(" / ")}`;
		}
	}

	if (typeof item.type === "string" && typeof item.name === "string") {
		return `${item.type}: ${item.name}`;
	}

	return JSON.stringify(item);
}

function formatToolCall(
	toolName: string,
	input: unknown,
	outputStr: string,
): string[] {
	const lines: string[] = [];

	if (
		toolName === "shell" &&
		isRecord(input) &&
		typeof input.command === "string"
	) {
		lines.push(`[shell] $ ${input.command}`);
		try {
			const result = JSON.parse(outputStr) as unknown;
			if (isRecord(result) && Array.isArray(result.output)) {
				for (const entry of result.output) {
					if (!isRecord(entry)) {
						continue;
					}
					if (typeof entry.stdout === "string" && entry.stdout.trim()) {
						lines.push(entry.stdout.trimEnd());
					}
					if (typeof entry.stderr === "string" && entry.stderr.trim()) {
						lines.push(`[stderr] ${entry.stderr.trimEnd()}`);
					}
					if (isRecord(entry.outcome)) {
						if (entry.outcome.type === "timeout") {
							lines.push("[shell] timed out");
						} else if (
							typeof entry.outcome.exitCode === "number" &&
							entry.outcome.exitCode !== 0
						) {
							lines.push(`[shell] exit ${entry.outcome.exitCode}`);
						}
					}
				}
			}
		} catch {
			/* malformed output — skip */
		}
		return lines;
	}

	if (toolName === "edit" && isRecord(input)) {
		const op = typeof input.type === "string" ? input.type : "?";
		const filePath = typeof input.path === "string" ? input.path : "?";
		try {
			const result = JSON.parse(outputStr) as unknown;
			const status =
				isRecord(result) && typeof result.status === "string"
					? result.status
					: "completed";
			const detail =
				isRecord(result) && typeof result.output === "string"
					? `: ${result.output}`
					: "";
			lines.push(`[edit] ${op} ${filePath} → ${status}${detail}`);
		} catch {
			lines.push(`[edit] ${op} ${filePath}`);
		}
		if (op === "create_file" && typeof input.content === "string") {
			for (const l of input.content.trimEnd().split("\n")) {
				lines.push(`  ${l}`);
			}
		} else if (op === "edit_file") {
			if (typeof input.old === "string") {
				lines.push(`  - old: ${input.old}`);
			}
			if (typeof input.new === "string") {
				lines.push(`  - new: ${input.new}`);
			}
		}
		return lines;
	}

	if (input !== undefined && input !== null) {
		lines.push(`[tool:${toolName}] ${JSON.stringify(input)}`);
		lines.push(`  → ${outputStr}`);
	} else {
		lines.push(`[tool:${toolName}] ${outputStr}`);
	}
	return lines;
}

async function resolveSessionId(selector?: string): Promise<string | null> {
	if (!selector) {
		const active = await rpcRequest("sessions", { type: "sessions.active.v1" });
		return isRecord(active) && typeof active.id === "string" ? active.id : null;
	}
	if (!/^\d+$/.test(selector)) {
		return selector;
	}
	const list = await rpcRequest("sessions", { type: "sessions.list.v1" });
	const listIds =
		isRecord(list) && Array.isArray(list.ids)
			? list.ids.filter((value): value is string => typeof value === "string")
			: [];
	const position = Number.parseInt(selector, 10);
	if (position < 1 || position > listIds.length) {
		return null;
	}
	return listIds[position - 1] ?? null;
}

async function handleSlashCommand(input: string): Promise<void> {
	const trimmed = input.trim();
	const [command, ...rest] = trimmed.split(/\s+/);

	if (command === "/sessions") {
		try {
			const list = await rpcRequest("sessions", { type: "sessions.list.v1" });
			const active = await rpcRequest("sessions", {
				type: "sessions.active.v1",
			});
			const listIds = isRecord(list) && Array.isArray(list.ids) ? list.ids : [];
			const activeId =
				isRecord(active) && typeof active.id === "string" ? active.id : null;
			if (listIds.length === 0) {
				deliverToClient("[session] no sessions");
				return;
			}
			let index = 1;
			for (const rawId of listIds) {
				if (typeof rawId !== "string") {
					continue;
				}
				const marker = rawId === activeId ? "*" : " ";
				deliverToClient(`[session] ${marker} [${index}] ${rawId}`);
				index += 1;
			}
		} catch (error) {
			deliverToClient(`[session] list failed: ${rpcErrorMessage(error)}`);
		}
		return;
	}

	if (command === "/session") {
		const selector = rest[0];
		if (!selector) {
			deliverToClient("[session] usage: /session <id|number>");
			return;
		}
		try {
			const id = await resolveSessionId(selector);
			if (!id) {
				deliverToClient(`[session] invalid number: ${selector}`);
				return;
			}
			await rpcRequest("sessions", { type: "sessions.switch.v1", id });
			deliverToClient(`[session] switch queued: ${id}`);
		} catch (error) {
			deliverToClient(`[session] switch failed: ${rpcErrorMessage(error)}`);
		}
		return;
	}

	if (command === "/new") {
		try {
			const created = await rpcRequest("sessions", { type: "sessions.new.v1" });
			const id =
				isRecord(created) && typeof created.id === "string" ? created.id : null;
			if (!id) {
				deliverToClient("[session] create failed: invalid response");
				return;
			}
			await rpcRequest("sessions", { type: "sessions.switch.v1", id });
			deliverToClient(`[session] created and switched: ${id}`);
		} catch (error) {
			deliverToClient(`[session] create failed: ${rpcErrorMessage(error)}`);
		}
		return;
	}

	if (command === "/log") {
		const selector = rest[0];
		try {
			const id = await resolveSessionId(selector);
			if (!id) {
				deliverToClient(
					selector
						? `[log] invalid number: ${selector}`
						: "[log] failed to resolve active session",
				);
				return;
			}
			const response = await rpcRequest("sessions", {
				type: "sessions.get.v1",
				id,
			});
			const history =
				isRecord(response) && Array.isArray(response.history)
					? response.history
					: null;
			if (!history) {
				deliverToClient("[log] failed: invalid response");
				return;
			}
			deliverToClient(`[log] session ${id} (${history.length} items)`);
			if (history.length === 0) {
				deliverToClient("[log] (empty)");
				return;
			}
			const start = Math.max(0, history.length - 20);
			if (start > 0) {
				deliverToClient(`[log] showing last ${history.length - start} items`);
			}
			for (let i = start; i < history.length; i += 1) {
				deliverToClient(`[log] ${i + 1}: ${formatHistoryItem(history[i])}`);
			}
		} catch (error) {
			deliverToClient(`[log] failed: ${rpcErrorMessage(error)}`);
		}
		return;
	}

	if (command === "/interrupt") {
		const text = rest.join(" ");
		if (!text) {
			deliverToClient("[interrupt] usage: /interrupt <text>");
			return;
		}
		try {
			await rpcRequest("sessions", { type: "sessions.interrupt.v1", text });
			deliverToClient("[interrupt] set");
		} catch (error) {
			deliverToClient(`[interrupt] failed: ${rpcErrorMessage(error)}`);
		}
		return;
	}

	if (command === "/skip") {
		try {
			const result = await rpcRequest("sessions", { type: "sessions.skip.v1" });
			deliverToClient(result === "no-op" ? "[skip] no-op" : "[skip] aborted");
		} catch (error) {
			deliverToClient(`[skip] failed: ${rpcErrorMessage(error)}`);
		}
		return;
	}

	if (command === "/kill") {
		try {
			await rpcRequest("sessions", { type: "sessions.kill.v1" });
			deliverToClient("[kill] queue cleared");
		} catch (error) {
			deliverToClient(`[kill] failed: ${rpcErrorMessage(error)}`);
		}
		return;
	}

	deliverToClient(
		"[session] unknown command. use /sessions, /session <id|number>, /new, /log [id|number], /interrupt <text>, /skip, or /kill",
	);
}

function deliverToClient(text: string): void {
	if (currentClient) {
		currentClient.write(`${text}\n`);
	} else {
		pendingMessages.push(text);
	}
}

function removeSocketFile(): void {
	try {
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
	} catch {
		// ignore
	}
}

process.on("exit", removeSocketFile);
process.on("SIGTERM", () => process.exit(0));

removeSocketFile();

Bun.listen({
	unix: socketPath,
	socket: {
		open(socket) {
			if (currentClient) {
				socket.end();
				return;
			}
			currentClient = socket;
			socketUtf8Decoder = new TextDecoder();
			socketLineBuffer = "";
			const queued = pendingMessages.splice(0);
			for (const t of queued) {
				socket.write(`${t}\n`);
			}
		},
		data(_socket, data) {
			appendSocketLines(socketUtf8Decoder.decode(data, { stream: true }));
		},
		close(socket) {
			if (currentClient === socket) {
				appendSocketLines(socketUtf8Decoder.decode());
				currentClient = null;
				socketLineBuffer = "";
			}
		},
	},
});

function handleStdinLine(line: string): void {
	let msg: unknown;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}

	if (!isRecord(msg) || msg.jsonrpc !== "2.0") {
		return;
	}

	if (typeof msg.id === "number" && !("method" in msg)) {
		const pending = pendingRpc.get(msg.id);
		if (!pending) {
			return;
		}
		pendingRpc.delete(msg.id);
		if (isRecord(msg.error)) {
			pending.reject(new Error(rpcErrorMessage(msg.error)));
			return;
		}
		pending.resolve(msg.result);
		return;
	}

	if (typeof msg.id === "number" && typeof msg.method === "string") {
		if (msg.method === "initialize") {
			writeLine({
				jsonrpc: "2.0",
				id: msg.id,
				result: { tools: [] },
			});
			return;
		}
		if (msg.method === "shutdown") {
			writeLine({ jsonrpc: "2.0", id: msg.id, result: "ok" });
			process.exit(0);
			return;
		}
		writeLine({
			jsonrpc: "2.0",
			id: msg.id,
			error: { code: -32601, message: "Method not found" },
		});
		return;
	}

	if (msg.method !== "event" || !isRecord(msg.params)) {
		return;
	}

	const params = msg.params;
	const pType = params.type;

	if (pType === "message.send.v1" && typeof params.text === "string") {
		deliverToClient(params.text);
		return;
	}

	if (pType === "tool_call.v1") {
		const toolName = typeof params.tool === "string" ? params.tool : "unknown";
		const outputStr = typeof params.output === "string" ? params.output : "";
		for (const line of formatToolCall(toolName, params.input, outputStr)) {
			deliverToClient(line);
		}
		return;
	}

	if (pType === "event.dropped.v1") {
		deliverToClient(`[error] event dropped: ${JSON.stringify(params.params)}`);
	}
}

async function readStdinLoop(): Promise<void> {
	const reader = Bun.stdin.stream().getReader();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += stdinUtf8Decoder.decode(value, { stream: true });
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const rawLine = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (line.length > 0) {
				handleStdinLine(line);
			}
			newlineIndex = buffer.indexOf("\n");
		}
	}

	buffer += stdinUtf8Decoder.decode();
	const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
	if (tail.length > 0) {
		handleStdinLine(tail);
	}
}

void readStdinLoop();
