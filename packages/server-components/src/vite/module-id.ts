/**
 * The module identity behind a Vite id: `/app/x.ts?raw`, `/app/x.ts?url` and
 * `/app/x.ts` are the same source file. Every browser-graph guard compares
 * ids through this, so a query suffix can never turn a forbidden module into
 * an allowed one.
 */
export function stripQuery(id: string): string {
  const query = id.indexOf("?");

  return query === -1 ? id : id.slice(0, query);
}
