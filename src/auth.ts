import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ApiKeySource = "env" | "auth-file" | "none";

export type ApiKeyStatus = {
  set: boolean;
  source: ApiKeySource;
  authPath: string;
};

export type LoginResult = {
  action: "stored" | "updated";
  authPath: string;
};

export type LogoutResult = {
  removed: boolean;
  authPath: string;
};

export function getUserCCAgentDir(): string {
  const override = process.env.CCAGENT_USER_DIR?.trim();

  if (override) {
    return override;
  }

  return join(homedir(), ".ccagent");
}

export function getAuthFilePath(): string {
  return join(getUserCCAgentDir(), "auth.json");
}

export async function loadApiKeyStatus(): Promise<ApiKeyStatus> {
  const authPath = getAuthFilePath();

  if ((process.env.OPENAI_API_KEY ?? "").trim().length > 0) {
    return {
      set: true,
      source: "env",
      authPath,
    };
  }

  const storedApiKey = await loadStoredApiKey();

  return {
    set: storedApiKey !== undefined,
    source: storedApiKey !== undefined ? "auth-file" : "none",
    authPath,
  };
}

export async function loadStoredApiKey(): Promise<string | undefined> {
  try {
    const raw = await readFile(getAuthFilePath(), "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const apiKey = (parsed as Record<string, unknown>).apiKey;

    return typeof apiKey === "string" && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function storeApiKey(apiKey: string): Promise<LoginResult> {
  const trimmed = apiKey.trim();

  if (!trimmed) {
    throw new Error("API key must be a non-empty string.");
  }

  const authPath = getAuthFilePath();
  const existed = (await loadStoredApiKey()) !== undefined;
  const payload = {
    apiKey: trimmed,
    updatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    action: existed ? "updated" : "stored",
    authPath,
  };
}

export async function clearStoredApiKey(): Promise<LogoutResult> {
  const authPath = getAuthFilePath();
  const removed = (await loadStoredApiKey()) !== undefined;

  await rm(authPath, { force: true });

  return {
    removed,
    authPath,
  };
}
