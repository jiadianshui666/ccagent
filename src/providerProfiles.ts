import { setUserConfigValue, type UserConfigSetResult } from "./config.js";
import type { OpenAIApiMode } from "./model.js";

export const PROVIDER_PROFILE_IDS = [
  "deepseek",
  "groq",
  "minimax",
  "mistral",
  "moonshot",
  "openrouter",
  "qwen",
  "siliconflow",
  "volcengine",
  "xai",
  "zhipu",
] as const;

export type ProviderProfileId = (typeof PROVIDER_PROFILE_IDS)[number];

export type ProviderProfile = {
  id: ProviderProfileId;
  name: string;
  baseURL: string;
  apiMode: OpenAIApiMode;
  model: string;
  notes: string[];
};

export type ProviderProfileApplication = {
  profile: ProviderProfile;
  results: UserConfigSetResult[];
};

export const PROVIDER_PROFILES: Record<ProviderProfileId, ProviderProfile> = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiMode: "chat",
    model: "deepseek-chat",
    notes: [
      "OpenAI-compatible chat API with tool calling.",
      "For the reasoning model, set model to deepseek-reasoner.",
    ],
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot AI (Kimi)",
    baseURL: "https://api.moonshot.cn/v1",
    apiMode: "chat",
    model: "kimi-k2-turbo",
    notes: [
      "OpenAI-compatible chat API maintained by Moonshot AI.",
      "Other supported model IDs can be set with model.",
    ],
  },
  zhipu: {
    id: "zhipu",
    name: "Zhipu AI (GLM)",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    apiMode: "chat",
    model: "glm-4.5",
    notes: [
      "OpenAI-compatible endpoint with Bearer authentication.",
      "Model IDs are often versioned; update model when the platform releases new GLM models.",
    ],
  },
  qwen: {
    id: "qwen",
    name: "Alibaba Cloud Model Studio (Qwen)",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiMode: "chat",
    model: "qwen-plus",
    notes: [
      "DashScope OpenAI compatibility mode.",
      "qwen-max offers higher capability at higher cost.",
    ],
  },
  groq: {
    id: "groq",
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiMode: "chat",
    model: "llama-3.3-70b-versatile",
    notes: [
      "Fast OpenAI-compatible inference for hosted open models.",
      "Newer Llama 4 class models replace older IDs over time; update model when Groq rotates its catalog.",
    ],
  },
  minimax: {
    id: "minimax",
    name: "MiniMax",
    baseURL: "https://api.minimaxi.com/v1",
    apiMode: "chat",
    model: "MiniMax-M3",
    notes: [
      "OpenAI-compatible endpoint on the MiniMax international platform.",
      "Model IDs are case-sensitive; update model when MiniMax ships a newer release.",
    ],
  },
  mistral: {
    id: "mistral",
    name: "Mistral AI",
    baseURL: "https://api.mistral.ai/v1",
    apiMode: "chat",
    model: "mistral-large-latest",
    notes: [
      "OpenAI-compatible chat endpoint with tool calling.",
      "Date-tagged model IDs exist alongside the latest alias; update model when Mistral moves the alias.",
    ],
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiMode: "chat",
    model: "openrouter/auto",
    notes: [
      "One key routes to many hosted models using provider/model slugs.",
      "openrouter/auto picks a model automatically; pin any slug from the OpenRouter model list instead.",
    ],
  },
  siliconflow: {
    id: "siliconflow",
    name: "SiliconFlow",
    baseURL: "https://api.siliconflow.cn/v1",
    apiMode: "chat",
    model: "deepseek-ai/DeepSeek-V3",
    notes: [
      "OpenAI-compatible endpoint for hosted open models.",
      "Model IDs use the full provider/model slug from the SiliconFlow catalog; update model when the catalog rotates.",
    ],
  },
  volcengine: {
    id: "volcengine",
    name: "Volcengine Ark (Doubao)",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    apiMode: "chat",
    model: "doubao-seed-2-1-pro-260915",
    notes: [
      "Doubao model IDs are date-versioned; update model as Volcengine releases newer versions.",
      "Deployment endpoint IDs (ep-...) also work after wiring the endpoint to the base URL.",
    ],
  },
  xai: {
    id: "xai",
    name: "xAI (Grok)",
    baseURL: "https://api.x.ai/v1",
    apiMode: "chat",
    model: "grok-4",
    notes: [
      "OpenAI-compatible endpoint for Grok models.",
      "Faster and newer variants ship under IDs like grok-4-fast; update model when xAI releases new versions.",
    ],
  },
};

export function isProviderProfileId(value: string): value is ProviderProfileId {
  return (PROVIDER_PROFILE_IDS as readonly string[]).includes(value);
}

export async function applyProviderProfile(
  id: ProviderProfileId,
): Promise<ProviderProfileApplication> {
  const profile = PROVIDER_PROFILES[id];
  const results: UserConfigSetResult[] = [];

  for (const [key, value] of [
    ["model", profile.model],
    ["openai.apiMode", profile.apiMode],
    ["openai.baseURL", profile.baseURL],
  ] as const) {
    results.push(await setUserConfigValue(key, value));
  }

  return { profile, results };
}

export function formatProviderProfileApplication(
  application: ProviderProfileApplication,
): string {
  const { profile, results } = application;
  const configPath = results[0]?.path ?? "(user config)";

  return [
    `Provider profile applied: ${profile.name} (${profile.id})`,
    `User config written: ${configPath}`,
    "",
    `model: ${profile.model}`,
    `openai.apiMode: ${profile.apiMode}`,
    `openai.baseURL: ${profile.baseURL}`,
    "",
    "Provider API keys are supplied through the normal CCAgent key flow:",
    "  ccagent login --api-key <key>",
    "  # or",
    "  $env:OPENAI_API_KEY = \"<key>\"   (PowerShell)",
    "",
    "Validate the setup with: ccagent --doctor",
    "",
    ...profile.notes.map((note) => `Note: ${note}`),
  ].join("\n");
}

export function formatProviderProfileError(id: string): string {
  return [
    `Unknown provider profile "${id}".`,
    `Available profiles: ${PROVIDER_PROFILE_IDS.join(", ")}.`,
    "Usage: ccagent --provider <id>",
  ].join("\n");
}
