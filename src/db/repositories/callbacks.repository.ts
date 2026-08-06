import { db } from "../kysely.js";
import { applyTransition } from "./transitions.repository.js";
import { ApiError } from "../../http/middleware/errorHandler.js";

export interface RecordCallbackInput {
  registryReferenceId: string;
  callbackId: string;
  result: "verified" | "rejected";
  remarks: string | null;
  rawPayload: unknown;
}

export interface RecordCallbackResult {
  status: "applied" | "duplicate_ignored";
  parcelId: string;
}

// The idempotency check IS the unique constraint on
// (parcel_id, external_callback_id) — ON CONFLICT DO NOTHING is atomic at
// the database level, so this is safe even if the partner's two
// "duplicate" deliveries land concurrently (which they do in this stub's
// duplicate scenario — two BullMQ jobs firing HTTP requests a couple
// seconds apart, no coordination between them, same as a real partner
// wouldn't coordinate). Inserting the callback record BEFORE applying the
// transition means a duplicate is caught and short-circuited before
// touching parcel state at all — there's no way for a duplicate to
// partially apply.
export async function recordCallbackAndTransition(input: RecordCallbackInput): Promise<RecordCallbackResult> {
  return db.transaction().execute(async (trx) => {
    const parcel = await trx
      .selectFrom("parcels")
      .select(["id", "status"])
      .where("registry_reference_id", "=", input.registryReferenceId)
      .executeTakeFirst();

    if (!parcel) {
      throw new ApiError(
        404,
        "PARCEL_NOT_FOUND",
        `No parcel with registry_reference_id '${input.registryReferenceId}'.`,
      );
    }

    const inserted = await trx
      .insertInto("registry_callbacks")
      .values({
        parcel_id: parcel.id,
        external_callback_id: input.callbackId,
        result: input.result,
        raw_payload: JSON.stringify(input.rawPayload),
      })
      .onConflict((oc) => oc.columns(["parcel_id", "external_callback_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();

    if (!inserted) {
      return { status: "duplicate_ignored", parcelId: parcel.id };
    }

    // A different (non-duplicate) callback_id arriving for a parcel
    // that's no longer under_verification — e.g. two distinct callbacks
    // disagreeing with each other — falls straight through to
    // applyTransition's own InvalidTransitionError -> 409. That's the
    // right behavior: a second, different result for an already-resolved
    // parcel is genuinely anomalous and should surface loudly, not be
    // silently swallowed the way an exact duplicate is.
    await applyTransition(trx, {
      parcelId: parcel.id,
      from: parcel.status,
      to: input.result,
      actor: "registry-partner",
      reason: input.remarks ?? `Registry partner reported '${input.result}'.`,
    });

    return { status: "applied", parcelId: parcel.id };
  });
}
