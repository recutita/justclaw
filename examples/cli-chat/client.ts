#!/usr/bin/env bun
import { existsSync } from "node:fs";
import path from "node:path";

const home =
	process.env.JUSTCLAW_HOME ??
	(process.env.HOME ? path.join(process.env.HOME, "justclaw") : null);
if (!home) {
	throw new Error("JUSTCLAW_HOME is not set and HOME is not set");
}
const socketPath = path.join(home, "modules", "cli-chat", "cli-chat.sock");

if (!existsSync(socketPath)) {
	process.stderr.write("[error] cannot connect to cli-chat daemon\n");
	process.exit(1);
}

const isTTY = Boolean(process.stdin.isTTY);
function prompt(): void {
	if (isTTY) {
		process.stderr.write("> ");
	}
}

/**
 * Everything the daemon relays (LLM replies, shell commands and their output,
 * history) can carry bytes from files or pages the agent read. Written raw, a
 * terminal would run their escape sequences: rewrite what was displayed, set
 * the clipboard (OSC 52), or answer a query into stdin, which this client sends
 * to the agent as user input. Every control character except newline and tab
 * is shown as `\xNN` instead.
 */
function escapeControlChars(text: string): string {
	return text.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
		/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
		(c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);
}

const stdinUtf8Decoder = new TextDecoder();
/** Replaced in connect open() for a fresh decoder per connection. */
let serverToClientUtf8Decoder = new TextDecoder();
let waitingLocalCommandResponse = false;
let delayedPromptTimer: Timer | null = null;

function clearDelayedPromptTimer(): void {
	if (delayedPromptTimer) {
		clearTimeout(delayedPromptTimer);
		delayedPromptTimer = null;
	}
}

function schedulePromptAfterResponse(): void {
	if (!isTTY) {
		return;
	}
	clearDelayedPromptTimer();
	delayedPromptTimer = setTimeout(() => {
		waitingLocalCommandResponse = false;
		delayedPromptTimer = null;
		prompt();
	}, 50);
}

async function stdinLoop(socket: Bun.Socket<undefined>): Promise<void> {
	const reader = Bun.stdin.stream().getReader();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			buffer += stdinUtf8Decoder.decode();
			const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			if (tail.length > 0) {
				socket.write(`${tail}\n`);
			}
			process.exit(0);
		}
		buffer += stdinUtf8Decoder.decode(value, { stream: true });
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const rawLine = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			waitingLocalCommandResponse = line.startsWith("/");
			if (waitingLocalCommandResponse) {
				clearDelayedPromptTimer();
			}
			socket.write(`${line}\n`);
			newlineIndex = buffer.indexOf("\n");
		}
	}
}

try {
	Bun.connect({
		unix: socketPath,
		socket: {
			open(socket) {
				serverToClientUtf8Decoder = new TextDecoder();
				prompt();
				void stdinLoop(socket);
			},
			data(_socket, data) {
				const text = escapeControlChars(
					serverToClientUtf8Decoder.decode(data, { stream: true }),
				);
				if (text.length > 0) {
					process.stdout.write(text);
					if (waitingLocalCommandResponse) {
						schedulePromptAfterResponse();
					} else if (text.endsWith("\n")) {
						prompt();
					}
				}
			},
			close() {
				clearDelayedPromptTimer();
				process.stdout.write(
					escapeControlChars(serverToClientUtf8Decoder.decode()),
				);
				process.stderr.write("[disconnected]\n");
				process.exit(1);
			},
			error() {
				clearDelayedPromptTimer();
				process.stdout.write(
					escapeControlChars(serverToClientUtf8Decoder.decode()),
				);
				process.stderr.write("[disconnected]\n");
				process.exit(1);
			},
		},
	});
} catch {
	process.stderr.write("[error] cannot connect to cli-chat daemon\n");
	process.exit(1);
}
