import { distribution } from "./deployed.ts";
import type { Distribution } from "./deployed.ts";
import { privateLeaks } from "./full-stack-remote.ts";
import { get } from "./full-stack-verify.ts";
import { check, section } from "./harness.ts";
import { classifyReply, classifyTransportError } from "./response-classification.ts";
import type {
  AnomalySample,
  RequestExpectation,
  ResponseClass,
} from "./response-classification.ts";

/**
 * The controlled controller-concurrency matrix (docs/research/full-stack-cloudflare-concurrency.md).
 *
 * Deterministic, bounded and URL-agnostic: it speaks plain HTTP to a Node server, local workerd or a
 * public deployment. It is a functional correctness probe, NOT load evidence: there is no throughput
 * target, no latency budget, and a green matrix says nothing about production scale.
 *
 * Every request carries a synthetic correlation id; for the `qualification` route the answer must
 * echo exactly that id and the resource that was asked for, so an answer that belongs to another
 * request cannot pass. A failed request is never retried and never turned into a success.
 */

/** The hard ceiling for one URL. `requestBudget` may only lower it. */
export const MAX_REQUESTS_PER_URL = 1_500;
const SAMPLES_PER_ROUND = 3;
const SAMPLES_PER_RUN = 8;

export interface MatrixCase {
  readonly name: string;
  readonly kind: "controller" | "server-component";
  readonly status: number;
  readonly contentType: string;
  /** The public id the answer carries (null: not checked). */
  readonly subject: string | null;
  /** True: the route echoes the synthetic correlation id. */
  readonly correlated: boolean;
  /** Request target for one correlation id. */
  readonly target: (correlation: string) => string;
  /** Exact body for one correlation id; null means "compare to the recorded baseline". */
  readonly body: (correlation: string) => string | null;
  baseline: string | null;
}

const product = (id: string, status: number): MatrixCase => ({
  name: `GET /api/products/${id}`,
  kind: "controller",
  status,
  contentType: "application/json",
  subject: status === 200 ? id : null,
  correlated: false,
  target: (correlation) => `/api/products/${id}?request=${correlation}`,
  body: () => null,
  baseline: null,
});

const resource = (name: string): MatrixCase => {
  const known = name !== "unknown";

  return {
    name: `GET /api/qualification/${name}`,
    kind: "controller",
    status: known ? 200 : 404,
    contentType: "application/json",
    subject: known ? name : null,
    correlated: known,
    target: (correlation) => `/api/qualification/${name}?cid=${correlation}`,
    body: (correlation) =>
      known
        ? JSON.stringify({ resource: name, correlation, path: `/api/qualification/${name}` })
        : JSON.stringify({ error: "not_found" }),
    baseline: null,
  };
};

const page = (id: string): MatrixCase => ({
  name: `GET /products/${id}`,
  kind: "server-component",
  status: 200,
  contentType: "text/html",
  subject: null,
  correlated: false,
  target: (correlation) => `/products/${id}?request=${correlation}`,
  body: () => null,
  baseline: null,
});

/** `/api/products/{42,7,999}`: two 200s then a 404, as the PR #84 gate alternates them. */
export const productCases = (): MatrixCase[] => [
  product("42", 200),
  product("7", 200),
  product("999", 404),
];

/** The qualification-only route: three allowlisted resources and one unknown (404). */
export const correlationCases = (): MatrixCase[] => [
  resource("alpha"),
  resource("beta"),
  resource("gamma"),
  resource("unknown"),
];

export const pageCases = (): MatrixCase[] => [page("42"), page("999")];

export interface RoundResult {
  readonly group: string;
  readonly label: string;
  readonly requests: number;
  readonly concurrency: number;
  readonly matched: number;
  readonly classes: Record<ResponseClass, number>;
  readonly statuses: Record<string, number>;
  readonly expectedNotFound: number;
  readonly unexpectedNotFound: number;
  readonly bodyMismatches: number;
  readonly networkErrors: number;
  readonly latency: Distribution;
  readonly wallMs: number;
  readonly samples: readonly AnomalySample[];
}

export interface MatrixResult {
  readonly target: string;
  readonly baseUrl: string;
  readonly requestsIssued: number;
  readonly requestBudget: number;
  readonly correlationRoute: "present" | "absent";
  readonly rounds: readonly RoundResult[];
  readonly anomalies: number;
  readonly firstSamples: readonly AnomalySample[];
  readonly verdict: "GO" | "NO-GO";
  /** REPRODUCED = at least one answer that is not the expected one in this run. */
  readonly reproduced: "REPRODUCED" | "NOT REPRODUCED";
}

export interface MatrixOptions {
  /** A short name for logs and evidence: node, workerd, deployed. */
  readonly target: string;
  /** Pause between the post-readiness burst and the later rounds; 0 skips the "after stabilization" round. */
  readonly stabilizeMs: number;
  /** Lowers MAX_REQUESTS_PER_URL; never raises it. */
  readonly requestBudget?: number;
  /** Rotate case order by this many positions on each burst. Default true. */
  readonly rotate?: boolean;
  /** Negative controls run the matrix against a faulty stub: no console output, no harness checks. */
  readonly quiet?: boolean;
}

class Budget {
  used = 0;

  readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  take(): void {
    if (this.used >= this.max)
      throw new Error(`request budget of ${this.max} exhausted; the matrix is bounded by design`);
    this.used++;
  }
}

const blankClasses = (): Record<ResponseClass, number> => ({
  match: 0,
  "controller-response-mismatch": 0,
  "edge-response": 0,
  "transport-error": 0,
  unclassified: 0,
});

let serial = 0;
const correlationId = (round: number, index: number): string =>
  `c${round}-${index}-${(serial++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

async function round(
  base: string,
  budget: Budget,
  group: string,
  label: string,
  cases: readonly MatrixCase[],
  requests: number,
  concurrency: number,
  roundNumber: number,
): Promise<RoundResult> {
  const classes = blankClasses();
  const statuses: Record<string, number> = {};
  const samples: AnomalySample[] = [];
  const latencies: number[] = [];
  let expectedNotFound = 0;
  let unexpectedNotFound = 0;
  let bodyMismatches = 0;
  let next = 0;
  const wallStart = performance.now();

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;

      if (index >= requests) return;

      budget.take();

      const kase = cases[index % cases.length]!;
      const correlation = correlationId(roundNumber, index);
      const expectation: RequestExpectation = {
        target: kase.target(correlation),
        status: kase.status,
        contentType: kase.contentType,
        subject: kase.subject,
        correlation: kase.correlated ? correlation : null,
        body: kase.body(correlation) ?? kase.baseline,
      };
      const started = performance.now();

      try {
        const reply = await get(`${base}${expectation.target}`);
        const elapsed = performance.now() - started;
        const verdict = classifyReply(expectation, reply, elapsed, privateLeaks);

        latencies.push(elapsed);
        statuses[String(reply.status)] = (statuses[String(reply.status)] ?? 0) + 1;
        classes[verdict.class]++;
        if (reply.status === 404) {
          if (kase.status === 404 && verdict.class === "match") expectedNotFound++;
          else unexpectedNotFound++;
        }
        if (verdict.sample) {
          if (
            reply.status === kase.status &&
            reply.headers.get("content-type")?.includes(kase.contentType)
          )
            bodyMismatches++;
          if (samples.length < SAMPLES_PER_ROUND) samples.push(verdict.sample);
        }
      } catch (error) {
        classes["transport-error"]++;
        statuses["network-error"] = (statuses["network-error"] ?? 0) + 1;
        if (samples.length < SAMPLES_PER_ROUND)
          samples.push(classifyTransportError(expectation, error, performance.now() - started));
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const networkErrors = classes["transport-error"];

  return {
    group,
    label,
    requests,
    concurrency,
    matched: classes.match,
    classes,
    statuses,
    expectedNotFound,
    unexpectedNotFound,
    bodyMismatches,
    networkErrors,
    latency: distribution(latencies),
    wallMs: Math.round((performance.now() - wallStart) * 10) / 10,
    samples,
  };
}

const rotated = <T>(list: readonly T[], by: number): T[] => [
  ...list.slice(by % list.length),
  ...list.slice(0, by % list.length),
];

export async function runConcurrencyMatrix(
  base: string,
  options: MatrixOptions,
): Promise<MatrixResult> {
  const budget = new Budget(
    Math.min(options.requestBudget ?? MAX_REQUESTS_PER_URL, MAX_REQUESTS_PER_URL),
  );
  const rounds: RoundResult[] = [];
  let roundNumber = 0;
  const log = options.quiet ? (): void => {} : console.log;
  const verify = options.quiet ? (): boolean => true : check;

  if (!options.quiet)
    section(
      `Controller concurrency matrix: ${options.target} ${base} (budget ${budget.max} requests; functional probe, not load evidence)`,
    );

  const products = productCases();
  const pages = pageCases();
  let correlation = correlationCases();

  // Is the qualification route part of this artifact? An older deployment may predate it; that is
  // recorded and the correlation rounds are skipped, never silently treated as passing.
  const probe = await get(`${base}/api/qualification/alpha?cid=probe-0`).catch(() => undefined);

  budget.take();

  const hasRoute =
    probe !== undefined &&
    probe.status === 200 &&
    probe.headers.get("content-type")?.includes("application/json") === true &&
    probe.headers.get("x-fullstack-catalog") !== null;

  if (!hasRoute) correlation = [];
  log(
    `${options.target}: qualification correlation route ${hasRoute ? "present" : "ABSENT in this artifact (correlation rounds skipped)"}`,
  );

  for (const kase of [...products, ...pages]) {
    budget.take();
    kase.baseline = (await get(`${base}${kase.target("baseline-0")}`)).body;
  }

  verify(
    `${options.target}: the alternated resources have distinct baselines (a swapped body is detectable)`,
    new Set(products.map((c) => c.baseline)).size === products.length &&
      new Set(pages.map((c) => c.baseline)).size === pages.length,
  );

  const record = async (
    group: string,
    label: string,
    cases: readonly MatrixCase[],
    requests: number,
    concurrency: number,
  ): Promise<void> => {
    const result = await round(
      base,
      budget,
      group,
      label,
      cases,
      requests,
      concurrency,
      ++roundNumber,
    );

    rounds.push(result);
    log(
      `${options.target} ${group} / ${label}: ${result.matched}/${requests} matched, statuses ${JSON.stringify(result.statuses)}, ` +
        `classes ${JSON.stringify(Object.fromEntries(Object.entries(result.classes).filter(([, n]) => n > 0)))}, ` +
        `ms p50 ${result.latency.p50Ms} p90 ${result.latency.p90Ms} p95 ${result.latency.p95Ms} max ${result.latency.maxMs}`,
    );
    verify(
      `${options.target} ${group} / ${label}: every answer matches the request that was sent`,
      result.matched === requests,
      JSON.stringify(result.samples[0] ?? {}),
    );
  };

  // G. Immediately after readiness: the very first rounds after the readiness gate returned.
  await record(
    "controller-products",
    "G immediately after readiness: 25 concurrent",
    products,
    25,
    25,
  );

  const sets: [string, readonly MatrixCase[]][] = [["controller-products", products]];

  if (correlation.length > 0) sets.push(["controller-correlation", correlation]);

  for (const [group, cases] of sets) {
    const reversed = [...cases].reverse();

    // A. sequential baseline (5 per resource of the products set; 4 resources for the correlation set)
    await record(group, "A sequential baseline", cases, cases.length * 4, 1);
    // B. 10 concurrent, C. 25 concurrent
    await record(group, "B 10 concurrent", cases, 10, 10);
    await record(group, "C 25 concurrent", cases, 25, 25);
    // D. repeated 25-request bursts (E: the sets mix successes with expected 404s by construction)
    for (let burst = 1; burst <= 10; burst++)
      await record(
        group,
        `D burst ${burst}/10: 25 concurrent`,
        options.rotate === false ? cases : rotated(cases, burst),
        25,
        25,
      );
    // F. reversed resource ordering
    await record(group, "F reversed order: 25 concurrent", reversed, 25, 25);
  }

  // H. after a bounded stabilization interval.
  if (options.stabilizeMs > 0) {
    log(`${options.target}: stabilization wait ${options.stabilizeMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, options.stabilizeMs));
    for (const [group, cases] of sets)
      await record(group, "H after stabilization: 25 concurrent", cases, 25, 25);
  }

  // J. combined controller + Server Component traffic.
  const combined: MatrixCase[] = [];
  const longest = Math.max(products.length, correlation.length, pages.length);

  for (let i = 0; i < longest; i++) {
    combined.push(products[i % products.length]!);
    if (correlation.length > 0) combined.push(correlation[i % correlation.length]!);
    combined.push(pages[i % pages.length]!);
  }
  for (let burst = 1; burst <= 4; burst++)
    await record(
      "combined",
      `J burst ${burst}/4: controller + Server Component, 25 concurrent`,
      rotated(combined, burst),
      25,
      25,
    );

  const anomalies = rounds.reduce((sum, r) => sum + (r.requests - r.matched), 0);
  const firstSamples = rounds.flatMap((r) => r.samples).slice(0, SAMPLES_PER_RUN);
  const ok = anomalies === 0;

  log(
    `${options.target}: ${budget.used} requests issued (budget ${budget.max}); ${anomalies} anomalous answer(s); ` +
      `${ok ? "NOT REPRODUCED" : "REPRODUCED"}`,
  );
  for (const sample of firstSamples) log(`anomaly sample: ${JSON.stringify(sample)}`);

  return {
    target: options.target,
    baseUrl: base,
    requestsIssued: budget.used,
    requestBudget: budget.max,
    correlationRoute: hasRoute ? "present" : "absent",
    rounds,
    anomalies,
    firstSamples,
    verdict: ok ? "GO" : "NO-GO",
    reproduced: ok ? "NOT REPRODUCED" : "REPRODUCED",
  };
}
