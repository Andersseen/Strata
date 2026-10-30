import type { Report, Runtime } from "./streaming.ts";

/**
 * Observations of `requestCorrelation` on the real fixture
 * (docs/research/analog-request-correlation-v012.md). The fixture records, per stage, the id each
 * stage saw, plus every observation, in a log an uncorrelated, unobserved route returns.
 */

const CANARY = "fixture-correlated-private-canary";
const BASE = "/api/strata/correlated";
const LOG = "/api/strata/correlated-log";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OVERLAP = 24;

interface Stage {
  readonly kind: "stage";
  readonly stage: string;
  readonly tag: string;
  readonly correlationId: string | undefined;
}
interface Observation {
  readonly kind: "observation";
  readonly observation: { readonly outcome: string; readonly correlationId?: string };
}
type Entry = Stage | Observation;

const readLog = async (baseUrl: string): Promise<Entry[]> =>
  (await (await fetch(`${baseUrl}${LOG}`)).json()) as Entry[];
const reset = async (baseUrl: string): Promise<void> => {
  await fetch(`${baseUrl}${LOG}/reset`, { method: "POST" });
};
const stages = (log: readonly Entry[], tag: string): Stage[] =>
  log.filter((e): e is Stage => e.kind === "stage" && e.tag === tag);
const observed = (log: readonly Entry[]) =>
  log.flatMap((e) => (e.kind === "observation" ? [e.observation] : []));

const FULL = ["guard", "interceptor", "factory", "handler:before", "handler:after", "cleanup"];

export async function observeCorrelation(
  baseUrl: string,
  runtime: Runtime,
  report: Report,
): Promise<{ readonly overlapping: number; readonly outcomes: readonly string[] }> {
  const label = `${runtime}:`;
  const outcomes: string[] = [];

  // 1. One request: the same id at every stage and in the observation.
  await reset(baseUrl);
  const ok = await fetch(`${baseUrl}${BASE}/ok/${CANARY}-param?tag=one&q=${CANARY}`, {
    headers: {
      authorization: `Bearer ${CANARY}`,
      cookie: `session=${CANARY}`,
      "x-request-id": "client-chosen-id",
    },
  });
  const okBody = await ok.text();
  report(`${label} correlated route answers unchanged`, ok.status === 200 && okBody.includes("ok"));
  report(
    `${label} no automatic correlation response header`,
    [...ok.headers.keys()].every((name) => !/correlation|request-id/i.test(name)),
  );
  report(`${label} response body carries no id`, !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(okBody));
  let log = await readLog(baseUrl);
  const mine = stages(log, "one");
  const ids = new Set([
    ...mine.map((s) => s.correlationId),
    ...observed(log).map((o) => o.correlationId),
  ]);
  report(
    `${label} guard, interceptor, factory, handler (before/after await), cleanup and observer share one id`,
    FULL.every((name) => mine.some((s) => s.stage === name)) &&
      ids.size === 1 &&
      UUID.test([...ids][0] ?? ""),
    JSON.stringify(log),
  );
  report(
    `${label} id is not the client-supplied value and no request secret is recorded`,
    !ids.has("client-chosen-id") && !JSON.stringify(log).includes(CANARY),
  );
  outcomes.push(observed(log)[0]?.outcome ?? "none");

  // 2. Overlapping requests with distinct synthetic identities.
  await reset(baseUrl);
  const tags = Array.from({ length: OVERLAP }, (_, i) => `user-${String(i)}-${"x".repeat(i % 7)}`);
  const responses = await Promise.all(
    tags.map((tag) => fetch(`${baseUrl}${BASE}/ok/${tag}?tag=${tag}`)),
  );
  await Promise.all(responses.map((r) => r.text()));
  log = await readLog(baseUrl);
  const perTag = tags.map((tag) => new Set(stages(log, tag).map((s) => s.correlationId)));
  const allIds = perTag.map((set) => [...set][0]);
  report(
    `${label} ${String(OVERLAP)} overlapping requests: one id each, all stages agree`,
    perTag.every((set) => set.size === 1) &&
      tags.every((tag) => stages(log, tag).length === FULL.length),
  );
  report(
    `${label} ${String(OVERLAP)} overlapping requests: ids are unique`,
    new Set(allIds).size === OVERLAP,
  );
  const obsIds = observed(log).map((o) => o.correlationId);
  report(
    `${label} each overlapping request has exactly one matching observation`,
    obsIds.length === OVERLAP && [...obsIds].sort().join() === [...allIds].sort().join(),
  );
  outcomes.push("overlap");

  // 3. Guard denial: no controller, same id in guard and observation.
  await reset(baseUrl);
  const denied = await fetch(`${baseUrl}${BASE}/ok/x?tag=deny&deny=1`);
  await denied.text();
  log = await readLog(baseUrl);
  const deniedStages = stages(log, "deny");
  report(`${label} guard denial still answers 403`, denied.status === 403);
  report(
    `${label} guard denial: only the guard ran, observer has the same id`,
    deniedStages.length === 1 &&
      observed(log)[0]?.outcome === "guard-denied" &&
      observed(log)[0]?.correlationId === deniedStages[0]?.correlationId,
    JSON.stringify(log),
  );
  outcomes.push("guard-denied");

  // 4. Input rejection keeps its status.
  await reset(baseUrl);
  const bad = await fetch(`${baseUrl}${BASE}/validated?tag=bad`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ n: CANARY }),
  });
  const badBody = await bad.text();
  log = await readLog(baseUrl);
  report(
    `${label} invalid input still answers 400 without detail`,
    bad.status === 400 && !badBody.includes("fixture-private"),
  );
  report(
    `${label} input rejection observed with the id`,
    observed(log)[0]?.outcome === "input-rejected" &&
      UUID.test(observed(log)[0]?.correlationId ?? ""),
  );
  outcomes.push("input-rejected");

  // 5. Valid POST.
  await reset(baseUrl);
  const post = await fetch(`${baseUrl}${BASE}/validated?tag=post`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ n: 3 }),
  });
  report(
    `${label} validated POST answers unchanged`,
    post.status === 200 && (await post.text()).includes("3"),
  );
  log = await readLog(baseUrl);
  report(
    `${label} validated POST observed as completed`,
    observed(log)[0]?.outcome === "completed",
  );

  // 6. Unexpected error stays an error and leaks nothing.
  await reset(baseUrl);
  const boom = await fetch(`${baseUrl}${BASE}/unexpected?tag=boom`);
  await boom.text();
  log = await readLog(baseUrl);
  report(`${label} unexpected failure still answers 5xx`, boom.status >= 500);
  report(
    `${label} unexpected failure: observed as failed with the id, no private text`,
    observed(log)[0]?.outcome === "failed" &&
      observed(log)[0]?.correlationId === stages(log, "boom")[0]?.correlationId &&
      !JSON.stringify(log).includes(CANARY),
  );
  outcomes.push("failed");

  // 7. Stream: id kept until the body ends; one observation, after cleanup.
  await reset(baseUrl);
  const stream = await fetch(`${baseUrl}${BASE}/stream?tag=stream`);
  const text = await stream.text();
  log = await readLog(baseUrl);
  const streamIds = new Set([
    ...stages(log, "stream").map((s) => s.correlationId),
    ...observed(log).map((o) => o.correlationId),
  ]);
  report(`${label} streamed body unchanged`, stream.status === 200 && text === "one;two;");
  report(
    `${label} stream observed once with the same id, after cleanup`,
    observed(log).length === 1 &&
      observed(log)[0]?.outcome === "stream-completed" &&
      streamIds.size === 1,
    JSON.stringify(log),
  );
  outcomes.push("stream-completed");

  // 8. Native Nitro routes are not touched.
  await reset(baseUrl);
  const native = await fetch(`${baseUrl}/api/native`);
  report(`${label} native Nitro route still answers`, native.status === 200);
  report(
    `${label} native routes add no correlation entries`,
    (await readLog(baseUrl)).length === 0,
  );

  return { overlapping: OVERLAP, outcomes };
}
