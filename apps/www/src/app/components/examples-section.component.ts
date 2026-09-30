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
import { LmnArrowRightIcon } from "lumen-icons/arrow-right";

import { ANALOG_EXAMPLE, CONTROLLER_EXAMPLE, METADATA_EXAMPLE } from "../content";

import { CodePanelComponent } from "./code-panel.component";

@Component({
  selector: "strata-examples-section",
  imports: [
    ...MOVEMENT_DIRECTIVES,
    LmnArrowRightIcon,
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
  template: `<section id="controllers" class="example-section section-wrap">
      <div
        class="section-heading compact"
        [moveInView]="{ opacity: [0, 1], y: [24, 0] }"
        moveInViewOnce="true"
      >
        <p class="eyebrow">STRUCTURED APIs WHEN YOU NEED THEM</p>
        <h2>Controllers for the HTTP side.</h2>
      </div>
      <div class="code-layout" [moveInView]="{ opacity: [0, 1], y: [28, 0] }" moveInViewOnce="true">
        <strata-code-panel filename="users.controller.ts" [code]="controllerExample" />
        <volt-card class="example-notes"
          ><volt-card-header>
            <span class="note-number">01</span>
            <volt-card-title>Start with your domain.</volt-card-title> </volt-card-header
          ><volt-card-content>
            <p>
              Controllers are ordinary classes. <code>&#64;Get</code>, <code>&#64;Post</code>,
              <code>&#64;Put</code>, <code>&#64;Patch</code> and <code>&#64;Delete</code> create
              portable metadata with standard decorators, not a second application model.
            </p>
            <div class="note-rule"></div>
            <span class="note-number">02</span>
            <h3>Attach to a runtime when ready.</h3>
            <p>
              Register the class on Nitro's router from a server plugin with
              <code>&#64;strata-sc/analog</code>. Native routes keep working beside it.
            </p>
            <a href="#analog"
              >See the Analog integration <lmn-arrow-right [size]="16"
            /></a> </volt-card-content
        ></volt-card>
      </div>
    </section>
    <section id="analog" class="analog-section section-wrap">
      <div class="analog-header">
        <div>
          <p class="eyebrow">ANALOG, WITHOUT A DETOUR</p>
          <h2>Native to the Nitro seam.</h2>
        </div>
        <p>
          The Analog adapter registers controllers where Nitro expects them: in a server plugin, on
          the router it already owns.
        </p>
      </div>
      <volt-tabs
        class="integration-tabs"
        value="analog"
        [moveInView]="{ opacity: [0, 1], y: [28, 0] }"
        moveInViewOnce="true"
      >
        <volt-tabs-list>
          <volt-tabs-trigger value="analog">Analog plugin</volt-tabs-trigger>
          <volt-tabs-trigger value="metadata">Route metadata</volt-tabs-trigger>
        </volt-tabs-list>
        <volt-tabs-content value="analog"
          ><strata-code-panel filename="src/server/plugins/strata.ts" [code]="analogExample"
        /></volt-tabs-content>
        <volt-tabs-content value="metadata"
          ><strata-code-panel filename="inspect-routes.ts" [code]="metadataExample"
        /></volt-tabs-content>
      </volt-tabs>
    </section>`,
})
export class ExamplesSectionComponent {
  protected readonly controllerExample = CONTROLLER_EXAMPLE;
  protected readonly analogExample = ANALOG_EXAMPLE;
  protected readonly metadataExample = METADATA_EXAMPLE;
}
