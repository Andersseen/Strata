import { Directive, ElementRef, computed, inject, input } from "@angular/core";

import { STRATA_BOUNDARY_PROTOCOL, serializeBoundaryProps } from "./boundary-protocol.js";

/**
 * Plain data only: a flat object of strings, finite numbers, booleans and
 * nulls. Enforced at runtime too (boundary-protocol.ts): a cast cannot smuggle
 * a class instance, function, signal or nested value across.
 */
export type ClientBoundaryProps = Readonly<Record<string, string | number | boolean | null>>;

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
    "[attr.data-strata-protocol]": "protocol",
    "[attr.data-strata-props]": "serializedProps()",
  },
})
export class StrataClientBoundary {
  readonly strataClient = input.required<ClientBoundaryProps>();

  protected readonly selector = (inject(ElementRef).nativeElement as HTMLElement).localName;
  protected readonly protocol = STRATA_BOUNDARY_PROTOCOL;
  protected readonly serializedProps = computed(() =>
    serializeBoundaryProps(this.selector, this.strataClient()),
  );
}
