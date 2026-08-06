import type { NextFunction, Request, Response } from "express";
import { env } from "../../config/env";

// Static API key per the brief ("a static API key in a header is fine" —
// explicitly out of scope: real user management/auth). Deliberately NOT
// applied to /healthz, /docs, /openapi.json, or the registry callback —
// the callback is required by the brief to be unauthenticated. See
// README "What I'd push back on" for why that last one is a real risk.
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header("X-API-Key");
  if (provided !== env.API_KEY) {
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid X-API-Key header.",
        request_id: req.id,
      },
    });
    return;
  }
  next();
}
