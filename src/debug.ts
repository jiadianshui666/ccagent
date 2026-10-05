import { redactSecrets } from "./secrets.js";

export type DebugLogger = (event: string, data?: Record<string, unknown>) => void;

export function createDebugLogger(
  enabled: boolean,
  writeLine: (line: string) => void,
): DebugLogger {
  return (event, data) => {
    if (!enabled) {
      return;
    }

    const suffix = data ? ` ${formatDebugData(data)}` : "";
    writeLine(`[debug] ${event}${suffix}`);
  };
}

export function isDebugEnvEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export const noopDebugLogger: DebugLogger = () => {};

function formatDebugData(data: Record<string, unknown>): string {
  try {
    return redactSecrets(JSON.stringify(data, (_key, value: unknown) => {
      if (typeof value === "string" && value.length > 240) {
        return `${value.slice(0, 240)}...[truncated]`;
      }

      return value;
    }));
  } catch {
    return JSON.stringify({ error: "Failed to serialize debug data." });
  }
}
