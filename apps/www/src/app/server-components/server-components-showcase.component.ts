import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { ServerComponentDemoComponent } from "./server-component-demo.component";
import { ServerComponentFactsRepository } from "./server-component-facts.repository";

// Qualification evidence (`pnpm test:www:server-components`); never rendered as text.
const SERVER_COMPONENT_MARKER = "STRATA_WWW_SERVER_COMPONENT_MARKER";

/**
 * The landing's Server Component section, rendered by the private, experimental
 * @strata-sc/server-components package. In the browser graph the Vite plugin
 * replaces this module with a generated surrogate, so neither this class nor
 * ServerComponentFactsRepository (nor what that imports) ships. Only
 * ServerComponentDemoComponent, marked `[strataClient]`, hydrates.
 *
 * The template is plain HTML on purpose: an unmarked child *component* inside
 * a Server Component is not qualified yet, so Volt UI and Lumen Icons live in
 * the client island.
 */
@ServerComponent()
@Component({
  selector: "strata-server-components-showcase",
  imports: [ServerComponentDemoComponent, StrataClientBoundary],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section
    id="server-components"
    class="sc-section section-wrap"
    aria-labelledby="server-components-title"
    [attr.data-server-evidence]="evidence"
  >
    <div class="sc-heading">
      <p class="sc-status">
        <span class="status-pill status-pill-accent">Experimental</span
        ><span class="status-pill">Preview</span>
      </p>
      <p class="eyebrow">STRATA SERVER COMPONENTS</p>
      <h2 id="server-components-title">Angular components that stay on the server.</h2>
      <p>
        Server Components run Angular components on the server without shipping their implementation
        or server dependencies to the browser. Interactive children stay interactive: only explicit
        client boundaries hydrate.
      </p>
    </div>

    <div class="sc-grid">
      <figure class="sc-graph" aria-labelledby="sc-graph-caption">
        <figcaption id="sc-graph-caption">This section’s module graph</figcaption>
        <div class="sc-tree" role="list">
          @for (module of facts.graph; track module.name; let first = $first) {
            <div
              class="sc-node"
              role="listitem"
              [class.sc-node-root]="first"
              [class.sc-node-client]="module.runtime === 'browser'"
            >
              <code>{{ module.name }}</code>
              <small>{{ module.role }}</small>
              <span class="sc-runtime" [class.sc-runtime-browser]="module.runtime === 'browser'">
                {{ module.runtime === "browser" ? "→ browser" : "server" }}
              </span>
            </div>
          }
        </div>
        <table class="sc-ledger">
          <caption>
            Shipped to the browser?
          </caption>
          <tbody>
            @for (module of facts.graph; track module.name) {
              <tr>
                <th scope="row">{{ module.name }}</th>
                <td [class.sc-yes]="module.runtime === 'browser'">
                  @if (module.runtime === "browser") {
                    <span aria-hidden="true">✓</span> browser
                  } @else {
                    <span aria-hidden="true">✗</span> server only
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </figure>

      <div class="sc-proof" aria-labelledby="sc-proof-title">
        <p class="sc-proof-kicker">Live · rendered on the server</p>
        <h3 id="sc-proof-title">This panel is the proof.</h3>
        <dl class="sc-facts">
          <div>
            <dt>Server Component</dt>
            <dd>{{ componentId }}</dd>
          </div>
          <div>
            <dt>Implementation</dt>
            <dd class="sc-yes">server only <span aria-hidden="true">✓</span></dd>
          </div>
          <div>
            <dt>Data dependency</dt>
            <dd class="sc-yes">server only <span aria-hidden="true">✓</span></dd>
          </div>
          <div>
            <dt>Rendered by</dt>
            <dd>{{ facts.runtime }}</dd>
          </div>
        </dl>
        <strata-server-demo
          [label]="facts.islandLabel"
          [componentId]="componentId"
          [serverOnlyModules]="facts.serverOnlyModules"
          [strataClient]="{
            label: facts.islandLabel,
            componentId: componentId,
            serverOnlyModules: facts.serverOnlyModules,
          }"
        />
      </div>
    </div>

    <div class="sc-notes">
      <p>
        <b>Preview status.</b> Currently dogfooded in this site and qualified in the repository on
        Node/Nitro and Cloudflare workerd. The public package is not released yet.
      </p>
      <p>
        <b>Navigation.</b> The preview supports initial and document navigation. Angular Router SPA
        navigation into a new Server Component subtree is not supported yet.
      </p>
    </div>
  </section>`,
})
export class ServerComponentsShowcaseComponent {
  private readonly repository = inject(ServerComponentFactsRepository);

  protected readonly facts = this.repository.getFacts();
  protected readonly componentId =
    this.facts.graph.find((module) => module.role === "Server Component")?.name ?? "unknown";
  protected readonly evidence = `${this.repository.evidenceFor(SERVER_COMPONENT_MARKER)}.${this.facts.provenance}`;
}
