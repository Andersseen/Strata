// Consumer-authored use of every public declaration of the packed
// @strata-sc/server-components, including the optional /navigation entry.
import "@strata-sc/server-components/server-only";

import { Component, inject } from "@angular/core";
import type { CanActivateFn } from "@angular/router";
import {
  ServerComponent,
  StrataClientBoundary,
  StrataIslandHost,
  provideClientReferences,
} from "@strata-sc/server-components";
import type { ClientBoundaryProps } from "@strata-sc/server-components";
import {
  StrataDocumentLink,
  StrataDocumentNavigationError,
  StrataDocumentNavigator,
  strataDocumentNavigationGuard,
} from "@strata-sc/server-components/navigation";
import type {
  StrataDocumentDestination,
  StrataDocumentNavigateOptions,
} from "@strata-sc/server-components/navigation";
import { strataServerComponents } from "@strata-sc/server-components/vite";
import type { Plugin } from "vite";

@Component({ selector: "check-client", template: "" })
export class CheckClient {}

@ServerComponent()
@Component({
  selector: "check-server",
  imports: [CheckClient, StrataClientBoundary],
  template: `<check-client [strataClient]="{ id: 1 }" />`,
})
export class CheckServer {}

@Component({
  selector: "check-host",
  template: "",
  hostDirectives: [StrataIslandHost],
  providers: [provideClientReferences([CheckClient])],
})
export class CheckHost {}

export const props: ClientBoundaryProps = { id: 1 };
export const guard: CanActivateFn = strataDocumentNavigationGuard;

// AOT strict templates type-check the directive's inputs against the packed declarations.
@Component({
  selector: "check-link",
  imports: [StrataDocumentLink],
  template: `<a
    [strataDocumentLink]="['/products', 42]"
    [queryParams]="{ ref: 'check' }"
    fragment="details"
    >link</a
  >`,
})
export class CheckLink {
  private readonly documentNavigator = inject(StrataDocumentNavigator);

  go(destination: StrataDocumentDestination, options: StrataDocumentNavigateOptions): boolean {
    try {
      this.documentNavigator.resolve(destination);

      return this.documentNavigator.navigate(destination, options);
    } catch (error) {
      return error instanceof StrataDocumentNavigationError;
    }
  }
}

export const plugin: Plugin = strataServerComponents({
  root: "/app",
  sourceDir: "src/app",
  generatedDir: "src/generated/server-components",
  enabled: true,
});
