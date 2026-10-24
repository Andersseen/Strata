import type { Report, Runtime } from "./streaming.ts";

/**
 * Observations of `request.validateHeaders()` on the real fixture
 * (docs/research/analog-header-validation-v09.md). The fixture records every
 * observation, and the cleanup that preceded it, in the observability log, so
 * classification is verified independently of the HTTP response.
 */

const HEADERS = "/api/strata/observed/headers";
const LOG = "/api/strata/observed-log";
const CANARY = "fixture-header-private";

interface Entry {
  readonly kind: string;
  readonly observation?: { readonly outcome: string; readonly route: { readonly path: string } };
}

const readLog = async (baseUrl: string): Promise<Entry[]> =>
  (await (await fetch(`${baseUrl}${LOG}`)).json()) as Entry[];

const reset = async (baseUrl: string): Promise<void> => {
  await fetch(`${baseUrl}${LOG}/reset`, { method: "POST" });
};

/** The dev server pretty-prints JSON; the body is compared as data, not as bytes. */
function sameJson(text: string, expected: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

export async function observeHeaderValidation(
  baseUrl: string,
  runtime: Runtime,
  report: Report,
): Promise<{ readonly concurrent: boolean }> {
  const label = `${runtime}:`;

  // 1. Valid, transformed input; mixed-case names; credentials present but never read.
  await reset(baseUrl);
  const ok = await fetch(`${baseUrl}${HEADERS}/metadata`, {
    headers: {
      "X-Request-ID": "req-1",
      "X-Client-Version": "7",
      authorization: `Bearer ${CANARY}-auth`,
      cookie: `session=${CANARY}-cookie`,
    },
  });
  const okText = await ok.text();
  report(
    `${label} validateHeaders returns the transformed, normalized input`,
    ok.status === 200 &&
      sameJson(okText, { requestId: "req-1", version: 7, traced: false, stable: true }),
    `${String(ok.status)} ${okText}`,
  );
  report(
    `${label} a successful header validation is not observed as rejected`,
    (await readLog(baseUrl)).at(-1)?.observation?.outcome === "completed",
  );

  // 2. Missing and invalid input: safe 400, observed as input-rejected, cleanup first.
  for (const [name, headers] of [
    ["missing", {}],
    ["invalid", { "x-request-id": "r", "x-client-version": `v-${CANARY}`, cookie: CANARY }],
  ] as const) {
    await reset(baseUrl);
    const response = await fetch(`${baseUrl}${HEADERS}/metadata`, { headers });
    const text = await response.text();
    report(
      `${label} ${name} header answers the safe 400 contract`,
      response.status === 400 &&
        response.headers.get("cache-control") === "no-store" &&
        response.headers.get("content-type") === "application/json; charset=utf-8" &&
        text === '{"error":"invalid_request","source":"headers"}',
      `${String(response.status)} ${text}`,
    );
    const log = await readLog(baseUrl);
    report(
      `${label} ${name} header rejection is cleaned up, then observed as input-rejected`,
      log.map((entry) => entry.kind).join() === "cleanup,observation" &&
        log[1]?.observation?.outcome === "input-rejected" &&
        !JSON.stringify(log).includes(CANARY),
      JSON.stringify(log),
    );
  }

  // 3. Asynchronous validation.
  const gold = await fetch(`${baseUrl}${HEADERS}/async`, { headers: { "x-token-class": "gold" } });
  report(
    `${label} asynchronous header validation succeeds`,
    gold.status === 200 && sameJson(await gold.text(), { tier: "gold" }),
  );
  const bronze = await fetch(`${baseUrl}${HEADERS}/async`, { headers: { "x-token-class": "no" } });
  report(`${label} asynchronous header validation rejects`, bronze.status === 400);

  // 4. A validator that throws is an application failure, never a 400.
  await reset(baseUrl);
  const throwing = await fetch(`${baseUrl}${HEADERS}/throws`, {
    headers: { authorization: `Bearer ${CANARY}` },
  });
  const throwingText = await throwing.text();
  report(
    `${label} a throwing validator answers 5xx without private text`,
    throwing.status >= 500 &&
      // Nitro's dev error page echoes a thrown message; that is the host's dev behavior.
      (runtime === "dev" || !throwingText.includes(CANARY)),
    `${String(throwing.status)}`,
  );
  const failedLog = await readLog(baseUrl);
  report(
    `${label} a throwing validator is observed as failed`,
    failedLog.at(-1)?.observation?.outcome === "failed" &&
      !JSON.stringify(failedLog).includes(CANARY),
    JSON.stringify(failedLog),
  );

  // 5. Overlapping mixed requests keep distinct headers apart.
  await reset(baseUrl);
  const concurrent = await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      const valid = index % 3 !== 0;
      const response = await fetch(`${baseUrl}${HEADERS}/metadata`, {
        headers: {
          "x-request-id": `${CANARY}-${index}`,
          "x-client-version": valid ? String(index) : "bad",
          authorization: `Bearer ${CANARY}-auth-${index}`,
        },
      });
      const text = await response.text();
      return valid
        ? sameJson(text, {
            requestId: `${CANARY}-${index}`,
            version: index,
            traced: false,
            stable: true,
          })
        : response.status === 400 && text === '{"error":"invalid_request","source":"headers"}';
    }),
  ).then((results) => results.every(Boolean));
  report(`${label} 24 overlapping mixed header requests remain isolated`, concurrent);
  const finalLog = await readLog(baseUrl);
  report(
    `${label} the concurrent observations hold no header value`,
    !JSON.stringify(finalLog).includes(CANARY),
  );

  return { concurrent };
}
