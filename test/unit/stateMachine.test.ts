import { describe, expect, it } from "vitest";
import { PARCEL_STATUSES, type ParcelStatus } from "../../src/domain/parcelStatus.js";
import { assertValidTransition, InvalidTransitionError, isValidTransition } from "../../src/domain/stateMachine.js";

const VALID_TRANSITIONS: ReadonlyArray<readonly [ParcelStatus, ParcelStatus]> = [
  ["submitted", "documents_pending"],
  ["documents_pending", "under_verification"],
  ["under_verification", "verified"],
  ["under_verification", "rejected"],
  ["verified", "disputed"],
  ["disputed", "verified"], // the brief requires disputed -> verified to be reversible
];

describe("state machine", () => {
  it("accepts every transition in the documented table", () => {
    for (const [from, to] of VALID_TRANSITIONS) {
      expect(isValidTransition(from, to), `${from} -> ${to} should be valid`).toBe(true);
      expect(() => assertValidTransition(from, to)).not.toThrow();
    }
  });

  it("rejects every transition not in the documented table (exhaustive over all state pairs)", () => {
    const validSet = new Set(VALID_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

    for (const from of PARCEL_STATUSES) {
      for (const to of PARCEL_STATUSES) {
        const expected = validSet.has(`${from}->${to}`);
        expect(isValidTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("throws InvalidTransitionError with the offending states on an invalid transition", () => {
    expect(() => assertValidTransition("verified", "under_verification")).toThrow(InvalidTransitionError);

    try {
      assertValidTransition("rejected", "verified");
      expect.fail("expected assertValidTransition to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const invalidTransitionError = err as InvalidTransitionError;
      expect(invalidTransitionError.from).toBe("rejected");
      expect(invalidTransitionError.to).toBe("verified");
      expect(invalidTransitionError.code).toBe("INVALID_TRANSITION");
    }
  });

  it("treats rejected as terminal — nothing transitions out of it", () => {
    for (const to of PARCEL_STATUSES) {
      expect(isValidTransition("rejected", to)).toBe(false);
    }
  });

  it("never allows a state to transition to itself", () => {
    for (const state of PARCEL_STATUSES) {
      expect(isValidTransition(state, state)).toBe(false);
    }
  });
});
