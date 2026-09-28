/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import { dirname, resolve } from "node:path";

import type { TmplAstElement } from "@angular/compiler";
import { TmplAstRecursiveVisitor, parseTemplate, tmplAstVisitAll } from "@angular/compiler";
import ts from "typescript";

/** The package whose imports are server-component runtime, never client references. */
export const RUNTIME_PACKAGE = "@strata-sc/server-components";

/** The client boundary input (`StrataClientBoundary`) that marks an interactive child. */
const BOUNDARY_INPUT = "strataClient";

const DECORATOR = "ServerComponent";
const SOURCE_EXTENSION = ".ts";

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

/** The object literal passed to a class's `@Component(...)`, if it has one. */
function componentMetadata(
  declaration: ts.ClassDeclaration,
): ts.ObjectLiteralExpression | undefined {
  const metadata = (ts.getDecorators(declaration) ?? [])
    .map((d) => decoratorCall(d, "Component"))
    .find((call) => call !== undefined)?.arguments[0];

  return metadata && ts.isObjectLiteralExpression(metadata) ? metadata : undefined;
}

function stringProperty(literal: ts.ObjectLiteralExpression, name: string): string | undefined {
  const value = property(literal, name);

  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

/** Tag names of the elements the template marks as client boundaries (`[strataClient]`). */
function boundaryTags(file: string, template: string): Set<string> {
  const parsed = parseTemplate(template, file, {});

  if (parsed.errors?.length) {
    throw new Error(`${file}: cannot parse the template: ${parsed.errors[0]?.msg ?? "unknown"}`);
  }

  const tags = new Set<string>();

  class BoundaryVisitor extends TmplAstRecursiveVisitor {
    override visitElement(element: TmplAstElement): void {
      const marked = [...element.inputs, ...element.attributes].some(
        (attribute) => attribute.name === BOUNDARY_INPUT,
      );

      if (marked) tags.add(element.name);
      super.visitElement(element);
    }
  }

  tmplAstVisitAll(new BoundaryVisitor(), parsed.nodes);

  return tags;
}

/** The `@Component` selector of the class `name` declared in an app module, if any. */
function componentSelector(module: string, name: string, readFile: ReadFile): string | undefined {
  const path = module.endsWith(SOURCE_EXTENSION) ? module : `${module}${SOURCE_EXTENSION}`;
  const source = ts.createSourceFile(path, readFile(path), ts.ScriptTarget.Latest, true);

  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      const metadata = componentMetadata(statement);

      return metadata && stringProperty(metadata, "selector");
    }
  }

  return undefined;
}

/**
 * Reads what the surrogate needs from a module declaring a `@ServerComponent()`
 * class, or `undefined` if it declares none.
 *
 * Client references are explicit: only the `imports` entries whose component
 * selector is an element marked `[strataClient]` in the server component's
 * template. Every other import (a server-only child component, a pipe, a
 * directive) stays in the server graph.
 *
 * Experimental restrictions, enforced with an error rather than guessed around:
 * exactly one named `@ServerComponent()` class per module; a string literal
 * `selector`; an inline string-literal `template` or a relative `templateUrl`;
 * `imports` listing plain identifiers bound by named imports; and a client
 * component declared, with a string literal element selector, in an app
 * module imported by a relative specifier (`./x` resolving to `./x.ts`).
 * Components from packages cannot be client references yet.
 */
export function analyzeServerComponent(
  file: string,
  text: string,
  readFile: ReadFile,
): ServerComponentDeclaration | undefined {
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
  const metadata = componentMetadata(declaration);

  if (!metadata) {
    throw new Error(`${file}: @${DECORATOR}() must decorate an @Component({...}) class.`);
  }

  const selector = stringProperty(metadata, "selector");

  if (selector === undefined) {
    throw new Error(`${file}: a server component needs a string literal selector.`);
  }

  const templateUrl = stringProperty(metadata, "templateUrl");
  const template =
    stringProperty(metadata, "template") ??
    (templateUrl === undefined ? undefined : readFile(resolve(dirname(file), templateUrl)));

  if (template === undefined) {
    throw new Error(`${file}: a server component needs a string literal template or templateUrl.`);
  }

  const boundaries = boundaryTags(file, template);
  const imports = property(metadata, "imports");
  const clientReferences: ClientReference[] = [];

  for (const element of imports && ts.isArrayLiteralExpression(imports) ? imports.elements : []) {
    if (!ts.isIdentifier(element)) {
      throw new Error(`${file}: server component imports must be plain identifiers.`);
    }

    const specifier = importedFrom.get(element.text);

    if (!specifier) throw new Error(`${file}: cannot find the import of ${element.text}.`);

    // Runtime (the boundary directive) and package imports never become client references.
    if (!specifier.startsWith(".")) continue;

    const module = resolve(dirname(file), specifier);
    const childSelector = componentSelector(module, element.text, readFile);

    if (childSelector !== undefined && boundaries.delete(childSelector)) {
      clientReferences.push({ name: element.text, module });
    }
  }

  for (const tag of boundaries) {
    throw new Error(
      `${file}: <${tag}> is marked [${BOUNDARY_INPUT}], but no component in imports from a relative app module has selector "${tag}".`,
    );
  }

  return { className, selector, clientReferences };
}
