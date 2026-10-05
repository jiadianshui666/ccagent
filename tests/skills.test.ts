import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatProjectSkill,
  formatProjectSkills,
  initProjectSkill,
  loadProjectSkills,
  readProjectSkill,
} from "../src/skills.js";
import { ListSkillsTool, ReadSkillTool } from "../src/tools/skills.js";

test("loadProjectSkills returns an empty list when the skills directory is missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-skills-"));

  try {
    const loaded = await loadProjectSkills(workspaceRoot);

    assert.equal(loaded.skills.length, 0);
    assert.deepEqual(loaded.warnings, []);
    assert.match(formatProjectSkills(loaded), /No project skills found/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("initProjectSkill creates a reusable skill without overwriting it", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-skills-"));
  const path = join(workspaceRoot, ".ccagent", "skills", "code-review", "SKILL.md");

  try {
    const created = await initProjectSkill(workspaceRoot, "code-review");
    const template = await readFile(path, "utf8");
    const existing = await initProjectSkill(workspaceRoot, "code-review");

    assert.equal(created.created, true);
    assert.equal(created.name, "code-review");
    assert.equal(created.path, path);
    assert.match(template, /description: Code Review workflow guidance./);
    assert.match(template, /tags: workflow/);
    assert.match(template, /# Code Review/);
    assert.equal(existing.created, false);
    assert.equal(existing.reason, "Project skill already exists.");
    assert.equal(await readFile(path, "utf8"), template);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadProjectSkills parses frontmatter and readProjectSkill formats content", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-skills-"));
  const skillsDir = join(workspaceRoot, ".ccagent", "skills");

  try {
    await writeSkill(
      skillsDir,
      "code-review",
      [
        "---",
        "description: Review code for correctness and regressions.",
        "tags: review, safety",
        "---",
        "",
        "# Code Review",
        "",
        "Read the changed files before reporting findings.",
      ].join("\n"),
    );
    await writeSkill(
      skillsDir,
      "windows-shell",
      [
        "---",
        "description: Use PowerShell safely.",
        "tags: windows, shell",
        "---",
        "",
        "# Windows Shell",
      ].join("\r\n"),
    );

    const loaded = await loadProjectSkills(workspaceRoot);
    const result = await readProjectSkill(workspaceRoot, "code-review");

    assert.deepEqual(loaded.skills.map((skill) => skill.name), ["code-review", "windows-shell"]);
    assert.equal(loaded.skills[0]?.description, "Review code for correctness and regressions.");
    assert.deepEqual(loaded.skills[0]?.tags, ["review", "safety"]);
    assert.equal(loaded.skills[0]?.content, "# Code Review\n\nRead the changed files before reporting findings.");
    assert.equal(loaded.skills[1]?.description, "Use PowerShell safely.");
    assert.deepEqual(loaded.skills[1]?.tags, ["windows", "shell"]);
    assert.deepEqual(loaded.warnings, []);
    assert.equal(result.ok, true);

    if (result.ok) {
      const output = formatProjectSkill(result.skill);

      assert.match(output, /Name: code-review/);
      assert.match(output, /Tags: review, safety/);
      assert.match(output, /Read the changed files before reporting findings/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("project skills reject invalid names and report missing files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-skills-"));
  const skillsDir = join(workspaceRoot, ".ccagent", "skills");

  try {
    const invalid = await initProjectSkill(workspaceRoot, "../outside");
    const invalidRead = await readProjectSkill(workspaceRoot, "../outside");
    await mkdir(join(skillsDir, "missing-file"), { recursive: true });
    await mkdir(join(skillsDir, "bad name"), { recursive: true });

    const loaded = await loadProjectSkills(workspaceRoot);
    const missing = await readProjectSkill(workspaceRoot, "missing-file");

    assert.equal(invalid.created, false);
    assert.match(invalid.reason, /letters, numbers, dashes, or underscores/);
    assert.equal(invalidRead.ok, false);
    assert.equal(missing.ok, false);
    assert.match(loaded.warnings.join("\n"), /Ignoring invalid skill directory name: bad name/);
    assert.match(loaded.warnings.join("\n"), /missing-file: SKILL.md is missing or not a file/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadProjectSkills ignores skill files larger than 64 KiB", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-skills-"));
  const skillsDir = join(workspaceRoot, ".ccagent", "skills");

  try {
    await writeSkill(skillsDir, "oversized", "x".repeat(64 * 1024 + 1));

    const loaded = await loadProjectSkills(workspaceRoot);

    assert.equal(loaded.skills.length, 0);
    assert.match(loaded.warnings.join("\n"), /oversized: SKILL.md is too large/);
    assert.match(loaded.warnings.join("\n"), /max 65536/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("project skill tools list and read reusable guidance", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-skills-"));
  const skillsDir = join(workspaceRoot, ".ccagent", "skills");

  try {
    await writeSkill(
      skillsDir,
      "testing",
      "---\ndescription: Run focused tests first.\ntags: test\n---\n\n# Testing\n",
    );

    const listed = await new ListSkillsTool().execute({}, { workspaceRoot });
    const read = await new ReadSkillTool().execute({ name: "testing" }, { workspaceRoot });
    const missingName = await new ReadSkillTool().execute({}, { workspaceRoot });

    assert.equal(listed.ok, true);
    assert.equal(read.ok, true);
    assert.equal(missingName.ok, false);

    if (listed.ok) {
      assert.match(listed.content, /testing: Run focused tests first./);
      assert.equal(listed.metadata?.count, 1);
    }

    if (read.ok) {
      assert.match(read.content, /Name: testing/);
      assert.match(read.content, /# Testing/);
      assert.deepEqual(read.metadata?.tags, ["test"]);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function writeSkill(skillsDir: string, name: string, content: string): Promise<void> {
  const skillDir = join(skillsDir, name);

  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content, "utf8");
}
