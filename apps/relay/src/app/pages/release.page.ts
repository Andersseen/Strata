import { defineRouteMeta } from "@analogjs/router";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import {
  strataDocumentNavigationGuard,
  StrataDocumentLink,
  StrataDocumentNavigator,
} from "@strata-sc/server-components/navigation";

import { BriefingMetadataServerComponent } from "../server-components/briefing/briefing-metadata.server-component";
import { ReleaseGateServerComponent } from "../server-components/release/release-gate.server-component";

// Server-owned routes are reached by document navigation; the guard cancels any
// Angular Router activation before it can render an empty Server Component.
export const routeMeta = defineRouteMeta({
  canActivate: [strataDocumentNavigationGuard],
});

@Component({
  selector: "relay-release-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReleaseGateServerComponent, BriefingMetadataServerComponent, StrataDocumentLink],
  template: `
    <main class="release-page">
      <header class="release-header">
        <a [strataDocumentLink]="['/']">← Back to operations</a>
        <div>
          <p class="eyebrow">DOCUMENT NAVIGATION EXAMPLE</p>
          <h1>Release gate</h1>
          <p>
            This route uses a full document request because client-router navigation is not
            supported by the current Server Component experiment.
          </p>
          <button type="button" (click)="openIncidentDigest()">Open incident digest</button>
        </div>
      </header>
      <relay-release-gate />
      <section class="briefing-context" aria-labelledby="briefing-context-title">
        <p class="server-label">SERVER COMPONENT / IMPORTED DIRECTLY</p>
        <h2 id="briefing-context-title">Operations briefing context</h2>
        <p>
          The same Server Component the overview nests inside its briefing, imported here by an
          ordinary page. Its own surrogate hydrates the acknowledgement island.
        </p>
        <relay-briefing-metadata />
      </section>
      <section class="implementation-notes" aria-labelledby="implementation-notes-title">
        <p class="server-label">WHAT THIS EXERCISES</p>
        <h2 id="implementation-notes-title">One route, two different graphs.</h2>
        <ol>
          <li>The risk service and release component implementation execute only on the server.</li>
          <li>The server renders the complete assessment and serializes four plain-data props.</li>
          <li>The browser receives a generated surrogate plus only the rollout simulator.</li>
          <li>
            The simulator hydrates as an independent Angular root on the existing SSR element.
          </li>
        </ol>
      </section>
    </main>
  `,
})
export default class ReleasePage {
  private readonly documentNavigator = inject(StrataDocumentNavigator);

  openIncidentDigest(): void {
    this.documentNavigator.navigate(["/incidents"], {
      queryParams: { from: "release" },
      fragment: "incident-digest-title",
    });
  }
}
