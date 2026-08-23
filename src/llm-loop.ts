import { Buffer } from "node:buffer";
import path from "node:path";
import {
	Agent,
	type AgentInputItem,
	type FunctionToolResult,
	Runner,
	setDefaultOpenAIClient,
	setOpenAIAPI,
	setTracingDisabled,
	type Tool,
	tool,
} from "@openai/agents";
import OpenAI from "openai";
import {
	loadAgentContext,
	loadHomeAgentsFile,
	loadSkillsIndex,
	readInitContent,
} from "./agent-context";
import { notifyDropped, notifyEventDropped } from "./event-dropped";
import {
	ACTIVE_SESSION_META_KEY,
	type EventQueue,
	formatLocalTimestamp,
	LAST_REPLYABLE_TARGET_META_KEY,
	type QueuedEvent,
	timestampFromUUIDv7,
} from "./event-queue";
import {
	type BootstrapRuntimeOptions,
	reloadModules,
	type StartedDaemon,
	type TimerScheduler,
} from "./runtime";
import type { SessionStore } from "./session-store";
import { buildSystemPrompt } from "./system-prompt";
import { runReadFileBase64 } from "./workspace";

setTracingDisabled(true);

type OpenAIAPIMode = "chat_completions" | "responses";
type MediaEventParams = {
	type: "image.send.v1" | "file.send.v1";
	data: string;
	mediaType: string;
	filename?: string;
	link?: string;
	size?: number;
	sha256?: string;
};
export type InputModality = "image" | "file" | "audio";

const ALL_INPUT_MODALITIES: InputModality[] = ["image", "file", "audio"];

type ToolResultDelivery = {
	apiMode: OpenAIAPIMode;
	inputModalities: ReadonlySet<InputModality>;
	enqueueMedia: (params: MediaEventParams) => void;
};

// Which multimodal input parts the configured endpoint accepts. OpenAI-compatible
// providers implement these unevenly and independently of the API mode — vLLM,
// for example, takes input_image and input_audio but rejects input_file on both
// /v1/chat/completions and /v1/responses. An unsupported part comes back as a
// hard 400 that drops the whole event, so the modality set has to be operator
// configuration: the core cannot probe capability, and the API-mode switch does
// not describe it.
export function resolveInputModalities(): ReadonlySet<InputModality> {
	const raw = process.env.JUSTCLAW_OPENAI_INPUT_MODALITIES;
	if (raw === undefined || raw.trim() === "") {
		return new Set(ALL_INPUT_MODALITIES);
	}
	// Explicit sentinel for a text-only provider. Without it that case is
	// inexpressible, because an empty value reads as "unset" above.
	if (raw.trim() === "none") {
		return new Set<InputModality>();
	}
	const modalities = new Set<InputModality>();
	for (const entry of raw.split(",")) {
		const name = entry.trim();
		if (
			name !== "image" &&
			name !== "file" &&
			name !== "audio" &&
			name !== ""
		) {
			throw new Error(
				`JUSTCLAW_OPENAI_INPUT_MODALITIES must be "none" or a comma-separated list of image, file, audio, got ${JSON.stringify(raw)}`,
			);
		}
		if (name !== "") modalities.add(name);
	}
	if (modalities.size === 0) {
		throw new Error(
			`JUSTCLAW_OPENAI_INPUT_MODALITIES names no modality; use "none" to disable all, got ${JSON.stringify(raw)}`,
		);
	}
	return modalities;
}

function resolveOpenAIAPIMode(): OpenAIAPIMode {
	const api = process.env.JUSTCLAW_OPENAI_API ?? "chat_completions";
	if (api === "chat_completions" || api === "responses") {
		return api;
	}
	throw new Error(
		'JUSTCLAW_OPENAI_API must be "chat_completions" or "responses"',
	);
}

export function resolveModelConfig(): string {
	const apiKey = process.env.JUSTCLAW_OPENAI_API_KEY;
	const model = process.env.JUSTCLAW_OPENAI_MODEL;
	const baseURL = process.env.JUSTCLAW_OPENAI_BASE_URL;
	const api = resolveOpenAIAPIMode();
	if (!apiKey) {
		throw new Error("JUSTCLAW_OPENAI_API_KEY is required");
	}
	if (!model) {
		throw new Error("JUSTCLAW_OPENAI_MODEL is required");
	}

	setDefaultOpenAIClient(
		new OpenAI({
			apiKey,
			...(baseURL !== undefined && baseURL !== "" ? { baseURL } : {}),
		}),
	);
	setOpenAIAPI(api);
	return model;
}

// Maximum agent turns (LLM call -> tool calls -> repeat) per event before the
// runner gives up. Defaults to 10, matching the @openai/agents default.
export function resolveMaxTurns(): number {
	const raw = process.env.JUSTCLAW_MAX_TURNS;
	if (raw === undefined || raw === "") {
		return 10;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(
			`JUSTCLAW_MAX_TURNS must be a positive integer, got ${JSON.stringify(raw)}`,
		);
	}
	return parsed;
}

// Timeouts are configured in whole seconds; both resolvers return milliseconds
// because that is what setTimeout and the SDK take. `0` disables the bound.
function resolveTimeoutMs(name: string, defaultSeconds: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") {
		return defaultSeconds * 1000;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(
			`${name} must be a non-negative integer number of seconds, got ${JSON.stringify(raw)}`,
		);
	}
	return parsed * 1000;
}

/**
 * Bound on a single model call. The LLM queue is serial, so a request the
 * provider never answers blocks every other event, not just this one. On expiry
 * the SDK throws ModelTimeoutError, which lands in the per-event catch below and
 * drops the event like any other LLM failure — the source module is notified and
 * decides whether to re-emit.
 */
export function resolveModelTimeoutMs(): number {
	return resolveTimeoutMs("JUSTCLAW_MODEL_TIMEOUT", 600);
}

/**
 * Bound on a single module tool call. Unlike a model timeout this does not fail
 * the event: the timeout is returned to the model as the tool result so the rest
 * of the turn survives one unresponsive module.
 */
export function resolveToolTimeoutMs(): number {
	return resolveTimeoutMs("JUSTCLAW_TOOL_TIMEOUT", 60);
}

// Whether to strip reasoning items carried over from previous events before
// sending the history to the model. Defaults to keeping them: the Responses
// API path carries only an item id (no summary or encrypted content is
// requested), which costs almost nothing and lets the provider continue the
// prior reasoning. The Chat Completions path is where this earns its keep — a
// provider that returns `message.reasoning` (OpenRouter-style) has that raw
// text replayed in full on every subsequent event, for no benefit across
// events.
export function resolveDropReasoningHistory(): boolean {
	const raw = process.env.JUSTCLAW_DROP_REASONING_HISTORY;
	if (raw === undefined || raw === "") {
		return false;
	}
	if (raw === "0") {
		return false;
	}
	if (raw === "1") {
		return true;
	}
	throw new Error(
		`JUSTCLAW_DROP_REASONING_HISTORY must be "0" or "1", got ${JSON.stringify(raw)}`,
	);
}

/**
 * Drops reasoning items from a stored history before it becomes model input.
 *
 * Only applied to history carried over from previous events. Reasoning
 * generated inside the current run lives in the SDK's own generated-items list
 * and never passes through here, so a tool-calling chain keeps the reasoning
 * continuity that both the Responses API and Anthropic-style thinking require
 * within a turn.
 *
 * Dropping the reasoning item itself (rather than anything that follows it) is
 * the safe direction for the Responses API: it never leaves a reasoning item
 * without its required following item, and function calls are matched by
 * `callId`, not by reasoning id.
 */
export function dropReasoningItems(
	history: AgentInputItem[],
): AgentInputItem[] {
	return history.filter((item) => item.type !== "reasoning");
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function assertValidXmlKey(key: string): void {
	if (!/^[a-zA-Z_][\w.-]*$/.test(key)) {
		throw new Error(`Invalid XML element name: ${JSON.stringify(key)}`);
	}
}

function valueToXml(tag: string, value: unknown, indent: string): string {
	assertValidXmlKey(tag);
	if (value === null || value === undefined) {
		return "";
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => valueToXml(tag, item, indent))
			.filter(Boolean)
			.join("\n");
	}
	if (typeof value === "object") {
		const inner = objectToXml(value as Record<string, unknown>, `${indent}  `);
		return inner
			? `${indent}<${tag}>\n${inner}\n${indent}</${tag}>`
			: `${indent}<${tag}></${tag}>`;
	}
	return `${indent}<${tag}>${escapeXml(String(value))}</${tag}>`;
}

function objectToXml(obj: Record<string, unknown>, indent = "  "): string {
	return Object.entries(obj)
		.map(([k, v]) => valueToXml(k, v, indent))
		.filter(Boolean)
		.join("\n");
}

export function eventToXml(event: QueuedEvent): string {
	const timestamp = timestampFromUUIDv7(event.id);
	const { type, ...rest } = event.params;
	// For multimodal envelopes the base64 `data` rides a separate content part
	// (see the userInput builder below). Keep it out of the XML so the bytes are
	// not sent twice; the text copy blows past the context window. The small
	// descriptive fields (mediaType, filename, format) stay.
	if (
		type === "image.send.v1" ||
		type === "file.send.v1" ||
		type === "audio.send.v1"
	) {
		delete (rest as Record<string, unknown>).data;
	}
	const inner = objectToXml(rest);
	const attrs = `source="${escapeXml(event.source)}" timestamp="${escapeXml(timestamp)}"`;
	return inner
		? `<event ${attrs}>\n${inner}\n</event>`
		: `<event ${attrs}></event>`;
}

function inferImageMediaType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return "image/jpeg";
	}
}

function inferFileMediaType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".pdf":
			return "application/pdf";
		case ".txt":
			return "text/plain";
		case ".csv":
			return "text/csv";
		default:
			return "application/octet-stream";
	}
}

function inferAudioFormat(params: Record<string, unknown>): "wav" | "mp3" {
	if (params.format === "wav" || params.format === "mp3") {
		return params.format;
	}
	const mediaType =
		typeof params.mediaType === "string" ? params.mediaType.toLowerCase() : "";
	if (mediaType === "audio/mpeg" || mediaType === "audio/mp3") {
		return "mp3";
	}
	return "wav";
}

const IMAGE_MAX_DIMENSION = 2048;

export async function downscaleImage(
	bytes: Uint8Array,
	mediaType: string,
): Promise<{ data: Uint8Array; mediaType: string }> {
	try {
		// Full-resolution phone photos (~6 MB) are the same image regardless of how
		// they are stored, but the base64 copy rides the conversation history and is
		// resent on every LLM turn. Left at native size they accumulate until a request
		// exceeds the provider's max body size (Anthropic returned 413 once the history
		// held ~32 MB of images). Both Anthropic and OpenAI internally downscale images
		// before tokenizing (Anthropic to a 1568px long edge, OpenAI to a 2048px box),
		// so capping the long edge at 2048px costs zero image tokens while cutting the
		// payload from megabytes to a few hundred KB. Resize on ingestion so only the
		// small copy is ever stored and replayed.
		const image = new Bun.Image(bytes);
		const metadata = await image.metadata();
		if (
			metadata.width <= IMAGE_MAX_DIMENSION &&
			metadata.height <= IMAGE_MAX_DIMENSION
		) {
			return { data: bytes, mediaType };
		}
		const resized = await image
			.resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
				fit: "inside",
				withoutEnlargement: true,
			})
			.jpeg({ quality: 85 })
			.bytes();
		if (resized.byteLength === 0) {
			return { data: bytes, mediaType };
		}
		// Re-encode normalizes to JPEG; mediaType must follow or the declared type
		// and the base64 bytes disagree.
		return { data: resized, mediaType: "image/jpeg" };
	} catch (error) {
		// Undecodable/unsupported image: fall back to the original. Sending it risks
		// the 413 again, but dropping the image silently is worse for a chat bridge.
		console.error(
			`[core] image downscale failed (${mediaType}), sending original: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { data: bytes, mediaType };
	}
}

async function prepareImageEventForInput(
	event: QueuedEvent,
): Promise<QueuedEvent> {
	if (
		event.params.type !== "image.send.v1" ||
		typeof event.params.data !== "string"
	) {
		return event;
	}
	const mediaType =
		typeof event.params.mediaType === "string"
			? event.params.mediaType
			: "image/jpeg";
	const original = Buffer.from(event.params.data, "base64");
	const image = await downscaleImage(original, mediaType);
	if (
		image.data.byteLength === original.byteLength &&
		image.mediaType === mediaType
	) {
		return event;
	}
	return {
		...event,
		params: {
			...event.params,
			data: Buffer.from(image.data).toString("base64"),
			mediaType: image.mediaType,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function isAttachableLink(link: unknown): Promise<boolean> {
	if (typeof link !== "string" || link.length === 0) {
		return false;
	}
	try {
		const proc = Bun.spawn(["test", "-f", link, "-a", "-r", link], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

async function buildMediaMetadata(
	type: "image" | "file",
	bytes: Uint8Array,
	mediaType: string,
	link: unknown,
	filename?: unknown,
): Promise<Record<string, unknown>> {
	return {
		type,
		...(typeof filename === "string" && filename.length > 0
			? { filename }
			: {}),
		mediaType,
		size: bytes.byteLength,
		sha256: sha256Hex(bytes),
		...(typeof link === "string" && link.length > 0 ? { link } : {}),
		attachable: await isAttachableLink(link),
	};
}

function attachProviderMetadata(
	providerData: unknown,
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	const base = isRecord(providerData) ? { ...providerData } : {};
	const justclaw = isRecord(base.justclaw) ? { ...base.justclaw } : {};
	return {
		...base,
		justclaw: {
			...justclaw,
			metadata,
		},
	};
}

function decodeInlineBytes(
	value: unknown,
	fallbackMediaType: string,
): { bytes: Uint8Array; mediaType: string } | null {
	if (value instanceof Uint8Array) {
		return { bytes: value, mediaType: fallbackMediaType };
	}
	if (typeof value !== "string" || value.length === 0) {
		return null;
	}
	const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(value);
	if (match) {
		return {
			bytes: Buffer.from(match[2] ?? "", "base64"),
			mediaType: match[1] ?? fallbackMediaType,
		};
	}
	return { bytes: Buffer.from(value, "base64"), mediaType: fallbackMediaType };
}

async function prepareImageToolResult(
	result: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
	const image = isRecord(result.image) ? result.image : result;
	const decoded = decodeInlineBytes(
		image.data ?? result.data,
		typeof image.mediaType === "string"
			? image.mediaType
			: typeof result.mediaType === "string"
				? result.mediaType
				: "image/jpeg",
	);
	if (!decoded) {
		return null;
	}
	const downscaled = await downscaleImage(decoded.bytes, decoded.mediaType);
	const link = image.link ?? result.link;
	const metadata = await buildMediaMetadata(
		"image",
		downscaled.data,
		downscaled.mediaType,
		link,
	);
	return {
		type: "image",
		image: {
			data: Buffer.from(downscaled.data).toString("base64"),
			mediaType: downscaled.mediaType,
			size: metadata.size,
			sha256: metadata.sha256,
			...(typeof link === "string" && link.length > 0 ? { link } : {}),
		},
		...(typeof result.detail === "string" ? { detail: result.detail } : {}),
		providerData: attachProviderMetadata(result.providerData, metadata),
	};
}

async function prepareFileToolResult(
	result: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
	const file = isRecord(result.file) ? result.file : result;
	const decoded = decodeInlineBytes(
		file.data ?? (typeof result.file === "string" ? result.file : result.data),
		typeof file.mediaType === "string"
			? file.mediaType
			: typeof result.mediaType === "string"
				? result.mediaType
				: "application/octet-stream",
	);
	if (!decoded) {
		return null;
	}
	const filename =
		file.filename ??
		result.filename ??
		(typeof result.name === "string" ? result.name : undefined);
	const link = file.link ?? result.link;
	const metadata = await buildMediaMetadata(
		"file",
		decoded.bytes,
		decoded.mediaType,
		link,
		filename,
	);
	return {
		type: "file",
		file: {
			data: Buffer.from(decoded.bytes).toString("base64"),
			mediaType: decoded.mediaType,
			filename:
				typeof filename === "string" && filename.length > 0
					? filename
					: "attachment",
			size: metadata.size,
			sha256: metadata.sha256,
			...(typeof link === "string" && link.length > 0 ? { link } : {}),
		},
		providerData: attachProviderMetadata(result.providerData, metadata),
	};
}

function mediaEventFromToolResult(
	result: Record<string, unknown>,
): MediaEventParams | null {
	if (result.type === "image" && isRecord(result.image)) {
		const image = result.image;
		if (typeof image.data !== "string") return null;
		return {
			type: "image.send.v1",
			data: image.data,
			mediaType:
				typeof image.mediaType === "string" ? image.mediaType : "image/jpeg",
			...(typeof image.link === "string" ? { link: image.link } : {}),
			...(typeof image.size === "number" ? { size: image.size } : {}),
			...(typeof image.sha256 === "string" ? { sha256: image.sha256 } : {}),
		};
	}
	if (result.type === "file" && isRecord(result.file)) {
		const file = result.file;
		if (typeof file.data !== "string") return null;
		return {
			type: "file.send.v1",
			data: file.data,
			mediaType:
				typeof file.mediaType === "string"
					? file.mediaType
					: "application/octet-stream",
			...(typeof file.filename === "string" ? { filename: file.filename } : {}),
			...(typeof file.link === "string" ? { link: file.link } : {}),
			...(typeof file.size === "number" ? { size: file.size } : {}),
			...(typeof file.sha256 === "string" ? { sha256: file.sha256 } : {}),
		};
	}
	return null;
}

function mediaToolMetadata(
	result: Record<string, unknown>,
): Record<string, unknown> {
	const media =
		result.type === "image" && isRecord(result.image)
			? result.image
			: result.type === "file" && isRecord(result.file)
				? result.file
				: {};
	const { data: _data, ...metadata } = media;
	return metadata;
}

function delayedMediaToolOutput(result: Record<string, unknown>): string {
	return JSON.stringify({
		type: result.type,
		delayed: true,
		message:
			"Media was queued as a multimodal event and will be available in the next LLM cycle.",
		[result.type === "file" ? "file" : "image"]: mediaToolMetadata(result),
	});
}

function unsupportedMediaToolOutput(result: Record<string, unknown>): string {
	return JSON.stringify({
		type: result.type,
		unsupported: true,
		message:
			"The configured model endpoint does not accept this input modality, so the bytes were not sent. Only the metadata below is available.",
		[result.type === "file" ? "file" : "image"]: mediaToolMetadata(result),
	});
}

function maybeDelayMediaToolResult(
	result: Record<string, unknown>,
	delivery?: ToolResultDelivery,
): unknown {
	if (!delivery) {
		return result;
	}
	const event = mediaEventFromToolResult(result);
	if (!event) {
		return result;
	}
	const modality = event.type === "image.send.v1" ? "image" : "file";
	if (!delivery.inputModalities.has(modality)) {
		// Not enqueued as a media event either: the next cycle would build the
		// same rejected content part and drop that event too.
		return unsupportedMediaToolOutput(result);
	}
	if (delivery.apiMode !== "chat_completions") {
		return result;
	}
	delivery.enqueueMedia(event);
	return delayedMediaToolOutput(result);
}

async function prepareToolResultForLlm(
	result: unknown,
	delivery?: ToolResultDelivery,
): Promise<unknown> {
	if (!isRecord(result)) {
		return JSON.stringify(result);
	}
	const type = result.type;
	if (type === undefined || type === "json") {
		return JSON.stringify(
			type === "json" && "data" in result ? result.data : result,
		);
	}
	if (type === "image") {
		const prepared = await prepareImageToolResult(result);
		return prepared
			? maybeDelayMediaToolResult(prepared, delivery)
			: JSON.stringify(result);
	}
	if (type === "file") {
		const prepared = await prepareFileToolResult(result);
		return prepared
			? maybeDelayMediaToolResult(prepared, delivery)
			: JSON.stringify(result);
	}
	return JSON.stringify(result);
}

function metadataFromProviderData(
	providerData: unknown,
): Record<string, unknown> | null {
	if (!isRecord(providerData) || !isRecord(providerData.justclaw)) {
		return null;
	}
	const metadata = providerData.justclaw.metadata;
	return isRecord(metadata) ? { ...metadata } : null;
}

function fileMetadataFromDataUrl(
	value: unknown,
	filename?: unknown,
): Record<string, unknown> | null {
	const decoded = decodeInlineBytes(value, "application/octet-stream");
	if (!decoded) {
		return null;
	}
	return {
		type: "file",
		...(typeof filename === "string" && filename.length > 0
			? { filename }
			: {}),
		mediaType: decoded.mediaType,
		size: decoded.bytes.byteLength,
		sha256: sha256Hex(decoded.bytes),
		attachable: false,
	};
}

function audioMetadataFromInline(
	value: unknown,
	format?: unknown,
): Record<string, unknown> | null {
	const mediaType =
		format === "mp3"
			? "audio/mpeg"
			: format === "wav"
				? "audio/wav"
				: "application/octet-stream";
	const decoded = decodeInlineBytes(value, mediaType);
	if (!decoded) {
		return null;
	}
	return {
		type: "audio",
		format,
		mediaType: decoded.mediaType,
		size: decoded.bytes.byteLength,
		sha256: sha256Hex(decoded.bytes),
		attachable: false,
	};
}

function fileMetadataText(
	metadata: Record<string, unknown>,
): Record<string, string> {
	return {
		type: "input_text",
		text: JSON.stringify({
			type: "file",
			file: {
				...metadata,
				omitted: "data",
			},
		}),
	};
}

function audioMetadataText(
	metadata: Record<string, unknown>,
): Record<string, string> {
	return {
		type: "input_text",
		text: JSON.stringify({
			type: "audio",
			audio: {
				...metadata,
				omitted: "data",
			},
		}),
	};
}

function sanitizeHistoryContent(part: unknown): unknown {
	if (!isRecord(part)) {
		return part;
	}
	if (part.type === "audio") {
		const metadata =
			metadataFromProviderData(part.providerData) ??
			audioMetadataFromInline(part.audio, part.format);
		return metadata ? audioMetadataText(metadata) : part;
	}
	if (part.type === "input_file") {
		const metadata =
			metadataFromProviderData(part.providerData) ??
			fileMetadataFromDataUrl(part.file, part.filename);
		return metadata ? fileMetadataText(metadata) : part;
	}
	if (part.type === "file") {
		const file = isRecord(part.file) ? part.file : part;
		const metadata =
			metadataFromProviderData(part.providerData) ??
			fileMetadataFromDataUrl(
				file.data ?? part.file,
				file.filename ?? part.filename,
			);
		return metadata
			? { type: "text", text: fileMetadataText(metadata).text }
			: part;
	}
	return part;
}

export function sanitizeHistoryForStorage(
	history: AgentInputItem[],
): AgentInputItem[] {
	return history.map((item) => {
		if (!isRecord(item)) {
			return item;
		}
		if ("content" in item && Array.isArray(item.content)) {
			return {
				...item,
				content: item.content.map(sanitizeHistoryContent),
			} as AgentInputItem;
		}
		if (item.type === "function_call_result") {
			const output = item.output;
			if (Array.isArray(output)) {
				return {
					...item,
					output: output.map(sanitizeHistoryContent),
				} as AgentInputItem;
			}
			return {
				...item,
				output: sanitizeHistoryContent(output),
			} as AgentInputItem;
		}
		return item;
	});
}

function summarizeToolOutputForNotification(output: unknown): string {
	if (
		typeof output === "object" &&
		output !== null &&
		(output as { type?: unknown }).type === "image"
	) {
		const image = (output as { image?: unknown }).image;
		if (typeof image === "object" && image !== null) {
			const record = image as Record<string, unknown>;
			return JSON.stringify({
				type: "image",
				image: {
					mediaType: record.mediaType,
					size: record.size,
					sha256: record.sha256,
					link: record.link,
				},
			});
		}
	}
	if (
		typeof output === "object" &&
		output !== null &&
		(output as { type?: unknown }).type === "file"
	) {
		const file = (output as { file?: unknown }).file;
		if (typeof file === "object" && file !== null) {
			const record = file as Record<string, unknown>;
			return JSON.stringify({
				type: "file",
				file: {
					filename: record.filename,
					mediaType: record.mediaType,
					size: record.size,
					sha256: record.sha256,
					link: record.link,
				},
			});
		}
	}
	return typeof output === "string" ? output : JSON.stringify(output);
}

function wrapWithNotification(
	t: Tool,
	getTarget: () => string,
	daemonsRef: { current: StartedDaemon[] },
): Tool {
	if (t.type !== "function") {
		return t;
	}
	const originalInvoke = t.invoke.bind(t);
	return {
		...t,
		invoke: async (runContext, input, details) => {
			const output = await originalInvoke(runContext, input, details);
			let inputForNotify: unknown = input;
			try {
				inputForNotify = JSON.parse(input) as unknown;
			} catch {
				// keep raw string when invoke receives non-JSON input
			}
			const outputStr = summarizeToolOutputForNotification(output);
			const daemon = daemonsRef.current.find(
				(d) => d.manifest.name === getTarget(),
			);
			daemon?.peer.notify("event", {
				type: "tool_call.v1",
				tool: t.name,
				input: inputForNotify,
				output: outputStr,
			});
			return output;
		},
	};
}

// Raised when a module does not answer a tool call within JUSTCLAW_TOOL_TIMEOUT.
// Distinct from an abort so the caller can tell "this module is unresponsive"
// (reportable to the model, turn continues) from "the run was cancelled" (must
// unwind).
class ModuleToolTimeoutError extends Error {}

// Resolve/reject with the module tool request, but settle early if the run's
// abort signal fires or the module misses its deadline. A hung-but-alive module
// has no timeout of its own, so without this a stuck request would stall the
// single serial queue: before the deadline existed, sessions.skip.v1 was the only
// way out. Rejecting on abort unwinds runner.run so the normal
// abort -> event.dropped.v1 path runs.
//
// The pending JSON-RPC request is deliberately left registered on timeout. A late
// response then resolves a promise nobody awaits, which is harmless; dropping the
// entry instead would make that response uncorrelatable and raise a local error.
function requestWithAbort(
	request: Promise<unknown>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<unknown> {
	if (!signal && timeoutMs === 0) {
		return request;
	}
	return new Promise<unknown>((resolve, reject) => {
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timeoutHandle !== undefined) {
				clearTimeout(timeoutHandle);
			}
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("run aborted before module tool responded"));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort);
		if (timeoutMs > 0) {
			timeoutHandle = setTimeout(() => {
				cleanup();
				reject(
					new ModuleToolTimeoutError(
						`module did not respond within ${timeoutMs / 1000}s`,
					),
				);
			}, timeoutMs);
		}
		request.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function buildModuleTools(
	daemons: StartedDaemon[],
	delivery: ToolResultDelivery,
	toolTimeoutMs: number,
): Tool[] {
	return daemons.flatMap((daemon) =>
		daemon.tools.map((toolDef) =>
			tool({
				name: `${daemon.manifest.name}__${toolDef.name}`,
				description: toolDef.description,
				// biome-ignore lint/suspicious/noExplicitAny: avoid @openai/agents-core subpath types for parameters
				parameters: toolDef.parameters as any,
				strict: false,
				execute: async (input: unknown, _context, details) => {
					let result: unknown;
					try {
						result = await requestWithAbort(
							daemon.peer.request(`tool/${toolDef.name}`, input ?? {}),
							details?.signal,
							toolTimeoutMs,
						);
					} catch (error) {
						// One unresponsive module must not cost the whole turn: return the
						// timeout as this tool's result and let the model decide what to do.
						// Returning (rather than throwing) also keeps the tool_call.v1
						// notification firing, since the wrapper awaits this value.
						if (error instanceof ModuleToolTimeoutError) {
							return `error: ${error.message}`;
						}
						throw error;
					}
					// Proved healthy: serving a tool call resets the
					// consecutive-failure count.
					daemon.restartAttempts = 0;
					return prepareToolResultForLlm(result, delivery);
				},
			}),
		),
	);
}

function buildRouteMessageTool(
	daemonsRef: { current: StartedDaemon[] },
	getTarget: () => string,
	onSend: (moduleName: string) => void,
): Tool {
	return tool({
		name: "route_message",
		description:
			"Route a message to a replyable module other than the current delivery target. Use this only when forwarding output to a different module. To reply to the sender of the current event, emit free-form text instead — it is delivered automatically. Calling it with the current delivery target as the destination returns an error.",
		parameters: {
			type: "object",
			properties: {
				module: {
					type: "string",
					description:
						"Target module name (must differ from the current delivery target)",
				},
				text: { type: "string", description: "Message body" },
			},
			required: ["module", "text"],
			additionalProperties: false,
		},
		strict: true,
		execute: async (input: unknown) => {
			const { module: moduleName, text } = input as {
				module: string;
				text: string;
			};
			if (moduleName === getTarget()) {
				return `error: "${moduleName}" is already the current delivery target; emit free-form text to reply to the current sender`;
			}
			const daemon = daemonsRef.current.find(
				(d) => d.manifest.name === moduleName,
			);
			if (!daemon) {
				return `error: module "${moduleName}" not found`;
			}
			if (daemon.manifest.replyable !== true) {
				return `error: module "${moduleName}" is not replyable`;
			}
			daemon.peer.notify("event", { type: "message.send.v1", text });
			onSend(moduleName);
			return "ok";
		},
	});
}

export type LlmLoopOptions = {
	runner?: Runner;
	sessionStore?: SessionStore;
	workspaceTools?: Tool[];
	workspaceDir?: string;
	historyDir?: string;
	characterDir?: string;
	contextInstructions?: string;
	homeDir?: string;
	modulesRoot?: string;
	skillsDir?: string;
	sandboxFactory?: BootstrapRuntimeOptions["sandboxFactory"];
	initializeTimeoutMs?: BootstrapRuntimeOptions["initializeTimeoutMs"];
	abortSignal?: BootstrapRuntimeOptions["abortSignal"];
	timerSchedulerRef?: { current: TimerScheduler };
};

function resetSessionState(state: {
	currentSessionId: string | null;
	history: AgentInputItem[];
}): void {
	state.currentSessionId = null;
	state.history = [];
}

async function loadSessionIntoState(
	id: string,
	state: { currentSessionId: string | null; history: AgentInputItem[] },
	sessionStore: SessionStore,
	context: string,
): Promise<boolean> {
	try {
		const loaded = await sessionStore.load(id);
		if (loaded === null) {
			return false;
		}
		state.history = loaded;
		state.currentSessionId = id;
		return true;
	} catch (error) {
		console.warn(
			`[core] ${context}: session "${id}" is invalid or unreadable (${error instanceof Error ? error.message : String(error)})`,
		);
		return false;
	}
}

async function applySessionSwitch(
	newId: string,
	state: { currentSessionId: string | null; history: AgentInputItem[] },
	eventQueue: EventQueue,
	sessionStore: SessionStore,
): Promise<boolean> {
	if (newId === state.currentSessionId) {
		eventQueue.setMeta(ACTIVE_SESSION_META_KEY, newId);
		return true;
	}
	if (state.currentSessionId !== null) {
		if (await shouldPersistCurrentSession(state, eventQueue)) {
			await sessionStore.save(state.currentSessionId, state.history);
		}
	}
	if (
		!(await loadSessionIntoState(
			newId,
			state,
			sessionStore,
			"sessions.switch.v1 apply",
		))
	) {
		console.error(
			`[core] sessions.switch.v1: history for session "${newId}" is missing or unreadable at apply time; switch not applied`,
		);
		return false;
	}
	eventQueue.setMeta(ACTIVE_SESSION_META_KEY, newId);
	return true;
}

async function adoptSessionFromMetadata(
	state: { currentSessionId: string | null; history: AgentInputItem[] },
	eventQueue: EventQueue,
	sessionStore: SessionStore,
): Promise<boolean> {
	const metaSessionId = eventQueue.getMeta(ACTIVE_SESSION_META_KEY);
	if (metaSessionId !== null) {
		if (
			await loadSessionIntoState(
				metaSessionId,
				state,
				sessionStore,
				"active_session_id metadata adopt",
			)
		) {
			return true;
		}
		console.warn(
			`[core] active session metadata points to unreadable session "${metaSessionId}"; falling back to newest readable session`,
		);
	}

	const fallbackId = sessionStore.newestReadableSessionId();
	if (fallbackId === null) {
		return false;
	}
	if (
		!(await loadSessionIntoState(
			fallbackId,
			state,
			sessionStore,
			"newest readable fallback adopt",
		))
	) {
		return false;
	}
	eventQueue.setMeta(ACTIVE_SESSION_META_KEY, fallbackId);
	return true;
}

async function shouldPersistCurrentSession(
	state: { currentSessionId: string | null; history: AgentInputItem[] },
	eventQueue: EventQueue,
): Promise<boolean> {
	if (state.currentSessionId === null) {
		return false;
	}
	return state.currentSessionId === eventQueue.getMeta(ACTIVE_SESSION_META_KEY);
}

function isSessionsSwitchV1(
	params: Record<string, unknown>,
): params is { type: "sessions.switch.v1"; id: string } {
	return (
		params.type === "sessions.switch.v1" &&
		typeof params.id === "string" &&
		params.id !== ""
	);
}

export async function runLlmLoop(
	eventQueue: EventQueue,
	daemonsRef: { current: StartedDaemon[] },
	model: string,
	options?: LlmLoopOptions,
): Promise<void> {
	const runner = options?.runner ?? new Runner({ tracingDisabled: true });
	const maxTurns = resolveMaxTurns();
	const dropReasoningHistory = resolveDropReasoningHistory();
	const inputModalities = resolveInputModalities();
	const modelTimeoutMs = resolveModelTimeoutMs();
	const toolTimeoutMs = resolveToolTimeoutMs();
	const sessionStore = options?.sessionStore;
	const baseAgent = new Agent({
		name: "justclaw",
		model,
		instructions: "",
		tools: [],
		// The SDK rejects timeoutMs <= 0, so an unbounded configuration omits the
		// setting rather than passing 0. clone() below carries modelSettings over.
		...(modelTimeoutMs > 0
			? { modelSettings: { timeoutMs: modelTimeoutMs } }
			: {}),
	});

	const session = {
		currentSessionId: null as string | null,
		history: [] as AgentInputItem[],
	};

	// A single persistent listener aborts whichever run controller is current,
	// instead of registering a new {once:true} listener per iteration (which
	// would leak on the long-lived shared abortSignal).
	let currentRunController: AbortController | null = null;
	options?.abortSignal?.addEventListener("abort", () => {
		currentRunController?.abort();
	});

	while (true) {
		// Do not start a new (un-abortable) run once shutdown has begun.
		if (options?.abortSignal?.aborted) break;

		// Interrupt slot takes priority over the persistent queue. Interrupt events
		// are synthetic (not stored in the DB), so complete() is skipped for them.
		const interrupt = eventQueue.consumeInterrupt();
		const isInterrupt = interrupt !== null;
		const event = isInterrupt
			? {
					id: Bun.randomUUIDv7(),
					source: interrupt.source,
					params: interrupt.params,
				}
			: await eventQueue.next();
		if (!event) {
			// next() also resolves to undefined when a parked wait was woken by
			// setInterrupt() rather than shutdown; loop back so the interrupt
			// slot is consumed first instead of exiting.
			if (eventQueue.closed) break;
			continue;
		}

		if (
			session.currentSessionId !== eventQueue.getMeta(ACTIVE_SESSION_META_KEY)
		) {
			resetSessionState(session);
		}

		if (isSessionsSwitchV1(event.params)) {
			if (!sessionStore) {
				console.warn(
					`[core] sessions.switch.v1 requires a configured session store; dropping switch for "${event.params.id}"`,
				);
				notifyEventDropped(daemonsRef.current, event);
				eventQueue.complete(event.id);
				continue;
			}
			let applied = false;
			try {
				applied = await applySessionSwitch(
					event.params.id,
					session,
					eventQueue,
					sessionStore,
				);
			} catch (error) {
				console.error(
					`[core] sessions.switch.v1 failed for "${event.params.id}": ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			if (!applied) {
				notifyEventDropped(daemonsRef.current, event);
			}
			eventQueue.complete(event.id);
			continue;
		}

		// QueuedEvent.params is untyped; only LLM-bound envelope types reach the model.
		const envelopeType = event.params.type;
		if (
			envelopeType !== "event.v1" &&
			envelopeType !== "image.send.v1" &&
			envelopeType !== "file.send.v1" &&
			envelopeType !== "audio.send.v1"
		) {
			console.warn(
				`[core] unsupported internal event type for ${event.source} (id=${event.id}): ${String(envelopeType)} (expected event.v1, image.send.v1, file.send.v1, or audio.send.v1); dropping`,
			);
			eventQueue.complete(event.id);
			continue;
		}

		if (sessionStore && session.currentSessionId === null) {
			try {
				const adopted = await adoptSessionFromMetadata(
					session,
					eventQueue,
					sessionStore,
				);
				// Fires once when a new empty session is first adopted at bootstrap.
				// Explicit-switch cases are handled in sessions.switch.v1 before "ok" is returned.
				if (adopted && session.history.length === 0 && options?.characterDir) {
					const initText = await readInitContent(options.characterDir);
					if (initText) {
						eventQueue.enqueue(event.source, {
							type: "event.v1",
							text: initText,
						});
					}
				}
			} catch (error) {
				console.error(
					`[core] failed to adopt initial session for event from ${event.source} (id=${event.id}): ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				notifyEventDropped(daemonsRef.current, event);
				eventQueue.complete(event.id);
				continue;
			}
		}
		if (sessionStore && session.currentSessionId === null) {
			console.error(
				`[core] no active session for event from ${event.source} (id=${event.id}); add a session history file or call sessions.switch.v1 — dropping`,
			);
			notifyEventDropped(daemonsRef.current, event);
			eventQueue.complete(event.id);
			continue;
		}

		const sourceDaemon = daemonsRef.current.find(
			(d) => d.manifest.name === event.source,
		);
		if (sourceDaemon?.manifest.replyable === true) {
			eventQueue.setMeta(LAST_REPLYABLE_TARGET_META_KEY, event.source);
		}
		const fallbackTarget =
			eventQueue.getMeta(LAST_REPLYABLE_TARGET_META_KEY) ?? event.source;
		let currentTarget =
			sourceDaemon?.manifest.replyable === true ? event.source : fallbackTarget;

		const restartModulesTool = tool({
			name: "restart_modules",
			description:
				"Reload all modules (daemon and timer) from the modules directory (reflects adds/removes and manifest changes). Discovery runs first; on failure existing processes stay up and the tool returns an error. On success, processes update immediately (modules that fail to start are skipped with a warning) and the current LLM run ends after this tool call; pass non-empty continuation to enqueue a follow-up event.v1 (source fixed to current event source) so the next event runs with the reloaded module set. Pass an empty string when no follow-up is needed.",
			parameters: {
				type: "object",
				properties: {
					continuation: {
						type: "string",
						description:
							'After a successful reload, non-whitespace continuation enqueues one event.v1 (source = current event source, params = { type: "event.v1", text: continuation }). Pass empty string when no follow-up is needed.',
					},
				},
				required: ["continuation"],
				additionalProperties: false,
			},
			strict: true,
			execute: async (input: unknown) => {
				if (options?.modulesRoot === undefined || options.modulesRoot === "") {
					return "error: modules root not configured";
				}
				if (!sessionStore) {
					return "error: session store not configured";
				}
				try {
					await reloadModules(daemonsRef, options.modulesRoot, eventQueue, {
						sessionStore,
						sandboxFactory: options.sandboxFactory,
						initializeTimeoutMs: options.initializeTimeoutMs,
						abortSignal: options.abortSignal,
						timerSchedulerRef: options.timerSchedulerRef,
						// Without characterDir the reloaded daemons' session-request
						// handlers stop injecting INIT.md for new sessions.
						characterDir: options.characterDir,
					});
					const rawContinuation =
						(input as { continuation: string }).continuation ?? "";
					if (rawContinuation.trim() !== "") {
						eventQueue.enqueue(event.source, {
							type: "event.v1",
							text: rawContinuation.trim(),
						});
					}
					return `ok: loaded ${daemonsRef.current.length} module(s)`;
				} catch (e) {
					return `error: ${e instanceof Error ? e.message : String(e)}`;
				}
			},
		});

		const openAIAPIMode = resolveOpenAIAPIMode();
		const toolResultDelivery: ToolResultDelivery = {
			apiMode: openAIAPIMode,
			inputModalities,
			enqueueMedia: (params) => {
				eventQueue.enqueue(event.source, params);
			},
		};

		const coreTools: Tool[] = [
			buildRouteMessageTool(
				daemonsRef,
				() => currentTarget,
				(name) => {
					currentTarget = name;
				},
			),
			restartModulesTool,
			tool({
				name: "turn_end",
				description:
					"End the current turn immediately without sending any message to the user or any module. " +
					"Use this when the task is complete and no reply is needed — for example after a background " +
					"task, a timer event, or any event that requires action but not a user-facing response. " +
					"Do NOT use this when you have something to say; emit free-form text instead.",
				parameters: {
					type: "object",
					properties: {},
					required: [],
					additionalProperties: false,
				},
				strict: true,
				execute: async () => "ok",
			}),
			// The attach_* tools exist only to put bytes in front of the model. When
			// the endpoint cannot take that modality they are omitted rather than
			// left to return an error: a tool the model can call but never succeed
			// with just burns turns and confuses it.
			...(inputModalities.has("image")
				? [
						tool({
							name: "attach_image",
							description:
								"Read a local image file and attach it to the LLM input. " +
								"In Responses mode it is available in this turn; in Chat Completions mode it arrives in the next cycle. " +
								"The path must be within a sandbox-accessible directory (workspace, character, modules, skills, history, or standard OS read-only paths).",
							parameters: {
								type: "object",
								properties: {
									path: {
										type: "string",
										description: "Path to the image file",
									},
								},
								required: ["path"],
								additionalProperties: false,
							},
							strict: true,
							execute: async (input: unknown) => {
								if (
									options === undefined ||
									options.workspaceDir === undefined ||
									options.workspaceDir === ""
								) {
									return "error: workspace not configured";
								}
								const {
									workspaceDir,
									historyDir: historyDirOpt,
									characterDir,
									modulesRoot,
									skillsDir,
								} = options;
								const historyDir = historyDirOpt ?? workspaceDir;
								const { path: pathArg } = input as { path: string };
								const resolved = path.resolve(pathArg);
								const read = await runReadFileBase64(
									workspaceDir,
									historyDir,
									process.platform,
									resolved,
									characterDir,
									modulesRoot,
									skillsDir,
								);
								if (!read.ok) {
									return `error: ${read.stderr.trim() || "read failed"}`;
								}
								const mediaType = inferImageMediaType(resolved);
								const original = Buffer.from(read.content, "base64");
								const image = await downscaleImage(original, mediaType);
								const metadata = await buildMediaMetadata(
									"image",
									image.data,
									image.mediaType,
									resolved,
								);
								return prepareToolResultForLlm(
									{
										type: "image",
										image: {
											data: Buffer.from(image.data).toString("base64"),
											mediaType: image.mediaType,
											size: metadata.size,
											sha256: metadata.sha256,
											link: resolved,
										},
										providerData: attachProviderMetadata(undefined, metadata),
									},
									toolResultDelivery,
								);
							},
						}),
					]
				: []),
			...(inputModalities.has("file")
				? [
						tool({
							name: "attach_file",
							description:
								"Read a local file and attach it to the LLM input. " +
								"In Responses mode it is available in this turn; in Chat Completions mode it arrives in the next cycle. " +
								"The path must be within a sandbox-accessible directory (workspace, character, modules, skills, history, or standard OS read-only paths).",
							parameters: {
								type: "object",
								properties: {
									path: {
										type: "string",
										description: "Path to the file",
									},
								},
								required: ["path"],
								additionalProperties: false,
							},
							strict: true,
							execute: async (input: unknown) => {
								if (
									options === undefined ||
									options.workspaceDir === undefined ||
									options.workspaceDir === ""
								) {
									return "error: workspace not configured";
								}
								const {
									workspaceDir,
									historyDir: historyDirOpt,
									characterDir,
									modulesRoot,
									skillsDir,
								} = options;
								const historyDir = historyDirOpt ?? workspaceDir;
								const { path: pathArg } = input as { path: string };
								const resolved = path.resolve(pathArg);
								const read = await runReadFileBase64(
									workspaceDir,
									historyDir,
									process.platform,
									resolved,
									characterDir,
									modulesRoot,
									skillsDir,
								);
								if (!read.ok) {
									return `error: ${read.stderr.trim() || "read failed"}`;
								}
								const mediaType = inferFileMediaType(resolved);
								const filename = path.basename(resolved);
								const bytes = Buffer.from(read.content, "base64");
								const metadata = await buildMediaMetadata(
									"file",
									bytes,
									mediaType,
									resolved,
									filename,
								);
								return prepareToolResultForLlm(
									{
										type: "file",
										file: {
											data: read.content,
											mediaType,
											filename,
											size: metadata.size,
											sha256: metadata.sha256,
											link: resolved,
										},
										providerData: attachProviderMetadata(undefined, metadata),
									},
									toolResultDelivery,
								);
							},
						}),
					]
				: []),
		];

		const tools: Tool[] = [
			...(options?.workspaceTools ?? []).map((toolItem) =>
				wrapWithNotification(toolItem, () => currentTarget, daemonsRef),
			),
			...buildModuleTools(
				daemonsRef.current,
				toolResultDelivery,
				toolTimeoutMs,
			).map((toolItem) =>
				wrapWithNotification(toolItem, () => currentTarget, daemonsRef),
			),
			...coreTools.map((toolItem) =>
				wrapWithNotification(toolItem, () => currentTarget, daemonsRef),
			),
		];

		const operatorContext = options?.homeDir
			? await loadHomeAgentsFile(options.homeDir)
			: undefined;
		const characterContext = options?.characterDir
			? await loadAgentContext(options.characterDir)
			: options?.contextInstructions;
		// Operator instructions live in a fixed file the agent cannot edit, so they
		// get their own tag distinct from the editable character files. The fence
		// labels origin only — content is not escaped, so a character file can emit
		// a forged <system-instructions> block. Acceptable because all writers are
		// inside the trust boundary; see "Fence trust model" in docs/spec.md before
		// giving this tag authority over character content.
		const contextInstructions =
			[
				operatorContext
					? `<system-instructions>\n${operatorContext}\n</system-instructions>`
					: undefined,
				characterContext,
			]
				.filter(Boolean)
				.join("\n\n") || undefined;
		const modules = daemonsRef.current.map((d) => ({
			name: d.manifest.name,
			replyable: d.manifest.replyable,
			tools: d.tools.map((t) => t.name),
		}));
		const skills = options?.skillsDir
			? await loadSkillsIndex(options.skillsDir)
			: undefined;
		const instructions = buildSystemPrompt({
			contextInstructions,
			workspaceDir: options?.workspaceDir,
			historyDir: options?.historyDir,
			characterDir: options?.characterDir,
			modulesRoot: options?.modulesRoot,
			modules,
			// Derived from the tools actually built above, so the prompt cannot
			// drift from the live tool set.
			builtinTools: coreTools.map((t) => t.name),
			skillsDir: options?.skillsDir,
			skills,
		});
		const agent = baseAgent.clone({
			tools,
			instructions,
			toolUseBehavior: (_context, toolResults: FunctionToolResult[]) => {
				const restartResult = toolResults.find(
					(result) =>
						result.type === "function_output" &&
						result.tool.name === "restart_modules" &&
						typeof result.output === "string" &&
						result.output.startsWith("ok:"),
				);
				if (restartResult) {
					return {
						isFinalOutput: true,
						isInterrupted: undefined,
						finalOutput: "",
					};
				}
				// The SDK loop cannot terminate without text output; turn_end provides
				// an explicit escape hatch that ends the run silently via isFinalOutput.
				const turnEndResult = toolResults.find(
					(result) =>
						result.type === "function_output" &&
						result.tool.name === "turn_end" &&
						result.output === "ok",
				);
				if (turnEndResult) {
					return {
						isFinalOutput: true,
						isInterrupted: undefined,
						finalOutput: "",
					};
				}
				return { isFinalOutput: false, isInterrupted: undefined };
			},
		});

		const runController = new AbortController();
		// Propagate the process-level abort into the per-run controller so that
		// either a sessions.skip.v1 request or a process shutdown aborts the run.
		currentRunController = runController;
		eventQueue.setRunController(runController);
		// The abortSignal may have fired while this iteration was blocked in
		// `await eventQueue.next()`, before currentRunController pointed at it.
		if (options?.abortSignal?.aborted) runController.abort();
		// Snapshot so a dropped turn (save failure below) can be rolled back
		// and not later persisted/replayed on a subsequent event.
		const historyBefore = session.history;
		try {
			// Build the LLM input inside the try so an invalid payload (e.g. a
			// key eventToXml rejects) is dropped like any other per-event failure
			// instead of throwing out of runLlmLoop and killing the whole loop.
			// A disabled modality falls through to the text-only branch below: the
			// XML wrapper already excludes the base64 data and keeps the
			// descriptive fields, so the model still learns that a file arrived
			// and what it was, without a content part the endpoint would reject.
			const eventForInput = inputModalities.has("image")
				? await prepareImageEventForInput(event)
				: event;
			const xml = eventToXml(eventForInput);
			const userInput: AgentInputItem =
				eventForInput.params.type === "image.send.v1" &&
				inputModalities.has("image")
					? ({
							role: "user",
							content: [
								{ type: "input_text", text: xml },
								{
									type: "input_image",
									image: `data:${String(eventForInput.params.mediaType)};base64,${String(eventForInput.params.data)}`,
								},
							],
						} as AgentInputItem)
					: eventForInput.params.type === "file.send.v1" &&
							inputModalities.has("file")
						? ({
								role: "user",
								content: [
									{ type: "input_text", text: xml },
									{
										type: "input_file",
										file: `data:${String(eventForInput.params.mediaType)};base64,${String(eventForInput.params.data)}`,
										...(typeof eventForInput.params.filename === "string"
											? { filename: eventForInput.params.filename }
											: {}),
									},
								],
							} as AgentInputItem)
						: eventForInput.params.type === "audio.send.v1" &&
								inputModalities.has("audio")
							? ({
									role: "user",
									content: [
										{ type: "input_text", text: xml },
										{
											type: "audio",
											audio: String(eventForInput.params.data),
											format: inferAudioFormat(eventForInput.params),
										},
									],
								} as AgentInputItem)
							: ({ role: "user", content: xml } as AgentInputItem);

			// Filter here, not at the storage boundary: the persisted history stays
			// a complete record of what the model produced, including reasoning,
			// so it remains usable as an audit trail when the agent misbehaves.
			// Only the copy handed to the model is reduced.
			const modelHistory = dropReasoningHistory
				? dropReasoningItems(session.history)
				: session.history;
			const runInput: string | AgentInputItem[] =
				modelHistory.length > 0
					? [...modelHistory, userInput]
					: eventForInput.params.type === "event.v1"
						? xml
						: [userInput];
			const result = await runner.run(agent, runInput, {
				signal: runController.signal,
				maxTurns,
			});
			// A sessions.skip.v1 that aborted this run — including the narrow window
			// where the run resolved just before the abort landed — must yield a
			// dropped event, not a delivered reply. Past this point the run is
			// committed: the controller is unregistered so a later skip is a no-op
			// (the save/deliver window is intentionally not abortable).
			if (runController.signal.aborted) {
				notifyEventDropped(daemonsRef.current, event);
				if (!isInterrupt) eventQueue.complete(event.id);
				continue;
			}
			eventQueue.setRunController(null);
			const text = result.finalOutput;
			// `result.history` is the run's input verbatim, followed by the items the
			// run generated (@openai/agents `getTurnInput`; only the generated tail
			// is ever pruned). Storing it directly would write back the *filtered*
			// input, erasing on this save the very reasoning the filter deliberately
			// left on disk. Re-anchor on the unfiltered history and append only what
			// this run added. When nothing was filtered `modelHistory` is
			// `session.history`, so this reduces to `result.history` unchanged.
			session.history = sanitizeHistoryForStorage([
				...session.history,
				...result.history.slice(modelHistory.length),
			]);
			if (sessionStore && session.currentSessionId !== null) {
				// Re-check liveness immediately before writing. sessions.delete.v1
				// removes the history file mid-run; the completing turn must not
				// recreate it (spec: deleted sessions are never written again).
				// active_session_id alone is insufficient because the delete removes
				// the file before it clears that metadata, so also confirm the file
				// still exists.
				const stillActive =
					session.currentSessionId ===
					eventQueue.getMeta(ACTIVE_SESSION_META_KEY);
				const stillOnDisk =
					stillActive &&
					(await sessionStore.load(session.currentSessionId)) !== null;
				if (stillOnDisk) {
					await sessionStore.save(session.currentSessionId, session.history);
				} else {
					resetSessionState(session);
				}
			}
			// Deliver only after the session history is persisted, so a save
			// failure (caught below) means nothing was delivered and the
			// event.dropped.v1 path is not reporting an already-sent reply.
			if (text?.trim()) {
				const targetDaemon = daemonsRef.current.find(
					(d) => d.manifest.name === currentTarget,
				);
				if (targetDaemon?.manifest.replyable === true) {
					targetDaemon.peer.notify("event", {
						type: "message.send.v1",
						text,
					});
				}
			}
			if (!isInterrupt) eventQueue.complete(event.id);
		} catch (error) {
			console.error(
				`[core] LLM cycle failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			// The turn is dropped, so discard its in-memory history mutation;
			// otherwise a failed save would still leave the turn to be persisted
			// on a later event and re-processed after re-emit.
			session.history = historyBefore;
			notifyEventDropped(daemonsRef.current, event);
			if (!isInterrupt) eventQueue.complete(event.id);
		} finally {
			eventQueue.setRunController(null);
		}
	}

	// A pending interrupt at shutdown is otherwise discarded silently (close()
	// only resolves the next() waiter); report it as dropped like any other
	// unhandled event.
	const pendingInterrupt = eventQueue.consumeInterrupt();
	if (pendingInterrupt) {
		notifyDropped(
			daemonsRef.current,
			pendingInterrupt.source,
			pendingInterrupt.params,
			formatLocalTimestamp(Date.now()),
		);
	}
}
