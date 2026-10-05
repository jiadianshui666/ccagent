import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_SKILL_BYTES = 64 * 1024;
const SKILL_FILE_NAME = "SKILL.md";
const SKILL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ProjectSkill = {
  content: string;
  description?: string;
  name: string;
  path: string;
  summary: string;
  tags?: string[];
};

export type LoadedProjectSkills = {
  path: string;
  skills: ProjectSkill[];
  warnings: string[];
};

export type InitProjectSkillResult =
  | {
      created: true;
      name: string;
      path: string;
    }
  | {
      created: false;
      name: string;
      path: string;
      reason: string;
    };

export type ReadProjectSkillResult =
  | {
      ok: true;
      skill: ProjectSkill;
    }
  | {
      error: string;
      loaded: LoadedProjectSkills;
      ok: false;
    };

export async function initProjectSkill(
  workspaceRoot: string,
  name: string,
): Promise<InitProjectSkillResult> {
  const normalizedName = name.trim();
  const skillsDir = getProjectSkillsDir(workspaceRoot);

  if (!isValidProjectSkillName(normalizedName)) {
    return {
      created: false,
      name: normalizedName,
      path: skillsDir,
      reason: "Expected skill name to contain 1-64 letters, numbers, dashes, or underscores.",
    };
  }

  const skillDir = join(skillsDir, normalizedName);
  const path = join(skillDir, SKILL_FILE_NAME);

  try {
    await stat(path);
    return {
      created: false,
      name: normalizedName,
      path,
      reason: "Project skill already exists.",
    };
  } catch (error) {
    if (!isFileNotFound(error)) {
      const reason = error instanceof Error ? error.message : String(error);

      return {
        created: false,
        name: normalizedName,
        path,
        reason: `Could not check project skill: ${reason}`,
      };
    }
  }

  await mkdir(skillDir, { recursive: true });
  await writeFile(path, buildProjectSkillTemplate(normalizedName), "utf8");

  return {
    created: true,
    name: normalizedName,
    path,
  };
}

export async function loadProjectSkills(workspaceRoot: string): Promise<LoadedProjectSkills> {
  const skillsDir = getProjectSkillsDir(workspaceRoot);
  let entries: Array<{ isDirectory(): boolean; name: string }>;

  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        path: skillsDir,
        skills: [],
        warnings: [],
      };
    }

    const reason = error instanceof Error ? error.message : String(error);
    return {
      path: skillsDir,
      skills: [],
      warnings: [`Failed to read project skills: ${reason}`],
    };
  }

  const skills: ProjectSkill[] = [];
  const warnings: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (!isValidProjectSkillName(entry.name)) {
      warnings.push(`Ignoring invalid skill directory name: ${entry.name}`);
      continue;
    }

    const path = join(skillsDir, entry.name, SKILL_FILE_NAME);

    try {
      const fileStat = await stat(path);

      if (!fileStat.isFile()) {
        warnings.push(`Ignoring ${entry.name}: ${SKILL_FILE_NAME} is missing or not a file.`);
        continue;
      }

      if (fileStat.size > MAX_SKILL_BYTES) {
        warnings.push(`Ignoring ${entry.name}: ${SKILL_FILE_NAME} is too large (${fileStat.size} bytes, max ${MAX_SKILL_BYTES}).`);
        continue;
      }

      const parsed = parseProjectSkillFile((await readFile(path, "utf8")).trimEnd());
      skills.push({
        content: parsed.content,
        ...(parsed.description ? { description: parsed.description } : {}),
        name: entry.name,
        path,
        summary: parsed.description ?? summarizeSkill(parsed.content, entry.name),
        ...(parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
      });
    } catch (error) {
      if (isFileNotFound(error)) {
        warnings.push(`Ignoring ${entry.name}: ${SKILL_FILE_NAME} is missing or not a file.`);
        continue;
      }

      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to read skill ${entry.name}: ${reason}`);
    }
  }

  return {
    path: skillsDir,
    skills,
    warnings,
  };
}

export async function readProjectSkill(
  workspaceRoot: string,
  name: string,
): Promise<ReadProjectSkillResult> {
  const loaded = await loadProjectSkills(workspaceRoot);
  const normalizedName = name.trim();

  if (!isValidProjectSkillName(normalizedName)) {
    return {
      error: "Expected skill name to contain 1-64 letters, numbers, dashes, or underscores.",
      loaded,
      ok: false,
    };
  }

  const skill = loaded.skills.find((candidate) => candidate.name === normalizedName);

  if (!skill) {
    return {
      error: `Project skill not found: ${normalizedName}`,
      loaded,
      ok: false,
    };
  }

  return {
    ok: true,
    skill,
  };
}

export function formatProjectSkill(skill: ProjectSkill): string {
  return [
    "Project skill",
    `Name: ${skill.name}`,
    `Path: ${skill.path}`,
    `Description: ${skill.description ?? "(none)"}`,
    `Tags: ${skill.tags?.join(", ") ?? "(none)"}`,
    "",
    "Content:",
    "",
    skill.content || "(empty)",
  ].join("\n");
}

export function formatProjectSkills(loaded: LoadedProjectSkills): string {
  const lines = [
    "Project skills",
    `Path: ${loaded.path}`,
    `Count: ${loaded.skills.length}`,
  ];

  if (loaded.skills.length === 0) {
    lines.push("", "No project skills found. Use ccagent --init-skill <name> to create one.");
  } else {
    lines.push("", "Skills:");
    lines.push(...loaded.skills.map((skill) => `- ${skill.name}: ${skill.summary}`));
  }

  if (loaded.warnings.length > 0) {
    lines.push("", "Warnings:", ...loaded.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function getProjectSkillsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".ccagent", "skills");
}

export function isValidProjectSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

function buildProjectSkillTemplate(name: string): string {
  const title = name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

  return [
    "---",
    `description: ${title} workflow guidance.`,
    "tags: workflow",
    "---",
    "",
    `# ${title}`,
    "",
    "Describe when this skill applies, the files to inspect first, and the verification to run.",
    "",
  ].join("\n");
}

function parseProjectSkillFile(rawContent: string): {
  content: string;
  description?: string;
  tags: string[];
} {
  const normalizedContent = rawContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

  if (!normalizedContent.startsWith("---\n")) {
    return { content: normalizedContent, tags: [] };
  }

  const lines = normalizedContent.split("\n");
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

  if (closingIndex < 0) {
    return { content: normalizedContent, tags: [] };
  }

  const metadata = lines.slice(1, closingIndex).join("\n");
  const content = lines.slice(closingIndex + 1).join("\n").replace(/^\n+/, "").trimEnd();
  let description: string | undefined;
  let tags: string[] = [];

  for (const line of metadata.split(/\r?\n/)) {
    const separator = line.indexOf(":");

    if (separator < 0) {
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "description" && value) {
      description = value;
    }

    if (key === "tags") {
      tags = value.split(",").map((tag) => tag.trim()).filter(Boolean);
    }
  }

  return { content, ...(description ? { description } : {}), tags };
}

function summarizeSkill(content: string, name: string): string {
  const firstMeaningfulLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstMeaningfulLine) {
    return `${name} skill`;
  }

  return firstMeaningfulLine.replace(/^#+\s*/, "").slice(0, 160);
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
