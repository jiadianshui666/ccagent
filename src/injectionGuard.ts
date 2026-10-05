export type ExecutionGuardLevel = "off" | "warn" | "deny";

export type ExecutionGuardRule = {
  id: string;
  pattern: RegExp;
  reason: string;
};

export type ExecutionGuardScan = {
  flagged: boolean;
  rules: ExecutionGuardRule[];
};

export const EXECUTION_GUARD_LEVELS: readonly ExecutionGuardLevel[] = ["off", "warn", "deny"];

export const EXECUTION_GUARD_RULES: readonly ExecutionGuardRule[] = [
  {
    id: "remote-pipe-to-shell",
    pattern: /\b(curl|wget)\b[\s\S]{0,300}\|\s*(ba)?sh\b/i,
    reason: "remote content is piped into a shell, a common injection and exfiltration pattern",
  },
  {
    id: "destructive-system-paths",
    pattern: /\brm\s+(-[^\s]*\s*)*-(r\s*f|f\s*r|rf|fr)\b[^\n]*\s(\/|\/etc|\/usr|\/boot|\$HOME|~)/i,
    reason: "recursive removal targets system or home directories",
  },
  {
    id: "authorized-keys-write",
    pattern:
      /\b(authorized_keys|known_hosts)\b[\s\S]{0,80}(>>|tee\s+-a)|(>>|tee\s+-a)[\s\S]{0,80}\b(authorized_keys|known_hosts)\b/i,
    reason: "SSH trust files are being modified",
  },
  {
    id: "fork-bomb",
    pattern: /:\(\)\s*\{[^}]*:\|[^}]*&\s*\}[^;]*;\s*:/,
    reason: "shell fork bomb",
  },
  {
    id: "shell-history-clear",
    pattern: /(\bhistory\s+-c\b|>\s*(~\/\.(bash_history|zsh_history)|\$HISTFILE))/i,
    reason: "shell history is being cleared or redirected away",
  },
];

export const DEFAULT_EXECUTION_GUARD_LEVEL: ExecutionGuardLevel = "deny";

export function scanShellCommand(command: string): ExecutionGuardScan {
  const normalized = command.replace(/\s+/g, " ");
  const rules = EXECUTION_GUARD_RULES.filter((rule) => {
    rule.pattern.lastIndex = 0;

    return rule.pattern.test(normalized);
  });

  return {
    flagged: rules.length > 0,
    rules,
  };
}

export function formatExecutionGuardDenial(rules: ExecutionGuardRule[]): string {
  const lines = rules.map((rule) => `- [${rule.id}] ${rule.reason}`);

  return [
    "Shell command blocked by the execution guard because it matches suspicious patterns:",
    ...lines,
    'Override per-project with toolPolicy.executionGuard ("off" | "warn" | "deny").',
  ].join("\n");
}

export function isExecutionGuardLevel(value: string): value is ExecutionGuardLevel {
  return (EXECUTION_GUARD_LEVELS as readonly string[]).includes(value);
}
