import { H3 } from "h3";

// SPEC-002 AC5 disposable negative control: a deliberate consumer-authored
// type mismatch, unrelated to H3's own declarations. The matrix runner
// asserts this produces a diagnostic classified as "consumer-authored"
// (TS2322 on this file), proving the classifier attributes an ordinary
// consumer mistake correctly instead of folding it into an upstream-origin
// count. This fixture is never a promotion candidate.
const app = new H3();

app.get("/native", () => ({ native: true }));

const deliberateMismatch: number = "not-a-number";
void deliberateMismatch;
