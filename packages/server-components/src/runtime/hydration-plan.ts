import type { Type } from "@angular/core";

import {
  BOUNDARY_CLIENT_ATTRIBUTE,
  BOUNDARY_PROPS_ATTRIBUTE,
  BOUNDARY_PROTOCOL_ATTRIBUTE,
  MAX_CLIENT_BOUNDARIES_PER_HOST,
  MAX_CLIENT_BOUNDARY_PAYLOAD_BYTES_PER_HOST,
  StrataBoundaryError,
  StrataBuildMismatchError,
  boundaryPayloadUtf8Bytes,
  parseBoundaryAttributes,
} from "./boundary-protocol.js";
import type { BoundaryEntries, BoundaryFailureCategory } from "./boundary-protocol.js";
import { BOUNDARY_BUILD_ATTRIBUTE, checkBuildIdentity } from "./build-identity.js";

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

/** A refused boundary: why, in which class, and the identities when it is a build mismatch. */
interface Refusal {
  readonly problem: string;
  readonly category: BoundaryFailureCategory;
  readonly mismatch?: { readonly browser: string; readonly server: string };
}

const refuse = (problem: string, category: BoundaryFailureCategory): Refusal => ({
  problem,
  category,
});

function checkBoundary(
  host: BoundaryHost,
  references: ReadonlyMap<string, ClientReference>,
  browserBuildId: string | undefined,
  registryProblem?: string,
): Refusal | PlannedClientBoundary<BoundaryHost> {
  const selector = host.getAttribute(BOUNDARY_CLIENT_ATTRIBUTE);

  if (selector === null) return refuse(`${BOUNDARY_CLIENT_ATTRIBUTE} is missing.`, "metadata");
  if (selector !== host.localName) {
    return refuse(
      `${BOUNDARY_CLIENT_ATTRIBUTE} does not match its host element selector <${host.localName}>.`,
      "metadata",
    );
  }

  // Before the registry, the protocol and the props: when the document and the
  // script come from different builds, the registry and the inputs are exactly
  // what cannot be trusted to agree, and the protocol number says nothing.
  const identity = checkBuildIdentity(browserBuildId, host.getAttribute(BOUNDARY_BUILD_ATTRIBUTE));

  if (identity.kind === "mismatch") {
    return {
      problem:
        `this browser runtime is application build "${identity.browser}" but the server rendered it with build "${identity.server}" ` +
        `(${BOUNDARY_BUILD_ATTRIBUTE}); the document and the script come from different deployments.`,
      category: "build-mismatch",
      mismatch: identity,
    };
  }
  if (identity.kind === "missing") {
    return refuse(
      `this browser runtime is application build "${browserBuildId}" but ${BOUNDARY_BUILD_ATTRIBUTE} is missing; the document was not rendered by a build that declares an identity.`,
      "build-identity",
    );
  }
  if (identity.kind === "malformed") {
    return refuse(`${BOUNDARY_BUILD_ATTRIBUTE} is not a valid build identity.`, "build-identity");
  }

  // After the build identity (a confirmed mismatch outranks it) and before any
  // lookup: an untrustworthy registry authorizes nothing.
  if (registryProblem !== undefined) return refuse(registryProblem, "reference");

  const reference = references.get(selector);

  if (!reference) return refuse("no client reference has this selector.", "reference");
  if (reference.selector !== host.localName) {
    return refuse(
      `its client reference has selector "${reference.selector}", not "${host.localName}".`,
      "reference",
    );
  }

  const parsed = parseBoundaryAttributes({
    protocol: host.getAttribute(BOUNDARY_PROTOCOL_ATTRIBUTE),
    props: host.getAttribute(BOUNDARY_PROPS_ATTRIBUTE),
  });

  if (!parsed.ok) return refuse(parsed.problem, parsed.category);

  const publicNames = new Set(reference.inputs.values());

  for (const [name] of parsed.value) {
    if (publicNames.has(name)) continue;

    const alias = reference.inputs.get(name);

    return refuse(
      alias
        ? `prop "${name}" is not a public input name; the input's public (aliased) name is "${alias}".`
        : `prop "${name}" is not an input of the component.`,
      "inputs",
    );
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
  browserBuildId?: string,
  registryProblem?: string,
): PlannedClientBoundary<H>[] {
  if (hosts.length > MAX_CLIENT_BOUNDARIES_PER_HOST) {
    throw resourceLimit(
      owner,
      `the client boundary count exceeds the per-host limit of ${MAX_CLIENT_BOUNDARIES_PER_HOST}.`,
    );
  }

  let payloadBytes = 0;
  for (const host of hosts) {
    const payload = host.getAttribute(BOUNDARY_PROPS_ATTRIBUTE);
    if (payload !== null) payloadBytes += boundaryPayloadUtf8Bytes(payload);
    if (payloadBytes > MAX_CLIENT_BOUNDARY_PAYLOAD_BYTES_PER_HOST) {
      throw resourceLimit(
        owner,
        `the aggregate serialized boundary payload exceeds the per-host limit of ${MAX_CLIENT_BOUNDARY_PAYLOAD_BYTES_PER_HOST} UTF-8 bytes.`,
      );
    }
  }

  return hosts.map((host, index) => {
    const checked = checkBoundary(host, references, browserBuildId, registryProblem);

    if ("problem" in checked) {
      const message =
        `[strata] Cannot hydrate client boundary <${host.localName}> (boundary ${index + 1} of ${hosts.length} in <${owner}>): ${checked.problem}\n` +
        `No client boundary in <${owner}> was hydrated; its server-rendered DOM is left in place.`;

      throw checked.mismatch
        ? new StrataBuildMismatchError(message, checked.mismatch.browser, checked.mismatch.server)
        : new StrataBoundaryError(message, checked.category);
    }

    return { ...checked, host };
  });
}

function resourceLimit(owner: string, detail: string): StrataBoundaryError {
  return new StrataBoundaryError(
    `[strata] Cannot hydrate client boundaries in <${owner}>: ${detail} No client boundary in <${owner}> was hydrated; its server-rendered DOM is left in place.`,
    "resource-limit",
  );
}
