import { describe, expect, test } from "bun:test";
import { buildRuntimeInstructions } from "./runtime-prompt";
import { buildSystemPrompt } from "./system-prompt";

describe("buildRuntimeInstructions", () => {
	test("embeds workspace, history, character, and modules paths", () => {
		const text = buildRuntimeInstructions({
			workspaceDir: "/tmp/ws",
			historyDir: "/tmp/hist",
			characterDir: "/tmp/ch",
			modulesRoot: "/tmp/mods",
			modules: [
				{ name: "cli-chat", replyable: true, tools: ["send"] },
				{ name: "watcher", replyable: false, tools: [] },
			],
			builtinTools: ["route_message", "turn_end"],
		});
		expect(text).toContain("Path: /tmp/ws");
		expect(text).toContain("Path: /tmp/hist");
		expect(text).toContain("Path: /tmp/ch");
		expect(text).toContain("Modules directory: /tmp/mods");
		expect(text).toContain("| cli-chat | yes | send |");
		expect(text).toContain("| watcher | no | — |");
	});

	test("lists only the built-in tools it is given", () => {
		const text = buildRuntimeInstructions({
			workspaceDir: "/tmp/ws",
			historyDir: "/tmp/hist",
			characterDir: "/tmp/ch",
			modulesRoot: "/tmp/mods",
			modules: [],
			builtinTools: ["route_message", "restart_modules", "turn_end"],
		});
		expect(text).toContain(
			"Built-in tools: route_message, restart_modules, turn_end.",
		);
		expect(text).not.toContain("attach_image");
		expect(text).not.toContain("attach_file");
	});
});

describe("buildSystemPrompt", () => {
	test("returns empty string when both inputs are absent", () => {
		expect(buildSystemPrompt({})).toBe("");
	});

	test("omits undefined and empty string parts", () => {
		expect(buildSystemPrompt({ contextInstructions: "" })).toBe("");
		expect(
			buildSystemPrompt({
				contextInstructions: "ctx",
			}),
		).toBe("ctx");
	});

	test("joins context and runtime with a blank line when all path options are set", () => {
		const modules: Array<{
			name: string;
			replyable: boolean;
			tools: string[];
		}> = [];
		expect(
			buildSystemPrompt({
				contextInstructions: "alpha",
				workspaceDir: "/w",
				historyDir: "/h",
				characterDir: "/c",
				modulesRoot: "/m",
				modules,
				builtinTools: ["turn_end"],
			}),
		).toBe(
			`alpha\n\n${buildRuntimeInstructions({
				workspaceDir: "/w",
				historyDir: "/h",
				characterDir: "/c",
				modulesRoot: "/m",
				modules,
				builtinTools: ["turn_end"],
			})}`,
		);
	});

	test("omits runtime block when any required path or module metadata is missing", () => {
		expect(
			buildSystemPrompt({
				contextInstructions: "only-ctx",
				workspaceDir: "/w",
				historyDir: "/h",
				characterDir: "/c",
			}),
		).toBe("only-ctx");
	});
});
