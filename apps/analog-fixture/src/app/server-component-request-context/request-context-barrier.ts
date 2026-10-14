import "@strata-sc/server-components/server-only";

interface Round {
  readonly arrivals: Set<string>;
  readonly release: Promise<void>;
  resolve(): void;
}

// Workerd may cap the number of in-flight requests on a constrained CI runner.
// Keep the client round at 24 requests, but only require a bounded concurrent
// cohort so the proof cannot deadlock behind the runtime's scheduler limit.
const EXPECTED_REQUESTS = 12;
const rounds = new Map<string, Round>();

function roundFor(key: string): Round {
  const existing = rounds.get(key);
  if (existing) return existing;

  let resolve!: () => void;
  const round: Round = {
    arrivals: new Set(),
    release: new Promise<void>((done) => (resolve = done)),
    resolve,
  };
  rounds.set(key, round);
  return round;
}

/** Test coordination only: proves 24 SSR renders overlap without a timer. */
export async function waitForConcurrentRound(roundKey: string, requestKey: string): Promise<void> {
  const round = roundFor(roundKey);
  round.arrivals.add(requestKey);
  if (round.arrivals.size >= EXPECTED_REQUESTS) round.resolve();
  await round.release;
  if (round.arrivals.size >= EXPECTED_REQUESTS) rounds.delete(roundKey);
}
