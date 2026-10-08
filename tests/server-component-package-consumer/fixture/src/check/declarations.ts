// Consumer-authored use of every public declaration of the packed package.
import "@strata-sc/server-components/server-only";

import { Component } from "@angular/core";
import {
  ServerComponent,
  StrataClientBoundary,
  StrataIslandHost,
  provideClientReferences,
} from "@strata-sc/server-components";
import type { ClientBoundaryProps } from "@strata-sc/server-components";
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

export const plugin: Plugin = strataServerComponents({
  root: "/app",
  sourceDir: "src/app",
  generatedDir: "src/generated/server-components",
  enabled: true,
});
