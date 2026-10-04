import type { Type } from "@angular/core";

import {
  BOUNDARY_CLIENT_ATTRIBUTE,
  BOUNDARY_PROPS_ATTRIBUTE,
  BOUNDARY_PROTOCOL_ATTRIBUTE,
  StrataBoundaryError,
  parseBoundaryAttributes,
} from "./boundary-protocol.js";
import type { BoundaryEntries } from "./boundary-protocol.js";

/** What the preflight reads from a host element; an `HTMLElement` is one. */
export interface BoundaryHost {
  readonly localName: string;
  getAttribute(name: string): string | null;
}

/** A client reference, from `reflectComponentType` (public Angular API). */
export interface ClientReference {
  readonly type: Type<unknown>;
  readonly selector: string;
  /** Public input names (`templateName`, aliases applied): what `setInput` expects. */
  readonly inputs: ReadonlyMap<string, string>;
}

/** One boundary that passed preflight: its own host element, component and props. */
export interface PlannedClientBoundary<H extends BoundaryHost> {
  readonly host: H;
  readonly type: Type<unknown>;
  readonly props: BoundaryEntries;
}

/** Matches any element carrying a boundary attribute, so a partial boundary is still found. */
export const BOUNDARY_HOST_SELECTOR = [
  BOUNDARY_CLIENT_ATTRIBUTE,
  BOUNDARY_PROTOCOL_ATTRIBUTE,
  BOUNDARY_PROPS_ATTRIBUTE,
]
  .map((name) => `[${name}]`)
  .join(", ");

function checkBoundary(
  host: BoundaryHost,
  references: ReadonlyMap<string, ClientReference>,
): string | PlannedClientBoundary<BoundaryHost> {
  const selector = host.getAttribute(BOUNDARY_CLIENT_ATTRIBUTE);

  if (selector === null) return `${BOUNDARY_CLIENT_ATTRIBUTE} is missing.`;
  if (selector !== host.localName) {
    return `${BOUNDARY_CLIENT_ATTRIBUTE}="${selector}" does not name its host element <${host.localName}>.`;
  }

  const reference = references.get(selector);

  if (!reference) return "no client reference has this selector.";
  if (reference.selector !== host.localName) {
    return `its client reference has selector "${reference.selector}", not "${host.localName}".`;
  }

  const parsed = parseBoundaryAttributes({
    protocol: host.getAttribute(BOUNDARY_PROTOCOL_ATTRIBUTE),
    props: host.getAttribute(BOUNDARY_PROPS_ATTRIBUTE),
  });

  if (!parsed.ok) return parsed.problem;

  const publicNames = new Set(reference.inputs.values());

  for (const [name] of parsed.value) {
    if (publicNames.has(name)) continue;

    const alias = reference.inputs.get(name);

    return alias
      ? `prop "${name}" is not a public input name; the input's public (aliased) name is "${alias}".`
      : `prop "${name}" is not an input of the component.`;
  }

  return { host, type: reference.type, props: parsed.value };
}

/**
 * Preflight of every client boundary of one Server Component host, before
 * anything is created: all valid, or a StrataBoundaryError for the first
 * invalid boundary and no plan at all. Each boundary is its own host element;
 * boundaries are never matched by selector or payload.
 */
export function planClientBoundaries<H extends BoundaryHost>(
  owner: string,
  hosts: readonly H[],
  references: ReadonlyMap<string, ClientReference>,
): PlannedClientBoundary<H>[] {
  return hosts.map((host, index) => {
    const checked = checkBoundary(host, references);

    if (typeof checked === "string") {
      throw new StrataBoundaryError(
        `[strata] Cannot hydrate client boundary <${host.localName}> (boundary ${index + 1} of ${hosts.length} in <${owner}>): ${checked}\n` +
          `No client boundary in <${owner}> was hydrated; its server-rendered DOM is left in place.`,
      );
    }

    return { ...checked, host };
  });
}
