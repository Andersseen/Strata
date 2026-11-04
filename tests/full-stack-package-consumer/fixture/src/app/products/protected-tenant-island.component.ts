import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

/** Browser-only behavior: safe tenant prop and one same-origin protected API call. */
@Component({
  selector: "protected-tenant-island",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" data-protected-island (click)="load()">
      Load protected result
    </button>
    <output data-protected-api-result>{{ result() }}</output>`,
})
export class ProtectedTenantIsland {
  readonly tenant = input.required<string>();
  protected readonly result = signal("not loaded");

  protected async load(): Promise<void> {
    try {
      const response = await fetch(
        `/api/protected/${encodeURIComponent(this.tenant())}/products/${encodeURIComponent(this.tenant() + "-product")}`,
      );
      if (!response.ok) {
        this.result.set(`Request denied (${response.status})`);
        return;
      }
      const body = (await response.json()) as { readonly label?: string };
      this.result.set(body.label ?? "Request denied");
    } catch {
      this.result.set("Request unavailable");
    }
  }
}
