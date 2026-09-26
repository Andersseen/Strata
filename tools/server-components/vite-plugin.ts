/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import ts from "typescript";
import type { Plugin } from "vite";

/**
 * Private build transform for the server-component graph PoC
 * (docs/research/server-component-graph-poc.md). Not a package, not public API.
 *
 * A module declaring a `@ServerComponent()` class is replaced, in Vite's
 * `client` environment only, by a generated surrogate: an ordinary Angular
 * component with the same selector, an empty template, and the server
 * component's interactive imports as client references. The `ssr` environment
 * (and therefore Nitro) keeps the real module. The surrogate is written to disk
 * so Analog's Angular compiler AOT-compiles it like any other source file.
 */
export interface ServerComponentsOptions {
  /** The Analog app root (the directory holding `vite.config.ts`). */
  readonly root: string;
  /** App-relative directory scanned for `@ServerComponent()` classes. */
  readonly sourceDir: string;
  /** App-relative directory of the fixture-local runtime (decorator, boundary directive, island host). */
  readonly runtimeDir: string;
  /** App-relative directory the surrogates are generated into. Must be in the Angular program. */
  readonly generatedDir: string;
  /** `false` keeps the real modules in the browser graph: the plain-SSR control build. */
  readonly enabled: boolean;
}

export interface ServerComponentModule {
  /** Absolute path of the authored server component module. */
  readonly file: string;
  /** Absolute path of its generated browser surrogate. */
  readonly surrogate: string;
  readonly className: string;
  readonly selector: string;
  readonly clientReferences: readonly ClientReference[];
}

interface ClientReference {
  readonly name: string;
  /** Absolute path without extension for app modules, or a bare package specifier. */
  readonly module: string;
}

const DECORATOR = "ServerComponent";
const SOURCE_EXTENSION = ".ts";

export function strataServerComponents(options: ServerComponentsOptions): Plugin {
  const root = resolve(options.root);
  const sourceDir = join(root, options.sourceDir);
  const runtimeDir = join(root, options.runtimeDir);
  const generatedDir = join(root, options.generatedDir);
  let bySource = new Map<string, ServerComponentModule>();

  const generate = (): void => {
    rmSync(generatedDir, { recursive: true, force: true });
    bySource = new Map();

    for (const file of listSourceFiles(sourceDir, generatedDir)) {
      const found = analyze(file, runtimeDir);

      if (!found) continue;

      const surrogate = join(generatedDir, relative(sourceDir, file));
      const module: ServerComponentModule = { file, surrogate, ...found };

      mkdirSync(dirname(surrogate), { recursive: true });
      writeFileSync(surrogate, renderSurrogate(module, root, runtimeDir));
      bySource.set(file, module);
    }
  };

  return {
    name: "strata:server-components-poc",
    enforce: "pre",

    // Runs before Analog reads its tsconfig, so the surrogates are in the
    // Angular program from the start.
    config() {
      generate();
    },

    async resolveId(source, importer, resolveOptions) {
      if (!options.enabled || this.environment.name !== "client" || !importer) return null;
      if (!source.startsWith(".") && !source.startsWith("/")) return null;

      const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
      const module = resolved && bySource.get(stripQuery(resolved.id));

      return module ? module.surrogate : null;
    },

    // A server component module reaching the browser graph by any other path
    // (e.g. a glob import that bypasses resolveId) fails the build instead of leaking.
    load(id) {
      if (!options.enabled || this.environment.name !== "client") return null;

      const module = bySource.get(stripQuery(id));

      if (module) {
        this.error(
          `Server component module ${relative(root, module.file)} entered the browser graph.`,
        );
      }

      return null;
    },
  };
}

function stripQuery(id: string): string {
  return id.split("?")[0] ?? id;
}

function listSourceFiles(dir: string, exclude: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (path !== exclude) files.push(...listSourceFiles(path, exclude));
    } else if (entry.name.endsWith(SOURCE_EXTENSION) && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }

  return files.sort();
}

function decoratorCall(decorator: ts.Decorator, name: string): ts.CallExpression | undefined {
  const expression = decorator.expression;

  return ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === name
    ? expression
    : undefined;
}

function property(literal: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const element of literal.properties) {
    if (
      ts.isPropertyAssignment(element) &&
      ts.isIdentifier(element.name) &&
      element.name.text === name
    ) {
      return element.initializer;
    }
  }

  return undefined;
}

/** Reads what the surrogate needs from a module declaring a `@ServerComponent()` class. */
function analyze(
  file: string,
  runtimeDir: string,
): Omit<ServerComponentModule, "file" | "surrogate"> | undefined {
  const text = readFileSync(file, "utf8");

  if (!text.includes(`@${DECORATOR}(`)) return undefined;

  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const importedFrom = new Map<string, string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const bindings = statement.importClause?.namedBindings;

    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        importedFrom.set(element.name.text, statement.moduleSpecifier.text);
      }
    }
  }

  const classes = source.statements.filter(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) &&
      (ts.getDecorators(statement) ?? []).some((d) => decoratorCall(d, DECORATOR)),
  );

  const declaration = classes[0];

  if (classes.length !== 1 || !declaration?.name) {
    throw new Error(`${file}: expected exactly one named @${DECORATOR}() class.`);
  }

  const className = declaration.name.text;
  const component = (ts.getDecorators(declaration) ?? [])
    .map((d) => decoratorCall(d, "Component"))
    .find((call) => call !== undefined);
  const metadata = component?.arguments[0];

  if (!metadata || !ts.isObjectLiteralExpression(metadata)) {
    throw new Error(`${file}: @${DECORATOR}() must decorate an @Component({...}) class.`);
  }

  const selector = property(metadata, "selector");

  if (!selector || !ts.isStringLiteralLike(selector)) {
    throw new Error(`${file}: a server component needs a string literal selector.`);
  }

  const imports = property(metadata, "imports");
  const clientReferences: ClientReference[] = [];

  for (const element of imports && ts.isArrayLiteralExpression(imports) ? imports.elements : []) {
    if (!ts.isIdentifier(element)) {
      throw new Error(`${file}: server component imports must be plain identifiers.`);
    }

    const specifier = importedFrom.get(element.text);

    if (!specifier) throw new Error(`${file}: cannot find the import of ${element.text}.`);

    const module = specifier.startsWith(".") ? resolve(dirname(file), specifier) : specifier;

    // The boundary directive is server-side runtime: it never becomes a client reference.
    if (!module.startsWith(runtimeDir + sep)) clientReferences.push({ name: element.text, module });
  }

  return { className, selector: selector.text, clientReferences };
}

function specifierFrom(fromFile: string, module: string): string {
  if (!module.startsWith("/")) return module;

  const path = relative(
    dirname(fromFile),
    module.endsWith(SOURCE_EXTENSION) ? module.slice(0, -SOURCE_EXTENSION.length) : module,
  );

  return path.startsWith(".") ? path : `./${path}`;
}

function renderSurrogate(module: ServerComponentModule, root: string, runtimeDir: string): string {
  const references = module.clientReferences;
  const imports = references
    .map((ref) => `import { ${ref.name} } from "${specifierFrom(module.surrogate, ref.module)}";`)
    .join("\n");

  return `// @generated by tools/server-components/vite-plugin.ts — do not edit.
// Browser-graph surrogate for ${relative(root, module.file)}: the server
// component's implementation and server-only imports are absent by construction.
import { ChangeDetectionStrategy, Component } from "@angular/core";

import { StrataIslandHost, provideClientReferences } from "${specifierFrom(module.surrogate, join(runtimeDir, "islands.ts"))}";
${imports}

@Component({
  selector: ${JSON.stringify(module.selector)},
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: "",
  hostDirectives: [StrataIslandHost],
  providers: [provideClientReferences([${references.map((ref) => ref.name).join(", ")}])],
})
export class ${module.className} {}
`;
}
