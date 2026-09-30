/**
 * One instance per server process (or Worker isolate), even when this module
 * is bundled more than once.
 *
 * Analog builds the Angular SSR bundle separately from Nitro's server bundle,
 * so a module imported by both a Server Component and a Strata controller is
 * evaluated twice, each copy with its own module-level state. Keying the
 * instance on `globalThis` with a registered symbol makes both copies share
 * it: what a controller writes, the next server render reads.
 */
export function processSingleton<T>(key: string, create: () => T): T {
  const registry = globalThis as typeof globalThis & Record<symbol, unknown>;
  const symbol = Symbol.for(key);

  return (registry[symbol] ??= create()) as T;
}
