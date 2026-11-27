import { recoverMessageAddress } from "viem";

// Author wallet proofs as specified in BSIP-22:
// https://github.com/bitsocialnet/BSIPs/blob/master/BSIPS/bsip-22.md
//
// Verification is stateless and needs no RPC: no "newest timestamp wins", no per-wallet or per-author
// record. The proof binds a wallet to the author's signing key (never to the runtime author.address,
// which follows a name when the name is repointed), and names the wallet so that a made-up signature
// cannot "prove" an address nobody controls.

export const WALLET_PROOF_DOMAIN_SEPARATOR = "bitsocial-author-wallet";
// How far ahead of the verifier's clock a proof timestamp may be, in seconds.
export const WALLET_PROOF_TIMESTAMP_ALLOWANCE_SECONDS = 300;

// Half of the secp256k1 curve order. Signatures with s above it are the malleable twin of a valid one.
const SECP256K1_HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export type WalletProofOutcome =
  | { outcome: "valid" }
  // Unproven: not a ground for rejecting a publication, but it does not satisfy this challenge.
  | { outcome: "unknown"; reason: string }
  | { outcome: "invalid"; reason: string };

// The string the wallet signs with EIP-191. Built by concatenation: the field order is fixed and there is
// no whitespace, so a serializer whose key order has not been confirmed must not be used.
export const buildWalletProofMessage = (params: {
  authorPublicKey: string;
  walletAddress: string;
  timestamp: number;
}): string =>
  `{"domainSeparator":"${WALLET_PROOF_DOMAIN_SEPARATOR}",` +
  `"authorPublicKey":"${params.authorPublicKey}",` +
  `"walletAddress":"${params.walletAddress.toLowerCase()}",` +
  `"timestamp":${params.timestamp}}`;

// For a value the author picks (a wallet's chain ticker key, its signature type) that is echoed back in a
// reason. Reasons go to the author and to the node's log buffer, which every RPC client can read, so the
// value is kept to one bounded line of plain characters: no newlines to forge log lines, no unbounded payload.
const PRINTABLE_TOKEN_MAX_LENGTH = 64;
export const toPrintableToken = (value: string): string => {
  const printable = value.replace(/[^\w.:+-]/g, "?");
  return printable.length > PRINTABLE_TOKEN_MAX_LENGTH
    ? `${printable.slice(0, PRINTABLE_TOKEN_MAX_LENGTH)}...`
    : printable;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const verifyWalletProof = async (params: {
  entry: unknown;
  // The key address (12D3KooW...) of the signing key of the publication that carries the entry.
  authorPublicKey: string;
  // Seconds since the epoch. Injectable for tests.
  now?: number;
}): Promise<WalletProofOutcome> => {
  const { entry } = params;
  if (
    !isRecord(entry) ||
    typeof entry.address !== "string" ||
    typeof entry.timestamp !== "number" ||
    !Number.isInteger(entry.timestamp) ||
    !isRecord(entry.signature) ||
    typeof entry.signature.signature !== "string" ||
    typeof entry.signature.type !== "string"
  ) {
    return {
      outcome: "invalid",
      reason:
        "The wallet entry must have the shape { address: string, timestamp: integer, signature: { signature: string, type: string } }"
    };
  }

  const { address, timestamp } = entry;
  const { signature, type } = entry.signature;

  if (type !== "eip191") {
    return {
      outcome: "unknown",
      reason: `The wallet signature type '${toPrintableToken(type)}' is not supported, so the wallet is unproven`
    };
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return {
      outcome: "invalid",
      reason: "The wallet address must be 0x followed by 40 hex digits"
    };
  }

  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (timestamp < 0 || timestamp > now + WALLET_PROOF_TIMESTAMP_ALLOWANCE_SECONDS) {
    return {
      outcome: "invalid",
      reason: "The wallet signature timestamp is negative or too far in the future"
    };
  }

  // Recovery libraries, viem included, accept other forms of v and s, so both are checked explicitly.
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return {
      outcome: "invalid",
      reason: "The wallet signature must be 65 bytes (0x and 130 hex digits)"
    };
  }
  const v = parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) {
    return { outcome: "invalid", reason: "The wallet signature has an invalid v" };
  }
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  if (s > SECP256K1_HALF_ORDER) {
    return { outcome: "invalid", reason: "The wallet signature has a high s" };
  }

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({
      message: buildWalletProofMessage({
        authorPublicKey: params.authorPublicKey,
        walletAddress: address,
        timestamp
      }),
      signature: signature as `0x${string}`
    });
  } catch {
    return {
      outcome: "invalid",
      reason: "The wallet signature could not be recovered"
    };
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { outcome: "invalid", reason: "The signature of the wallet is invalid" };
  }

  return { outcome: "valid" };
};
