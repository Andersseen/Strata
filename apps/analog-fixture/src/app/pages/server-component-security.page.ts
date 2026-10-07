import { ChangeDetectionStrategy, Component } from "@angular/core";

import { SecurityServerComponent } from "../server-component-security/security.server-component";

/**
 * Server Component data-confidentiality fixture
 * (docs/research/server-component-data-security.md): a server-only repository
 * uses a DATA canary; only a safe verdict and an explicit PUBLIC control cross.
 */
@Component({
  selector: "app-server-component-security-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SecurityServerComponent],
  template: `<main><security-surface /></main>`,
})
export default class ServerComponentSecurityPage {}
