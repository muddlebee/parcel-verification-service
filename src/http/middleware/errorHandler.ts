import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { logger } from "../../logger.js";
import { InvalidTransitionError } from "../../domain/stateMachine.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Last-resort handler. Anything that reaches here is either a known ApiError
// (state-machine 409s, not-found 404s, etc.) or an actual bug — the latter
// gets logged with full detail server-side but never leaks internals to the
// caller.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.id as string | undefined;

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        request_id: requestId,
      },
    });
    return;
  }

  if (err instanceof MulterError) {
    res.status(400).json({
      error: { code: `UPLOAD_${err.code}`, message: err.message, request_id: requestId },
    });
    return;
  }

  if (err instanceof InvalidTransitionError) {
    res.status(409).json({
      error: { code: err.code, message: err.message, request_id: requestId },
    });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, request_id: requestId },
    });
    return;
  }

  logger.error({ err, requestId }, "unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong.", request_id: requestId },
  });
}
