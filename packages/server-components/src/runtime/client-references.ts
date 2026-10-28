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

const isDescriptor = (input: ClientReferenceInput): input is ClientReferenceDescriptor =>
  typeof input === "object" && input !== null;

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

  inputs.forEach((input, index) => {
    if (problem !== undefined) return;

    const descriptor = isDescriptor(input);
    const type = descriptor ? input.type : input;
    const expected = descriptor ? input.expectedSelector : undefined;
    const position = `client reference ${index + 1} of ${inputs.length}`;
    const mirror = typeof type === "function" ? reflectComponentType(type) : null;

    if (!mirror) {
      problem = `${position} is not an Angular component (no component metadata).`;
      return;
    }
    if (expected !== undefined && typeof expected === "string" && mirror.selector !== expected) {
      problem =
        `${position} is registered for <${expected}> but its component declares selector "${mirror.selector}". ` +
        `Correct the clientComponents registry or the import.`;
      return;
    }

    const existing = references.get(mirror.selector);

    if (existing) {
      // The same component listed twice is harmless; two distinct types are ambiguous.
      if (existing.type !== type) {
        problem =
          `two different components declare selector "${mirror.selector}" (${position}). ` +
          `Correct the clientComponents registry or the import.`;
      }
      return;
    }
    references.set(mirror.selector, {
      type,
      selector: mirror.selector,
      inputs: new Map(mirror.inputs.map((i) => [i.propName, i.templateName])),
    });
  });

  return problem === undefined ? { references } : { references, problem };
}
