import { DOCUMENT, Location } from "@angular/common";
import { computed, Directive, inject, input } from "@angular/core";
import type { Params, UrlTree } from "@angular/router";
import { ActivatedRoute, Router, RouterLink, UrlSerializer } from "@angular/router";

import { StrataDocumentNavigationError, resolveDocumentUrl } from "./resolve.js";

/**
 * An ordinary native anchor whose `href` is computed from Angular route
 * commands, a `UrlTree` or a root-relative string. Clicks are never
 * intercepted: the browser performs a real document navigation, so history,
 * new-tab, modified clicks, `target`, keyboard activation and fragments keep
 * working natively.
 *
 * Do not combine with `routerLink` on the same anchor. Use a plain
 * `<a href>` for external URLs.
 */
@Directive({
  selector: "a[strataDocumentLink]",
  host: { "[attr.href]": "href()" },
})
export class StrataDocumentLink {
  readonly destination = input<string | UrlTree | readonly unknown[] | null | undefined>(null, {
    alias: "strataDocumentLink",
  });
  readonly queryParams = input<Params | null | undefined>(null);
  readonly fragment = input<string | null | undefined>(null);
  readonly relativeTo = input<ActivatedRoute | null | undefined>(null);

  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly serializer = inject(UrlSerializer);
  private readonly document = inject(DOCUMENT);
  private readonly route = inject(ActivatedRoute, { optional: true });

  constructor() {
    if (inject(RouterLink, { self: true, optional: true })) {
      throw new StrataDocumentNavigationError(
        "an anchor cannot have both routerLink and strataDocumentLink; use strataDocumentLink for Server Component routes.",
      );
    }
  }

  /** `null` (no `href`) while the destination is null or undefined. */
  protected readonly href = computed(() => {
    const destination = this.destination();
    if (destination === null || destination === undefined) return null;

    return resolveDocumentUrl(
      {
        router: this.router,
        location: this.location,
        serializer: this.serializer,
        origin: this.document.location?.origin,
      },
      destination,
      {
        queryParams: this.queryParams(),
        fragment: this.fragment(),
        relativeTo: this.relativeTo() ?? this.route ?? undefined,
      },
    );
  });
}
