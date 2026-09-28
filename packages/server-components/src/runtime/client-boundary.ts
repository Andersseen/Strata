import { Directive, ElementRef, computed, inject, input } from "@angular/core";

/** Plain data only: the PoC does not define serialization for anything richer. */
export type ClientBoundaryProps = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Server side of a client boundary. Placed on an interactive child inside a
 * server component template, it records which component the host is and the
 * plain-data inputs the browser needs to hydrate it as its own root.
 * Imported only by server components, so it stays in the server graph.
 */
@Directive({
  selector: "[strataClient]",
  host: {
    "[attr.data-strata-client]": "selector",
    "[attr.data-strata-props]": "serializedProps()",
  },
})
export class StrataClientBoundary {
  readonly strataClient = input.required<ClientBoundaryProps>();

  protected readonly selector = (inject(ElementRef).nativeElement as HTMLElement).localName;
  protected readonly serializedProps = computed(() => JSON.stringify(this.strataClient()));
}
