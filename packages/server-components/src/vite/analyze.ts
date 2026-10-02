/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import { dirname, resolve } from "node:path";

import type { TmplAstBoundEvent, TmplAstElement, TmplAstTemplate } from "@angular/compiler";
import {
  CssSelector,
  ParsedEventType,
  TmplAstRecursiveVisitor,
  parseTemplate,
  tmplAstVisitAll,
} from "@angular/compiler";
import ts from "typescript";

/** The package whose imports are server-component runtime, never client references. */
export const RUNTIME_PACKAGE = "@strata-sc/server-components";

/** The client boundary input (`StrataClientBoundary`) that marks an interactive child. */
const BOUNDARY_INPUT = "strataClient";

const DECORATOR = "ServerComponent";
const SOURCE_EXTENSION = ".ts";
const ELEMENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

export interface ClientReference {
  readonly name: string;
  /** Absolute path of the app module declaring the component, without extension. */
  readonly module: string;
}

export interface ServerComponentDeclaration {
  readonly className: string;
  readonly selector: string;
  readonly clientReferences: readonly ClientReference[];
}

/** Reads a source or template file; throws if it does not exist. */
export type ReadFile = (path: string) => string;

/**
 * Per-generation memo of parsed app modules and analyzed component subtrees.
 * Create one per build (or per surrogate generation) and drop it afterwards:
 * it never outlives the files it read.
 */
export interface AnalysisCache {
  readonly modules: Map<string, ParsedModule>;
  readonly subtrees: Map<string, readonly FoundReference[]>;
}

export function createAnalysisCache(): AnalysisCache {
  return { modules: new Map(), subtrees: new Map() };
}

// ---------------------------------------------------------------------------
// Internal representation. None of this is exported from the package.

interface ImportBinding {
  readonly specifier: string;
  /** The name the module exports (differs from the local name for `{ A as B }`). */
  readonly exported: string;
}

interface ParsedModule {
  readonly file: string;
  readonly source: ts.SourceFile;
  /** Local name → where it is imported from. */
  readonly imports: ReadonlyMap<string, ImportBinding>;
}

interface TemplateSource {
  /** The file the template text lives in: the component module or its templateUrl. */
  readonly file: string;
  readonly text: string;
  /** For an inline template: its module and the offset of its first character. */
  readonly inline?: { readonly source: ts.SourceFile; readonly start: number };
}

interface AngularComponentDeclaration {
  /** `file#ClassName`: the identity cycle detection and memoization use. */
  readonly key: string;
  readonly file: string;
  readonly className: string;
  /** The single element name this component matches. */
  readonly selector: string;
  readonly serverComponent: boolean;
  readonly declaration: ts.ClassDeclaration;
  readonly metadata: ts.ObjectLiteralExpression;
  readonly module: ParsedModule;
}

/** A client reference with the selector it hydrates, while the graph is walked. */
interface FoundReference extends ClientReference {
  readonly selector: string;
  /** The component whose template marked it, for diagnostics. */
  readonly markedIn: string;
}

interface AnalysisContext {
  readonly readFile: ReadFile;
  readonly cache: AnalysisCache;
}

function fail(location: string, message: string): never {
  throw new Error(`${location}: ${message}`);
}

function trailOf(path: readonly AngularComponentDeclaration[]): string {
  return path.map((component) => component.className).join(" → ");
}

// ---------------------------------------------------------------------------
// TypeScript metadata

function decoratorCall(decorator: ts.Decorator, name: string): ts.CallExpression | undefined {
  const expression = decorator.expression;

  return ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === name
    ? expression
    : undefined;
}

/** Whether any decorator anywhere in `node` calls `name`, at any depth. */
function hasDecoratorCall(node: ts.Node, name: string): boolean {
  if (ts.isDecorator(node) && decoratorCall(node, name)) return true;

  return ts.forEachChild(node, (child) => hasDecoratorCall(child, name) || undefined) ?? false;
}

function hasDecorator(node: ts.HasDecorators, name: string): boolean {
  return (ts.getDecorators(node) ?? []).some((d) => decoratorCall(d, name));
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

/** The object literal passed to a class's `@<name>(...)`, if it has one. */
function decoratorMetadata(
  declaration: ts.ClassDeclaration,
  name: string,
): ts.ObjectLiteralExpression | undefined {
  const metadata = (ts.getDecorators(declaration) ?? [])
    .map((d) => decoratorCall(d, name))
    .find((call) => call !== undefined)?.arguments[0];

  return metadata && ts.isObjectLiteralExpression(metadata) ? metadata : undefined;
}

function stringLiteral(
  literal: ts.ObjectLiteralExpression,
  name: string,
): ts.StringLiteralLike | undefined {
  const value = property(literal, name);

  return value && ts.isStringLiteralLike(value) ? value : undefined;
}

function parseModule(file: string, text: string): ParsedModule {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, ImportBinding>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const bindings = statement.importClause?.namedBindings;

    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, {
          specifier: statement.moduleSpecifier.text,
          exported: (element.propertyName ?? element.name).text,
        });
      }
    }
  }

  return { file, source, imports };
}

function loadModule(module: string, context: AnalysisContext): ParsedModule {
  const file = module.endsWith(SOURCE_EXTENSION) ? module : `${module}${SOURCE_EXTENSION}`;
  const cached = context.cache.modules.get(file);

  if (cached) return cached;

  const parsed = parseModule(file, context.readFile(file));

  context.cache.modules.set(file, parsed);

  return parsed;
}

function classNamed(module: ParsedModule, name: string): ts.ClassDeclaration | undefined {
  return module.source.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === name,
  );
}

function location(source: ts.SourceFile, node: ts.Node): string {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));

  return `${source.fileName}:${line + 1}:${character + 1}`;
}

/** Reads a component class into the analyzer's representation, enforcing the restrictions. */
function componentDeclaration(
  module: ParsedModule,
  declaration: ts.ClassDeclaration,
  metadata: ts.ObjectLiteralExpression,
): AngularComponentDeclaration {
  const className = declaration.name?.text ?? "";
  const serverComponent = hasDecorator(declaration, DECORATOR);
  const literal = stringLiteral(metadata, "selector");

  if (literal === undefined) {
    fail(
      module.file,
      serverComponent
        ? "a server component needs a string literal selector."
        : `${className} needs a string literal selector to be composed under a server component.`,
    );
  }

  return {
    key: `${module.file}#${className}`,
    file: module.file,
    className,
    selector: literal.text,
    serverComponent,
    declaration,
    metadata,
    module,
  };
}

/** The single element name `component` matches, or a build failure. */
function elementName(component: AngularComponentDeclaration): string {
  const selectors = CssSelector.parse(component.selector);
  const only = selectors[0];

  if (
    selectors.length !== 1 ||
    !only?.element ||
    only.attrs.length > 0 ||
    only.classNames.length > 0 ||
    only.notSelectors.length > 0 ||
    !ELEMENT_NAME.test(only.element)
  ) {
    fail(
      component.file,
      `${component.className} has selector "${component.selector}". Components composed under a server component need a single custom element selector (e.g. "order-details").`,
    );
  }

  return only.element;
}

function templateOf(
  component: AngularComponentDeclaration,
  context: AnalysisContext,
): TemplateSource {
  const inline = stringLiteral(component.metadata, "template");

  if (inline) {
    return {
      file: component.file,
      text: inline.text,
      inline: {
        source: component.module.source,
        start: inline.getStart(component.module.source) + 1,
      },
    };
  }

  const templateUrl = stringLiteral(component.metadata, "templateUrl");

  if (templateUrl === undefined) {
    fail(
      component.file,
      component.serverComponent
        ? "a server component needs a string literal template or templateUrl."
        : `${component.className} needs a string literal template or a relative templateUrl to be composed under a server component.`,
    );
  }

  const file = resolve(dirname(component.file), templateUrl.text);

  return { file, text: context.readFile(file) };
}

/**
 * Event listeners on the component host (`host: { "(click)": ... }` or
 * `@HostListener`): interaction the server-owned class would never run.
 */
function checkHostListeners(
  declaration: ts.ClassDeclaration,
  metadata: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  owner: string,
): void {
  const host = property(metadata, "host");

  if (host && ts.isObjectLiteralExpression(host)) {
    for (const entry of host.properties) {
      const name = entry.name && (ts.isStringLiteralLike(entry.name) ? entry.name.text : undefined);

      if (name?.startsWith("(")) {
        fail(
          location(source, entry),
          `host listener "${name}" on ${owner}, which is server-owned and never runs in the browser. Move this interaction into an Angular component marked with [${BOUNDARY_INPUT}].`,
        );
      }
    }
  }

  for (const member of declaration.members) {
    if (ts.canHaveDecorators(member) && hasDecorator(member, "HostListener")) {
      fail(
        location(source, member),
        `@HostListener on ${owner}, which is server-owned and never runs in the browser. Move this interaction into an Angular component marked with [${BOUNDARY_INPUT}].`,
      );
    }
  }
}

/**
 * The local components a server-owned component can render, by element name,
 * resolved only through its own `imports: [...]`. Package imports (and the
 * runtime) stay opaque: they are never crawled.
 */
function componentScope(
  component: AngularComponentDeclaration,
  context: AnalysisContext,
): Map<string, AngularComponentDeclaration> {
  const scope = new Map<string, AngularComponentDeclaration>();
  const imports = property(component.metadata, "imports");
  const owner = component.serverComponent ? "server component" : component.className;

  if (imports && !ts.isArrayLiteralExpression(imports)) {
    fail(component.file, `${owner} imports must be an array literal.`);
  }

  for (const element of imports?.elements ?? []) {
    if (!ts.isIdentifier(element)) {
      fail(component.file, `${owner} imports must be plain identifiers.`);
    }

    const binding = component.module.imports.get(element.text);

    if (!binding) fail(component.file, `cannot find the import of ${element.text}.`);

    // Runtime (the boundary directive) and package imports are opaque.
    if (!binding.specifier.startsWith(".")) continue;

    const module = loadModule(resolve(dirname(component.file), binding.specifier), context);
    const declaration = classNamed(module, binding.exported);

    if (!declaration) {
      fail(
        component.file,
        `${element.text} is imported from "${binding.specifier}", which does not declare class ${binding.exported}. Re-exports and barrels are not supported under a server component.`,
      );
    }

    if (hasDecorator(declaration, "NgModule")) {
      fail(
        component.file,
        `${element.text} is an NgModule. Import standalone components directly under a server component.`,
      );
    }

    const directive = decoratorMetadata(declaration, "Directive");

    if (directive) {
      checkHostListeners(declaration, directive, module.source, `directive ${binding.exported}`);
      continue;
    }

    const metadata = decoratorMetadata(declaration, "Component");

    if (!metadata) continue; // A pipe, or not an Angular class: nothing to render.

    const child = componentDeclaration(module, declaration, metadata);
    const name = elementName(child);
    const existing = scope.get(name);

    if (existing && existing.key !== child.key) {
      fail(
        component.file,
        `<${name}> is ambiguous in ${component.className}: both ${existing.className} (${existing.file}) and ${child.className} (${child.file}) declare selector "${name}".`,
      );
    }

    scope.set(name, child);
  }

  return scope;
}

/** `(click)`, `[(ngModel)]`, `(@fade.done)`: the binding as the author wrote it. */
function bindingText(event: TmplAstBoundEvent): string {
  return event.sourceSpan.toString().replace(/\s*=[\s\S]*$/, "");
}

function templateLocation(template: TemplateSource, event: TmplAstBoundEvent): string {
  const start = event.sourceSpan.start;

  if (template.inline) {
    const { line, character } = template.inline.source.getLineAndCharacterOfPosition(
      template.inline.start + start.offset,
    );

    return `${template.file}:${line + 1}:${character + 1}`;
  }

  return `${template.file}:${start.line + 1}:${start.col + 1}`;
}

/**
 * The client references a server-owned component's subtree hydrates, in
 * first-encounter (template document) order. Walks the template; at an
 * element marked `[strataClient]` it records the component and stops; at an
 * unmarked local component (ordinary or `@ServerComponent`) it recurses,
 * because that component is server-owned too.
 */
function walk(
  component: AngularComponentDeclaration,
  path: readonly AngularComponentDeclaration[],
  context: AnalysisContext,
): readonly FoundReference[] {
  const memo = context.cache.subtrees.get(component.key);

  if (memo) return memo;

  const trail = [...path, component];
  const owner = `server-only component ${component.className}${
    trail.length > 1 ? ` (rendered by ${trailOf(trail)})` : ""
  }`;

  checkHostListeners(component.declaration, component.metadata, component.module.source, owner);

  const scope = componentScope(component, context);
  const template = templateOf(component, context);
  const parsed = parseTemplate(template.text, template.file, {});

  if (parsed.errors?.length) {
    fail(template.file, `cannot parse the template: ${parsed.errors[0]?.msg ?? "unknown"}`);
  }

  const found: FoundReference[] = [];
  const add = (reference: FoundReference): void => {
    const clash = found.find((other) => other.selector === reference.selector);

    if (!clash) {
      found.push(reference);
    } else if (clash.module !== reference.module || clash.name !== reference.name) {
      fail(
        component.file,
        `two client components hydrate as <${reference.selector}> under ${component.className}: ${clash.name} (${clash.module}, marked in ${clash.markedIn}) and ${reference.name} (${reference.module}, marked in ${reference.markedIn}).`,
      );
    }
  };

  const checkOutputs = (tag: string, outputs: readonly TmplAstBoundEvent[], marked: boolean) => {
    const event = outputs[0];

    if (!event) return;

    const binding = bindingText(event);
    const kind = event.type === ParsedEventType.TwoWay ? "Two-way binding" : "Interactive binding";
    const advice = marked
      ? `<${tag}> is a client boundary, but its outputs would be handled by the server-owned template. Handle the interaction inside the client component.`
      : "Server-owned templates never run in the browser. Move this interaction into an Angular component marked with [strataClient].";

    fail(
      templateLocation(template, event),
      `${kind} "${binding}" on <${tag}> appears in ${owner}. ${advice}`,
    );
  };

  class CompositionVisitor extends TmplAstRecursiveVisitor {
    override visitElement(element: TmplAstElement): void {
      const marked = [...element.inputs, ...element.attributes].some(
        (attribute) => attribute.name === BOUNDARY_INPUT,
      );

      checkOutputs(element.name, element.outputs, marked);

      const local = scope.get(element.name);

      if (marked) {
        if (!local) {
          fail(
            component.file,
            `<${element.name}> is marked [${BOUNDARY_INPUT}], but no component in imports from a relative app module has selector "${element.name}".`,
          );
        }

        if (local.serverComponent) {
          fail(
            component.file,
            `<${element.name}> is marked [${BOUNDARY_INPUT}], but ${local.className} is a @${DECORATOR}(). A server component cannot be a client boundary.`,
          );
        }

        // The boundary: its own template belongs to the browser graph. Stop.
        add({
          name: local.className,
          module: local.file.slice(0, -SOURCE_EXTENSION.length),
          selector: element.name,
          markedIn: component.className,
        });
      } else if (local) {
        if (trail.some((ancestor) => ancestor.key === local.key)) {
          fail(
            component.file,
            `Server Component composition cycle: ${trailOf([...trail, local])}. Recursive server-owned composition is not supported.`,
          );
        }

        for (const reference of walk(local, trail, context)) add(reference);
      }

      // Projected content is still this template's: keep checking it.
      super.visitElement(element);
    }

    override visitTemplate(node: TmplAstTemplate): void {
      if (node.tagName === "ng-template") checkOutputs("ng-template", node.outputs, false);
      super.visitTemplate(node);
    }
  }

  tmplAstVisitAll(new CompositionVisitor(), parsed.nodes);
  context.cache.subtrees.set(component.key, found);

  return found;
}

/**
 * Reads what the surrogate needs from a module declaring a `@ServerComponent()`
 * class, or `undefined` if it declares none.
 *
 * Client references are explicit and transitive. The server component's
 * template is walked, and so is the template of every unmarked local
 * component it renders (ordinary components and nested server components
 * alike, at any depth): they are server-owned. An element marked
 * `[strataClient]` is a client reference, and the walk does not enter it.
 * Components are resolved only through the owning component's own `imports`;
 * there is no global registry.
 *
 * Server-owned templates must not be interactive: an event or two-way
 * binding, a host listener, or a `@HostListener` anywhere in them fails the
 * build, as do composition cycles and ambiguous selectors.
 *
 * Experimental restrictions, enforced with an error rather than guessed around:
 * exactly one named `@ServerComponent()` class per module; string literal
 * selectors (a single custom element name for composed components); an
 * inline string-literal `template` or a relative `templateUrl`; `imports`
 * listing plain identifiers bound by named imports; local components declared
 * in app modules imported by a relative specifier (`./x` resolving to
 * `./x.ts`), not re-exported. Package components are opaque: never crawled,
 * and never client references.
 */
export function analyzeServerComponent(
  file: string,
  text: string,
  readFile: ReadFile,
  cache: AnalysisCache = createAnalysisCache(),
): ServerComponentDeclaration | undefined {
  if (!text.includes(`@${DECORATOR}(`)) return undefined;

  const module = parseModule(file, text);

  // The text check above is only a prefilter: a module that merely mentions
  // the decorator (a string, a template literal, a comment) declares none.
  // Any real decorator call, however nested, still goes through the checks.
  if (!hasDecoratorCall(module.source, DECORATOR)) return undefined;

  cache.modules.set(file, module);

  const classes = module.source.statements.filter(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && hasDecorator(statement, DECORATOR),
  );

  const declaration = classes[0];

  if (classes.length !== 1 || !declaration?.name) {
    fail(file, `expected exactly one named @${DECORATOR}() class.`);
  }

  const metadata = decoratorMetadata(declaration, "Component");

  if (!metadata) fail(file, `@${DECORATOR}() must decorate an @Component({...}) class.`);

  const root = componentDeclaration(module, declaration, metadata);
  const found = walk(root, [], { readFile, cache });

  return {
    className: root.className,
    selector: root.selector,
    clientReferences: found.map(({ name, module: path }) => ({ name, module: path })),
  };
}
