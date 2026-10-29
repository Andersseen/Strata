import { reflectComponentType } from "@angular/core";
import type { Type } from "@angular/core";

import type { ClientReference } from "./hydration-plan.js";

/**
 * A client reference with the selector the build authorized for it. The
 * generated surrogate supplies it from the validated server-owned template.
 */
export interface ClientReferenceDescriptor {
  readonly type: Type<unknown>;
  readonly expectedSelector: string;
}

/** What `provideClientReferences` accepts: a component type, or a type with its expected selector. */
export type ClientReferenceInput = Type<unknown> | ClientReferenceDescriptor;

/** The references of one host, by selector, and the first integrity problem found, if any. */
export interface ClientReferenceRegistry {
  readonly references: ReadonlyMap<string, ClientReference>;
  /** Set when the registry cannot be trusted; the host refuses every boundary. */
  readonly problem?: string;
}

/** The custom-element contract the build enforces on `clientComponents` selectors. */
const CUSTOM_ELEMENT_SELECTOR = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

type ReadInput =
  | { readonly ok: true; readonly type: unknown; readonly expected: string | undefined }
  | { readonly ok: false; readonly problem: string };

/**
 * Reads a reference without invoking consumer code: a descriptor must carry
 * `type` and `expectedSelector` as own data properties, so no getter, inherited
 * accessor, `toString` or `valueOf` of the consumer runs. A Proxy that throws
 * on inspection is a malformed reference, not an exception.
 */
function readInput(input: unknown, position: string): ReadInput {
  try {
    if (typeof input === "function") return { ok: true, type: input, expected: undefined };
    if (typeof input !== "object" || input === null) {
      return {
        ok: false,
        problem: `${position} is not an Angular component (no component metadata).`,
      };
    }

    const type = Object.getOwnPropertyDescriptor(input, "type");
    const expected = Object.getOwnPropertyDescriptor(input, "expectedSelector");

    if (!type || !("value" in type) || !expected || !("value" in expected)) {
      return {
        ok: false,
        problem: `${position} is not a valid descriptor: "type" and "expectedSelector" must be own data properties.`,
      };
    }
    if (typeof expected.value !== "string" || !CUSTOM_ELEMENT_SELECTOR.test(expected.value)) {
      return {
        ok: false,
        problem: `${position} has an invalid expectedSelector: it must be a custom-element name such as "order-details".`,
      };
    }
    return { ok: true, type: type.value, expected: expected.value };
  } catch {
    return { ok: false, problem: `${position} could not be inspected safely.` };
  }
}

/** Angular reflection can throw on corrupt metadata; that is a reference problem, not a crash. */
function reflect(type: unknown): ReturnType<typeof reflectComponentType> | "unreadable" {
  try {
    return typeof type === "function" ? reflectComponentType(type as Type<unknown>) : null;
  } catch {
    return "unreadable";
  }
}

/**
 * One pass over the host's references with Angular's public
 * `reflectComponentType`: one reflection per distinct component type. Never
 * throws and never prints a consumer value: a problem names the reference by
 * position and, where safe, the selectors involved.
 */
export function buildClientReferenceRegistry(
  inputs: readonly ClientReferenceInput[],
): ClientReferenceRegistry {
  const references = new Map<string, ClientReference>();
  let problem: string | undefined;

  if (!Array.isArray(inputs)) {
    return { references, problem: "the client references of this host are not an array." };
  }

  for (let index = 0; index < inputs.length && problem === undefined; index++) {
    let input: unknown;

    try {
      input = inputs[index];
    } catch {
      problem = `client reference ${index + 1} of ${inputs.length} could not be read.`;
      break;
    }

    const position = `client reference ${index + 1} of ${inputs.length}`;
    const read = readInput(input, position);

    if (!read.ok) {
      problem = read.problem;
      continue;
    }

    const type = read.type as Type<unknown>;
    const expected = read.expected;
    const mirror = reflect(type);

    if (mirror === "unreadable") {
      problem = `${position} has component metadata that could not be read.`;
      continue;
    }
    if (!mirror) {
      problem = `${position} is not an Angular component (no component metadata).`;
      continue;
    }
    if (expected !== undefined && mirror.selector !== expected) {
      problem =
        `${position} is registered for <${expected}> but its component declares selector "${mirror.selector}". ` +
        `Correct the clientComponents registry or the import.`;
      continue;
    }

    const existing = references.get(mirror.selector);

    if (existing) {
      // The same component listed twice is harmless; two distinct types are ambiguous.
      if (existing.type !== type) {
        problem =
          `two different components declare selector "${mirror.selector}" (${position}). ` +
          `Correct the clientComponents registry or the import.`;
      }
      continue;
    }
    references.set(mirror.selector, {
      type,
      selector: mirror.selector,
      inputs: new Map(mirror.inputs.map((i) => [i.propName, i.templateName])),
    });
  }

  return problem === undefined ? { references } : { references, problem };
}
