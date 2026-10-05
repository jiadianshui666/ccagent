import { isAbsolute, relative, resolve } from "node:path";

export type WritePathPolicy = {
  allowWritePaths?: string[];
  denyWritePaths?: string[];
};

export type WritePathPolicyEvaluation =
  | {
      ok: true;
      paths: string[];
    }
  | {
      ok: false;
      path?: string;
      paths: string[];
      reason: string;
      rule?: string;
    };

export function evaluateWritePathPolicy(
  patch: string,
  policy: WritePathPolicy,
): WritePathPolicyEvaluation {
  const paths = extractPatchPaths(patch);

  return evaluateWritePathsPolicy(paths, policy, {
    missingPathReason: "Patch does not declare any writable paths, but toolPolicy.allowWritePaths is set.",
  });
}

export function evaluateWritePathsPolicy(
  paths: string[],
  policy: WritePathPolicy,
  options: { missingPathReason?: string } = {},
): WritePathPolicyEvaluation {
  const denyRules = normalizeWritePathRules(policy.denyWritePaths ?? []);
  const allowRules = normalizeWritePathRules(policy.allowWritePaths ?? []);

  for (const path of paths) {
    const rule = denyRules.find((candidate) => matchesWritePathRule(path, candidate));

    if (rule) {
      return {
        ok: false,
        path,
        paths,
        reason: `Write path is denied by policy: ${path} matches ${rule}.`,
        rule,
      };
    }
  }

  if (allowRules.length > 0) {
    if (paths.length === 0) {
      return {
        ok: false,
        paths,
        reason: options.missingPathReason ?? "No writable paths were declared, but toolPolicy.allowWritePaths is set.",
      };
    }

    const disallowedPath = paths.find(
      (path) => !allowRules.some((rule) => matchesWritePathRule(path, rule)),
    );

    if (disallowedPath) {
      return {
        ok: false,
        path: disallowedPath,
        paths,
        reason: `Write path is not allowed by policy: ${disallowedPath}. Allowed paths: ${allowRules.join(", ")}.`,
      };
    }
  }

  return {
    ok: true,
    paths,
  };
}

export function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(/\s+/);
      addPatchPath(paths, parts[2]);
      addPatchPath(paths, parts[3]);
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const value = line.slice(4).trim().split(/\s+/)[0];
      addPatchPath(paths, value);
    }
  }

  return [...paths];
}

export function isSafeWorkspacePath(workspaceRoot: string, patchPath: string): boolean {
  if (patchPath.includes("\0") || patchPath.length === 0) {
    return false;
  }

  if (isAbsolute(patchPath) || /^[A-Za-z]:/.test(patchPath)) {
    return false;
  }

  const resolvedPath = resolve(workspaceRoot, patchPath);
  const relativePath = relative(workspaceRoot, resolvedPath);

  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function matchesWritePathRule(path: string, rule: string): boolean {
  const normalizedPath = normalizeWritePath(path);
  const normalizedRule = normalizeWritePath(rule);

  if (normalizedPath.length === 0 || normalizedRule.length === 0) {
    return false;
  }

  if (normalizedRule.endsWith("/")) {
    return normalizedPath.startsWith(normalizedRule);
  }

  return normalizedPath === normalizedRule;
}

function addPatchPath(paths: Set<string>, rawPath: string | undefined): void {
  if (!rawPath || rawPath === "/dev/null") {
    return;
  }

  const path = normalizePatchPath(rawPath);

  if (path.length > 0) {
    paths.add(path);
  }
}

function normalizePatchPath(rawPath: string): string {
  let path = rawPath.replaceAll("\\", "/");

  if (path.startsWith("a/") || path.startsWith("b/")) {
    path = path.slice(2);
  }

  return normalizeWritePath(path);
}

function normalizeWritePathRules(rules: string[]): string[] {
  return rules.map(normalizeWritePath).filter(Boolean);
}

function normalizeWritePath(value: string): string {
  let path = value.trim().replaceAll("\\", "/").replace(/\/+/g, "/");

  while (path.startsWith("./")) {
    path = path.slice(2);
  }

  return path;
}
