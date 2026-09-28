/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import { dirname, resolve } from "node:path";

import ts from "typescript";

/** The package whose imports are server-component runtime, never client references. */
export const RUNTIME_PACKAGE = "@strata-sc/server-components";

const DECORATOR = "ServerComponent";

export interface ClientReference {
  readonly name: string;
  /** Absolute path without extension for app modules, or a bare package specifier. */
  readonly module: string;
}

export interface ServerComponentDeclaration {
  readonly className: string;
  readonly selector: string;
  readonly clientReferences: readonly ClientReference[];
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

/**
 * Reads what the surrogate needs from a module declaring a `@ServerComponent()`
 * class, or `undefined` if it declares none.
 *
 * Experimental restrictions, enforced with an error rather than guessed around:
 * exactly one named `@ServerComponent()` class per module, a string literal
 * `selector`, and `imports` listing plain identifiers bound by named imports.
 *
 * Provisional heuristic: every `imports` entry not from the runtime package is
 * treated as a client reference. A future compiler must derive explicit client
 * boundaries; not every imported Angular component is necessarily client-side.
 */
export function analyzeServerComponent(
  file: string,
  text: string,
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

    // The boundary directive is server-side runtime: it never becomes a client reference.
    if (specifier === RUNTIME_PACKAGE) continue;

    const module = specifier.startsWith(".") ? resolve(dirname(file), specifier) : specifier;

    clientReferences.push({ name: element.text, module });
  }

  return { className, selector: selector.text, clientReferences };
}
