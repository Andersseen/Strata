/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import ts from "typescript";

/**
 * The production compilation contract (docs/research/server-component-ssr-integrity-v07.md).
 *
 * An Angular class reaches a production bundle in one of two states. Compiled
 * by Angular (AOT, or linked from a partial declaration), it carries its Ivy
 * definition as a static member and its decorator is gone. Not compiled, the
 * decorator is still applied at module evaluation, and Angular falls back to
 * the JIT compiler the first time the class is used: absent from a
 * production server (`JIT compiler unavailable`), refused outright on Workers.
 * The server then returns HTTP 200 with an empty or partial document.
 *
 * Both states are visible in a module's transformed code, before it is
 * minified, so the check is a structural invariant and not a string match on a
 * symbol name: a decorator call that resolves to an `@angular/core` import and
 * is applied to a class (as decorator syntax, or as the array handed to
 * `__decorate`/`__esDecorate`), and a call of a partial declaration
 * (`ɵɵngDeclare*({ minVersion, version, … })`) that the linker should have
 * replaced. Neither can be produced by a correctly compiled module.
 */

const ANGULAR_CORE = "@angular/core";
/** The decorators Angular's compiler turns into static definitions. */
const COMPILED_DECORATORS: ReadonlySet<string> = new Set([
  "Component",
  "Directive",
  "Pipe",
  "Injectable",
  "NgModule",
]);
const DECORATE_HELPERS: ReadonlySet<string> = new Set(["__decorate", "__esDecorate"]);

/** A cheap pre-filter: a module that names none of these cannot violate the contract. */
const DECORATOR_HINT = /\b(?:Component|Directive|Pipe|Injectable|NgModule)\b/;
const PARTIAL_HINT = "ɵɵngDeclare";
/**
 * The partial-declaration metadata format is a stable, forward-compatible
 * contract between Angular libraries and the linker; `minVersion` is its
 * first required field. A function declaration of the same name (Angular's
 * own, in `@angular/core`) is not followed by an object literal.
 */
const PARTIAL_CALL = /ɵɵngDeclare[A-Za-z]+\s*\(\s*\{\s*minVersion\b/g;

export interface UnlinkedClass {
  /** Which Angular decorator is still applied. */
  readonly decorator: string;
  /** The decorated class, when it is a plain identifier. */
  readonly className: string | undefined;
}

/**
 * The Angular classes in `code` whose decorator is still applied, that is,
 * that Angular's compiler did not process. `code` is a module as it leaves
 * the transform pipeline: JavaScript (a TypeScript file is parsed leniently).
 * Empty for a correctly compiled module.
 */
export function findUncompiledAngularClasses(code: string, fileName: string): UnlinkedClass[] {
  if (!code.includes(ANGULAR_CORE) || !DECORATOR_HINT.test(code)) return [];

  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const { named, namespaces } = angularCoreBindings(source);

  if (named.size === 0 && namespaces.size === 0) return [];

  /** The Angular decorator a call expression applies, if its callee is one. */
  const angularDecorator = (expression: ts.Expression): string | undefined => {
    if (!ts.isCallExpression(expression)) return undefined;

    const callee = expression.expression;

    if (ts.isIdentifier(callee)) return named.get(callee.text);

    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text) &&
      COMPILED_DECORATORS.has(callee.name.text)
    ) {
      return callee.name.text;
    }

    return undefined;
  };
  const found: UnlinkedClass[] = [];
  const visit = (node: ts.Node): void => {
    // Decorator syntax kept as-is (`@Component(...) class X`).
    if (ts.isDecorator(node)) {
      const decorator = angularDecorator(node.expression);

      if (decorator) {
        const owner = node.parent;

        found.push({
          decorator,
          className: ts.isClassLike(owner) ? owner.name?.text : undefined,
        });
      }
    }

    // Lowered form: `X = __decorate([Component({...}), ...], X)`.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      DECORATE_HELPERS.has(node.expression.text)
    ) {
      const [list, target] = node.arguments;

      if (list && ts.isArrayLiteralExpression(list)) {
        for (const element of list.elements) {
          const decorator = angularDecorator(element);

          if (decorator) {
            found.push({
              decorator,
              className: target && ts.isIdentifier(target) ? target.text : undefined,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

/**
 * The local names bound to the compiled decorators of `@angular/core`
 * (aliases included), and the namespace names the whole module is imported as.
 */
function angularCoreBindings(source: ts.SourceFile): {
  named: Map<string, string>;
  namespaces: Set<string>;
} {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== ANGULAR_CORE ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }

    const bindings = statement.importClause?.namedBindings;

    if (!bindings) continue;

    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;

        if (!element.isTypeOnly && COMPILED_DECORATORS.has(imported)) {
          named.set(element.name.text, imported);
        }
      }
    }
  }

  return { named, namespaces };
}

/**
 * How many partial declarations (`ɵɵngDeclare*({ minVersion, … })`) `code`
 * still calls. The Angular linker replaces every one of them in a bundled
 * library; any left would run through the JIT compiler.
 */
export function countUnlinkedPartialDeclarations(code: string): number {
  if (!code.includes(PARTIAL_HINT)) return 0;

  return code.match(PARTIAL_CALL)?.length ?? 0;
}

export type IntegrityFinding =
  | { readonly kind: "uncompiled"; readonly classes: readonly UnlinkedClass[] }
  | { readonly kind: "unlinked-partial"; readonly count: number };

/** Both checks over one module's transformed code; undefined when it honours the contract. */
export function inspectCompiledModule(
  code: string,
  fileName: string,
): IntegrityFinding | undefined {
  const classes = findUncompiledAngularClasses(code, fileName);

  if (classes.length > 0) return { kind: "uncompiled", classes };

  const count = countUnlinkedPartialDeclarations(code);

  return count > 0 ? { kind: "unlinked-partial", count } : undefined;
}

/**
 * The build error. Names the module (already a display path, never an
 * absolute one), the environment, the classes and the cause, and carries no
 * source text.
 */
export function aotIntegrityMessage(
  displayPath: string,
  environment: string,
  finding: IntegrityFinding,
): string {
  const where = `"${displayPath}" (${environment} build)`;
  const consequence =
    "A production server cannot compile it at runtime: Angular reports `JIT compiler unavailable` " +
    "and the document is served as HTTP 200 with the component missing; Workers refuse JIT outright.";

  if (finding.kind === "unlinked-partial") {
    return (
      `[strata] AOT integrity: ${where} still contains ${finding.count} Angular partial ` +
      `declaration(s) (ɵɵngDeclare*): the Angular linker did not process this package. ${consequence} ` +
      "Make sure the package is bundled through the SSR graph (ssr.noExternal, or clientComponents for a " +
      "registered package island) and that the Angular plugin ran on it."
    );
  }

  const classes = finding.classes
    .slice(0, 5)
    .map((entry) => `@${entry.decorator}${entry.className ? ` ${entry.className}` : ""}`)
    .join(", ");
  const more = finding.classes.length > 5 ? `, and ${finding.classes.length - 5} more` : "";

  return (
    `[strata] AOT integrity: ${where} reached the bundle without Angular compilation: ${classes}${more} ` +
    `still applies its decorator. ${consequence} ` +
    "The Angular plugin had no compiled output for this file when it was transformed. Check that the " +
    "file is in the app's tsconfig program (compilerOptions, include and exclude); " +
    "see docs/research/server-component-ssr-integrity-v07.md."
  );
}
