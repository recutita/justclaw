## Skills

A skill is a set of instructions stored in {{SKILLS_DIR}}/<name>/SKILL.md.

{{SKILLS_INDEX}}

If a task matches a skill's description above, read that skill's instructions completely before acting: shell(["cat {{SKILLS_DIR}}/<name>/SKILL.md"]). Resolve relative paths in a SKILL.md against that skill's directory.

To create a skill, create a directory under {{SKILLS_DIR}} containing a SKILL.md with YAML frontmatter (name, description) and Markdown instructions. The skill appears in this index on the next turn.
