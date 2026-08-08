export const REGISTRY_SCENARIOS = ["verified", "rejected", "timeout", "failure", "duplicate"] as const;
export type RegistryScenario = (typeof REGISTRY_SCENARIOS)[number];

export class RegistryPartnerError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Weighted random pick used when the caller doesn't force a scenario
// (the normal case — a real submission has no idea what the partner will
// do). "duplicate" is deliberately excluded from the random pool: it's a
// delivery-mechanics test, not a business outcome a real submission would
// randomly hit, so it's only reachable by explicit request.
export function pickRandomScenario(): RegistryScenario {
  const r = Math.random();
  if (r < 0.6) return "verified";
  if (r < 0.8) return "rejected";
  if (r < 0.9) return "timeout";
  return "failure";
}

export interface SubmitToRegistryParams {
  registryReferenceId: string;
  scenario: RegistryScenario;
  timeoutMs: number;
}

// This IS the fake external partner — the one thing in this codebase that
// would be deleted and replaced with a real HTTP client if BhoomiPe ever
// gets integration access. Everything downstream (the worker, retry
// config, callback handler) is written against "a slow async call that
// sometimes doesn't come back," not against this stub specifically.
//
// Deliberate simplification: a real timeout means the caller gave up
// waiting, not that this function announced one — so "timeout" here just
// means "take much longer than the caller's own timeout budget," and it's
// the caller (the worker, via Promise.race) that actually produces the
// timeout condition. See submitWorker.ts.
export async function submitToRegistry(params: SubmitToRegistryParams): Promise<{ acknowledged: true }> {
  if (params.scenario === "timeout") {
    await sleep(params.timeoutMs * 3);
    return { acknowledged: true };
  }

  await sleep(randomBetween(params.timeoutMs * 0.2, params.timeoutMs * 0.7));

  if (params.scenario === "failure") {
    throw new RegistryPartnerError("Simulated registry partner failure (5xx).");
  }

  return { acknowledged: true };
}
