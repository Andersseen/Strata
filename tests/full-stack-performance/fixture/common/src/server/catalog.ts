export interface PublicProduct {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
}

const CATALOG: Readonly<Record<string, PublicProduct>> = {
  "42": { id: "42", name: "Product 42", available: true },
  "7": { id: "7", name: "Product 7", available: false },
};

export function findPublicProduct(id: string): PublicProduct | undefined {
  return Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined;
}
