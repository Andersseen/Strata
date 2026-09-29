export const requestMetrics = {
  started: 0,
  completed: 0,
};

export class RequestAudit {
  readonly correlationId: string;

  constructor(correlationId: string | undefined) {
    this.correlationId = correlationId ?? crypto.randomUUID();
    requestMetrics.started++;
  }

  complete(): void {
    requestMetrics.completed++;
  }
}
