import type { Transaction } from "kysely";
import type { Database } from "../types.js";
import type { ParcelStatus } from "../../domain/parcelStatus.js";
import { assertValidTransition, InvalidTransitionError } from "../../domain/stateMachine.js";

export interface ApplyTransitionParams {
  parcelId: string;
  from: ParcelStatus;
  to: ParcelStatus;
  actor: string;
  reason: string;
}

// Single choke point for every state change in the system — parcel
// creation's auto-advance, the verify trigger, the registry callback, and
// manual ops transitions all go through this. Two things every caller
// gets for free:
//
// 1. Server-side enforcement (assertValidTransition): a 409 is thrown
//    before any row is touched if the move isn't in the table.
// 2. An optimistic concurrency guard: the UPDATE only succeeds if the row
//    is *still* in `from` at the moment of the write. Two requests racing
//    to move the same parcel (e.g. a duplicate verify call, or a callback
//    racing a manual dispute) can't both succeed — the loser's WHERE
//    matches zero rows and gets a 409 instead of silently overwriting the
//    audit trail.
//
// Caller must run this inside a transaction it controls, so the status
// update and the transition-log insert commit atomically together.
export async function applyTransition(trx: Transaction<Database>, params: ApplyTransitionParams): Promise<void> {
  assertValidTransition(params.from, params.to);

  await trx
    .updateTable("parcels")
    .set({ status: params.to, updated_at: new Date().toISOString() })
    .where("id", "=", params.parcelId)
    .where("status", "=", params.from)
    .returning("id")
    .executeTakeFirstOrThrow(() => new InvalidTransitionError(params.from, params.to));

  await trx
    .insertInto("parcel_transitions")
    .values({
      parcel_id: params.parcelId,
      from_state: params.from,
      to_state: params.to,
      actor: params.actor,
      reason: params.reason,
    })
    .execute();
}
