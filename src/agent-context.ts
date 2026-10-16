import path from "node:path";

/**
 * Files read from {@link resolveCharacterDir}'s directory, in order.
 * Each present file is included in the system prompt fenced in an XML element
 * named after the file (e.g. `<SOUL.md>...</SOUL.md>`). runtime instructions
 * document what each file means, so the tag name alone is sufficient.
 * The LLM may write back to these files (character dir is rw-mounted in the sandbox).
 */
export const CHARACTER_FILES = [
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"MEMORY.md",
] as const;

/**
 * Reads a file the agent can write (character files, INIT.md, SKILL.md) and
 * returns its text, or null when it is absent or unreadable.
 *
 * The core runs unsandboxed, but the agent can replace any of these files with
 * a symlink to a host path it cannot reach itself (e.g. `~/.ssh/id_ed25519`).
 * A host-side read would follow the link and put the target into the prompt.
 * The bundled entrypoint therefore reads them inside the workspace sandbox
 * (see createSandboxedFileReader), where a path resolves only to what the
 * agent could read anyway. Injected rather than imported so these loaders stay
 * free of sandbox plumbing and tests can read from the host directly.
 */
export type ReadAgentFile = (absPath: string) => Promise<string | null>;

export function resolveSkillsDir(
	justclawHome = process.env.JUSTCLAW_HOME,
	override = process.env.JUSTCLAW_SKILLS,
	homeDir = process.env.HOME,
): string {
	if (override) {
		return path.resolve(override);
	}
	if (justclawHome) {
		return path.resolve(justclawHome, "skills");
	}
	if (homeDir) {
		return path.resolve(homeDir, "justclaw", "skills");
	}
	throw new Error(
		"Neither JUSTCLAW_HOME nor HOME is set; cannot resolve skills directory",
	);
}

export function resolveCharacterDir(
	justclawHome = process.env.JUSTCLAW_HOME,
	override = process.env.JUSTCLAW_CHARACTER,
	homeDir = process.env.HOME,
): string {
	if (override) {
		return path.resolve(override);
	}
	if (justclawHome) {
		return path.resolve(justclawHome, "character");
	}
	if (homeDir) {
		return path.resolve(homeDir, "justclaw", "character");
	}
	throw new Error(
		"JUSTCLAW_HOME is not set; cannot resolve character directory",
	);
}

/**
 * Reads `INIT.md` from the character directory.
 * Returns trimmed content, or null when the file is absent or empty.
 * Used to enqueue a startup event when a new empty session becomes active.
 */
export async function readInitContent(
	characterDir: string,
	readFile: ReadAgentFile,
): Promise<string | null> {
	const content = await readFile(path.join(characterDir, "INIT.md"));
	return content?.trim() || null;
}

/**
 * Reads `AGENTS.md` from the justclaw home directory (operator-level instructions).
 * Called once at startup so the content is fixed for the lifetime of the process;
 * the agent cannot modify it even if sandbox write paths change in the future.
 * Returns the trimmed content, or an empty string when the file is absent.
 */
export async function loadHomeAgentsFile(homeDir: string): Promise<string> {
	const file = Bun.file(path.join(homeDir, "AGENTS.md"));
	if (!(await file.exists())) {
		return "";
	}
	return (await file.text()).trim();
}

/**
 * Reads present files from {@link CHARACTER_FILES} under `characterDir`.
 * Each non-empty file is fenced in an XML element named after the file:
 * `<FILENAME>\n<content>\n</FILENAME>`. The fence labels each block's origin;
 * content is not escaped, so it is forgeable by content that emits closing
 * tags (see "Fence trust model" in docs/spec.md for why that is acceptable).
 * Sections are joined with a blank line.
 * Missing or unreadable files are skipped.
 */
export async function loadAgentContext(
	characterDir: string,
	readFile: ReadAgentFile,
): Promise<string> {
	const sections: string[] = [];
	for (const filename of CHARACTER_FILES) {
		const content = await readFile(path.join(characterDir, filename));
		if (content === null) {
			continue;
		}
		const trimmed = content.trim();
		if (trimmed) {
			sections.push(`<${filename}>\n${trimmed}\n</${filename}>`);
		}
	}
	return sections.join("\n\n");
}

/**
 * Parses YAML frontmatter from a SKILL.md file and extracts name and description.
 * Both fields are strings per the Agent Skills spec; values of any other YAML
 * type (e.g. an unquoted `name: true`) are treated as missing rather than
 * coerced, so the author gets a warning instead of a silently mangled value.
 * Returns null when the file does not begin with a valid `---` block.
 */
function parseFrontmatter(
	content: string,
): { name?: string; description?: string } | null {
	if (!content.startsWith("---")) return null;
	const firstNewline = content.indexOf("\n");
	if (firstNewline === -1) return null;
	const rest = content.slice(firstNewline + 1);
	const closingMatch = rest.match(/^---[ \t]*$/m);
	if (!closingMatch || closingMatch.index === undefined) return null;
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(rest.slice(0, closingMatch.index));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const fm = parsed as Record<string, unknown>;
	return {
		name: typeof fm.name === "string" ? fm.name : undefined,
		description:
			typeof fm.description === "string" ? fm.description : undefined,
	};
}

/**
 * Scans `skillsDir` for subdirectories containing a `SKILL.md` file and returns
 * the name and description from each skill's frontmatter.
 * Skills without a description are skipped. Parse errors are warned and skipped.
 */
export async function loadSkillsIndex(
	skillsDir: string,
	readFile: ReadAgentFile,
): Promise<Array<{ name: string; description: string }>> {
	const skills: Array<{ name: string; description: string }> = [];
	const glob = new Bun.Glob("*/SKILL.md");
	for await (const relPath of glob.scan({ cwd: skillsDir, onlyFiles: true })) {
		// Listing on the host only reveals whether a symlinked directory holds a
		// SKILL.md; the contents are read through readFile.
		const skillMdPath = path.join(skillsDir, relPath);
		const content = await readFile(skillMdPath);
		if (content === null) {
			continue;
		}
		const fm = parseFrontmatter(content);
		if (!fm) {
			console.warn(`[skills] ${skillMdPath}: could not parse frontmatter`);
			continue;
		}
		if (!fm.description) {
			console.warn(`[skills] ${skillMdPath}: missing description, skipping`);
			continue;
		}
		const dirName = path.basename(path.dirname(skillMdPath));
		if (fm.name && fm.name !== dirName) {
			console.warn(
				`[skills] ${skillMdPath}: name "${fm.name}" does not match directory "${dirName}"; using directory name`,
			);
		}
		skills.push({ name: dirName, description: fm.description });
	}
	return skills;
}
