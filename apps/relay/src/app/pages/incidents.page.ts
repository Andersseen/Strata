import { ChangeDetectionStrategy, Component } from "@angular/core";

import { IncidentDigestServerComponent } from "../server-components/incidents/incident-digest.server-component";

@Component({
  selector: "relay-incidents-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IncidentDigestServerComponent],
  template: `
    <main class="release-page">
      <header class="release-header">
        <a href="/">← Back to operations</a>
        <div>
          <p class="eyebrow">SERVER COMPONENT + CONTROLLERS</p>
          <h1>Incident digest</h1>
          <p>
            The digest is rendered on the server from the same repository the Strata controllers
            write to. Each triage control is a client island that mutates through
            <code>PATCH /api/ops/incidents/:id</code>; reload the page to see the server render the
            new state.
          </p>
        </div>
      </header>
      <relay-incident-digest />
    </main>
  `,
})
export default class IncidentsPage {}
