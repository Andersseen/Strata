import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Observations of `streamResponse()` and of a real Analog server function in the
 * fixture (docs/research/analog-stream-lifecycle-v07.md). One set of checks runs
 * against the Node production server, the Vite dev server and Wrangler's local
 * Pages runtime (workerd), so a transport difference is a recorded result, not
 * a different test.
 */

export const STREAM_CANARY = "fixture-stream-private-canary";
export const SERVER_FN_CANARY = "fixture-serverfn-private-canary";

export type Runtime = "node" | "dev" | "workerd";

export type Report = (name: string, passed: boolean, detail?: string) => boolean;

interface Stats {
  readonly opened: number;
  readonly closed: number;
  readonly cleanups: number;
  readonly open: readonly string[];
}

const decoder = new TextDecoder();
const STREAM = "/api/strata/stream";

type Step =
  | { readonly kind: "chunk"; readonly text: string }
  | { readonly kind: "done" }
  | { readonly kind: "error" }
  | { readonly kind: "timeout" };

const pending = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, Promise<Step>>();

/**
 * One read with a bound: a buffering transport shows up as `timeout`, never as a hang. A read
 * that timed out stays pending and is reused by the next call, so no chunk is lost to it.
 */
async function step(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  milliseconds = 10_000,
): Promise<Step> {
  let read = pending.get(reader);
  if (!read) {
    read = reader.read().then(
      (result): Step =>
        result.done ? { kind: "done" } : { kind: "chunk", text: decoder.decode(result.value) },
      (): Step => ({ kind: "error" }),
    );
    pending.set(reader, read);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Step>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), milliseconds);
  });
  try {
    const result = await Promise.race([read, timeout]);
    if (result.kind !== "timeout") pending.delete(reader);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads until the body ends, fails or stalls; chunks may be coalesced by the transport. */
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  milliseconds = 10_000,
): Promise<{ readonly text: string; readonly end: "done" | "error" | "timeout" }> {
  let text = "";
  for (;;) {
    const next = await step(reader, milliseconds);
    if (next.kind === "chunk") text += next.text;
    else return { text, end: next.kind };
  }
}

async function open(baseUrl: string, path: string, signal?: AbortSignal) {
  const response = await fetch(`${baseUrl}${path}`, signal ? { signal } : {});
  if (!response.body) throw new Error(`${path}: no response body`);
  return { response, reader: response.body.getReader() };
}

async function stats(baseUrl: string): Promise<Stats> {
  return (await (await fetch(`${baseUrl}${STREAM}/stats`)).json()) as Stats;
}

async function release(baseUrl: string, id: string): Promise<void> {
  await fetch(`${baseUrl}${STREAM}/release?id=${id}`, { method: "POST" });
}

async function until(condition: () => Promise<boolean>, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const describeStep = (value: Step): string =>
  value.kind === "chunk" ? `chunk ${JSON.stringify(value.text)}` : value.kind;

export interface StreamingObservation {
  /** Whether the transport delivered a gated body incrementally, from a route with no Strata code. */
  readonly transport: "incremental" | "buffered";
  /** What a client sees after a native stream, and a Strata stream, fail mid-body. */
  readonly nativeFailure: string;
  readonly strataFailure: string;
  /** What happened to the reader after the client disconnected mid-body. */
  readonly disconnect: string;
}

interface Outcome {
  readonly status: number;
  readonly text: string;
  readonly end: "done" | "error" | "timeout";
}

async function outcomeOf(baseUrl: string, path: string, window = 3_000): Promise<Outcome> {
  const { response, reader } = await open(baseUrl, path);
  const drained = await drain(reader, window);
  await reader.cancel().catch(() => undefined);
  return { status: response.status, ...drained };
}

const describeOutcome = (outcome: Outcome): string =>
  `${String(outcome.status)} ${JSON.stringify(outcome.text)} ${outcome.end}`;

/** `window` bounds how long a blocked producer may stay silent before the body counts as buffered. */
const BUFFER_WINDOW = 3_000;

export async function observeStreaming(
  baseUrl: string,
  runtime: Runtime,
  report: Report,
): Promise<StreamingObservation> {
  const label = `${runtime}:`;
  const expected = runtime === "workerd" ? "buffered" : "incremental";

  // 0. What the transport does by itself: a native Nitro route, no Strata code on the path.
  let transport: "incremental" | "buffered";
  {
    const { reader } = await open(baseUrl, "/api/native-stream?id=n1&mode=gate");
    const first = await step(reader, BUFFER_WINDOW);
    transport = first.kind === "chunk" && first.text === "n1:0;" ? "incremental" : "buffered";
    await release(baseUrl, "n1");
    const rest = await drain(reader);
    report(
      `${label} control: a native Nitro route's gated body is delivered ${transport}ly by the installed transport`,
      transport === expected && rest.text.endsWith("n1:1;") && rest.end === "done",
      `first read ${describeStep(first)}; rest ${JSON.stringify(rest)}`,
    );
  }
  const incremental = transport === "incremental";

  const base = await stats(baseUrl);

  // 1. The reader's lifetime across one body.
  if (incremental) {
    const { response, reader } = await open(baseUrl, `${STREAM}/owned?id=a1&gate=1`);
    const first = await step(reader);
    report(
      `${label} owned stream delivers its first chunk while the producer is still blocked`,
      first.kind === "chunk" && first.text === "a1:0;",
      `first read: ${describeStep(first)}`,
    );
    report(
      `${label} owned stream answers 200 text/plain`,
      response.status === 200 &&
        (response.headers.get("content-type") ?? "").startsWith("text/plain"),
      `${String(response.status)} ${response.headers.get("content-type") ?? ""}`,
    );
    const during = await stats(baseUrl);
    report(
      `${label} the request-scoped reader stays open while the body is in flight`,
      during.opened === base.opened + 1 &&
        during.closed === base.closed &&
        during.open.includes("a1"),
      JSON.stringify(during),
    );
    await release(baseUrl, "a1");
    const rest = await drain(reader);
    report(
      `${label} the remaining chunks arrive in order and the body ends cleanly`,
      rest.text === "a1:1;a1:2;" && rest.end === "done",
      JSON.stringify(rest),
    );
    const after = await stats(baseUrl);
    report(
      `${label} the reader is released exactly once, before the body is reported complete`,
      after.opened === base.opened + 1 &&
        after.closed === base.closed + 1 &&
        after.open.length === 0,
      JSON.stringify(after),
    );
  } else {
    // Buffered transport: UNSUPPORTED as incremental delivery. It must still not leak.
    const ungated = await outcomeOf(baseUrl, `${STREAM}/owned?id=u1`);
    const afterUngated = await stats(baseUrl);
    report(
      `${label} buffered mode: a finite body is still delivered complete and its reader released once`,
      ungated.text === "u1:0;u1:1;u1:2;" &&
        ungated.end === "done" &&
        afterUngated.closed === base.closed + 1,
      `${describeOutcome(ungated)} ${JSON.stringify(afterUngated)}`,
    );
    const { reader } = await open(baseUrl, `${STREAM}/owned?id=a1&gate=1`);
    const first = await step(reader, BUFFER_WINDOW);
    const during = await stats(baseUrl);
    report(
      `${label} buffered mode: a blocked producer delivers nothing (incremental delivery is unsupported here)`,
      first.kind === "timeout" && during.open.includes("a1"),
      `first read ${describeStep(first)}; open ${JSON.stringify(during.open)}`,
    );
    await release(baseUrl, "a1");
    const rest = await drain(reader);
    const after = await stats(baseUrl);
    report(
      `${label} buffered mode: after release the whole body arrives and the reader is released once`,
      rest.text === "a1:0;a1:1;a1:2;" &&
        rest.end === "done" &&
        after.open.length === 0 &&
        after.closed === base.closed + 2,
      `${JSON.stringify(rest)} ${JSON.stringify(after)}`,
    );
  }

  // 2. Two overlapping streams keep separate resources.
  {
    const before = await stats(baseUrl);
    const one = await open(baseUrl, `${STREAM}/owned?id=b1&gate=1`);
    const two = await open(baseUrl, `${STREAM}/owned?id=b2&gate=1`);
    if (incremental) {
      const [first, second] = [await step(one.reader), await step(two.reader)];
      report(
        `${label} two overlapping streams each deliver their own first chunk`,
        first.kind === "chunk" &&
          first.text === "b1:0;" &&
          second.kind === "chunk" &&
          second.text === "b2:0;",
        `${describeStep(first)}, ${describeStep(second)}`,
      );
    } else {
      await until(async () => {
        const now = await stats(baseUrl);
        return now.open.includes("b1") && now.open.includes("b2");
      }, 5_000);
    }
    const both = await stats(baseUrl);
    report(
      `${label} both readers are open at once`,
      both.open.includes("b1") && both.open.includes("b2") && both.closed === before.closed,
      JSON.stringify(both.open),
    );
    await release(baseUrl, "b1");
    const rest1 = await drain(one.reader);
    const afterOne = await stats(baseUrl);
    report(
      `${label} finishing one stream releases only its own reader`,
      rest1.text.endsWith("b1:1;b1:2;") &&
        !rest1.text.includes("b2") &&
        rest1.end === "done" &&
        afterOne.open.includes("b2") &&
        !afterOne.open.includes("b1") &&
        afterOne.closed === before.closed + 1,
      `${JSON.stringify(rest1)}; open ${JSON.stringify(afterOne.open)}`,
    );
    await release(baseUrl, "b2");
    const rest2 = await drain(two.reader);
    const afterTwo = await stats(baseUrl);
    report(
      `${label} the other stream completes with its own chunks and releases its reader`,
      rest2.text.endsWith("b2:1;b2:2;") &&
        !rest2.text.includes("b1") &&
        rest2.end === "done" &&
        afterTwo.open.length === 0,
      JSON.stringify(rest2),
    );
  }

  // 3. The pre-0.7 contract is unchanged for an ordinary Response over a stream.
  {
    const before = await stats(baseUrl);
    const response = await fetch(`${baseUrl}${STREAM}/eager?id=e1`);
    const text = await response.text();
    const after = await stats(baseUrl);
    report(
      `${label} an ordinary streaming Response still has its scope closed before the body is read`,
      text.includes("e1:closed-before-use;") && after.closed === before.closed + 1,
      `${text} ${JSON.stringify(after)}`,
    );
  }

  // 4. Guard denial and interceptor replacement never stream.
  {
    const before = await stats(baseUrl);
    const denied = await fetch(`${baseUrl}${STREAM}/owned?id=g1&deny=1`);
    const deniedText = await denied.text();
    const afterDenied = await stats(baseUrl);
    report(
      `${label} a denied request answers 403 without constructing a reader or starting the stream`,
      denied.status === 403 && afterDenied.opened === before.opened && !deniedText.includes("g1:"),
      `${String(denied.status)} ${deniedText}`,
    );
    const replaced = await fetch(`${baseUrl}${STREAM}/owned?id=r1&replace=1`);
    const replacedBody = await replaced.text();
    const afterReplaced = await stats(baseUrl);
    report(
      `${label} an interceptor that replaces the response gets the eager contract`,
      replaced.status === 200 &&
        replacedBody === '{"replaced":true}' &&
        afterReplaced.opened === afterDenied.opened + 1 &&
        afterReplaced.closed === afterDenied.closed + 1,
      `${replacedBody} ${JSON.stringify(afterReplaced)}`,
    );
  }

  // 5. HEAD derived from the GET route releases the stream without reading it.
  {
    const before = await stats(baseUrl);
    const head = await fetch(`${baseUrl}${STREAM}/owned?id=h1`, { method: "HEAD" });
    const text = await head.text();
    const settled = await until(
      async () => (await stats(baseUrl)).closed === before.closed + 1,
      5_000,
    );
    report(
      `${label} HEAD answers headers only and the reader is released`,
      head.status === 200 && text === "" && settled,
      `${String(head.status)} ${JSON.stringify(await stats(baseUrl))}`,
    );
  }

  // 6. A producer failing after the first chunk: the transport decides what the client sees.
  const nativeOutcome = await outcomeOf(baseUrl, "/api/native-stream?id=nf&mode=fail");
  let strataOutcome: Outcome;
  {
    const before = await stats(baseUrl);
    strataOutcome = await outcomeOf(baseUrl, `${STREAM}/fail?id=f1`);
    const released = await until(
      async () => (await stats(baseUrl)).closed === before.closed + 1,
      5_000,
    );
    report(
      `${label} a producer failure is surfaced exactly as the transport surfaces a native stream failure`,
      strataOutcome.status === nativeOutcome.status &&
        strataOutcome.end === nativeOutcome.end &&
        (incremental
          ? strataOutcome.text === "f1:0;" && nativeOutcome.text === "nf:0;"
          : strataOutcome.text === nativeOutcome.text),
      `native ${describeOutcome(nativeOutcome)}; strata ${describeOutcome(strataOutcome)}`,
    );
    report(
      `${label} a partial stream is never reported as a complete body of the intended chunks`,
      incremental ? strataOutcome.end !== "done" : strataOutcome.text !== "f1:0;f1:1;f1:2;",
      describeOutcome(strataOutcome),
    );
    report(
      `${label} the reader is released exactly once after the failure`,
      released && (await stats(baseUrl)).closed === before.closed + 1,
    );
    report(
      `${label} the private error message is not in the response`,
      !strataOutcome.text.includes(STREAM_CANARY) && !nativeOutcome.text.includes(STREAM_CANARY),
    );
  }

  // 7. A failing cleanup after a complete body must not look like a clean success.
  {
    const before = await stats(baseUrl);
    const outcome = await outcomeOf(baseUrl, `${STREAM}/owned?id=c1&cleanupFailure=1`);
    const after = await stats(baseUrl);
    report(
      `${label} a cleanup failure after the last chunk does not end the body cleanly`,
      incremental
        ? outcome.text === "c1:0;c1:1;c1:2;" && outcome.end !== "done"
        : outcome.end === strataOutcome.end && outcome.text === strataOutcome.text,
      describeOutcome(outcome),
    );
    report(
      `${label} that cleanup ran once and its private message is not in the response`,
      after.cleanups === before.cleanups + 1 &&
        after.closed === before.closed + 1 &&
        !outcome.text.includes(STREAM_CANARY),
      JSON.stringify(after),
    );
  }

  // 8. Client disconnect while the producer is blocked.
  let disconnect: string;
  {
    const before = await stats(baseUrl);
    const controller = new AbortController();
    const { reader } = await open(baseUrl, `${STREAM}/owned?id=d1&gate=1`, controller.signal);
    const first = await step(reader, incremental ? 10_000 : BUFFER_WINDOW);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const releasedByDisconnect = await until(
      async () => (await stats(baseUrl)).closed === before.closed + 1,
      2_000,
    );
    disconnect = releasedByDisconnect
      ? "released on disconnect"
      : "retained until the producer ends";
    report(
      `${label} client disconnect: ${disconnect}`,
      incremental ? first.kind === "chunk" && !releasedByDisconnect : true,
      `first read ${describeStep(first)}`,
    );
    await release(baseUrl, "d1");
    const finished = await until(
      async () => (await stats(baseUrl)).closed === before.closed + 1,
      5_000,
    );
    const finalStats = await stats(baseUrl);
    report(
      `${label} the reader of a disconnected client is released exactly once once the producer ends`,
      finished && finalStats.closed === before.closed + 1 && finalStats.open.length === 0,
      JSON.stringify(finalStats),
    );
  }

  return {
    transport,
    nativeFailure: describeOutcome(nativeOutcome),
    strataFailure: describeOutcome(strataOutcome),
    disconnect,
  };
}

export function serverFnId(exportName: string): string {
  return createHash("sha256")
    .update(`src/app/server-fn/strata-compat.server.ts#${exportName}`)
    .digest("hex")
    .slice(0, 16);
}

export interface ServerFnObservation {
  readonly status: Record<string, number>;
}

/** A real compiled Analog server function next to Strata, native Nitro routes and SSR. */
export async function observeServerFunctions(
  baseUrl: string,
  runtime: Runtime,
  report: Report,
  output: () => string,
): Promise<ServerFnObservation> {
  const label = `${runtime}:`;
  const echo = `${baseUrl}/_analog/fn/${serverFnId("serverFnEcho")}`;
  const ping = `${baseUrl}/_analog/fn/${serverFnId("serverFnPing")}`;
  const json = { "content-type": "application/json" };
  const status: Record<string, number> = {};

  if (runtime === "workerd") {
    // Measured limitation, pinned: the dispatch module bootstraps Angular from an unlinked
    // `@analogjs/router/server`, which needs the JIT compiler, and workerd forbids `new Function`.
    const calls = await Promise.all([
      fetch(ping),
      fetch(echo, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ label: "x", count: 4 }),
      }),
      fetch(`${baseUrl}/_analog/fn/0000000000000000`),
    ]);
    status["GET ping"] = calls[0].status;
    status["POST echo"] = calls[1].status;
    status["GET unknown"] = calls[2].status;
    const bodies = await Promise.all(calls.map((call) => call.text()));
    const logged = await until(
      () => Promise.resolve(output().includes("Code generation from strings disallowed")),
      5_000,
    );
    report(
      `${label} NO-GO (pinned): every serverFn dispatch answers 500 because Angular's JIT compiler is unavailable`,
      calls.every((call) => call.status === 500) &&
        logged &&
        bodies.every((body) => !body.includes(SERVER_FN_CANARY)),
      calls.map((call) => String(call.status)).join(", "),
    );
  } else {
    const pinged = await fetch(ping);
    status["GET ping"] = pinged.status;
    const pingBody = (await pinged.json().catch(() => null)) as {
      pong?: boolean;
      secretLength?: number;
    } | null;
    report(
      `${label} a real input-less serverFn answers GET with its return value`,
      pinged.status === 200 &&
        pingBody?.pong === true &&
        pingBody.secretLength === SERVER_FN_CANARY.length,
      `${String(pinged.status)} ${JSON.stringify(pingBody)}`,
    );

    const posted = await fetch(echo, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ label: "x", count: 4 }),
    });
    status["POST echo"] = posted.status;
    const postedBody = (await posted.json().catch(() => null)) as {
      label?: string;
      doubled?: number;
    } | null;
    report(
      `${label} a real serverFn preserves its argument and return contract over POST`,
      posted.status === 200 && postedBody?.label === "x" && postedBody.doubled === 8,
      `${String(posted.status)} ${JSON.stringify(postedBody)}`,
    );

    const invalid = await fetch(echo, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ label: 1 }),
    });
    status["POST invalid"] = invalid.status;
    const invalidText = await invalid.text();
    report(
      `${label} serverFn input validation answers 400 through Analog, not Strata`,
      invalid.status === 400 &&
        invalidText.includes("label and count are required") &&
        !invalidText.includes('"error"'),
      `${String(invalid.status)} ${invalidText}`,
    );

    const unknown = await fetch(`${baseUrl}/_analog/fn/0000000000000000`);
    status["GET unknown"] = unknown.status;
    const unknownText = await unknown.text();
    report(
      `${label} an unknown server function id is answered by Analog, not by the Strata API boundary`,
      unknown.status === 404 &&
        unknownText.includes("Unknown server function") &&
        !unknownText.includes("not_found"),
      `${String(unknown.status)} ${unknownText}`,
    );

    const wrongMethod = await fetch(ping, { method: "POST", headers: json, body: "{}" });
    status["POST ping"] = wrongMethod.status;
    report(
      `${label} a wrong-method serverFn call answers Analog's 405`,
      wrongMethod.status === 405,
      String(wrongMethod.status),
    );

    const concurrent = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        fetch(echo, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ label: `c${String(index)}`, count: index }),
        }).then((response) => response.json() as Promise<{ label?: string; doubled?: number }>),
      ),
    );
    report(
      `${label} concurrent serverFn calls keep their own inputs`,
      concurrent.every(
        (body, index) => body.label === `c${String(index)}` && body.doubled === index * 2,
      ),
      JSON.stringify(concurrent),
    );
  }

  // Strata, native routes and the boundary around the serverFn route.
  const native = await fetch(`${baseUrl}/api/native`);
  report(
    `${label} the native Nitro route is unchanged next to Strata and serverFn`,
    native.status === 200 && ((await native.json()) as { source?: string }).source === "analog",
  );
  const users = await fetch(`${baseUrl}/api/strata/users`);
  report(
    `${label} a Strata controller route still answers`,
    users.status === 200,
    String(users.status),
  );
  const missing = await fetch(`${baseUrl}/api/not-a-route`);
  report(
    `${label} the opt-in API boundary still answers its JSON 404 under /api`,
    missing.status === 404 && (await missing.text()) === '{"error":"not_found"}',
  );
  const page = await fetch(`${baseUrl}/server-component`);
  const html = await page.text();
  report(
    `${label} Angular SSR still renders the Server Component page`,
    page.status === 200 &&
      /<app-root|<ng-component|ng-server-context/.test(html) &&
      html.length > 500,
    `${String(page.status)} ${String(html.length)} bytes`,
  );

  return { status };
}

/** Files under `dir` that contain `needle`, relative to it. */
export function filesContaining(dir: string, needle: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (readFileSync(path).includes(needle)) found.push(path.slice(dir.length + 1));
    }
  };
  visit(dir);
  return found;
}
