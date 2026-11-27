import { vi } from "vitest";
import type { ChallengeLog } from "../src/types.js";

// Stand-in for the logger pkc-js passes. pkc-js 0.0.165 makes `log` required, so every direct call to the
// factory, getChallenge or validateChallengeSettings needs one.
export const createLogStub = () => {
  const stub = Object.assign(vi.fn(), {
    error: vi.fn(),
    trace: vi.fn(),
    child: vi.fn()
  });
  stub.child.mockReturnValue(stub);

  return {
    log: stub as unknown as ChallengeLog,
    stub,
    // Every line written at any level, each call's arguments joined, for content checks.
    lines: (): string[] =>
      [...stub.mock.calls, ...stub.error.mock.calls, ...stub.trace.mock.calls].map((args) =>
        args.map(String).join(" ")
      )
  };
};
