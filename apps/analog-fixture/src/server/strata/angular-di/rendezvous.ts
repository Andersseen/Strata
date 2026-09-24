interface Meeting {
  arrived: number;
  release: () => void;
  released: Promise<void>;
}

const meetings = new Map<string, Meeting>();

/**
 * A barrier for the harness: resolves `true` once `parties` callers have
 * arrived under the same `key`, or `false` after `timeoutMs` if they have not.
 *
 * Two requests that both pass it were provably suspended in their handlers at
 * the same time — their controllers and request injectors were alive together.
 * Requests served one after the other cannot pass it; they time out instead.
 */
export function rendezvous(key: string, parties: number, timeoutMs: number): Promise<boolean> {
  let meeting = meetings.get(key);

  if (!meeting) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    meeting = { arrived: 0, release, released };
    meetings.set(key, meeting);
  }

  meeting.arrived++;

  if (meeting.arrived === parties) {
    meetings.delete(key);
    meeting.release();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      meetings.delete(key);
      resolve(false);
    }, timeoutMs);
  });

  return Promise.race([meeting.released.then(() => true as const), timedOut]).finally(() => {
    clearTimeout(timer);
  });
}
