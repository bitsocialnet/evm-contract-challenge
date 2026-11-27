import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, verifyMessage } from "viem";
import { mainnet, polygon } from "viem/chains";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount
} from "viem/accounts";
import evmContractChallenge, {
  _clearViemClientCache
} from "../src/evm-contract-challenge.js";
import { buildWalletProofMessage } from "../src/wallet-proof.js";
import { createLogStub } from "./log-stub.js";
import type {
  ChallengeResultInput,
  GetChallengeArgsInput,
  HexAddress,
  PublicationWithCommunityAuthorFromDecryptedChallengeRequest,
  CommunityChallengeSetting
} from "../src/types.js";

type AuthorWallet = NonNullable<NonNullable<PublicationWithCommunityAuthorFromDecryptedChallengeRequest["author"]["wallets"]>[string]>;
type AuthorAvatar = NonNullable<PublicationWithCommunityAuthorFromDecryptedChallengeRequest["author"]["avatar"]>;

interface MockViemClient {
  verifyMessage: (args: { address: HexAddress; message: string; signature: HexAddress }) => Promise<boolean>;
  call: (args: { data: HexAddress; to: HexAddress }) => Promise<{ data?: HexAddress }>;
  getEnsAddress?: (args: { name: string }) => Promise<HexAddress | null | undefined>;
  readContract?: (args: { abi: readonly unknown[]; address: HexAddress; functionName: string; args: readonly unknown[] }) => Promise<unknown>;
}

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: (args: { chain?: { id: number } }) => {
      createPublicClientArgs.push(args);
      return currentMockClient;
    }
  };
});

let currentMockClient: MockViemClient;
// Recorded so the tests can assert on the client viem was asked to build, not just on the mock that
// comes back. Passing a chain is what gives http() a default RPC and what lets getEnsAddress run.
const createPublicClientArgs: Array<{ chain?: { id: number } }> = [];

const CONTRACT_ADDRESS =
  "0xEA81DaB2e0EcBc6B5c4172DE4c22B6Ef6E55Bd8f" as const;
const TOKEN_ADDRESS =
  "0x890a2e81836e0E76e0F49995e6b51ca6ce6F39ED" as const;
const BALANCE_ABI_JSON =
  '{"constant":true,"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"}';
const HIGH_BALANCE_DATA =
  "0x0000000000000000000000000000000000000000865a0735887d15fcf91fa302" as HexAddress;
const ZERO_BALANCE_DATA =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as HexAddress;
// Exactly 1000, so a "=1000" condition turns on the parsed value alone rather than on the margin.
const EXACT_1000_BALANCE_DATA =
  "0x00000000000000000000000000000000000000000000000000000000000003e8" as HexAddress;
// The condition value can be a string when the contract returns one, which is the only place the
// difference between splitting on the operator and slicing past it is observable.
const STRING_ABI_JSON =
  '{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"tierOf","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"}';
const DEFAULT_AUTHOR_ADDRESS = "author-address";
// The key address (12D3KooW...) of the author's signing key; pkc-js sets author.publicKey from the
// verified signature. Taken from the BSIP-22 test vectors.
const DEFAULT_AUTHOR_PUBLIC_KEY = "12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5";
const OTHER_AUTHOR_PUBLIC_KEY = "12D3KooWRndVhVZPCiQwHBBBdg769GyrPUW13zxwqQyf9r3ANaba";
const NFT_DISABLED_REASON =
  "The NFT avatar source is disabled until a BSIP defines the avatar proof";
const DEFAULT_RPC_URLS = "https://eth.example";

const DEFAULT_OPTIONS = {
  chainTicker: "eth",
  rpcUrls: DEFAULT_RPC_URLS,
  address: CONTRACT_ADDRESS,
  abi: BALANCE_ABI_JSON,
  condition: ">1000",
  error: "PLEB token balance must be greater than 1000."
};

let account: PrivateKeyAccount;

beforeAll(() => {
  account = privateKeyToAccount(generatePrivateKey());
});

beforeEach(() => {
  // Clients are cached per (chainTicker, rpcUrls), so without this every test after the first would
  // keep the first test's mock client instead of its own.
  _clearViemClientCache();
  createPublicClientArgs.length = 0;
});

const createChallengeSettings = (
  overrides: Partial<typeof DEFAULT_OPTIONS> = {}
): CommunityChallengeSetting => ({
  name: "@bitsocial/evm-contract-challenge",
  options: {
    ...DEFAULT_OPTIONS,
    ...overrides
  }
});

const createClient = (overrides: Partial<MockViemClient> = {}): MockViemClient => {
  const client: MockViemClient = {
    verifyMessage: overrides.verifyMessage ?? (async () => false),
    call: overrides.call ?? (async () => ({ data: ZERO_BALANCE_DATA }))
  };

  if (overrides.getEnsAddress) {
    client.getEnsAddress = overrides.getEnsAddress;
  }
  if (overrides.readContract) {
    client.readContract = overrides.readContract;
  }

  return client;
};

const createCommunity = (params: {
  resolveAuthorName?: (args: {
    name: string;
  }) => Promise<{ resolvedAuthorName: string | null }>;
} = {}) => {
  const storage = new Map<string, unknown>();

  const pkc = {
    resolveAuthorName:
      params.resolveAuthorName ??
      (async ({ name }: { name: string }) => ({ resolvedAuthorName: name })),
    _createStorageLRU: async () => ({
      getItem: async (key: string) => storage.get(key),
      setItem: async (key: string, value: unknown) => {
        storage.set(key, value);
      }
    })
  };

  return { _pkc: pkc };
};

const createPublication = (params: {
  authorAddress?: string;
  authorPublicKey?: string;
  wallet?: AuthorWallet;
  avatar?: AuthorAvatar;
  // The wallet is looked up as author.wallets[chainTicker], so a test using a non-default chainTicker
  // has to register the wallet under that ticker or the wallet check returns early.
  walletChainTicker?: string;
}): PublicationWithCommunityAuthorFromDecryptedChallengeRequest => {
  const authorAddress = params.authorAddress ?? DEFAULT_AUTHOR_ADDRESS;

  return {
    author: {
      address: authorAddress,
      publicKey: params.authorPublicKey ?? DEFAULT_AUTHOR_PUBLIC_KEY,
      ...(params.wallet
        ? { wallets: { [params.walletChainTicker ?? "eth"]: params.wallet } }
        : {}),
      ...(params.avatar ? { avatar: params.avatar } : {})
    },
    signature: { type: "ed25519", signature: "", publicKey: "mock-public-key", signedPropertyNames: [] }
  } as unknown as PublicationWithCommunityAuthorFromDecryptedChallengeRequest;
};

const createAvatarMessage = (params: {
  authorAddress: string;
  timestamp: number;
  tokenAddress: string;
  tokenId: string;
}): string => {
  const message: Record<string, string | number> = {};
  message.domainSeparator = "plebbit-author-avatar";
  message.authorAddress = params.authorAddress;
  message.timestamp = params.timestamp;
  message.tokenAddress = params.tokenAddress;
  message.tokenId = params.tokenId;
  return JSON.stringify(message);
};

const signWalletProof = async (params: {
  // The key the proof is bound to; defaults to the default publication's signing key.
  authorPublicKey?: string;
  // Signs a different message than the one sent, so the signature does not verify.
  corrupted?: boolean;
  timestamp?: number;
} = {}): Promise<AuthorWallet> => {
  const timestamp = params.timestamp ?? Math.round(Date.now() / 1000);
  const message = buildWalletProofMessage({
    authorPublicKey: params.authorPublicKey ?? DEFAULT_AUTHOR_PUBLIC_KEY,
    walletAddress: account.address,
    timestamp
  });
  const signedMessage = params.corrupted ? `${message}1` : message;

  const signature = await account.signMessage({ message: signedMessage });
  return {
    address: account.address,
    signature: { signature, type: "eip191" },
    timestamp
  };
};

const signAvatarProof = async (params: {
  authorAddress: string;
  corrupted?: boolean;
}): Promise<AuthorAvatar> => {
  const timestamp = Math.round(Date.now() / 1000);
  const tokenId = "5404";
  const message = createAvatarMessage({
    authorAddress: params.authorAddress,
    timestamp,
    tokenAddress: TOKEN_ADDRESS,
    tokenId
  });
  const signedMessage = params.corrupted ? `${message}1` : message;

  const signature = await account.signMessage({ message: signedMessage });
  return {
    address: TOKEN_ADDRESS,
    chainTicker: "matic",
    id: tokenId,
    timestamp,
    signature: { signature, type: "eip191" }
  };
};

const executeChallenge = async (params: {
  publication: PublicationWithCommunityAuthorFromDecryptedChallengeRequest;
  settings?: CommunityChallengeSetting;
  mockClient: MockViemClient;
  community?: ReturnType<typeof createCommunity>;
  log?: ReturnType<typeof createLogStub>["log"];
}): Promise<ChallengeResultInput> => {
  const settings = params.settings ?? createChallengeSettings();
  const community = params.community ?? createCommunity();
  const log = params.log ?? createLogStub().log;

  currentMockClient = params.mockClient;

  const challengeFile = evmContractChallenge({ challengeSettings: settings, log });
  const result = await challengeFile.getChallenge({
    challengeSettings: settings,
    challengeRequestMessage: { comment: params.publication } as unknown as GetChallengeArgsInput["challengeRequestMessage"],
    challengeIndex: 0,
    community: community as unknown as GetChallengeArgsInput["community"],
    log
  });

  if (!("success" in result)) {
    throw new Error("Expected a challenge result");
  }

  return result;
};

describe("evmContractChallenge", () => {
  it("passes when wallet balance is over threshold", async () => {
    const wallet = await signWalletProof();

    const mockClient = createClient({
      verifyMessage,
      call: async () => ({ data: HIGH_BALANCE_DATA })
    });

    const result = await executeChallenge({
      publication: createPublication({ wallet }),
      mockClient
    });

    expect(result).toEqual({ success: true });
  });

  it("fails when wallet balance is below threshold and no ENS/NFT fallback", async () => {
    const wallet = await signWalletProof();

    const mockClient = createClient({
      verifyMessage,
      call: async () => ({ data: ZERO_BALANCE_DATA })
    });

    const result = await executeChallenge({
      publication: createPublication({ wallet }),
      mockClient
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toBe(
      "Author (author-address) has failed all EVM challenges, " +
        "walletFailureReason='PLEB token balance must be greater than 1000.', " +
        "ensAuthorAddressFailureReason='Author address is not a .bso/.eth domain', " +
        `nftWalletAddressFailureReason='${NFT_DISABLED_REASON}'`
    );
  });

  // Disabled until a BSIP defines the avatar proof.
  it.skip("passes when wallet fails but NFT owner wallet passes", async () => {
    const wallet = await signWalletProof();
    const avatar = await signAvatarProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

    let callCount = 0;
    const mockClient = createClient({
      verifyMessage,
      readContract: async () => account.address,
      call: async () => {
        callCount += 1;
        return {
          data: callCount === 1 ? ZERO_BALANCE_DATA : HIGH_BALANCE_DATA
        };
      }
    });

    const result = await executeChallenge({
      publication: createPublication({ wallet, avatar }),
      mockClient
    });

    expect(result).toEqual({ success: true });
  });

  // Disabled until a BSIP defines the avatar proof.
  it.skip("fails when both wallet and NFT wallets are below threshold", async () => {
    const wallet = await signWalletProof();
    const avatar = await signAvatarProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

    const mockClient = createClient({
      verifyMessage,
      readContract: async () => account.address,
      call: async () => ({ data: ZERO_BALANCE_DATA })
    });

    const result = await executeChallenge({
      publication: createPublication({ wallet, avatar }),
      mockClient
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toBe(
      "Author (author-address) has failed all EVM challenges, " +
        "walletFailureReason='PLEB token balance must be greater than 1000.', " +
        "ensAuthorAddressFailureReason='Author address is not a .bso/.eth domain', " +
        "nftWalletAddressFailureReason='PLEB token balance must be greater than 1000.'"
    );
  });

  it("fails with invalid wallet signature", async () => {
    const wallet = await signWalletProof({ corrupted: true });

    const mockClient = createClient({
      verifyMessage,
      call: async () => ({ data: ZERO_BALANCE_DATA })
    });

    const result = await executeChallenge({
      publication: createPublication({ wallet }),
      mockClient
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toBe(
      "The author wallet entry for chain 'eth' is invalid: The signature of the wallet is invalid"
    );
  });

  // Disabled until a BSIP defines the avatar proof.
  it.skip("fails with invalid NFT signature", async () => {
    const avatar = await signAvatarProof({
      authorAddress: DEFAULT_AUTHOR_ADDRESS,
      corrupted: true
    });

    const mockClient = createClient({
      verifyMessage,
      readContract: async () => account.address,
      call: async () => ({ data: ZERO_BALANCE_DATA })
    });

    const result = await executeChallenge({
      publication: createPublication({ avatar }),
      mockClient
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toBe(
      "Author (author-address) has failed all EVM challenges, " +
        "walletFailureReason='The author wallet address is not defined', " +
        "ensAuthorAddressFailureReason='Author address is not a .bso/.eth domain', " +
        "nftWalletAddressFailureReason='The signature of the nft avatar is invalid'"
    );
  });

  it("passes for .eth author address when ENS owner wallet passes condition", async () => {
    const mockClient = createClient({
      verifyMessage,
      getEnsAddress: async () => account.address,
      call: async () => ({ data: HIGH_BALANCE_DATA })
    });

    const result = await executeChallenge({
      publication: createPublication({ authorAddress: "plebbit.eth" }),
      mockClient
    });

    expect(result).toEqual({ success: true });
  });

  it("passes for .bso author address when ENS owner wallet passes condition", async () => {
    const mockClient = createClient({
      verifyMessage,
      getEnsAddress: async () => account.address,
      call: async () => ({ data: HIGH_BALANCE_DATA })
    });

    const result = await executeChallenge({
      publication: createPublication({ authorAddress: "plebbit.bso" }),
      mockClient
    });

    expect(result).toEqual({ success: true });
  });

  it("throws for missing required options", async () => {
    const mockClient = createClient({
      verifyMessage,
      call: async () => ({ data: HIGH_BALANCE_DATA })
    });

    const publication = createPublication({
      wallet: await signWalletProof()
    });

    const missingCases: Array<{ key: string; expectedError: string }> = [
      { key: "chainTicker", expectedError: "missing option chainTicker" },
      { key: "address", expectedError: "missing option address" },
      { key: "abi", expectedError: "missing option abi" },
      { key: "condition", expectedError: "missing option condition" }
    ];

    for (const missingCase of missingCases) {
      const entries = Object.entries(DEFAULT_OPTIONS).filter(
        ([key]) => key !== missingCase.key
      );
      const options = Object.fromEntries(entries) as Record<string, string>;
      const settings: CommunityChallengeSetting = {
        name: "@bitsocial/evm-contract-challenge",
        options
      };

      await expect(
        executeChallenge({
          publication,
          mockClient,
          settings
        })
      ).rejects.toThrow(missingCase.expectedError);
    }
  });

  it("throws for unsupported condition operator", async () => {
    const wallet = await signWalletProof();

    const mockClient = createClient({
      verifyMessage,
      call: async () => ({ data: HIGH_BALANCE_DATA })
    });

    await expect(
      executeChallenge({
        publication: createPublication({ wallet }),
        mockClient,
        settings: createChallengeSettings({ condition: "!1000" })
      })
    ).rejects.toThrow("Condition uses unsupported comparison operator");
  });

  it("compares a whitespace-padded ordering condition numerically", async () => {
    // parseCondition used to keep the space, making isNumericConditionValue false and the comparison
    // a String() one, where "0" > " 1000". validateChallengeSettings trimmed before its numeric check,
    // so it accepted exactly the condition it exists to reject.
    const wallet = await signWalletProof();

    const result = await executeChallenge({
      publication: createPublication({ wallet }),
      mockClient: createClient({
        verifyMessage,
        call: async () => ({ data: ZERO_BALANCE_DATA })
      }),
      settings: createChallengeSettings({ condition: ">  1000" })
    });

    expect(result.success).toBe(false);
  });

  it("still passes a padded ordering condition when the balance is over it", async () => {
    const wallet = await signWalletProof();

    const result = await executeChallenge({
      publication: createPublication({ wallet }),
      mockClient: createClient({
        verifyMessage,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      }),
      settings: createChallengeSettings({ condition: "> 1000" })
    });

    expect(result).toEqual({ success: true });
  });

  it("compares a whitespace-padded equality condition against the trimmed value", async () => {
    // The ordering operators are not the only ones the untrimmed value broke: "= 1000" compared
    // String(1000n) against " 1000", so an exactly-matching balance failed its own condition.
    const wallet = await signWalletProof();

    const result = await executeChallenge({
      publication: createPublication({ wallet }),
      mockClient: createClient({
        verifyMessage,
        call: async () => ({ data: EXACT_1000_BALANCE_DATA })
      }),
      settings: createChallengeSettings({ condition: "= 1000" })
    });

    expect(result).toEqual({ success: true });
  });

  it("keeps the operator character inside a condition value", async () => {
    // parseCondition used to split on the operator and take element [1], so "=a=b" asked for "a".
    // Slicing past the operator once is what validateConditionOption always did.
    const wallet = await signWalletProof();

    const result = await executeChallenge({
      publication: createPublication({ wallet }),
      mockClient: createClient({
        verifyMessage,
        call: async () => ({
          data: encodeAbiParameters([{ type: "string" }], ["a=b"]) as HexAddress
        })
      }),
      settings: createChallengeSettings({
        abi: STRING_ABI_JSON,
        condition: "=a=b"
      })
    });

    expect(result).toEqual({ success: true });
  });

  it("passes when rpcUrls is omitted, using the chain's built-in RPC", async () => {
    const wallet = await signWalletProof();

    const mockClient = createClient({
      verifyMessage,
      call: async () => ({ data: HIGH_BALANCE_DATA })
    });

    const { rpcUrls: _, ...optionsWithoutRpcUrl } = DEFAULT_OPTIONS;
    const settings: CommunityChallengeSetting = {
      name: "@bitsocial/evm-contract-challenge",
      options: optionsWithoutRpcUrl
    };

    const result = await executeChallenge({
      publication: createPublication({ wallet }),
      mockClient,
      settings
    });

    expect(result).toEqual({ success: true });
  });

  it("returns chain type from chainTicker option", () => {
    const file = evmContractChallenge({
      challengeSettings: createChallengeSettings({ chainTicker: "matic" }),
      log: createLogStub().log
    });

    expect(file.type).toBe("chain/matic");
  });

  it("rejects a name as the wallet address, without resolving it", async () => {
    const wallet = await signWalletProof();
    // BSIP-22: the address of a wallet entry is 0x followed by 40 hex digits, not a name.
    const domainWallet = { ...wallet, address: "wallet-owner.eth" } as typeof wallet;
    const resolveAuthorNameCalls: Array<{ name: string }> = [];

    const result = await executeChallenge({
      publication: createPublication({ wallet: domainWallet }),
      mockClient: createClient({ call: async () => ({ data: HIGH_BALANCE_DATA }) }),
      community: createCommunity({
        resolveAuthorName: async (args) => {
          resolveAuthorNameCalls.push(args);
          return { resolvedAuthorName: DEFAULT_AUTHOR_PUBLIC_KEY };
        }
      })
    });

    expect(resolveAuthorNameCalls).toEqual([]);
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain(
      "The author wallet entry for chain 'eth' is invalid: The wallet address must be 0x followed by 40 hex digits"
    );
  });

  describe("wallet proof (BSIP-22)", () => {
    const highBalanceClient = () =>
      createClient({ call: async () => ({ data: HIGH_BALANCE_DATA }) });

    it("accepts a proof bound to the signing key when the author has a name", async () => {
      const wallet = await signWalletProof();

      const result = await executeChallenge({
        publication: createPublication({ authorAddress: "plebbit.bso", wallet }),
        mockClient: highBalanceClient()
      });

      expect(result).toEqual({ success: true });
    });

    it("accepts a wallet address in a non-checksum mixed case", async () => {
      const wallet = await signWalletProof();
      // BSIP-22 compares addresses without regard to letter case, so this spelling is a valid entry.
      // viem refuses to ABI-encode a mixed-case address whose checksum is wrong.
      // Flipping the case of one letter of the checksummed address always breaks its checksum.
      const address = account.address.replace(/(?<=^0x[0-9a-fA-F]*?)[a-fA-F]/, (c) =>
        c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()
      );
      expect(address).not.toBe(account.address);
      const mixedCaseWallet = { ...wallet, address } as AuthorWallet;

      const result = await executeChallenge({
        publication: createPublication({ wallet: mixedCaseWallet }),
        mockClient: highBalanceClient()
      });

      expect(result).toEqual({ success: true });
    });

    it("rejects a proof signed over the runtime author address", async () => {
      // What the old code and the old clients signed: the name, not the key.
      const wallet = await signWalletProof({ authorPublicKey: "plebbit.bso" });

      const result = await executeChallenge({
        publication: createPublication({ authorAddress: "plebbit.bso", wallet }),
        mockClient: highBalanceClient()
      });

      expect(result.success).toBe(false);
      expect((result as { error?: string }).error).toContain(
        "The author wallet entry for chain 'eth' is invalid: The signature of the wallet is invalid"
      );
    });

    it("rejects a proof bound to another key", async () => {
      const wallet = await signWalletProof({ authorPublicKey: OTHER_AUTHOR_PUBLIC_KEY });

      const result = await executeChallenge({
        publication: createPublication({ wallet }),
        mockClient: highBalanceClient()
      });

      expect(result.success).toBe(false);
    });

    it.each(["plebbit-author-wallet", "pkc-author-wallet"])(
      "rejects a proof signed with the old %s separator",
      async (separator) => {
        const timestamp = Math.round(Date.now() / 1000);
        const message = JSON.stringify({
          domainSeparator: separator,
          authorAddress: DEFAULT_AUTHOR_PUBLIC_KEY,
          timestamp
        });
        const wallet = {
          address: account.address,
          timestamp,
          signature: { signature: await account.signMessage({ message }), type: "eip191" }
        } as AuthorWallet;

        const result = await executeChallenge({
          publication: createPublication({ wallet }),
          mockClient: highBalanceClient()
        });

        expect(result.success).toBe(false);
      }
    );

    it("treats an unknown signature type as unproven, not as a pass", async () => {
      const wallet = await signWalletProof();
      const unknownWallet = {
        ...wallet,
        signature: { ...wallet.signature, type: "eip1271" }
      } as AuthorWallet;

      const result = await executeChallenge({
        publication: createPublication({ wallet: unknownWallet }),
        mockClient: highBalanceClient()
      });

      expect(result.success).toBe(false);
      expect((result as { error?: string }).error).toContain(
        "walletFailureReason='The wallet signature type 'eip1271' is not supported, so the wallet is unproven'"
      );
    });

    it("rejects a timestamp more than 300 seconds ahead of the clock", async () => {
      const wallet = await signWalletProof({
        timestamp: Math.round(Date.now() / 1000) + 400
      });

      const result = await executeChallenge({
        publication: createPublication({ wallet }),
        mockClient: highBalanceClient()
      });

      expect(result.success).toBe(false);
    });

    it("rejects the publication when the wallet entry is invalid, even if the ENS owner passes", async () => {
      const wallet = await signWalletProof({ corrupted: true });

      const result = await executeChallenge({
        publication: createPublication({ authorAddress: "plebbit.eth", wallet }),
        mockClient: createClient({
          getEnsAddress: async () => account.address,
          call: async () => ({ data: HIGH_BALANCE_DATA })
        })
      });

      expect(result).toEqual({
        success: false,
        error:
          "The author wallet entry for chain 'eth' is invalid: The signature of the wallet is invalid"
      });
    });

    it("rejects the publication when an entry for another chain is invalid, naming that chain", async () => {
      const validEthWallet = await signWalletProof();
      const invalidPolygonWallet = await signWalletProof({ corrupted: true });
      const publication = createPublication({ wallet: validEthWallet });
      publication.author.wallets = {
        eth: validEthWallet,
        matic: invalidPolygonWallet
      };

      const result = await executeChallenge({
        publication,
        mockClient: highBalanceClient()
      });

      expect(result).toEqual({
        success: false,
        error:
          "The author wallet entry for chain 'matic' is invalid: The signature of the wallet is invalid"
      });
    });

    it("lets an unknown entry fall through to the ENS source", async () => {
      const wallet = await signWalletProof();
      const unknownWallet = {
        ...wallet,
        signature: { ...wallet.signature, type: "eip1271" }
      } as AuthorWallet;

      const result = await executeChallenge({
        publication: createPublication({ authorAddress: "plebbit.eth", wallet: unknownWallet }),
        mockClient: createClient({
          getEnsAddress: async () => account.address,
          call: async () => ({ data: HIGH_BALANCE_DATA })
        })
      });

      expect(result).toEqual({ success: true });
    });

    it("is stateless: an older proof is accepted after a newer one", async () => {
      const now = Math.round(Date.now() / 1000);
      const newer = await signWalletProof({ timestamp: now });
      const older = await signWalletProof({ timestamp: now - 3600 });
      const community = createCommunity();

      for (const wallet of [newer, older]) {
        const result = await executeChallenge({
          publication: createPublication({ wallet }),
          mockClient: highBalanceClient(),
          community
        });
        expect(result).toEqual({ success: true });
      }
    });
  });

  it("builds the contract-call client with the chain the chainTicker names", async () => {
    const wallet = await signWalletProof();

    await executeChallenge({
      publication: createPublication({ wallet, walletChainTicker: "matic" }),
      mockClient: createClient({
        verifyMessage,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      }),
      settings: createChallengeSettings({ chainTicker: "matic" })
    });

    // Without a chain, viem's http() has no default RPC and throws UrlRequiredError at construction.
    expect(createPublicClientArgs.length).toBeGreaterThan(0);
    for (const args of createPublicClientArgs) {
      expect(args.chain?.id).toBe(polygon.id);
    }
  });

  it("resolves ENS against mainnet even when the contract call targets another chain", async () => {
    await executeChallenge({
      publication: createPublication({ authorAddress: "plebbit.eth" }),
      mockClient: createClient({
        verifyMessage,
        getEnsAddress: async () => account.address,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      }),
      settings: createChallengeSettings({ chainTicker: "matic" })
    });

    // ENS only exists on Ethereum mainnet, and viem refuses the lookup outright without a chain
    // ("client chain not configured. universalResolverAddress is required").
    expect(createPublicClientArgs.map((args) => args.chain?.id)).toContain(mainnet.id);
  });

  // Disabled until a BSIP defines the avatar proof.
  it.skip("falls through to the NFT check when the ENS lookup throws", async () => {
    const avatar = await signAvatarProof({ authorAddress: "plebbit.eth" });

    const result = await executeChallenge({
      publication: createPublication({ authorAddress: "plebbit.eth", avatar }),
      mockClient: createClient({
        verifyMessage,
        getEnsAddress: async () => {
          throw new Error("ENS provider is down");
        },
        readContract: async () => account.address,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      })
    });

    // A throwing ENS lookup used to propagate out of getChallenge, so the NFT check below it never ran
    // and the author got an exception instead of a challenge result.
    expect(result).toEqual({ success: true });
  });

  it("reports a failed ENS lookup as a challenge failure, not an exception", async () => {
    const result = await executeChallenge({
      publication: createPublication({ authorAddress: "plebbit.eth" }),
      mockClient: createClient({
        verifyMessage,
        getEnsAddress: async () => {
          throw new Error("ENS provider is down");
        },
        call: async () => ({ data: ZERO_BALANCE_DATA })
      })
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain(
      "ensAuthorAddressFailureReason='Failed to resolve ENS address of author.address: ENS provider is down'"
    );
  });

  it("reports an unresolvable ENS name as a challenge failure", async () => {
    const result = await executeChallenge({
      publication: createPublication({ authorAddress: "plebbit.eth" }),
      mockClient: createClient({
        verifyMessage,
        getEnsAddress: async () => null,
        call: async () => ({ data: ZERO_BALANCE_DATA })
      })
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain(
      "ensAuthorAddressFailureReason='Failed to get owner of ENS address of author.address'"
    );
  });

  describe("logging", () => {
    it("logs nothing for a publication that passes", async () => {
      const wallet = await signWalletProof();
      const logStub = createLogStub();

      const result = await executeChallenge({
        publication: createPublication({ wallet }),
        mockClient: createClient({ verifyMessage, call: async () => ({ data: HIGH_BALANCE_DATA }) }),
        log: logStub.log
      });

      expect(result).toEqual({ success: true });
      expect(logStub.lines()).toEqual([]);
    });

    it("logs the cause of a failed contract call, which the author never sees", async () => {
      const wallet = await signWalletProof();
      const logStub = createLogStub();

      const result = await executeChallenge({
        publication: createPublication({ wallet }),
        mockClient: createClient({
          verifyMessage,
          call: async () => {
            throw new Error("HTTP request failed.");
          }
        }),
        log: logStub.log
      });

      expect(result.success).toBe(false);
      expect(logStub.stub.error).toHaveBeenCalledTimes(1);
      expect(String(logStub.stub.error.mock.calls[0]?.[0])).toMatch(
        /^Contract call to .* failed: HTTP request failed\.$/
      );
    });

    it("logs the final rejection with its reasons at trace level", async () => {
      const wallet = await signWalletProof();
      const logStub = createLogStub();

      await executeChallenge({
        publication: createPublication({ wallet }),
        mockClient: createClient({ verifyMessage, call: async () => ({ data: ZERO_BALANCE_DATA }) }),
        log: logStub.log
      });

      expect(logStub.stub.trace).toHaveBeenCalledWith(
        expect.stringContaining("has failed all EVM challenges")
      );
    });

    it("never writes an rpcUrls value, even when viem's error repeats the URL", async () => {
      const wallet = await signWalletProof();
      const logStub = createLogStub();
      const secretRpcUrl = "https://eth-mainnet.example/v2/SECRET-KEY";
      // viem puts the URL on a later line; the first line here carries it too, to test the masking.
      const viemLikeError = new Error(
        `HTTP request failed at ${secretRpcUrl}.\n\nURL: ${secretRpcUrl}\nRequest body: {}`
      );

      const result = await executeChallenge({
        publication: createPublication({ wallet, authorAddress: "plebbit.eth" }),
        settings: createChallengeSettings({ rpcUrls: secretRpcUrl }),
        mockClient: createClient({
          verifyMessage,
          getEnsAddress: async () => {
            throw viemLikeError;
          },
          call: async () => {
            throw viemLikeError;
          }
        }),
        log: logStub.log
      });

      expect(logStub.stub.error).toHaveBeenCalled();
      for (const line of logStub.lines()) {
        expect(line).not.toContain("SECRET-KEY");
        expect(line).not.toContain("\n");
      }
      // The ENS reason is returned to the author too, so it is masked there as well.
      expect((result as { error?: string }).error).not.toContain("SECRET-KEY");
    });

    it("masks a keyed RPC URL that another configured URL is a prefix of", async () => {
      const wallet = await signWalletProof();
      const logStub = createLogStub();
      const keyedRpcUrl = "https://rpc.example/v2/SECRET-KEY";

      await executeChallenge({
        publication: createPublication({ wallet }),
        // The short URL comes first, so masking in configured order would leave "/v2/SECRET-KEY".
        settings: createChallengeSettings({ rpcUrls: `https://rpc.example,${keyedRpcUrl}` }),
        mockClient: createClient({
          verifyMessage,
          call: async () => {
            throw new Error(`HTTP request failed at ${keyedRpcUrl}.`);
          }
        }),
        log: logStub.log
      });

      expect(logStub.stub.error).toHaveBeenCalledWith(
        expect.stringContaining("failed: HTTP request failed at <rpcUrl>.")
      );
      expect(logStub.lines().join("\n")).not.toContain("SECRET-KEY");
    });

    it("logs nothing when the wallet's contract call fails but the ENS owner passes", async () => {
      const wallet = await signWalletProof();
      const logStub = createLogStub();
      let callCount = 0;

      const result = await executeChallenge({
        publication: createPublication({ wallet, authorAddress: "plebbit.eth" }),
        mockClient: createClient({
          verifyMessage,
          getEnsAddress: async () => account.address,
          // The first call is the proven wallet's, the second the ENS owner's.
          call: async () => {
            callCount += 1;
            if (callCount === 1) {
              throw new Error("HTTP request failed.");
            }
            return { data: HIGH_BALANCE_DATA };
          }
        }),
        log: logStub.log
      });

      expect(result).toEqual({ success: true });
      expect(callCount).toBe(2);
      expect(logStub.lines()).toEqual([]);
    });

    it("keeps an author name that ENS cannot normalize to one bounded line", async () => {
      const logStub = createLogStub();
      // Passes pkc-js's own name checks when resolveAuthorNames is off: it has a "." and no capitals.
      const craftedName = `x\nforged line ${"y".repeat(500)}.eth`;

      const result = await executeChallenge({
        publication: createPublication({ authorAddress: craftedName }),
        mockClient: createClient({
          verifyMessage,
          getEnsAddress: async () => account.address,
          call: async () => ({ data: HIGH_BALANCE_DATA })
        }),
        log: logStub.log
      });

      expect(result.success).toBe(false);
      expect(logStub.stub.error).toHaveBeenCalledWith(
        expect.stringContaining("ENS resolution of author address x?forged?line?")
      );
      for (const line of logStub.lines()) {
        expect(line).not.toContain("\n");
        expect(line).not.toContain("y".repeat(301));
      }
    });

    it("keeps an author-chosen signature type to one bounded line", async () => {
      const wallet = await signWalletProof();
      const logStub = createLogStub();
      const injectedType = `eip1271\nforged log line ${"x".repeat(500)}`;

      const result = await executeChallenge({
        publication: createPublication({
          wallet: {
            ...wallet,
            signature: { ...wallet.signature, type: injectedType }
          } as AuthorWallet
        }),
        mockClient: createClient({ verifyMessage, call: async () => ({ data: HIGH_BALANCE_DATA }) }),
        log: logStub.log
      });

      const error = (result as { error?: string }).error ?? "";
      expect(error).toContain("The wallet signature type 'eip1271?forged?log?line?xxx");
      expect(error).not.toContain("\n");
      expect(error).not.toContain("x".repeat(65));
      expect(logStub.lines().length).toBeGreaterThan(0);
      for (const line of logStub.lines()) {
        expect(line).not.toContain("\n");
        expect(line).not.toContain("x".repeat(65));
      }
    });
  });

  it("throws a message naming rpcUrls when the chainTicker has no built-in RPC", async () => {
    const wallet = await signWalletProof();

    const { rpcUrls: _unused, ...optionsWithoutRpcUrls } = DEFAULT_OPTIONS;

    await expect(
      executeChallenge({
        publication: createPublication({
          wallet,
          walletChainTicker: "notachain"
        }),
        mockClient: createClient(),
        settings: {
          name: "@bitsocial/evm-contract-challenge",
          options: { ...optionsWithoutRpcUrls, chainTicker: "notachain" }
        }
      })
    ).rejects.toThrow(/option rpcUrls is required for chainTicker "notachain"/);
  });

  // docs/nft.md is the guide a client follows to build an avatar payload, and nothing executed it, so
  // it drifted from the verifier: it signed a "pkc-author-avatar" separator and stored the signature
  // as a bare string, neither of which this challenge can read. These tests run the guide's own code
  // against the real verification path so the two cannot separate again silently.
  // Disabled until a BSIP defines the avatar proof.
  describe.skip("docs/nft.md", () => {
    const docSource = readFileSync(
      new URL("../docs/nft.md", import.meta.url),
      "utf8"
    );

    // The template is lifted out of the markdown rather than retyped, so a test copy cannot stay
    // correct while the guide a reader actually follows is wrong.
    const docMessageTemplate = (): string => {
      const match = docSource.match(
        /const getNftMessageToSign = [^\n]*\n(?:[^\n]*\n)*?\s*return (`\{"domainSeparator".*?`)\n/
      );

      if (!match?.[1]) {
        throw new Error(
          "could not find the getNftMessageToSign template in docs/nft.md"
        );
      }

      return match[1];
    };

    const buildDocMessage = (params: {
      authorAddress: string;
      timestamp: number;
      tokenAddress: string;
      tokenId: string;
    }): string =>
      new Function(
        "authorAddress",
        "timestamp",
        "tokenAddress",
        "tokenId",
        `return ${docMessageTemplate()}`
      )(
        params.authorAddress,
        params.timestamp,
        params.tokenAddress,
        params.tokenId
      ) as string;

    it("signs the same message the challenge verifies, byte for byte", () => {
      const params = {
        authorAddress: DEFAULT_AUTHOR_ADDRESS,
        timestamp: 1_700_000_000,
        tokenAddress: TOKEN_ADDRESS,
        tokenId: "5404"
      };

      expect(buildDocMessage(params)).toBe(createAvatarMessage(params));
    });

    it("produces an avatar payload the challenge accepts", async () => {
      const timestamp = Math.round(Date.now() / 1000);
      const tokenId = "5404";

      const signature = await account.signMessage({
        message: buildDocMessage({
          authorAddress: DEFAULT_AUTHOR_ADDRESS,
          timestamp,
          tokenAddress: TOKEN_ADDRESS,
          tokenId
        })
      });

      const result = await executeChallenge({
        publication: createPublication({
          avatar: {
            address: TOKEN_ADDRESS,
            chainTicker: "matic",
            id: tokenId,
            timestamp,
            // The nesting docs/nft.md now writes. A bare string here is what pkc-js rejects and what
            // verifyAuthorNftWalletAddress reads through as signature.signature.
            signature: { signature, type: "eip191" }
          } as unknown as AuthorAvatar
        }),
        mockClient: createClient({
          verifyMessage,
          readContract: async () => account.address,
          call: async () => ({ data: HIGH_BALANCE_DATA })
        })
      });

      expect(result).toEqual({ success: true });
    });

    it("stores and reads the signature through the nested shape", () => {
      expect(docSource).toContain("signature: { signature");
      expect(docSource).toContain("signature: nft.signature.signature");
      expect(docSource).not.toMatch(/signature: nft\.signature\b(?!\.)/);
    });
  });

  describe("ABI validation", () => {
    const VALID_ABI_BASE = {
      type: "function" as const,
      name: "balanceOf",
      inputs: [
        { internalType: "address", name: "account", type: "address" }
      ],
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view"
    };

    const buildAbiJson = (
      overrides: Record<string, unknown>
    ): string => JSON.stringify({ ...VALID_ABI_BASE, ...overrides });

    const buildAbiJsonWithout = (...keysToOmit: string[]): string =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(VALID_ABI_BASE).filter(
            ([key]) => !keysToOmit.includes(key)
          )
        )
      );

    let mockClient: MockViemClient;
    let publication: ReturnType<typeof createPublication>;

    beforeAll(async () => {
      const wallet = await signWalletProof();
      publication = createPublication({ wallet });
      mockClient = createClient({
        verifyMessage,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      });
    });

    const expectAbiError = (abi: string, expectedError: string) =>
      expect(
        executeChallenge({
          publication,
          mockClient,
          settings: createChallengeSettings({ abi })
        })
      ).rejects.toThrow(expectedError);

    it("throws for invalid JSON", async () => {
      await expectAbiError("not json", "option abi is not valid JSON");
    });

    it("throws for JSON array", async () => {
      await expectAbiError("[]", "option abi must be a JSON object");
    });

    it("throws for JSON null", async () => {
      await expectAbiError("null", "option abi must be a JSON object");
    });

    it("throws for JSON string primitive", async () => {
      await expectAbiError('"hello"', "option abi must be a JSON object");
    });

    it('throws when type is not "function"', async () => {
      await expectAbiError(
        buildAbiJson({ type: "event" }),
        'option abi "type" must be "function"'
      );
    });

    it("throws for missing name", async () => {
      await expectAbiError(
        buildAbiJsonWithout("name"),
        'option abi must have a "name" string property'
      );
    });

    it("throws for missing inputs", async () => {
      await expectAbiError(
        buildAbiJsonWithout("inputs"),
        'option abi must have an "inputs" array property'
      );
    });

    it("throws when inputs has wrong number of parameters", async () => {
      await expectAbiError(
        buildAbiJson({
          inputs: [
            { name: "a", type: "address" },
            { name: "b", type: "uint256" }
          ]
        }),
        'option abi "inputs" must have exactly one parameter'
      );
    });

    it("throws when input type is not address", async () => {
      await expectAbiError(
        buildAbiJson({
          inputs: [{ name: "amount", type: "uint256" }]
        }),
        'option abi "inputs[0].type" must be "address"'
      );
    });

    it("throws for missing outputs", async () => {
      await expectAbiError(
        buildAbiJsonWithout("outputs"),
        'option abi must have an "outputs" array property'
      );
    });

    it("throws for empty outputs", async () => {
      await expectAbiError(
        buildAbiJson({ outputs: [] }),
        'option abi "outputs" must have at least one entry'
      );
    });

    it("throws for invalid stateMutability", async () => {
      await expectAbiError(
        buildAbiJson({ stateMutability: "readonly" }),
        'option abi "stateMutability" must be one of'
      );
    });

    it("accepts ABI without type field (defaults to function)", async () => {
      const result = await executeChallenge({
        publication,
        mockClient,
        settings: createChallengeSettings({
          abi: buildAbiJsonWithout("type")
        })
      });
      expect(result).toEqual({ success: true });
    });

    it("accepts ABI without stateMutability when constant is true", async () => {
      const abi = JSON.stringify({
        ...Object.fromEntries(
          Object.entries(VALID_ABI_BASE).filter(
            ([key]) => key !== "stateMutability"
          )
        ),
        constant: true
      });
      const result = await executeChallenge({
        publication,
        mockClient,
        settings: createChallengeSettings({ abi })
      });
      expect(result).toEqual({ success: true });
    });
  });
});
