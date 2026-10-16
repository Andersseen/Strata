// Synthetic public inventory for the three-island profile. Nothing here is confidential:
// it is exactly what the public API returns.
export interface PublicStock {
  readonly id: string;
  readonly units: number;
}

export interface PublicDelivery {
  readonly id: string;
  readonly days: number;
}

const STOCK: Readonly<Record<string, PublicStock>> = {
  "42": { id: "42", units: 12 },
  "7": { id: "7", units: 0 },
};

const DELIVERY: Readonly<Record<string, PublicDelivery>> = {
  "42": { id: "42", days: 3 },
  "7": { id: "7", days: 9 },
};

export const findPublicStock = (id: string): PublicStock | undefined =>
  Object.hasOwn(STOCK, id) ? STOCK[id] : undefined;

export const findPublicDelivery = (id: string): PublicDelivery | undefined =>
  Object.hasOwn(DELIVERY, id) ? DELIVERY[id] : undefined;
