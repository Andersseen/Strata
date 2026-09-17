const EXPECTED_DEFINITION = {
  path: "/consumer",
  routes: [
    { method: "GET", path: "/", handler: "root" },
    { method: "GET", path: "/async", handler: "asyncRoute" },
  ],
};

const EXPECTED_LINES = {
  ROOT_STATUS: "200",
  ROOT_BODY: '{"greeting":"hello"}',
  ASYNC_STATUS: "200",
  ASYNC_BODY: '{"greeting":"hello","async":true}',
  NATIVE_STATUS: "200",
  NATIVE_BODY: '{"native":true}',
};

export class ConsumerAssertionError extends Error {}

function extractDefinitionJson(stdout) {
  const start = stdout.indexOf("DEFINITION_JSON_START");
  const end = stdout.indexOf("DEFINITION_JSON_END");

  if (start === -1 || end === -1 || end < start) {
    throw new ConsumerAssertionError("Missing DEFINITION_JSON_START/END markers in output.");
  }

  const jsonText = stdout.slice(start + "DEFINITION_JSON_START".length, end).trim();

  if (jsonText.length === 0) {
    throw new ConsumerAssertionError("Definition JSON block was empty.");
  }

  return JSON.parse(jsonText);
}

function extractLine(stdout, key) {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(`${key} `));

  if (!line) {
    throw new ConsumerAssertionError(`Missing "${key}" line in output.`);
  }

  return line.slice(key.length + 1).trim();
}

/**
 * Verifies one captured stdout (from tsc-emitted JS, Vite-bundled JS, or the
 * direct-Vite characterization output) against the fixed expected shape from
 * SPEC-001: public definition, sync/async controller bodies and native route.
 * Throws ConsumerAssertionError with a precise mismatch description on
 * failure — this is deliberately not a boolean return, so failures always
 * propagate with a diagnosable reason instead of being silently swallowed.
 */
export function assertConsumerBehavior(stdout) {
  const definition = extractDefinitionJson(stdout);

  if (JSON.stringify(definition) !== JSON.stringify(EXPECTED_DEFINITION)) {
    throw new ConsumerAssertionError(
      `Unexpected controller definition. Expected ${JSON.stringify(EXPECTED_DEFINITION)}, got ${JSON.stringify(definition)}.`,
    );
  }

  for (const [key, expected] of Object.entries(EXPECTED_LINES)) {
    const actual = extractLine(stdout, key);

    if (actual !== expected) {
      throw new ConsumerAssertionError(`Unexpected "${key}". Expected ${expected}, got ${actual}.`);
    }
  }
}
