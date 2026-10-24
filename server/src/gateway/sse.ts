import type { ServerResponse } from "node:http";

export class Sse {
  constructor(private res: ServerResponse) {}

  open(): void {
    this.res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.res.flushHeaders();
  }

  send(event: string, data: unknown): void {
    if (this.res.writableEnded || this.res.destroyed) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  end(): void {
    if (!this.res.writableEnded) this.res.end();
  }
}
