import "@strata-sc/server-components/server-only";

// Confidential on its own: reached only through ProductRepository.
const TRANSITIVE_MARKER = "EXTERNAL_CONSUMER_TRANSITIVE_MARKER";

export function readServerHelper(): string {
  return TRANSITIVE_MARKER;
}

/** A 32-bit string hash, evaluated at runtime so no bundler can fold a marker away. */
export function fingerprint(value: string): string {
  let result = 0;

  for (let index = 0; index < value.length; index++) {
    result = (Math.imul(result, 31) + value.charCodeAt(index)) | 0;
  }

  return (result >>> 0).toString(16);
}
