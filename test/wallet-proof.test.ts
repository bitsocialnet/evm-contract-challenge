import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildWalletProofMessage,
  verifyWalletProof
} from "../src/wallet-proof.js";

// Test vectors from BSIP-22 (assets/bsip-22/wallet-proof-vectors.json). Test keys only.
const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/bsip-22-wallet-proof-vectors.json", import.meta.url),
    "utf8"
  )
) as {
  authorKey: { address: string };
  walletAddress: string;
  timestamp: number;
  proofMessage: string;
  cases: Array<{
    name: string;
    entry: unknown;
    verifierTime: number;
    outcome: "valid" | "invalid" | "unknown";
    authorKey?: string;
  }>;
};

describe("wallet proof (BSIP-22)", () => {
  it("builds the exact proof message of the vector", () => {
    expect(
      buildWalletProofMessage({
        authorPublicKey: vectors.authorKey.address,
        walletAddress: vectors.walletAddress,
        timestamp: vectors.timestamp
      })
    ).toBe(vectors.proofMessage);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const result = await verifyWalletProof({
      entry: c.entry,
      authorPublicKey: c.authorKey ?? vectors.authorKey.address,
      now: c.verifierTime
    });

    expect(result.outcome).toBe(c.outcome);
  });

  it("does not accept a proof for a different author key", async () => {
    const valid = vectors.cases[0]!;
    const result = await verifyWalletProof({
      entry: valid.entry,
      authorPublicKey: "12D3KooWRndVhVZPCiQwHBBBdg769GyrPUW13zxwqQyf9r3ANaba",
      now: valid.verifierTime
    });

    expect(result.outcome).toBe("invalid");
  });
});
