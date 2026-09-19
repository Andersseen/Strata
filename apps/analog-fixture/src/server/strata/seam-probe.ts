// Records what the Nitro runtime hands to a plugin, so the H3 seam can be
// inspected from a real production server instead of inferred from types.

export interface SeamSnapshot {
  readonly nitroAppKeys: readonly string[];
  readonly h3App: ShapeSnapshot;
  readonly router: ShapeSnapshot;
}

export interface ShapeSnapshot {
  readonly typeofValue: string;
  readonly constructorName: string | null;
  readonly ownKeys: readonly string[];
  readonly hasOn: boolean;
  readonly hasUse: boolean;
  readonly hasStack: boolean;
  readonly hasFetch: boolean;
  readonly hasRoutes: boolean;
}

let snapshot: SeamSnapshot | undefined;

export function describeShape(value: unknown): ShapeSnapshot {
  const record = value as Record<string, unknown> | null | undefined;
  const isObjectLike = (typeof value === "object" && value !== null) || typeof value === "function";

  return {
    typeofValue: typeof value,
    constructorName:
      isObjectLike && typeof (value as object).constructor === "function"
        ? (value as object).constructor.name
        : null,
    ownKeys: isObjectLike ? Object.keys(value as object).sort() : [],
    hasOn: typeof record?.["on"] === "function",
    hasUse: typeof record?.["use"] === "function",
    hasStack: Array.isArray(record?.["stack"]),
    hasFetch: typeof record?.["fetch"] === "function",
    hasRoutes: typeof record?.["_routes"] === "object" || typeof record?.["routes"] === "object",
  };
}

export function recordSeamSnapshot(next: SeamSnapshot): void {
  snapshot = next;
}

export function readSeamSnapshot(): SeamSnapshot | undefined {
  return snapshot;
}
