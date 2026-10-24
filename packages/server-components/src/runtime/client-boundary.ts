import { Directive, ElementRef, computed, inject, input } from "@angular/core";

import { serializeBoundary } from "./boundary-protocol.js";
import { STRATA_BUILD_ID } from "./build-token.js";

/**
 * Readonly JSON-compatible data accepted at a `[strataClient]` boundary.
 * Runtime validation applies depth, node, key, array and byte limits and
 * rejects class instances, accessors, cycles, functions and other live values.
 */
export type ClientBoundaryPrimitive = string | number | boolean | null;
// TypeScript interfaces do not satisfy string index signatures, even when all
// their declared fields are valid. `object` keeps authored readonly view-model
// interfaces assignable; the shared runtime validator enforces every nested
// key and value before this value crosses the browser boundary.
export type ClientBoundaryObject = Readonly<object>;
export type ClientBoundaryValue =
  ClientBoundaryPrimitive | readonly ClientBoundaryValue[] | ClientBoundaryObject;
export type ClientBoundaryProps = Readonly<Record<string, ClientBoundaryValue>>;

/**
 * Server side of a client boundary. Placed on an interactive child inside a
 * server component template, it records which component the host is, the
 * boundary protocol version, and the plain-data inputs the browser needs to
 * hydrate it as its own root. Angular's attribute binding owns the escaping.
 * A value outside the protocol fails SSR. Imported only by server
 * components, so it stays in the server graph.
 */
@Directive({
  selector: "[strataClient]",
  host: {
    "[attr.data-strata-client]": "selector",
    "[attr.data-strata-protocol]": "serialized().protocol",
    "[attr.data-strata-props]": "serialized().props",
    "[attr.data-strata-build]": "buildId",
  },
})
export class StrataClientBoundary {
  readonly strataClient = input.required<ClientBoundaryProps>();

  /** The compiled application build identity; absent (no attribute) when not enabled. */
  protected readonly buildId = inject(STRATA_BUILD_ID) ?? null;
  protected readonly selector = (inject(ElementRef).nativeElement as HTMLElement).localName;
  protected readonly serialized = computed(() =>
    serializeBoundary(this.selector, this.strataClient()),
  );
}
