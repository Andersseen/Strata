import { ChangeDetectionStrategy, Component } from "@angular/core";
import {
  VoltCard,
  VoltCardContent,
  VoltCardHeader,
  VoltCardTitle,
  VoltTabs,
  VoltTabsContent,
  VoltTabsList,
  VoltTabsTrigger,
} from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";

import { CLIENT_BOUNDARY_EXAMPLE, SERVER_COMPONENT_EXAMPLE } from "../content";

import { CodePanelComponent } from "./code-panel.component";

@Component({
  selector: "strata-server-components-code",
  imports: [
    ...MOVEMENT_DIRECTIVES,
    CodePanelComponent,
    VoltCard,
    VoltCardContent,
    VoltCardHeader,
    VoltCardTitle,
    VoltTabs,
    VoltTabsContent,
    VoltTabsList,
    VoltTabsTrigger,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section id="server-components-code" class="example-section section-wrap">
    <div
      class="section-heading compact"
      [moveInView]="{ opacity: [0, 1], y: [24, 0] }"
      moveInViewOnce="true"
    >
      <p class="eyebrow">SERVER PARENT, CLIENT ISLAND</p>
      <h2>One decorator, one explicit boundary.</h2>
    </div>
    <div class="code-layout" [moveInView]="{ opacity: [0, 1], y: [28, 0] }" moveInViewOnce="true">
      <volt-tabs class="integration-tabs" value="server">
        <volt-tabs-list>
          <volt-tabs-trigger value="server">Server Component</volt-tabs-trigger>
          <volt-tabs-trigger value="client">Client boundary</volt-tabs-trigger>
        </volt-tabs-list>
        <volt-tabs-content value="server"
          ><strata-code-panel filename="product-summary.component.ts" [code]="serverExample"
        /></volt-tabs-content>
        <volt-tabs-content value="client"
          ><strata-code-panel filename="add-to-cart.component.ts" [code]="clientExample"
        /></volt-tabs-content>
      </volt-tabs>
      <volt-card class="example-notes"
        ><volt-card-header>
          <span class="note-number">01</span>
          <volt-card-title>Mark the parent server-only.</volt-card-title> </volt-card-header
        ><volt-card-content>
          <p>
            <code>&#64;ServerComponent()</code> sits on an ordinary <code>&#64;Component</code>. It
            renders with <code>inject()</code> on the server; the browser receives an empty
            surrogate.
          </p>
          <div class="note-rule"></div>
          <span class="note-number">02</span>
          <h3>Name what hydrates.</h3>
          <p>
            <code>[strataClient]</code> marks the child that ships. Its props cross as plain data:
            strings, numbers, booleans and <code>null</code> in a flat object.
          </p>
          <div class="note-rule"></div>
          <span class="note-number">03</span>
          <h3>Experimental, on the <code>next</code> channel.</h3>
          <p>
            <code>&#64;strata-sc/server-components&#64;next</code> is experimental (0.x): the API
            may change before 1.0. It powers this page. Streaming SSR and Router navigation into a
            new Server Component subtree are not supported.
          </p>
        </volt-card-content></volt-card
      >
    </div>
  </section>`,
})
export class ServerComponentsCodeComponent {
  protected readonly serverExample = SERVER_COMPONENT_EXAMPLE;
  protected readonly clientExample = CLIENT_BOUNDARY_EXAMPLE;
}
