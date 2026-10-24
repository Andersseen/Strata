import type { Report, Runtime } from "./streaming.ts";

/**
 * Observations of `onRequestSettled` on the real fixture
 * (docs/research/analog-request-observability-v08.md). The fixture records every
 * observation, and the cleanup that preceded it, in a log a separate unobserved
 * route returns, so the observer's output is verified independently of the HTTP
 * response the client saw.
 */

const CANARY = "fixture-observed-private-canary";
const OBSERVED = "/api/strata/observed";
const LOG = "/api/strata/observed-log";

type Entry =
  | { readonly kind: "cleanup"; readonly resource: string }
  | {
      readonly kind: "observation";
      readonly observation: {
        readonly route: { readonly method: string; readonly path: string };
        readonly outcome: string;
        readonly status: number | null | undefined;
        readonly phase: string;
        readonly streaming: boolean;
        readonly cleanup: string;
        readonly invocationMs: number;
        readonly elapsedMs: number;
      };
    };

async function readLog(baseUrl: string): Promise<Entry[]> {
  return (await (await fetch(`${baseUrl}${LOG}`)).json()) as Entry[];
}

async function reset(baseUrl: string): Promise<void> {
  await fetch(`${baseUrl}${LOG}/reset`, { method: "POST" });
}

/** The dev server pretty-prints JSON; the body is compared as data, not as bytes. */
function sameJson(text: string, expected: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

const observations = (log: readonly Entry[]) =>
  log.flatMap((entry) => (entry.kind === "observation" ? [entry.observation] : []));

export interface ObservabilityObservation {
  readonly outcomes: readonly string[];
}

export async function observeObservability(
  baseUrl: string,
  runtime: Runtime,
  report: Report,
  output: () => string,
): Promise<ObservabilityObservation> {
  const label = `${runtime}:`;
  const outcomes: string[] = [];

  // 1. An ordinary request. Route parameter, query and headers carry synthetic secrets.
  await reset(baseUrl);
  const ok = await fetch(`${baseUrl}${OBSERVED}/ok/${CANARY}-param?token=${CANARY}-query`, {
    headers: { authorization: `Bearer ${CANARY}`, cookie: `session=${CANARY}` },
  });
  report(`${label} observed route answers unchanged`, ok.status === 200);
  const okBody = await ok.text();
  report(`${label} observed route body unchanged`, sameJson(okBody, { ok: true }), okBody);
  let log = await readLog(baseUrl);
  let seen = observations(log);
  report(
    `${label} one observation, after its cleanup`,
    log.length === 2 && log[0]?.kind === "cleanup" && log[1]?.kind === "observation",
    JSON.stringify(log),
  );
  report(
    `${label} completed observation carries the registered route`,
    seen[0]?.outcome === "completed" &&
      seen[0].route.path === `${OBSERVED}/ok/:id` &&
      seen[0].route.method === "GET" &&
      seen[0].cleanup === "completed" &&
      seen[0].streaming === false,
    JSON.stringify(seen[0]),
  );
  report(
    `${label} observation holds no request secret`,
    !JSON.stringify(seen).includes(CANARY) && !JSON.stringify(seen).includes("token"),
  );
  outcomes.push(seen[0]?.outcome ?? "none");

  // 2. An expected application error.
  await reset(baseUrl);
  const expected = await fetch(`${baseUrl}${OBSERVED}/expected`);
  const expectedBody = await expected.text();
  report(
    `${label} expected error response unchanged`,
    expected.status === 409 && sameJson(expectedBody, { error: "conflict" }),
    `${String(expected.status)} ${expectedBody}`,
  );
  log = await readLog(baseUrl);
  seen = observations(log);
  report(
    `${label} expected error observed once, status 409, no private text`,
    seen.length === 1 &&
      seen[0]?.outcome === "application-error" &&
      seen[0].status === 409 &&
      !JSON.stringify(log).includes(CANARY),
    JSON.stringify(seen),
  );
  outcomes.push(seen[0]?.outcome ?? "none");

  // 3. An unexpected failure still reaches Nitro; Strata does not invent its status.
  await reset(baseUrl);
  const unexpected = await fetch(`${baseUrl}${OBSERVED}/unexpected`);
  await unexpected.text();
  report(`${label} unexpected failure still answers 5xx`, unexpected.status >= 500);
  log = await readLog(baseUrl);
  seen = observations(log);
  report(
    `${label} unexpected failure observed once, status unknown, no private text`,
    seen.length === 1 &&
      seen[0]?.outcome === "failed" &&
      (seen[0].status === undefined || seen[0].status === null) &&
      !JSON.stringify(log).includes(CANARY),
    JSON.stringify(seen),
  );
  outcomes.push(seen[0]?.outcome ?? "none");

  // 4. An owned stream: no observation at handler return, one after the body ends.
  await reset(baseUrl);
  const streamed = await fetch(`${baseUrl}${OBSERVED}/stream`);
  const text = await streamed.text();
  report(`${label} streamed body unchanged`, streamed.status === 200 && text === "one;two;three;");
  log = await readLog(baseUrl);
  seen = observations(log);
  report(
    `${label} stream observed once, after cleanup, as completed`,
    seen.length === 1 &&
      seen[0]?.outcome === "stream-completed" &&
      seen[0].streaming &&
      seen[0].phase === "stream" &&
      seen[0].elapsedMs >= seen[0].invocationMs &&
      log.map((entry) => entry.kind).join() === "cleanup,observation",
    JSON.stringify(log),
  );
  outcomes.push(seen[0]?.outcome ?? "none");

  // 5. Native Nitro routes are not observed and keep working.
  await reset(baseUrl);
  const native = await fetch(`${baseUrl}/api/native`);
  report(`${label} native Nitro route still answers`, native.status === 200);
  const health = await fetch(`${baseUrl}/api/health`);
  report(`${label} native health route still answers`, health.status === 200);
  report(`${label} native routes add no observation`, (await readLog(baseUrl)).length === 0);

  // 6. The consumer's own structured logger line reached the process output. A runtime may
  // forward console output asynchronously, so this waits for it instead of reading once.
  const logLines = (): string[] =>
    output()
      .split("\n")
      .filter((line) => line.includes("strata.request"));
  const deadline = Date.now() + (runtime === "workerd" ? 2_000 : 10_000);
  while (logLines().length < 4 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const lines = logLines();
  if (runtime === "workerd") {
    // Measured: Wrangler's captured output does not carry the Worker's console.log.
    console.log(`${label} consumer logger lines in captured wrangler output: ${lines.length}`);
  } else {
    report(
      `${label} consumer logger line reached the process output`,
      lines.length >= 4,
      lines.slice(0, 2).join(" | "),
    );
  }
  report(`${label} no private canary in the process log lines`, !lines.join("\n").includes(CANARY));

  return { outcomes };
}
