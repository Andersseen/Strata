const KIT_SAFE_MARKER = "STRATA_KIT_BROWSER_SAFE_MARKER";

export function formatPrice(cents) {
  return `${KIT_SAFE_MARKER}:${(cents / 100).toFixed(2)}`;
}
