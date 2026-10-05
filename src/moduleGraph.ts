import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import { shouldExcludeWorkspaceEntry } from "./tools/listFiles.js";

const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const MODULE_SOURCE_EXTENSIONS = new Set(MODULE_EXTENSIONS.filter((extension) => extension !== ".json"));
const MAX_RESOLVED_MODULE_BYTES = 512 * 1024;

export type LocalModuleReferenceKind = "dynamic import" | "import" | "project reference" | "re-export" | "require" | "side-effect import" | "symbol reference" | "type reference";

export type LocalModuleReference = {
  kind: LocalModuleReferenceKind;
  specifier: string;
  symbols: string[];
};

export type LocalModuleEdge = LocalModuleReference & {
  fromPath: string;
  toPath: string;
};

export type ModuleGraphSourceFile = {
  absolutePath: string;
  content?: string;
  path: string;
};

export async function getModuleResolutionConfigFingerprint(workspaceRoot: string): Promise<string> {
  const root = resolve(workspaceRoot);
  const dependencies = new Map<string, string>();

  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    await loadModuleResolutionConfig(
      resolve(root, fileName),
      root,
      new Set<string>(),
      dependencies,
    );
  }

  if (dependencies.size === 0) {
    return "";
  }

  const hash = createHash("sha256");

  for (const [path, content] of [...dependencies.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    hash.update(normalizeRelativePath(relative(root, path)));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

type ModulePathMapping = {
  pattern: string;
  prefix: string;
  suffix: string;
  targets: string[];
};

type TypeScriptModuleResolution = {
  baseUrl: string;
  hasBaseUrl: boolean;
  mappings: ModulePathMapping[];
};

type WorkspaceModuleResolution = TypeScriptModuleResolution & {
  packages: WorkspacePackage[];
};

type WorkspacePackage = {
  directoryPath: string;
  manifest: Record<string, unknown>;
  name: string;
};

let typescriptReferencesPromise: Promise<typeof import("./typescriptReferences.js")> | undefined;

export async function buildLocalModuleEdges(
  workspaceRoot: string,
  files: ModuleGraphSourceFile[],
): Promise<LocalModuleEdge[]> {
  const knownPaths = new Map(
    files.map((file) => [normalizePathKey(file.path), file.path]),
  );
  const resolutionCache = new Map<string, string | null>();
  const edges = new Map<string, LocalModuleEdge>();
  const moduleResolution = await loadWorkspaceModuleResolution(workspaceRoot, files);

  for (const file of files) {
    if (!file.content) {
      continue;
    }

    const references = MODULE_SOURCE_EXTENSIONS.has(extname(file.path).toLowerCase())
      ? await extractLocalModuleReferences(file.content, file.path)
      : [];
    const projectReferences = isProjectConfigPath(file.path)
      ? extractProjectReferences(file.content)
      : [];

    for (const reference of [...references, ...projectReferences]) {
      const cacheKey = `${dirname(file.absolutePath)}\0${reference.specifier}`;
      let toPath = resolutionCache.get(cacheKey);

      if (toPath === undefined) {
        toPath = reference.kind === "project reference"
          ? await resolveProjectReference(workspaceRoot, file.absolutePath, reference.specifier, knownPaths)
          : await resolveLocalModuleSpecifier(
            workspaceRoot,
            file.absolutePath,
            reference.specifier,
            knownPaths,
            moduleResolution,
          );
        resolutionCache.set(cacheKey, toPath);
      }

      if (!toPath || toPath === file.path) {
        continue;
      }

      const edgeKey = `${file.path}\0${toPath}\0${reference.kind}`;
      const existing = edges.get(edgeKey);

      if (existing) {
        existing.symbols = mergeSymbols(existing.symbols, reference.symbols);
        continue;
      }

      edges.set(edgeKey, {
        ...reference,
        fromPath: file.path,
        toPath,
      });
    }
  }

  return [...edges.values()].sort((left, right) =>
    left.fromPath.localeCompare(right.fromPath)
      || left.toPath.localeCompare(right.toPath)
      || left.kind.localeCompare(right.kind)
  );
}

export async function extractLocalModuleReferences(
  content: string,
  path = "source.ts",
): Promise<LocalModuleReference[]> {
  const parser = await (typescriptReferencesPromise ??= import("./typescriptReferences.js"));
  return parser.extractTypeScriptModuleReferences(content, path);
}

export async function buildTypeScriptSymbolEdges(
  workspaceRoot: string,
  files: ModuleGraphSourceFile[],
  moduleEdges: LocalModuleEdge[],
): Promise<LocalModuleEdge[]> {
  const parser = await (typescriptReferencesPromise ??= import("./typescriptReferences.js"));
  return parser.buildTypeScriptSymbolEdges(workspaceRoot, files, moduleEdges);
}

export function extractProjectReferences(content: string): LocalModuleReference[] {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  const references = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).references
    : undefined;

  if (errors.length > 0 || !Array.isArray(references)) {
    return [];
  }

  return references.flatMap((reference): LocalModuleReference[] => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
      return [];
    }

    const path = (reference as Record<string, unknown>).path;

    return typeof path === "string" && path.trim()
      ? [{ kind: "project reference", specifier: path.trim(), symbols: [] }]
      : [];
  });
}

async function resolveLocalModuleSpecifier(
  workspaceRoot: string,
  importerPath: string,
  rawSpecifier: string,
  knownPaths: Map<string, string>,
  moduleResolution: WorkspaceModuleResolution | null,
): Promise<string | null> {
  const specifier = rawSpecifier.split(/[?#]/, 1)[0];

  if (!specifier || isAbsolute(specifier)) {
    return null;
  }

  const basePaths = specifier.startsWith(".")
    ? [resolve(dirname(importerPath), specifier)]
    : resolveConfiguredModuleBasePaths(specifier, moduleResolution);

  for (const basePath of basePaths) {
    for (const candidatePath of buildResolutionCandidates(basePath)) {
      if (!isAllowedWorkspacePath(workspaceRoot, candidatePath)) {
        continue;
      }

      const relativePath = normalizeRelativePath(relative(workspaceRoot, candidatePath));
      const knownPath = knownPaths.get(normalizePathKey(relativePath));

      if (knownPath) {
        return knownPath;
      }

      try {
        const candidateStat = await stat(candidatePath);

        if (candidateStat.isFile() && candidateStat.size <= MAX_RESOLVED_MODULE_BYTES) {
          return relativePath;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function resolveProjectReference(
  workspaceRoot: string,
  importerPath: string,
  rawSpecifier: string,
  knownPaths: Map<string, string>,
): Promise<string | null> {
  const basePath = resolve(dirname(importerPath), rawSpecifier);
  const candidates = [
    basePath,
    `${basePath}.json`,
    `${basePath}.jsonc`,
    resolve(basePath, "tsconfig.json"),
    resolve(basePath, "jsconfig.json"),
  ];

  for (const candidatePath of candidates) {
    if (!isAllowedWorkspacePath(workspaceRoot, candidatePath)) {
      continue;
    }

    const relativePath = normalizeRelativePath(relative(workspaceRoot, candidatePath));
    const knownPath = knownPaths.get(normalizePathKey(relativePath));

    if (knownPath) {
      return knownPath;
    }

    try {
      const candidateStat = await stat(candidatePath);

      if (candidateStat.isFile()) {
        return relativePath;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function isProjectConfigPath(path: string): boolean {
  const fileName = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return fileName === "tsconfig.json" || fileName === "jsconfig.json";
}

async function loadWorkspacePackages(
  workspaceRoot: string,
  files: ModuleGraphSourceFile[],
): Promise<WorkspacePackage[]> {
  const rootManifestPath = resolve(workspaceRoot, "package.json");
  const rootManifest = await readPackageManifest(rootManifestPath);

  if (!rootManifest) {
    return [];
  }

  const patterns = [
    ...extractPackageWorkspacePatterns(rootManifest.workspaces),
    ...await loadPnpmWorkspacePatterns(workspaceRoot),
  ];
  const manifestPaths = new Set([
    rootManifestPath,
    ...files
      .filter((file) => {
        const path = normalizeRelativePath(file.path).toLowerCase();
        return path === "package.json" || path.endsWith("/package.json");
      })
      .map((file) => file.absolutePath),
  ]);
  const packages = new Map<string, WorkspacePackage>();

  for (const manifestPath of [...manifestPaths].sort((left, right) => left.localeCompare(right))) {
    const directoryPath = dirname(manifestPath);
    const relativeDirectory = normalizeRelativePath(relative(workspaceRoot, directoryPath));

    if (relativeDirectory && !matchesWorkspacePatterns(relativeDirectory, patterns)) {
      continue;
    }

    const manifest = manifestPath === rootManifestPath
      ? rootManifest
      : await readPackageManifest(manifestPath);
    const name = typeof manifest?.name === "string" ? manifest.name.trim() : "";

    if (!manifest || !name || packages.has(name)) {
      continue;
    }

    packages.set(name, {
      directoryPath,
      manifest,
      name,
    });
  }

  return [...packages.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function readPackageManifest(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractPackageWorkspacePatterns(value: unknown): string[] {
  const patterns = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).packages
      : [];

  return Array.isArray(patterns)
    ? patterns.filter((pattern): pattern is string => typeof pattern === "string" && pattern.trim().length > 0)
    : [];
}

async function loadPnpmWorkspacePatterns(workspaceRoot: string): Promise<string[]> {
  for (const fileName of ["pnpm-workspace.yaml", "pnpm-workspace.yml"]) {
    try {
      const parsed = parseYaml(await readFile(resolve(workspaceRoot, fileName), "utf8")) as unknown;

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return [];
      }

      const packages = (parsed as Record<string, unknown>).packages;
      return Array.isArray(packages)
        ? packages.filter((pattern): pattern is string => typeof pattern === "string" && pattern.trim().length > 0)
        : [];
    } catch {
      continue;
    }
  }

  return [];
}

function matchesWorkspacePatterns(relativeDirectory: string, patterns: string[]): boolean {
  const normalizedPatterns = patterns
    .map((pattern) => pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);
  const included = normalizedPatterns
    .filter((pattern) => !pattern.startsWith("!"))
    .some((pattern) => minimatch(relativeDirectory, pattern, { dot: true }));
  const excluded = normalizedPatterns
    .filter((pattern) => pattern.startsWith("!"))
    .some((pattern) => minimatch(relativeDirectory, pattern.slice(1), { dot: true }));

  return included && !excluded;
}

async function loadWorkspaceModuleResolution(
  workspaceRoot: string,
  files: ModuleGraphSourceFile[],
): Promise<WorkspaceModuleResolution | null> {
  const packages = await loadWorkspacePackages(workspaceRoot, files);

  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    const resolution = await loadModuleResolutionConfig(
      resolve(workspaceRoot, fileName),
      workspaceRoot,
      new Set<string>(),
    );

    if (resolution && (resolution.hasBaseUrl || resolution.mappings.length > 0)) {
      return {
        ...resolution,
        packages,
      };
    }
  }

  return packages.length > 0
    ? {
      baseUrl: workspaceRoot,
      hasBaseUrl: false,
      mappings: [],
      packages,
    }
    : null;
}

async function loadModuleResolutionConfig(
  configPath: string,
  workspaceRoot: string,
  loading: Set<string>,
  dependencies?: Map<string, string>,
): Promise<TypeScriptModuleResolution | null> {
  const normalizedConfigPath = normalizePathKey(configPath);

  if (loading.has(normalizedConfigPath)) {
    return null;
  }

  let raw: string;

  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return null;
  }

  dependencies?.set(resolve(configPath), raw);

  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;

  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const source = parsed as Record<string, unknown>;
  const extendedPath = typeof source.extends === "string"
    ? await resolveExtendedConfigPath(configPath, workspaceRoot, source.extends)
    : null;
  const inherited = extendedPath
    ? await loadModuleResolutionConfig(
      extendedPath,
      workspaceRoot,
      new Set([...loading, normalizedConfigPath]),
      dependencies,
    )
    : null;
  const compilerOptions = source.compilerOptions;

  if (!compilerOptions || typeof compilerOptions !== "object" || Array.isArray(compilerOptions)) {
    return inherited;
  }

  const options = compilerOptions as Record<string, unknown>;
  const hasOwnBaseUrl = typeof options.baseUrl === "string" && options.baseUrl.trim().length > 0;
  const hasOwnPaths = Object.prototype.hasOwnProperty.call(options, "paths");
  const baseUrl = hasOwnBaseUrl
    ? resolve(dirname(configPath), String(options.baseUrl))
    : inherited?.baseUrl ?? resolve(dirname(configPath), ".");
  const mappings = hasOwnPaths
    ? parseModulePathMappings(options.paths)
    : inherited?.mappings ?? [];

  return {
    baseUrl,
    hasBaseUrl: hasOwnBaseUrl || Boolean(inherited?.hasBaseUrl),
    mappings,
  };
}

async function resolveExtendedConfigPath(
  configPath: string,
  workspaceRoot: string,
  extendsValue: string,
): Promise<string | null> {
  const normalizedValue = extendsValue.trim();

  if (!normalizedValue) {
    return null;
  }

  if (normalizedValue.startsWith(".")) {
    return findExistingConfigFile(
      getExtendedConfigCandidates(resolve(dirname(configPath), normalizedValue)),
      workspaceRoot,
    );
  }

  return resolvePackageExtendedConfigPath(configPath, workspaceRoot, normalizedValue);
}

async function resolvePackageExtendedConfigPath(
  configPath: string,
  workspaceRoot: string,
  extendsValue: string,
): Promise<string | null> {
  const parsed = parsePackageSpecifier(extendsValue);

  if (!parsed) {
    return null;
  }

  for (const nodeModulesPath of getNodeModulesSearchPaths(dirname(configPath), workspaceRoot)) {
    const packagePath = resolve(nodeModulesPath, parsed.packageName);

    if (!isWithinWorkspaceOrRoot(workspaceRoot, packagePath)) {
      continue;
    }

    const basePaths = parsed.subpath
      ? [resolve(packagePath, parsed.subpath)]
      : await getPackageConfigBasePaths(packagePath);

    for (const basePath of basePaths) {
      const resolvedPath = await findExistingConfigFile(
        getExtendedConfigCandidates(basePath),
        workspaceRoot,
      );

      if (resolvedPath) {
        return resolvedPath;
      }
    }
  }

  return null;
}

async function getPackageConfigBasePaths(packagePath: string): Promise<string[]> {
  const manifest = await readPackageManifest(resolve(packagePath, "package.json"));
  const manifestConfig = manifest && typeof manifest.tsconfig === "string"
    ? manifest.tsconfig.trim()
    : "";
  const basePaths = manifestConfig
    ? [resolve(packagePath, manifestConfig)]
    : [];

  basePaths.push(resolve(packagePath, "tsconfig"));
  return [...new Set(basePaths)];
}

function parsePackageSpecifier(value: string): { packageName: string; subpath: string } | null {
  if (value.includes("\\") || value.startsWith("/") || isAbsolute(value)) {
    return null;
  }

  const segments = value.split("/").filter(Boolean);

  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) {
    return null;
  }

  const packageSegmentCount = segments[0]?.startsWith("@") ? 2 : 1;

  if (segments.length < packageSegmentCount) {
    return null;
  }

  return {
    packageName: segments.slice(0, packageSegmentCount).join("/"),
    subpath: segments.slice(packageSegmentCount).join("/"),
  };
}

function getNodeModulesSearchPaths(startDirectory: string, workspaceRoot: string): string[] {
  const paths: string[] = [];
  let currentDirectory = resolve(startDirectory);

  while (isWithinWorkspaceOrRoot(workspaceRoot, currentDirectory)) {
    paths.push(resolve(currentDirectory, "node_modules"));

    if (normalizePathKey(currentDirectory) === normalizePathKey(workspaceRoot)) {
      break;
    }

    const parentDirectory = dirname(currentDirectory);

    if (normalizePathKey(parentDirectory) === normalizePathKey(currentDirectory)) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  return paths;
}

function getExtendedConfigCandidates(basePath: string): string[] {
  return [
    basePath,
    `${basePath}.json`,
    `${basePath}.jsonc`,
    resolve(basePath, "tsconfig.json"),
  ];
}

async function findExistingConfigFile(
  candidates: string[],
  workspaceRoot: string,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!isWithinWorkspaceOrRoot(workspaceRoot, candidate)) {
      continue;
    }

    try {
      const candidateStat = await stat(candidate);

      if (candidateStat.isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function isWithinWorkspaceOrRoot(workspaceRoot: string, targetPath: string): boolean {
  const relativePath = relative(workspaceRoot, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function parseModulePathMappings(value: unknown): ModulePathMapping[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value as Record<string, unknown>)
    .flatMap(([pattern, rawTargets]): ModulePathMapping[] => {
      const firstStar = pattern.indexOf("*");

      if (firstStar >= 0 && pattern.indexOf("*", firstStar + 1) >= 0) {
        return [];
      }

      if (!Array.isArray(rawTargets)) {
        return [];
      }

      const targets = rawTargets.filter(
        (target): target is string => typeof target === "string" && target.trim().length > 0,
      );

      if (targets.length === 0) {
        return [];
      }

      return [{
        pattern,
        prefix: firstStar < 0 ? pattern : pattern.slice(0, firstStar),
        suffix: firstStar < 0 ? "" : pattern.slice(firstStar + 1),
        targets,
      }];
    })
    .sort((left, right) =>
      Number(!right.pattern.includes("*")) - Number(!left.pattern.includes("*"))
      || right.prefix.length - left.prefix.length
      || right.suffix.length - left.suffix.length
      || left.pattern.localeCompare(right.pattern)
    );
}

function resolveConfiguredModuleBasePaths(
  specifier: string,
  moduleResolution: WorkspaceModuleResolution | null,
): string[] {
  if (!moduleResolution) {
    return [];
  }

  for (const mapping of moduleResolution.mappings) {
    const wildcard = matchModulePathMapping(specifier, mapping);

    if (wildcard === null) {
      continue;
    }

    return mapping.targets.map((target) =>
      resolve(moduleResolution.baseUrl, target.replace("*", wildcard)),
    );
  }

  const packagePaths = resolveWorkspacePackageBasePaths(specifier, moduleResolution.packages);

  if (packagePaths.length > 0) {
    return packagePaths;
  }

  return moduleResolution.hasBaseUrl
    ? [resolve(moduleResolution.baseUrl, specifier)]
    : [];
}

function resolveWorkspacePackageBasePaths(
  specifier: string,
  packages: WorkspacePackage[],
): string[] {
  const parsed = parseWorkspacePackageSpecifier(specifier);

  if (!parsed) {
    return [];
  }

  const workspacePackage = packages.find((candidate) => candidate.name === parsed.packageName);

  if (!workspacePackage) {
    return [];
  }

  const exportKey = parsed.subpath ? `./${parsed.subpath}` : ".";
  const exportedTargets = getPackageExportTargets(workspacePackage.manifest.exports, exportKey);
  const fallbackTargets = parsed.subpath
    ? [parsed.subpath, `src/${parsed.subpath}`]
    : getPackageEntryTargets(workspacePackage.manifest);
  const basePaths = [...exportedTargets, ...fallbackTargets]
    .filter((target) => !target.startsWith("/"))
    .map((target) => resolve(workspacePackage.directoryPath, target));

  return [...new Set(basePaths)];
}

function parseWorkspacePackageSpecifier(specifier: string): {
  packageName: string;
  subpath: string;
} | null {
  const segments = specifier.split("/").filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  const packageSegmentCount = segments[0]?.startsWith("@") ? 2 : 1;

  if (segments.length < packageSegmentCount) {
    return null;
  }

  return {
    packageName: segments.slice(0, packageSegmentCount).join("/"),
    subpath: segments.slice(packageSegmentCount).join("/"),
  };
}

function getPackageEntryTargets(manifest: Record<string, unknown>): string[] {
  return ["source", "types", "module", "main"]
    .flatMap((field) => typeof manifest[field] === "string" ? [manifest[field] as string] : [])
    .concat(["src/index", "index"]);
}

function getPackageExportTargets(exportsValue: unknown, exportKey: string): string[] {
  if (typeof exportsValue === "string" || Array.isArray(exportsValue)) {
    return exportKey === "." ? collectPackageExportStrings(exportsValue) : [];
  }

  if (!exportsValue || typeof exportsValue !== "object") {
    return [];
  }

  const entries = exportsValue as Record<string, unknown>;
  const keys = Object.keys(entries);
  const hasSubpathEntries = keys.some((key) => key.startsWith("."));

  if (!hasSubpathEntries) {
    return exportKey === "." ? collectPackageExportStrings(entries) : [];
  }

  if (entries[exportKey] !== undefined) {
    return collectPackageExportStrings(entries[exportKey]);
  }

  const matches = keys
    .filter((key) => key.includes("*"))
    .flatMap((key) => {
      const firstStar = key.indexOf("*");
      const prefix = key.slice(0, firstStar);
      const suffix = key.slice(firstStar + 1);

      if (!exportKey.startsWith(prefix) || !exportKey.endsWith(suffix)) {
        return [];
      }

      return [{
        key,
        wildcard: exportKey.slice(prefix.length, exportKey.length - suffix.length),
      }];
    })
    .sort((left, right) => right.key.length - left.key.length || left.key.localeCompare(right.key));
  const match = matches[0];

  return match
    ? collectPackageExportStrings(entries[match.key]).map((target) => target.replace("*", match.wildcard))
    : [];
}

function collectPackageExportStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectPackageExportStrings);
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const entries = value as Record<string, unknown>;
  const priority = ["types", "import", "require", "default", "node"];
  const keys = [
    ...priority.filter((key) => entries[key] !== undefined),
    ...Object.keys(entries).filter((key) => !priority.includes(key)).sort(),
  ];

  return keys.flatMap((key) => collectPackageExportStrings(entries[key]));
}

function matchModulePathMapping(specifier: string, mapping: ModulePathMapping): string | null {
  if (!mapping.pattern.includes("*")) {
    return specifier === mapping.pattern ? "" : null;
  }

  if (!specifier.startsWith(mapping.prefix) || !specifier.endsWith(mapping.suffix)) {
    return null;
  }

  const wildcardEnd = specifier.length - mapping.suffix.length;
  return specifier.slice(mapping.prefix.length, wildcardEnd);
}

function buildResolutionCandidates(basePath: string): string[] {
  const extension = extname(basePath).toLowerCase();
  const candidates = [basePath];

  if (extension.length === 0) {
    for (const sourceExtension of MODULE_EXTENSIONS) {
      candidates.push(`${basePath}${sourceExtension}`);
    }

    for (const sourceExtension of MODULE_EXTENSIONS) {
      candidates.push(resolve(basePath, `index${sourceExtension}`));
    }
  } else {
    const stem = basePath.slice(0, -extension.length);
    const mappedExtensions = extension === ".js"
      ? [".ts", ".tsx", ".jsx"]
      : extension === ".mjs"
        ? [".mts"]
        : extension === ".cjs"
          ? [".cts"]
          : extension === ".jsx"
            ? [".tsx"]
            : [];

    for (const mappedExtension of mappedExtensions) {
      candidates.push(`${stem}${mappedExtension}`);
    }
  }

  return [...new Set(candidates)];
}

function mergeSymbols(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])].sort((first, second) => first.localeCompare(second));
}

function isAllowedWorkspacePath(workspaceRoot: string, targetPath: string): boolean {
  const relativePath = relative(workspaceRoot, targetPath);

  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return false;
  }

  let parentPath = workspaceRoot;

  for (const segment of normalizeRelativePath(relativePath).split("/")) {
    if (shouldExcludeWorkspaceEntry(workspaceRoot, parentPath, segment)) {
      return false;
    }

    parentPath = resolve(parentPath, segment);
  }

  return true;
}

function normalizePathKey(path: string): string {
  return normalizeRelativePath(path).toLowerCase();
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}
