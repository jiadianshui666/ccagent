import {
  formatProjectSkill,
  formatProjectSkills,
  loadProjectSkills,
  readProjectSkill,
} from "../skills.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export class ListSkillsTool implements Tool {
  readonly name = "list_skills";
  readonly description = "List reusable project skills so you can choose relevant workflow guidance.";
  readonly parameters = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  } as const;

  async execute(_input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const loaded = await loadProjectSkills(context.workspaceRoot);

    return {
      ok: true,
      content: formatProjectSkills(loaded),
      metadata: {
        count: loaded.skills.length,
        path: loaded.path,
        warnings: loaded.warnings.length,
      },
    };
  }
}

export class ReadSkillTool implements Tool {
  readonly name = "read_skill";
  readonly description = "Read one reusable project skill after identifying it with list_skills.";
  readonly parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name from list_skills.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.name !== "string" || !input.name.trim()) {
      return {
        ok: false,
        error: "Expected input.name to be a non-empty skill name.",
      };
    }

    const result = await readProjectSkill(context.workspaceRoot, input.name);

    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
      };
    }

    return {
      ok: true,
      content: formatProjectSkill(result.skill),
      metadata: {
        name: result.skill.name,
        path: result.skill.path,
        tags: result.skill.tags ?? [],
      },
    };
  }
}
