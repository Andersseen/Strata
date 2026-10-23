/** Synthetic private value: it must never reach a response body or the browser bundle. */
export const STREAM_CANARY = "fixture-stream-private-canary";

const released = new Set<string>();

export function release(id: string): void {
  released.add(id);
}

/**
 * A barrier another request opens. It polls a flag instead of sharing a promise across
 * requests: workerd cancels a request whose promise only a different request can settle.
 */
export async function waitFor(id: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!released.has(id)) {
    if (Date.now() > deadline) throw new Error(`barrier ${id} was never released`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
