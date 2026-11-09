import { createHmac } from "node:crypto";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
type WebhookRec = { id: string; url: string; secret: string };

export const EVENTS = [
  "card.created",
  "card.updated",
  "card.moved",
  "card.deleted",
  "card.archived",
  "card.restored",
  "card.due",
  "comment.created",
  "checklist.completed",
  "attachment.added",
  "member.added",
  "member.removed",
  "sprint.started",
  "sprint.completed",
] as const;

export interface DeliveryRec {
  id: string;
  webhookId: string;
  teamId: string;
  event: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  seq: number;
  /** The exact body bytes every attempt sends. */
  payload: Buffer;
}

export interface DeliveryEngineOptions {
  retryDelaysMs: number[];
  timeoutMs: number;
  /** The webhook as it is now (url and secret are read at each attempt), or undefined if deleted. */
  lookup: (webhookId: string) => WebhookRec | undefined;
}

/** Background delivery with retries on real (unref'd) timers. In memory only. */
export class DeliveryEngine {
  readonly deliveries = new Map<string, DeliveryRec>();
  private readonly opts: DeliveryEngineOptions;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Map<string, ClientRequest>();
  private closed = false;

  constructor(opts: DeliveryEngineOptions) {
    this.opts = opts;
  }

  /** Registers a pending delivery and starts its first attempt in the background. */
  add(delivery: DeliveryRec): void {
    this.deliveries.set(delivery.id, delivery);
    this.schedule(delivery.id, 0);
  }

  /** Drops every delivery of a webhook and stops its retries. */
  dropWebhook(webhookId: string): void {
    for (const d of [...this.deliveries.values()]) {
      if (d.webhookId !== webhookId) continue;
      this.deliveries.delete(d.id);
      this.cancel(d.id);
    }
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const req of this.inflight.values()) req.destroy();
    this.inflight.clear();
  }

  private cancel(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(id);
    const req = this.inflight.get(id);
    if (req !== undefined) req.destroy();
    this.inflight.delete(id);
  }

  private schedule(id: string, delayMs: number): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.attempt(id);
    }, delayMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  private attempt(id: string): void {
    if (this.closed) return;
    const delivery = this.deliveries.get(id);
    if (delivery === undefined || delivery.status !== "pending") return;
    const webhook = this.opts.lookup(delivery.webhookId);
    if (webhook === undefined) return;
    const attemptNo = delivery.attempts + 1;
    const signature = createHmac("sha256", webhook.secret).update(delivery.payload).digest("hex");

    let finished = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (statusCode: number | null, error: string | null) => {
      if (finished) return;
      finished = true;
      if (timeout !== undefined) clearTimeout(timeout);
      this.inflight.delete(id);
      if (this.closed || !this.deliveries.has(id)) return;
      delivery.attempts = attemptNo;
      delivery.lastStatusCode = statusCode;
      delivery.lastError = error;
      if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
        delivery.status = "succeeded";
        return;
      }
      if (attemptNo >= 1 + this.opts.retryDelaysMs.length) {
        delivery.status = "failed";
        return;
      }
      this.schedule(id, this.opts.retryDelaysMs[attemptNo - 1]!);
    };

    let url: URL;
    try {
      url = new URL(webhook.url);
    } catch {
      // cannot happen for validated urls; count it as a connection error
      finish(null, "invalid url");
      return;
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, {
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/json",
        "content-length": String(delivery.payload.length),
        "x-tracker-event": delivery.event,
        "x-tracker-delivery": delivery.id,
        "x-tracker-attempt": String(attemptNo),
        "x-tracker-signature": `sha256=${signature}`,
        connection: "close",
      },
    });
    this.inflight.set(id, req);
    timeout = setTimeout(() => {
      finish(null, `timed out after ${this.opts.timeoutMs} ms`);
      req.destroy();
    }, this.opts.timeoutMs);
    timeout.unref();
    req.on("socket", (socket) => socket.unref());
    req.on("response", (res) => {
      finish(res.statusCode ?? null, null);
      res.on("error", () => {});
      res.resume();
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      finish(null, err.message || err.code || "connection error");
    });
    req.end(delivery.payload);
  }
}
