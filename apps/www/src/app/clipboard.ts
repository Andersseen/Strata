/**
 * Copies text with the Clipboard API, falling back to a selection-based copy.
 * Browser privacy settings can reject Clipboard API writes even on a trusted
 * localhost page, and embedded previews often lack the API entirely.
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand?.("copy");
    textarea.remove();
  }
}
