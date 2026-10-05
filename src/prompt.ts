import type { LoadedProjectInstructions } from "./instructions.js";
import { buildSystemPrompt } from "./model.js";

export function formatEffectiveSystemPrompt(
  projectInstructions: LoadedProjectInstructions,
): string {
  const systemPrompt = buildSystemPrompt(projectInstructions.content);
  const lines = [
    "Effective system prompt",
    `Project instructions loaded: ${projectInstructions.exists ? "yes" : "no"}`,
    `Project instructions path: ${projectInstructions.path}`,
    `System prompt chars: ${systemPrompt.length}`,
    "",
    "Content:",
    "",
    systemPrompt,
  ];

  return lines.join("\n");
}
