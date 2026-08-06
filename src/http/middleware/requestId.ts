import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";

// Honor an inbound X-Request-Id (useful when the ops team or a load balancer
// already assigned one) so a single request can be traced across services,
// otherwise mint one. Echoed back on the response for the caller to log too.
export function genRequestId(req: IncomingMessage): string {
  const inbound = req.headers["x-request-id"];
  if (typeof inbound === "string" && inbound.trim().length > 0) {
    return inbound;
  }
  return randomUUID();
}

export function setRequestIdHeader(res: ServerResponse, id: string): void {
  res.setHeader("X-Request-Id", id);
}
