// The static prose of the runtime instructions lives in sibling Markdown
// templates (`runtime-prompt.md`, `runtime-skills.md`) so it can be read
// and reviewed as prose rather than buried in a TS string literal. This module
// only fills the dynamic parts (resolved paths, the live module table, the
// skills index) into those templates. Templates are imported as text, so the
// bundler inlines them and no runtime file I/O is needed.
import mainTemplate from "./runtime-prompt.md" with { type: "text" };
import skillsTemplate from "./runtime-skills.md" with { type: "text" };

// Replace each `{{KEY}}` token with its value. The replacement is passed as a
// function so `$`-sequences in dynamic values (paths, descriptions) are treated
// literally rather than as replacement patterns.
function interpolate(template: string, values: Record<string, string>): string {
	let out = template;
	for (const [key, value] of Object.entries(values)) {
		out = out.replaceAll(`{{${key}}}`, () => value);
	}
	return out;
}

export type RuntimeInstructionsOptions = {
	workspaceDir: string;
	historyDir: string;
	characterDir: string;
	modulesRoot: string;
	modules: Array<{ name: string; replyable: boolean; tools: string[] }>;
	// Names of the built-in tools actually handed to the model this turn. Passed
	// in rather than listed in the template because the set is not fixed: the
	// attach_* tools are omitted when the provider cannot take that input
	// modality, and a prompt that advertises a tool the model cannot call is
	// worse than no listing at all.
	builtinTools: string[];
	skillsDir?: string;
	skills?: Array<{ name: string; description: string }>;
};

export function buildRuntimeInstructions({
	workspaceDir,
	historyDir,
	characterDir,
	modulesRoot,
	modules,
	builtinTools,
	skillsDir,
	skills,
}: RuntimeInstructionsOptions): string {
	const moduleTable = modules
		.map(
			(m) =>
				`| ${m.name} | ${m.replyable ? "yes" : "no"} | ${m.tools.length > 0 ? m.tools.join(", ") : "—"} |`,
		)
		.join("\n");

	// Fence the whole block in <runtime> so the model can tell operator/character
	// context apart from machine-supplied runtime facts. The inner prose stays
	// Markdown; only the outer boundary is XML.
	const body = interpolate(mainTemplate.trimEnd(), {
		WORKSPACE_DIR: workspaceDir,
		HISTORY_DIR: historyDir,
		CHARACTER_DIR: characterDir,
		MODULES_ROOT: modulesRoot,
		MODULE_TABLE: moduleTable,
		BUILTIN_TOOLS: builtinTools.length > 0 ? builtinTools.join(", ") : "none",
		SKILLS_SECTION: buildSkillsSection(skillsDir, skills),
	});
	return `<runtime>\n${body}\n</runtime>`;
}

// The skills section has two structurally different renderings (configured vs.
// not), so its prose lives in its own template and the rare unconfigured case
// stays a one-line literal here rather than forcing conditionals into the
// template.
function buildSkillsSection(
	skillsDir: string | undefined,
	skills: Array<{ name: string; description: string }> | undefined,
): string {
	if (!skillsDir) {
		return "## Skills\n\nNo skills directory configured.";
	}

	const index =
		skills && skills.length > 0
			? `| Skill | Description |\n|---|---|\n${skills.map((s) => `| ${s.name} | ${s.description} |`).join("\n")}`
			: "No skills installed.";

	return interpolate(skillsTemplate.trimEnd(), {
		SKILLS_DIR: skillsDir,
		SKILLS_INDEX: index,
	});
}
