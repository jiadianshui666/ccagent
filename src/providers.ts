import type { OpenAIApiMode } from "./model.js";
import { PROVIDER_PROFILE_IDS, PROVIDER_PROFILES } from "./providerProfiles.js";

export type ProviderCompatibilityRuntime = {
  apiMode: OpenAIApiMode;
  apiModeSource: string;
  baseURL: string;
  baseURLSource: string;
  hasApiKey: boolean;
};

export type ProviderCompatibilityEntry = {
  id: string;
  name: string;
  baseURL: string;
  recommendedApiMode: OpenAIApiMode;
  expectedSupport: string;
  setup: string[];
  notes: string[];
};

export type ProviderSmokeDiagnosticProbe = {
  name: string;
  ok: boolean;
  stream?: boolean;
  summary: string;
  tool?: boolean;
};

export type ProviderSmokeDiagnosticInput = ProviderCompatibilityRuntime & {
  failed: number;
  model?: string;
  passed: number;
  profile: string;
  probes: ProviderSmokeDiagnosticProbe[];
};

export type ProviderSmokeCapabilityStatus = "fail" | "not-run" | "pass";

export type ProviderSmokeCapability = {
  name: string;
  status: ProviderSmokeCapabilityStatus;
  summary: string;
};

export type ProviderSmokeCompatibilityProfile = {
  capabilities: ProviderSmokeCapability[];
  reuseCommands: string[];
  status: "failed" | "known-good" | "mock-only" | "partial";
  summary: string;
};

export type ProviderSmokeDiagnosis = {
  actions: string[];
  notes: string[];
  status: "failing" | "needs-real-run" | "ready";
  warnings: string[];
};

export const PROVIDER_COMPATIBILITY_ENTRIES: readonly ProviderCompatibilityEntry[] = [
  {
    id: "openai-official",
    name: "OpenAI official endpoint",
    baseURL: "default https://api.openai.com/v1",
    recommendedApiMode: "responses",
    expectedSupport: "text, streaming, tool calls, and Responses conversation continuity",
    setup: [
      "ccagent --config-unset openai.baseURL",
      "ccagent --config-set openai.apiMode responses",
    ],
    notes: [
      "Best default when using the official endpoint.",
      "Use /provider-smoke after changing model IDs or API keys.",
    ],
  },
  {
    id: "generic-chat-relay",
    name: "Generic OpenAI-compatible relay",
    baseURL: "relay /v1 endpoint",
    recommendedApiMode: "chat",
    expectedSupport: "text, streaming if forwarded, and tool calls if the relay supports function tools",
    setup: [
      "ccagent --config-set openai.baseURL https://your-relay.example/v1",
      "ccagent --config-set openai.apiMode chat",
    ],
    notes: [
      "Safest first choice for many relay providers.",
      "Use this when /v1/responses is missing or previous_response_id errors appear.",
    ],
  },
  {
    id: "responses-compatible-relay",
    name: "Responses-compatible relay",
    baseURL: "relay /v1 endpoint with /responses support",
    recommendedApiMode: "responses",
    expectedSupport: "text, streaming, tool calls, and previous_response_id handling",
    setup: [
      "ccagent --config-set openai.baseURL https://your-relay.example/v1",
      "ccagent --config-set openai.apiMode responses",
    ],
    notes: [
      "Use only after /provider-smoke or provider docs confirm Responses API support.",
      "Switch back to chat if Responses-specific errors appear.",
    ],
  },
  {
    id: "local-openai-compatible",
    name: "Local OpenAI-compatible server",
    baseURL: "http://localhost:<port>/v1",
    recommendedApiMode: "chat",
    expectedSupport: "plain text; streaming and tool calls depend on the local server",
    setup: [
      "ccagent --config-set openai.baseURL http://localhost:8000/v1",
      "ccagent --config-set openai.apiMode chat",
    ],
    notes: [
      "Model names and tool support vary by local server.",
      "Run /model-smoke first, then /provider-smoke when tools are expected.",
    ],
  },
] as const;

export function formatProviderCompatibilityMatrix(runtime: ProviderCompatibilityRuntime): string {
  const profile = detectActiveProviderProfile(runtime);

  return [
    "Provider compatibility matrix",
    "",
    "Active runtime:",
    `- API mode: ${runtime.apiMode} (source: ${runtime.apiModeSource})`,
    `- Base URL: ${runtime.baseURL} (source: ${runtime.baseURLSource})`,
    `- API key: ${runtime.hasApiKey ? "set" : "not set"}`,
    `- Detected profile: ${profile.label}`,
    "",
    "Active recommendation:",
    `- ${profile.recommendation}`,
    "- Next check: ccagent --no-session /provider-smoke",
    "",
    "Profiles:",
    ...PROVIDER_COMPATIBILITY_ENTRIES.flatMap(formatProviderCompatibilityEntry),
    "",
    "Built-in provider profiles (ccagent --provider <id>):",
    ...PROVIDER_PROFILE_IDS.flatMap((profileId) => {
      const profile = PROVIDER_PROFILES[profileId];
      return [`- ${profile.id}: ${profile.name} (${profile.baseURL}, model ${profile.model})`];
    }),
  ].join("\n");
}

export function diagnoseProviderSmoke(input: ProviderSmokeDiagnosticInput): ProviderSmokeDiagnosis {
  const warnings: string[] = [];
  const actions: string[] = [];
  const notes: string[] = [];
  const failedProbes = input.probes.filter((probe) => !probe.ok);
  const normalizedBaseURL = normalizeBaseURL(input.baseURL);
  const isOfficialEndpoint = normalizedBaseURL === "https://api.openai.com/v1";

  if (!input.hasApiKey) {
    warnings.push("API key is not set; mock results do not prove real provider compatibility.");
    actions.push('Set OPENAI_API_KEY or run "ccagent login --api-key <key>", then rerun ccagent --no-session /provider-smoke --full --save.');
  }

  if (!isOfficialEndpoint && input.apiMode === "responses") {
    warnings.push("Responses mode on custom relays requires /v1/responses and previous_response_id support.");
    actions.push("If the relay rejects Responses or previous_response_id, run ccagent --config-set openai.apiMode chat.");
  }

  if (input.profile === "quick") {
    notes.push("Quick profile skips unicode and streaming tool-call probes.");
    actions.push("Run ccagent --no-session /provider-smoke --full to check unicode and streaming tool calls.");
  }

  for (const probe of failedProbes) {
    if (probe.name === "text") {
      actions.push("Fix model, key, base URL, or API mode first; text must pass before streaming or tools matter.");
    } else if (probe.name === "unicode") {
      actions.push("Check relay UTF-8 handling if unicode fails while plain text passes.");
    } else if (probe.name === "streaming") {
      actions.push("Check whether the relay forwards SSE streaming; otherwise keep streaming disabled or use another relay.");
    } else if (probe.name === "tool-call") {
      actions.push("Use a model and relay that support function/tool calls; coding agents need this for workspace tools.");
    } else if (probe.name === "streaming-tool-call") {
      actions.push("If non-streaming tools pass, use non-streaming tool workflows until the relay streams tool deltas correctly.");
    } else if (probe.name === "tool-followup") {
      actions.push("Relay or model broke after tool results were submitted; confirm multi-turn tool continuity, then run /provider-repair for deeper checks.");
    } else if (probe.tool) {
      actions.push("Check tool/function-call support for the selected model and relay.");
    } else if (probe.stream) {
      actions.push("Check streaming support for the selected model and relay.");
    }
  }

  if (failedProbes.length > 0) {
    warnings.push(`Failed probes: ${failedProbes.map((probe) => probe.name).join(", ")}.`);
  } else if (input.hasApiKey) {
    notes.push("All selected provider probes passed for this runtime.");
    actions.push("Save two full reports around provider changes, then run ccagent --no-session /provider-gate.");
  } else {
    notes.push("Mock probes passed; run the same smoke test with a real API key before trusting the provider.");
  }

  return {
    actions: uniqueLines(actions),
    notes: uniqueLines(notes),
    status: failedProbes.length > 0 ? "failing" : input.hasApiKey ? "ready" : "needs-real-run",
    warnings: uniqueLines(warnings),
  };
}

export function buildProviderSmokeCompatibilityProfile(
  input: ProviderSmokeDiagnosticInput,
): ProviderSmokeCompatibilityProfile {
  const capabilities = buildProviderSmokeCapabilities(input.probes);
  const status = determineProviderSmokeCompatibilityStatus(input);
  const model = input.model?.trim();

  return {
    capabilities,
    reuseCommands: [
      normalizeBaseURL(input.baseURL) === "https://api.openai.com/v1"
        ? "ccagent --config-unset openai.baseURL"
        : `ccagent --config-set openai.baseURL ${input.baseURL}`,
      `ccagent --config-set openai.apiMode ${input.apiMode}`,
      ...(model ? [`ccagent --config-set model ${model}`] : []),
    ],
    status,
    summary: formatProviderSmokeCompatibilitySummary(input, status),
  };
}

export function formatProviderSmokeCompatibilityProfile(
  profile: ProviderSmokeCompatibilityProfile,
): string[] {
  return [
    "Compatibility profile",
    `Status: ${profile.status}`,
    `Summary: ${profile.summary}`,
    "Capabilities:",
    ...profile.capabilities.map((capability) => (
      `- ${capability.name}: ${capability.status} - ${capability.summary}`
    )),
    "Reuse commands:",
    ...profile.reuseCommands.map((command) => `- ${command}`),
  ];
}

export function formatProviderSmokeDiagnosis(diagnosis: ProviderSmokeDiagnosis): string[] {
  const lines = [
    "Provider diagnosis",
    `Status: ${diagnosis.status}`,
  ];

  if (diagnosis.warnings.length > 0) {
    lines.push("Warnings:");
    lines.push(...diagnosis.warnings.map((warning) => `- ${warning}`));
  }

  if (diagnosis.actions.length > 0) {
    lines.push("Recommended actions:");
    lines.push(...diagnosis.actions.map((action) => `- ${action}`));
  }

  if (diagnosis.notes.length > 0) {
    lines.push("Notes:");
    lines.push(...diagnosis.notes.map((note) => `- ${note}`));
  }

  return lines;
}

function formatProviderCompatibilityEntry(entry: ProviderCompatibilityEntry): string[] {
  return [
    `- ${entry.id}: ${entry.name}`,
    `  base URL: ${entry.baseURL}`,
    `  recommended API mode: ${entry.recommendedApiMode}`,
    `  expected support: ${entry.expectedSupport}`,
    "  setup:",
    ...entry.setup.map((command) => `    ${command}`),
    "  notes:",
    ...entry.notes.map((note) => `    ${note}`),
  ];
}

function detectActiveProviderProfile(runtime: ProviderCompatibilityRuntime): {
  label: string;
  recommendation: string;
} {
  const normalizedBaseURL = normalizeBaseURL(runtime.baseURL);

  if (normalizedBaseURL === "https://api.openai.com/v1") {
    return {
      label: "OpenAI official endpoint",
      recommendation: runtime.apiMode === "responses"
        ? "responses mode is the best default for the official endpoint."
        : "chat mode can work, but responses mode gives better conversation continuity on the official endpoint.",
    };
  }

  if (normalizedBaseURL.startsWith("http://localhost:") || normalizedBaseURL.startsWith("http://127.0.0.1:")) {
    return {
      label: "Local OpenAI-compatible server",
      recommendation: "chat mode is the safest default; verify streaming and tool support with /provider-smoke.",
    };
  }

  if (runtime.apiMode === "chat") {
    return {
      label: "Custom Chat Completions relay",
      recommendation: "chat mode is the safest relay default; run /provider-smoke to confirm text, streaming, and tool calls.",
    };
  }

  return {
    label: "Custom Responses-compatible relay",
    recommendation: "responses mode requires /v1/responses and previous_response_id support; switch to chat if relay errors mention Responses or previous_response_id.",
  };
}

function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "").toLowerCase();
}

function uniqueLines(lines: string[]): string[] {
  return [...new Set(lines)];
}

function buildProviderSmokeCapabilities(probes: ProviderSmokeDiagnosticProbe[]): ProviderSmokeCapability[] {
  const probeMap = new Map(probes.map((probe) => [probe.name, probe]));

  return [
    "text",
    "unicode",
    "streaming",
    "tool-call",
    "streaming-tool-call",
    "tool-followup",
  ].map((name) => {
    const probe = probeMap.get(name);

    if (!probe) {
      return {
        name,
        status: "not-run",
        summary: "not run by selected smoke profile",
      };
    }

    return {
      name,
      status: probe.ok ? "pass" : "fail",
      summary: probe.summary,
    };
  });
}

function determineProviderSmokeCompatibilityStatus(
  input: ProviderSmokeDiagnosticInput,
): ProviderSmokeCompatibilityProfile["status"] {
  if (!input.hasApiKey) {
    return "mock-only";
  }

  if (input.failed > 0) {
    return "failed";
  }

  return input.profile === "full" ? "known-good" : "partial";
}

function formatProviderSmokeCompatibilitySummary(
  input: ProviderSmokeDiagnosticInput,
  status: ProviderSmokeCompatibilityProfile["status"],
): string {
  if (status === "mock-only") {
    return 'Mock-only run; set OPENAI_API_KEY or run "ccagent login --api-key <key>" and rerun before marking this provider known-good.';
  }

  if (status === "failed") {
    return `Real provider failed ${input.failed} probe(s); fix failures before saving this as known-good.`;
  }

  if (status === "partial") {
    return "Real provider passed selected probes, but full profile is required before known-good.";
  }

  return "Real provider passed the full compatibility profile.";
}
