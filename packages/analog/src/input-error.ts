/** Internal marker used only to translate expected invalid client input. */
export class StrataAnalogInputError extends Error {
  constructor(
    readonly source: "params" | "query" | "body",
    readonly status: 400 | 413 | 415,
  ) {
    super("Invalid request input.");
  }
}
