import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCompletionHelp,
  formatHelp,
  formatHelpOverview,
  formatHelpTopic,
  getHelpTopicNames,
} from "../src/help.js";

test("formatHelpOverview is concise and points to topics", () => {
  const overview = formatHelpOverview();

  assert.match(overview, /CCAgent help/);
  assert.match(overview, /\/help <topic>/);
  assert.match(overview, /\/hello/);
  assert.match(overview, /Topics:/);
  assert.match(overview, /workspace\s+Read, list, search/);
  assert.doesNotMatch(overview, /\/audit-export call \[--all\] <callId>/);
});

test("formatHelpTopic returns topic details and full help", () => {
  assert.match(formatHelpTopic("basic"), /\/hello/);
  assert.match(formatHelpTopic("workspace"), /Workspace help/);
  assert.match(formatHelpTopic("files"), /\/read <path>/);
  assert.match(formatHelpTopic("workspace"), /\/suggest-context <query>/);
  assert.match(formatHelpTopic("workspace"), /\/index build/);
  assert.match(formatHelpTopic("workspace"), /\/index semantic build/);
  assert.match(formatHelpTopic("workspace"), /\/symbols search <query>/);
  assert.match(formatHelpTopic("workspace"), /\/verify-suggest \[paths\.\.\.\]/);
  assert.match(formatHelpTopic("workspace"), /\/verify-run \[paths\.\.\.\]/);
  assert.match(formatHelpTopic("workspace"), /\/verify-last/);
  assert.match(formatHelpTopic("workspace"), /\/verify-failure/);
  assert.match(formatHelpTopic("workspace"), /\/verify-rerun/);
  assert.match(formatHelpTopic("workspace"), /\/verify-clear/);
  assert.match(formatHelpTopic("workspace"), /\/repair-last/);
  assert.match(formatHelpTopic("workspace"), /\/repair-preview/);
  assert.match(formatHelpTopic("workspace"), /\/repair-run/);
  assert.match(formatHelpTopic("workspace"), /\/repair-loop \[attempts\]/);
  assert.match(formatHelpTopic("tools"), /workspace_info/);
  assert.match(formatHelpTopic("tools"), /suggest_context/);
  assert.match(formatHelpTopic("tools"), /search_context_index/);
  assert.match(formatHelpTopic("tools"), /search_semantic_index/);
  assert.match(formatHelpTopic("tools"), /suggest_verification/);
  assert.match(formatHelpTopic("tools"), /search_symbols/);
  assert.match(formatHelpTopic("tools"), /list_skills, read_skill/);
  assert.match(formatHelpTopic("skills"), /Project skills help/);
  assert.match(formatHelpTopic("skill"), /--init-skill <name>/);
  assert.match(formatHelpTopic("skills"), /64 KiB/);
  assert.match(formatHelpTopic("code-map"), /Code map help/);
  assert.match(formatHelpTopic("codemap"), /Alias for \/code-map/);
  assert.match(formatHelpTopic("completion"), /Completion help/);
  assert.match(formatHelpTopic("keys"), /Alias for \/completion/);
  assert.equal(formatCompletionHelp(), formatHelpTopic("completion"));
  assert.match(formatHelpTopic("model"), /Model help/);
  assert.match(formatHelpTopic("models"), /Alias for \/model/);
  assert.match(formatHelpTopic("model"), /\/model-smoke/);
  assert.match(formatHelpTopic("model"), /\/providers/);
  assert.match(formatHelpTopic("model"), /\/provider-smoke/);
  assert.match(formatHelpTopic("model"), /\/provider-reports/);
  assert.match(formatHelpTopic("model"), /\/provider-compare/);
  assert.match(formatHelpTopic("model"), /\/provider-gate/);
  assert.match(formatHelpTopic("model"), /--full/);
  assert.match(formatHelpTopic("model"), /OpenAI provider retry/);
  assert.match(formatHelpTopic("model"), /\/diagnostics export/);
  assert.match(formatHelpTopic("mcp"), /MCP help/);
  assert.match(formatHelpTopic("mcp"), /\/mcp tools --json/);
  assert.match(formatHelpTopic("servers"), /Only trusted local commands/);
  assert.match(formatHelpTopic("safety"), /\/snapshots history \[limit\]/);
  assert.match(formatHelpTopic("safety"), /\/snapshots restore <file> <path>/);
  assert.match(formatHelpTopic("roadmap"), /CCAgent roadmap/);
  assert.match(formatHelpTopic("roadmap"), /Current estimate:/);
  assert.match(formatHelpTopic("architecture"), /Architecture help/);
  assert.match(formatHelpTopic("architecture"), /Topics:/);
  assert.match(formatHelpTopic("architecture tools"), /Architecture: tools/);
  assert.match(formatHelpTopic("architecture sources"), /Architecture: source landmarks/);
  assert.match(formatHelpTopic("architecture exercises"), /Architecture: learning exercises/);
  assert.match(formatHelpTopic("architecture"), /CLI -> Agent -> ModelClient -> ToolRegistry -> Tools -> Renderer/);
  assert.match(formatHelpTopic("dev"), /npm run typecheck/);
  assert.match(formatHelpTopic("dev"), /npm run check/);
  assert.match(formatHelpTopic("dev"), /npm run check:full/);
  assert.match(formatHelpTopic("dev"), /npm run release:check/);
  assert.match(formatHelpTopic("dev"), /\/evals cases/);
  assert.match(formatHelpTopic("dev"), /\/evals tags/);
  assert.match(formatHelpTopic("dev"), /--tag <tag>/);
  assert.match(formatHelpTopic("dev"), /--iterations <1-20>/);
  assert.match(formatHelpTopic("dev"), /\/evals report/);
  assert.match(formatHelpTopic("dev"), /\/evals reports/);
  assert.match(formatHelpTopic("dev"), /\/evals compare/);
  assert.match(formatHelpTopic("dev"), /\/evals gate/);
  assert.match(formatHelpTopic("dev"), /--max-duration-delta <ms>/);
  assert.match(formatHelpTopic("dev"), /npm run evals:gate/);
  assert.match(formatHelpTopic("dev"), /npm run provider:smoke/);
  assert.match(formatHelpTopic("dev"), /npm run provider:report/);
  assert.match(formatHelpTopic("dev"), /npm run provider:compare/);
  assert.match(formatHelpTopic("dev"), /npm run provider:gate/);
  assert.match(formatHelpTopic("all"), /\/hello/);
  assert.match(formatHelpTopic("all"), /Natural language examples:/);
  assert.equal(formatHelpTopic("all"), formatHelp());
});

test("formatHelpTopic reports unknown topics with the overview", () => {
  const output = formatHelpTopic("missing-topic");

  assert.match(output, /Unknown help topic: missing-topic/);
  assert.match(output, /Topics:/);
});

test("getHelpTopicNames exposes sorted completion names", () => {
  const topics = getHelpTopicNames();

  assert.deepEqual([...topics].sort((left, right) => left.localeCompare(right)), topics);
  assert.ok(topics.includes("all"));
  assert.ok(topics.includes("code-map"));
  assert.ok(topics.includes("completion"));
  assert.ok(topics.includes("model"));
  assert.ok(topics.includes("mcp"));
  assert.ok(topics.includes("roadmap"));
  assert.ok(topics.includes("skills"));
  assert.ok(topics.includes("workspace"));
});
