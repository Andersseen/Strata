import { ChangeDetectionStrategy, Component } from "@angular/core";
import { RouterLink } from "@angular/router";

import { FailureHostServerComponent } from "../server-component-failure/failure-host.server-component";

/**
 * Multi-host fixture of `pnpm test:server-component-failures`: three
 * independent Server Component hosts (A, B, C), the healthy origin of the
 * document-navigation checks (a plain anchor into a failing route), and a
 * router link out of the page to observe teardown.
 */
@Component({
  selector: "app-server-component-failures-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FailureHostServerComponent, RouterLink],
  template: `<main>
      <h1>Server Component failures</h1>
      <failure-host data-host="A" />
      <failure-host data-host="B" />
      <failure-host data-host="C" />
    </main>
    <nav>
      <a href="/server-component-failure/constructor">Failing document</a>
      <a routerLink="/server-component-navigation">Leave (router)</a>
    </nav>`,
})
export default class ServerComponentFailuresPage {}
