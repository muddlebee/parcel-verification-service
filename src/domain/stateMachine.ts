import type { ParcelStatus } from "./parcelStatus.js";

// The transition table this service enforces server-side. Anything not
// listed here is a 409, not a silent no-op (per the brief). The brief's own
// diagram is ambiguous about whether rejected/disputed branch directly off
// under_verification or only disputed branches off verified — this is the
// interpretation documented in docs/architecture.md and the README:
//
//   submitted           -> documents_pending   (system, auto, on creation)
//   documents_pending   -> under_verification  (explicit "ready" call, triggers the registry call)
//   under_verification  -> verified            (registry callback)
//   under_verification  -> rejected            (registry callback)
//   verified            -> disputed            (manual, ops — a competing claim surfaces)
//   disputed            -> verified            (manual, ops — the reversal the brief requires)
//
// rejected is terminal. Nothing transitions out of it — the brief doesn't
// describe a path back, and inventing one wasn't asked for.
const ALLOWED_TRANSITIONS: Record<ParcelStatus, readonly ParcelStatus[]> = {
  submitted: ["documents_pending"],
  documents_pending: ["under_verification"],
  under_verification: ["verified", "rejected"],
  verified: ["disputed"],
  rejected: [],
  disputed: ["verified"],
};

export function isValidTransition(from: ParcelStatus, to: ParcelStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly code = "INVALID_TRANSITION";

  constructor(
    public readonly from: ParcelStatus,
    public readonly to: ParcelStatus,
  ) {
    super(`Cannot transition parcel from '${from}' to '${to}'.`);
    this.name = "InvalidTransitionError";
  }
}

export function assertValidTransition(from: ParcelStatus, to: ParcelStatus): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}
