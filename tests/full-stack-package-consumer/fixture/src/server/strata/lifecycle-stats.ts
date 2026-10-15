// Qualification observation only: how many controller instances the factory
// created and how many cleanups ran. Not application state and never part of a
// product response.
export const lifecycleStats = { created: 0, cleaned: 0 };
