/**
 * Application build identity: the opt-in compatibility contract between the
 * HTML a server rendered and the browser runtime that hydrates it.
 *
 * The identity is chosen by the consumer (`strataServerComponents({ buildId })`)
 * and compiled into every environment of one build as the constant
 * `__STRATA_BUILD_ID__`. It is a deployment label, not a package version, not a
 * fingerprint and not a security boundary: it is public (it is written to the
 * document) and it proves nothing about who produced the markup.
 *
 * Without the option the constant is absent, nothing is stamped and nothing is
 * enforced, exactly as before the identity existed.
 */

declare const __STRATA_BUILD_ID__: string | undefined;

/** The identifier the Vite plugin defines; kept in one place for both sides. */
export const BUILD_ID_DEFINE = "__STRATA_BUILD_ID__";
export const BOUNDARY_BUILD_ATTRIBUTE = "data-strata-build";

/** Letters, digits and `. _ : + -`, 1 to 64 characters, starting with a letter or digit. */
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;

export function isValidBuildId(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID_PATTERN.test(value);
}

/** The identity compiled into this build, or `undefined` when the feature is not enabled. */
export function compiledBuildId(): string | undefined {
  return typeof __STRATA_BUILD_ID__ === "string" && isValidBuildId(__STRATA_BUILD_ID__)
    ? __STRATA_BUILD_ID__
    : undefined;
}

export type BuildIdentityCheck =
  /** The browser does not enforce an identity, or both sides carry the same one. */
  | { readonly kind: "compatible" }
  /** Both identities are well formed and differ: a confirmed deployment skew. */
  | { readonly kind: "mismatch"; readonly browser: string; readonly server: string }
  /** The browser enforces an identity and the host carries none. */
  | { readonly kind: "missing" }
  /** The host carries something that is not a build identity. */
  | { readonly kind: "malformed" };

/**
 * Compares the identity this browser build enforces with the host attribute.
 * Only two well-formed, different identities are a `mismatch`; anything else
 * wrong is reported as such and is never treated as evidence of a deployment.
 */
export function checkBuildIdentity(
  browserBuildId: string | undefined,
  attribute: string | null,
): BuildIdentityCheck {
  if (browserBuildId === undefined) return { kind: "compatible" };
  if (attribute === null) return { kind: "missing" };
  if (!isValidBuildId(attribute)) return { kind: "malformed" };

  return attribute === browserBuildId
    ? { kind: "compatible" }
    : { kind: "mismatch", browser: browserBuildId, server: attribute };
}
