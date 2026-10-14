import { ChangeDetectionStrategy, Component, PendingTasks, inject, signal } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { AuthorizationIslandComponent } from "./authorization-island.component";
import { AuthorizationReadTrace } from "./authorization-resource";
import { AuthorizationRepository } from "./authorization.repository";
import { AuthorizationService } from "./authorization.service";
import type { AuthorizationResult } from "./authorization.service";

@ServerComponent()
@Component({
  selector: "server-component-authorized",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthorizationIslandComponent, StrataClientBoundary],
  providers: [AuthorizationReadTrace, AuthorizationRepository, AuthorizationService],
  template: `@let current = result();
    @switch (current.kind) {
      @case ("loading") {
        <section data-auth-state="loading"><p>Loading resource.</p></section>
      }
      @case ("authorized") {
        <section
          data-auth-state="authorized"
          [attr.data-auth-principal]="current.tenant"
          [attr.data-resource-read]="current.readTenant"
        >
          <h2>{{ current.publicLabel }}</h2>
          <authorization-island
            [tenant]="current.tenant"
            [strataClient]="{ tenant: current.tenant }"
          />
        </section>
      }
      @case ("unauthenticated") {
        <section data-auth-state="unauthenticated" data-resource-read="none" role="alert">
          <h2>Sign-in required</h2>
          <p>This resource is not available without authorization.</p>
        </section>
      }
      @case ("forbidden") {
        <section data-auth-state="forbidden" data-resource-read="none" role="alert">
          <h2>Access denied</h2>
          <p>You cannot access this resource.</p>
        </section>
      }
      @default {
        <section data-auth-state="not-found" data-resource-read="none" role="alert">
          <h2>Resource not found</h2>
          <p>We could not find that resource.</p>
        </section>
      }
    }`,
})
export class AuthorizationServerComponent {
  private readonly service = inject(AuthorizationService);
  protected readonly result = signal<AuthorizationResult>({ kind: "loading" });

  constructor() {
    void inject(PendingTasks).run(async () => {
      this.result.set(await this.service.read());
    });
  }
}
