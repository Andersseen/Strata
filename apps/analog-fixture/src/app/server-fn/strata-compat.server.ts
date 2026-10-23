import { serverFn } from "@analogjs/router/server";

/** Server-only value: it must not appear in the browser bundle or any public response. */
const SERVER_ONLY = "fixture-serverfn-private-canary";

interface EchoInput {
  readonly label: string;
  readonly count: number;
}

const echoInput = {
  "~standard": {
    version: 1,
    vendor: "strata-fixture",
    validate(value: unknown) {
      const record = value as Partial<EchoInput> | null;
      if (record && typeof record.label === "string" && typeof record.count === "number") {
        return { value: { label: record.label, count: record.count } satisfies EchoInput };
      }
      return { issues: [{ message: "label and count are required" }] };
    },
  },
} as const;

/** A real Analog server function: POST `/_analog/fn/<id>` with a JSON body. */
export const serverFnEcho = serverFn(echoInput, (input: EchoInput) => ({
  label: input.label,
  doubled: input.count * 2,
  secretLength: SERVER_ONLY.length,
}));

/** An input-less server function: GET `/_analog/fn/<id>`. */
export const serverFnPing = serverFn(() => ({ pong: true, secretLength: SERVER_ONLY.length }));
