import { dirname, extname, resolve } from "node:path";
import ts from "typescript";
import type {
  LocalModuleEdge,
  LocalModuleReference,
  LocalModuleReferenceKind,
  ModuleGraphSourceFile,
} from "./moduleGraph.js";

const TYPECHECKER_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_TYPECHECKER_FILES = 500;
const MAX_TYPECHECKER_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_TYPECHECKER_EDGES = 2_000;
const MAX_SYMBOLS_PER_EDGE = 30;

export function extractTypeScriptModuleReferences(
  content: string,
  path = "source.ts",
): LocalModuleReference[] {
  const references = new Map<string, LocalModuleReference>();
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(path),
  );

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = getStaticModuleSpecifier(node.moduleSpecifier);

      if (specifier) {
        addLocalModuleReference(
          references,
          node.importClause ? "import" : "side-effect import",
          specifier,
          extractImportClauseSymbols(node.importClause),
        );
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = getStaticModuleSpecifier(node.moduleSpecifier);

      if (specifier) {
        addLocalModuleReference(
          references,
          "re-export",
          specifier,
          extractExportClauseSymbols(node.exportClause),
        );
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = getStaticModuleSpecifier(node.moduleReference.expression);

      if (specifier) {
        addLocalModuleReference(references, "require", specifier, [node.name.text]);
      }
    } else if (ts.isCallExpression(node)) {
      const specifier = getStaticModuleSpecifier(node.arguments[0]);

      if (specifier && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addLocalModuleReference(
          references,
          "dynamic import",
          specifier,
          extractExpressionBindingSymbols(node),
        );
      } else if (specifier && ts.isIdentifier(node.expression) && node.expression.text === "require") {
        addLocalModuleReference(
          references,
          "require",
          specifier,
          extractExpressionBindingSymbols(node),
        );
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = getStaticModuleSpecifier(node.argument.literal);

      if (specifier) {
        addLocalModuleReference(
          references,
          "type reference",
          specifier,
          extractEntityNameSymbols(node.qualifier),
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  collectTripleSlashReferences(content, references);

  return [...references.values()]
    .sort((left, right) => left.specifier.localeCompare(right.specifier) || left.kind.localeCompare(right.kind));
}

export function buildTypeScriptSymbolEdges(
  workspaceRoot: string,
  files: ModuleGraphSourceFile[],
  moduleEdges: LocalModuleEdge[],
): LocalModuleEdge[] {
  const root = resolve(workspaceRoot);
  const sourceInputs: Array<ModuleGraphSourceFile & { content: string }> = [];
  let sourceBytes = 0;

  for (const file of files) {
    if (!TYPECHECKER_SOURCE_EXTENSIONS.has(extname(file.path).toLowerCase())) {
      continue;
    }

    const content = file.content ?? ts.sys.readFile(file.absolutePath);

    if (content === undefined) {
      continue;
    }

    const nextBytes = sourceBytes + Buffer.byteLength(content, "utf8");

    // Stop collecting once the budget is exhausted, but keep the files already
    // gathered so large repositories still get partial TypeChecker coverage
    // instead of dropping symbol edges entirely.
    if (sourceInputs.length >= MAX_TYPECHECKER_FILES || nextBytes > MAX_TYPECHECKER_SOURCE_BYTES) {
      break;
    }

    sourceBytes = nextBytes;
    sourceInputs.push({ ...file, content });
  }

  if (sourceInputs.length === 0) {
    return [];
  }

  const sourceByAbsolutePath = new Map(
    sourceInputs.map((file) => [normalizePathKey(file.absolutePath), file]),
  );
  const workspacePathByAbsolutePath = new Map(
    sourceInputs.map((file) => [normalizePathKey(file.absolutePath), file.path]),
  );
  const directTargets = new Set(
    moduleEdges.map((edge) => `${normalizePathKey(edge.fromPath)}\0${normalizePathKey(edge.toPath)}`),
  );
  const specifierByOriginAndSymbol = buildSpecifierByOriginAndSymbol(moduleEdges);
  const compilerOptions = loadTypeCheckerCompilerOptions(root);
  const host = createTypeCheckerHost(
    compilerOptions,
    sourceByAbsolutePath,
    moduleEdges,
    root,
  );
  const program = ts.createProgram({
    host,
    options: compilerOptions,
    rootNames: sourceInputs.map((file) => file.absolutePath),
  });
  const checker = program.getTypeChecker();
  const edges = new Map<string, LocalModuleEdge>();

  for (const sourceFile of program.getSourceFiles()) {
    const fromPath = workspacePathByAbsolutePath.get(normalizePathKey(sourceFile.fileName));

    if (!fromPath) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const aliasSymbol = checker.getSymbolAtLocation(node);

        if (aliasSymbol) {
          const moduleSpecifier = getSymbolModuleSpecifier(aliasSymbol);
          const targetSymbol = resolveAliasedSymbol(checker, aliasSymbol);
          const toPath = getWorkspaceDeclarationPath(targetSymbol, workspacePathByAbsolutePath);

          if (
            toPath
            && toPath !== fromPath
            && !directTargets.has(`${normalizePathKey(fromPath)}\0${normalizePathKey(toPath)}`)
          ) {
            const targetName = normalizeTypeCheckerSymbolName(targetSymbol.getName());
            const symbols = [node.text, targetName]
              .filter((symbol): symbol is string => Boolean(symbol));
            const specifier = moduleSpecifier
              ?? specifierByOriginAndSymbol.get(`${normalizePathKey(fromPath)}\0${node.text.toLowerCase()}`)
              ?? targetName
              ?? node.text;

            addTypeScriptSymbolEdge(edges, {
              fromPath,
              kind: "symbol reference",
              specifier,
              symbols,
              toPath,
            });
          }
        }
      }

      if (edges.size < MAX_TYPECHECKER_EDGES) {
        ts.forEachChild(node, visit);
      }
    };

    visit(sourceFile);

    if (edges.size >= MAX_TYPECHECKER_EDGES) {
      break;
    }
  }

  return [...edges.values()].sort((left, right) =>
    left.fromPath.localeCompare(right.fromPath)
      || left.toPath.localeCompare(right.toPath)
      || left.kind.localeCompare(right.kind)
  );
}

function loadTypeCheckerCompilerOptions(workspaceRoot: string): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  };
  const configPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists);

  if (!configPath) {
    return defaults;
  }

  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);

  if (loaded.error) {
    return defaults;
  }

  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configPath));
  return {
    ...defaults,
    ...parsed.options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
  };
}

function createTypeCheckerHost(
  compilerOptions: ts.CompilerOptions,
  sourceByAbsolutePath: Map<string, ModuleGraphSourceFile & { content: string }>,
  moduleEdges: LocalModuleEdge[],
  workspaceRoot: string,
): ts.CompilerHost {
  const host = ts.createCompilerHost(compilerOptions, true);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const moduleTargets = new Map<string, string>();

  for (const edge of moduleEdges) {
    moduleTargets.set(
      `${normalizePathKey(resolve(workspaceRoot, edge.fromPath))}\0${edge.specifier}`,
      resolve(workspaceRoot, edge.toPath),
    );
  }

  host.fileExists = (path) => sourceByAbsolutePath.has(normalizePathKey(path)) || defaultFileExists(path);
  host.readFile = (path) => sourceByAbsolutePath.get(normalizePathKey(path))?.content ?? defaultReadFile(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    const known = sourceByAbsolutePath.get(normalizePathKey(path));

    if (known) {
      return ts.createSourceFile(
        path,
        known.content,
        languageVersion,
        true,
        getScriptKind(path),
      );
    }

    return defaultGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => {
    const mappedPath = moduleTargets.get(`${normalizePathKey(containingFile)}\0${moduleName}`);

    if (mappedPath) {
      return {
        extension: getTypeScriptExtension(mappedPath),
        isExternalLibraryImport: false,
        resolvedFileName: mappedPath,
      };
    }

    return ts.resolveModuleName(moduleName, containingFile, compilerOptions, host).resolvedModule;
  });

  return host;
}

function getTypeScriptExtension(path: string): ts.Extension {
  switch (extname(path).toLowerCase()) {
    case ".tsx":
      return ts.Extension.Tsx;
    case ".mts":
      return ts.Extension.Mts;
    case ".cts":
      return ts.Extension.Cts;
    case ".js":
      return ts.Extension.Js;
    case ".jsx":
      return ts.Extension.Jsx;
    case ".mjs":
      return ts.Extension.Mjs;
    case ".cjs":
      return ts.Extension.Cjs;
    case ".json":
      return ts.Extension.Json;
    default:
      return ts.Extension.Ts;
  }
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
    return symbol;
  }

  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function getWorkspaceDeclarationPath(
  symbol: ts.Symbol,
  workspacePathByAbsolutePath: Map<string, string>,
): string | null {
  for (const declaration of symbol.declarations ?? []) {
    const path = workspacePathByAbsolutePath.get(
      normalizePathKey(declaration.getSourceFile().fileName),
    );

    if (path) {
      return path;
    }
  }

  return null;
}

function getSymbolModuleSpecifier(symbol: ts.Symbol): string | null {
  for (const declaration of symbol.declarations ?? []) {
    let current: ts.Node | undefined = declaration;

    while (current && !ts.isSourceFile(current)) {
      if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) {
        return getStaticModuleSpecifier(current.moduleSpecifier);
      }

      if (ts.isImportEqualsDeclaration(current) && ts.isExternalModuleReference(current.moduleReference)) {
        return getStaticModuleSpecifier(current.moduleReference.expression);
      }

      current = current.parent;
    }
  }

  return null;
}

function buildSpecifierByOriginAndSymbol(moduleEdges: LocalModuleEdge[]): Map<string, string> {
  const specifiers = new Map<string, string>();

  for (const edge of moduleEdges) {
    for (const symbol of edge.symbols) {
      specifiers.set(
        `${normalizePathKey(edge.fromPath)}\0${symbol.toLowerCase()}`,
        edge.specifier,
      );
    }
  }

  return specifiers;
}

function addTypeScriptSymbolEdge(
  edges: Map<string, LocalModuleEdge>,
  edge: LocalModuleEdge,
): void {
  const key = `${edge.fromPath}\0${edge.toPath}`;
  const existing = edges.get(key);

  if (existing) {
    existing.symbols = mergeSymbols(existing.symbols, edge.symbols)
      .slice(0, MAX_SYMBOLS_PER_EDGE);
  } else if (edges.size < MAX_TYPECHECKER_EDGES) {
    edges.set(key, {
      ...edge,
      symbols: mergeSymbols([], edge.symbols).slice(0, MAX_SYMBOLS_PER_EDGE),
    });
  }
}

function normalizeTypeCheckerSymbolName(name: string): string | null {
  return name && !name.startsWith("__") ? name : null;
}

function normalizePathKey(path: string): string {
  return resolve(path).replaceAll("\\", "/").toLowerCase();
}

function getScriptKind(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".json":
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.TS;
  }
}

function getStaticModuleSpecifier(node: ts.Node | undefined): string | null {
  if (!node || (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node))) {
    return null;
  }

  return node.text.trim() || null;
}

function extractImportClauseSymbols(clause: ts.ImportClause | undefined): string[] {
  if (!clause) {
    return [];
  }

  const symbols = clause.name ? [clause.name.text] : [];
  const bindings = clause.namedBindings;

  if (bindings && ts.isNamespaceImport(bindings)) {
    symbols.push(bindings.name.text);
  } else if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      symbols.push(...extractAliasedNameSymbols(element.propertyName, element.name));
    }
  }

  return mergeSymbols([], symbols);
}

function extractExportClauseSymbols(clause: ts.NamedExportBindings | undefined): string[] {
  if (!clause) {
    return ["*"];
  }

  if (ts.isNamespaceExport(clause)) {
    return [clause.name.text];
  }

  return mergeSymbols(
    [],
    clause.elements.flatMap((element) =>
      extractAliasedNameSymbols(element.propertyName, element.name)
    ),
  );
}

function extractAliasedNameSymbols(
  originalName: ts.ModuleExportName | undefined,
  localName: ts.ModuleExportName,
): string[] {
  return mergeSymbols(
    [],
    [originalName?.text, localName.text].filter((name): name is string => Boolean(name)),
  );
}

function extractExpressionBindingSymbols(expression: ts.Expression): string[] {
  const symbols: string[] = [];
  let current: ts.Node = expression;

  for (let depth = 0; depth < 8; depth += 1) {
    const parent = current.parent;

    if (!parent) {
      break;
    }

    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      symbols.push(parent.name.text);
      current = parent;
      continue;
    }

    if (ts.isElementAccessExpression(parent) && parent.expression === current) {
      const property = getStaticModuleSpecifier(parent.argumentExpression);

      if (property) {
        symbols.push(property);
      }
      current = parent;
      continue;
    }

    if (
      (ts.isAwaitExpression(parent)
        || ts.isParenthesizedExpression(parent)
        || ts.isAsExpression(parent)
        || ts.isTypeAssertionExpression(parent)
        || ts.isNonNullExpression(parent)
        || ts.isSatisfiesExpression(parent))
      && parent.expression === current
    ) {
      current = parent;
      continue;
    }

    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      symbols.push(...extractBindingNameSymbols(parent.name));
    } else if (
      ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && parent.right === current
      && ts.isIdentifier(parent.left)
    ) {
      symbols.push(parent.left.text);
    }

    break;
  }

  return mergeSymbols([], symbols);
}

function extractBindingNameSymbols(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }

  return name.elements.flatMap((element): string[] => {
    if (ts.isOmittedExpression(element)) {
      return [];
    }

    const propertyName = extractPropertyNameSymbol(element.propertyName);
    return mergeSymbols(
      propertyName ? [propertyName] : [],
      extractBindingNameSymbols(element.name),
    );
  });
}

function extractPropertyNameSymbol(name: ts.PropertyName | undefined): string | null {
  if (!name) {
    return null;
  }

  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return ts.isComputedPropertyName(name) && ts.isIdentifier(name.expression)
    ? name.expression.text
    : null;
}

function extractEntityNameSymbols(name: ts.EntityName | undefined): string[] {
  if (!name) {
    return [];
  }

  if (ts.isIdentifier(name)) {
    return [name.text];
  }

  return mergeSymbols(extractEntityNameSymbols(name.left), [name.right.text]);
}

function collectTripleSlashReferences(
  content: string,
  references: Map<string, LocalModuleReference>,
): void {
  const pattern = /^\s*\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["'][^>]*\/?>/gm;

  for (const match of content.matchAll(pattern)) {
    const specifier = match[2]?.trim();

    if (specifier) {
      addLocalModuleReference(references, "type reference", specifier, []);
    }
  }
}

function addLocalModuleReference(
  references: Map<string, LocalModuleReference>,
  kind: LocalModuleReferenceKind,
  specifier: string,
  symbols: string[],
): void {
  const key = `${kind}\0${specifier}`;
  const existing = references.get(key);

  if (existing) {
    existing.symbols = mergeSymbols(existing.symbols, symbols);
  } else {
    references.set(key, {
      kind,
      specifier,
      symbols: mergeSymbols([], symbols),
    });
  }
}

function mergeSymbols(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])].sort((first, second) => first.localeCompare(second));
}
