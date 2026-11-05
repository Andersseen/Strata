import { Injectable, InjectionToken, inject } from "@angular/core";
import type { OnDestroy } from "@angular/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

/**
 * Consumer-owned request lifecycle for the composed packed-package matrix
 * (docs/research/m3-m4-contract-stabilization.md). Everything here is
 * application code: Strata only provides `registerControllers`, its guard,
 * interceptor, factory, cleanup and observation contracts.
 */

// Server-only values: they must reach the Nitro server output and never a browser file.
export const COMPOSITION_MARKER = "STRATA_PACKED_DI_COMPOSITION_SERVER_MARKER";
export const COMPOSITION_PRIVATE_CANARY = "PACKED_PRIVATE_COMPOSITION_CANARY";

export const COMPOSITION_REQUEST = new InjectionToken<StrataAnalogRequest>(
  "PACKED_COMPOSITION_REQUEST",
);
export const COMPOSITION_PRINCIPAL = new InjectionToken<"alpha" | "beta">(
  "PACKED_COMPOSITION_PRINCIPAL",
);
/** A request provider whose factory fails on demand: a provider resolution failure. */
export const COMPOSITION_AUDIT_SINK = new InjectionToken<string>("PACKED_COMPOSITION_AUDIT_SINK");

export const compositionStats = {
  guardEntered: 0,
  guardCleanups: 0,
  interceptorEntries: 0,
  interceptorCleanups: 0,
  factoryCalls: 0,
  injectorsCreated: 0,
  injectorsDestroyed: 0,
  live: 0,
  maxLive: 0,
  identitiesCreated: 0,
  identitiesDestroyed: 0,
  controllersConstructed: 0,
  controllersDestroyed: 0,
  handlerCalls: 0,
  cleanupRuns: 0,
  duplicateCleanups: 0,
  observations: 0,
  observationsWithoutTrace: 0,
};

export interface CompletedTrace {
  readonly outcome: string;
  readonly status: number | null;
  readonly phase: string;
  readonly cleanup: string;
  readonly steps: readonly string[];
}

/** Open traces by Strata correlation id, then completed ones by the scenario's own label. */
const open = new Map<string, { readonly label: string; readonly steps: string[] }>();
export const completed = new Map<string, CompletedTrace>();
const MAX_COMPLETED = 256;

export function openTrace(request: StrataAnalogRequest): void {
  const id = request.correlationId;
  if (!id) throw new Error("requestCorrelation is not enabled for the composition routes.");
  const label = typeof request.query["trace"] === "string" ? request.query["trace"] : "";
  open.set(id, { label, steps: ["guard"] });
}

export function step(request: StrataAnalogRequest, name: string): void {
  const id = request.correlationId;
  if (id) open.get(id)?.steps.push(name);
}

export function stepsOf(request: StrataAnalogRequest): readonly string[] {
  return [...(open.get(request.correlationId ?? "")?.steps ?? [])];
}

export function closeTrace(
  correlationId: string | undefined,
  settled: Omit<CompletedTrace, "steps">,
): void {
  compositionStats.observations++;
  const trace = correlationId ? open.get(correlationId) : undefined;
  if (!trace || !correlationId) {
    compositionStats.observationsWithoutTrace++;
    return;
  }
  open.delete(correlationId);
  trace.steps.push("observed");
  if (trace.label && completed.size < MAX_COMPLETED) {
    completed.set(trace.label, { ...settled, steps: trace.steps });
  }
}

/** Registers a cleanup that counts every run, so a second run of the same callback is visible. */
export function onceCounted(
  onCleanup: (cleanup: () => void | Promise<void>) => void,
  request: StrataAnalogRequest,
  name: string,
  work: () => void,
  failure?: string,
): void {
  let ran = false;
  onCleanup(() => {
    if (ran) compositionStats.duplicateCleanups++;
    ran = true;
    compositionStats.cleanupRuns++;
    step(request, `cleanup:${name}`);
    work();
    if (failure) throw new Error(`${failure} ${COMPOSITION_PRIVATE_CANARY}`);
  });
}

const meetings = new Map<
  string,
  { arrived: number; release: (met: boolean) => void; met: Promise<boolean> }
>();

/**
 * Resolves `true` once `size` handlers with the same key are suspended here at the same time:
 * deterministic proof of overlap, no sleep. The timeout only bounds a broken run.
 */
export function rendezvous(key: string, size: number, timeoutMs = 5_000): Promise<boolean> {
  let meeting = meetings.get(key);
  if (!meeting) {
    let release!: (met: boolean) => void;
    const met = new Promise<boolean>((resolve) => (release = resolve));
    meeting = { arrived: 0, release, met };
    meetings.set(key, meeting);
    const timer = setTimeout(() => {
      meetings.delete(key);
      release(false);
    }, timeoutMs);
    void met.then(() => clearTimeout(timer));
  }
  meeting.arrived++;
  if (meeting.arrived === size) {
    meetings.delete(key);
    meeting.release(true);
  }
  return meeting.met;
}

let catalogInstances = 0;

@Injectable({ providedIn: "root" })
export class CompositionCatalog {
  readonly instance = ++catalogInstances;
  product(id: number) {
    return { id, name: `Product ${id}` };
  }
}

let identities = 0;

@Injectable()
export class CompositionIdentity implements OnDestroy {
  readonly id = ++identities;
  readonly request = inject(COMPOSITION_REQUEST);
  readonly principal = inject(COMPOSITION_PRINCIPAL);

  constructor() {
    compositionStats.identitiesCreated++;
  }

  ngOnDestroy() {
    compositionStats.identitiesDestroyed++;
  }
}
