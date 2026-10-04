import { ChangeDetectionStrategy, Component } from "@angular/core";
import { RouterLink } from "@angular/router";

import { BoundaryProtocolServerComponent } from "../boundary-protocol/boundary-protocol.server-component";

/**
 * Client boundary protocol fixture page. The router link leaves the Server
 * Component through Angular, to observe island teardown.
 */
@Component({
  selector: "app-server-component-boundaries-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BoundaryProtocolServerComponent, RouterLink],
  template: `<main>
      <boundary-protocol />
    </main>
    <nav>
      <a routerLink="/server-component-navigation">Leave (router)</a>
    </nav>`,
})
export default class ServerComponentBoundariesPage {}
