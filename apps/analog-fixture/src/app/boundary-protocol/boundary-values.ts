/**
 * Values the boundary protocol fixture sends across `[strataClient]`. Plain
 * TypeScript with no imports: the Server Component renders them and
 * tools/server-components/lib/boundaries.ts imports the same module to
 * assert the exact round-trip.
 */

/** Characters that must stay inside the attribute, plus line separators and non-Latin text. */
export const ADVERSARIAL_TEXT =
  `" ' < > & </script><script>globalThis.__STRATA_XSS__=1</script>` +
  "    😀 日本語 Ελληνικά العربية";

export const PRIMITIVES = {
  text: "Plain text",
  count: 42,
  enabled: true,
  empty: null,
} as const;
