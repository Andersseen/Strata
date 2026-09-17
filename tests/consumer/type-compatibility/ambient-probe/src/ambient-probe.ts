// SPEC-002 negative ambient control. This file references identifiers that
// exist only under Bun (`Bun`) or Cloudflare Workers (`WebSocketPair`)
// ambient globals. Run under a Node-only `types` set, both identifiers must
// be unresolved names (TS2304/TS2552/TS2868); run under a set that activates
// Bun/Workers ambient types, both must resolve. Neither variant imports
// anything from H3 or Strata: this isolates ambient-global availability from
// any declaration-graph question.
console.log("BUN_GLOBAL", typeof Bun);
console.log("WORKERS_GLOBAL", typeof WebSocketPair);
