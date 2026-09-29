import { ChangeDetectionStrategy, Component } from "@angular/core";

import { ReleaseGateServerComponent } from "../server-components/release/release-gate.server-component";

@Component({
  selector: "relay-release-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReleaseGateServerComponent],
  template: `
    <main class="release-page">
      <header class="release-header">
        <a href="/">← Back to operations</a>
        <div>
          <p class="eyebrow">DOCUMENT NAVIGATION EXAMPLE</p>
          <h1>Release gate</h1>
          <p>
            This route uses a full document request because client-router navigation is not
            supported by the current Server Component experiment.
          </p>
        </div>
      </header>
      <relay-release-gate />
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
export default class ReleasePage {}
