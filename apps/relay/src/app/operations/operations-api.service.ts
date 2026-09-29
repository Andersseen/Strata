import { Injectable, computed, signal } from "@angular/core";

import type {
  CreateIncidentInput,
  Environment,
  IncidentStatus,
  OperationsSnapshot,
  Service,
} from "../../shared/operations.models";

interface NativeHealth {
  readonly status: string;
  readonly source: string;
  readonly checkedAt: string;
}

@Injectable({ providedIn: "root" })
export class OperationsApi {
  readonly environment = signal<Environment>("production");
  readonly snapshot = signal<OperationsSnapshot | null>(null);
  readonly health = signal<NativeHealth | null>(null);
  readonly selectedService = signal<Service | null>(null);
  readonly loading = signal(false);
  readonly mutating = signal(false);
  readonly error = signal<string | null>(null);

  readonly activeIncidents = computed(
    () => this.snapshot()?.incidents.filter((incident) => incident.status !== "resolved") ?? [],
  );
  readonly healthyServices = computed(
    () => this.snapshot()?.services.filter((service) => service.status === "healthy").length ?? 0,
  );
  readonly averageLatency = computed(() => {
    const services = this.snapshot()?.services ?? [];
    if (services.length === 0) return 0;
    return Math.round(
      services.reduce((total, service) => total + service.latencyMs, 0) / services.length,
    );
  });

  async changeEnvironment(environment: Environment): Promise<void> {
    if (environment === this.environment()) return;
    this.environment.set(environment);
    this.selectedService.set(null);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      const [snapshot, health] = await Promise.all([
        this.request<OperationsSnapshot>(
          `/api/ops/snapshot?environment=${encodeURIComponent(this.environment())}`,
        ),
        this.request<NativeHealth>("/api/ops/health"),
      ]);
      this.snapshot.set(snapshot);
      this.health.set(health);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : "Relay could not reach the API.");
    } finally {
      this.loading.set(false);
    }
  }

  async inspectService(id: string): Promise<void> {
    this.error.set(null);
    try {
      this.selectedService.set(await this.request<Service>(`/api/ops/services/${id}`));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : "The service could not be loaded.");
    }
  }

  async createIncident(input: CreateIncidentInput): Promise<boolean> {
    return this.mutate("/api/ops/incidents", "POST", input);
  }

  async updateIncident(id: string, status: IncidentStatus): Promise<boolean> {
    return this.mutate(`/api/ops/incidents/${id}`, "PATCH", { status });
  }

  private async mutate(path: string, method: "POST" | "PATCH", body: object): Promise<boolean> {
    this.mutating.set(true);
    this.error.set(null);
    try {
      await this.request(path, { method, body: JSON.stringify(body) });
      await this.refresh();
      return true;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : "The change could not be saved.");
      return false;
    } finally {
      this.mutating.set(false);
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-relay-request": crypto.randomUUID(),
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}.`);
    }

    return (await response.json()) as T;
  }
}
