import { id, type Envelope } from "./contracts.js";
// Each logical zone owns a mailbox. Queries retain correlation without becoming observations.
export class Mailbox {
  private queue: { run: () => Promise<void>; priority: number }[] = [];
  private running = false;
  request<T>(
    message: Envelope<unknown>,
    handler: (request: Envelope<unknown>, requestId: string) => Promise<T>,
    priority = 0,
  ): Promise<{ request_id: string; value: T }> {
    const requestId = id("request");
    return new Promise((resolve, reject) => {
      this.queue.push({
        priority,
        run: async () => {
          try {
            resolve({
              request_id: requestId,
              value: await handler(message, requestId),
            });
          } catch (e) {
            reject(e);
          }
        },
      });
      this.queue.sort((a, b) => b.priority - a.priority);
      void this.drain();
    });
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) await this.queue.shift()!.run();
    } finally {
      this.running = false;
    }
  }
}
export class Dispatcher {
  readonly zones = Object.fromEntries(
    ["perception", "thinking", "behavior", "memory", "drive"].map((name) => [
      name,
      new Mailbox(),
    ]),
  );
}
