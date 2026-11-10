import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, HttpRequestError, verifyMessage } from "viem";
import { mainnet, polygon } from "viem/chains";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount
} from "viem/accounts";
import evmContractChallenge, {
  _clearViemClientCache
} from "../src/evm-contract-challenge.js";
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
  storage?: Map<string, unknown>;
} = {}) => {
  const storage = params.storage ?? new Map<string, unknown>();

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
  wallet?: AuthorWallet;
  avatar?: AuthorAvatar;
  // The wallet is looked up as author.wallets[chainTicker], so a test using a non-default chainTicker
  // has to register the wallet under that ticker or the wallet check returns early.
  walletChainTicker?: string;
  // The key that signed the publication. Two different authors have two different keys.
  signerPublicKey?: string;
}): PublicationWithCommunityAuthorFromDecryptedChallengeRequest => {
  const authorAddress = params.authorAddress ?? DEFAULT_AUTHOR_ADDRESS;

  return {
    author: {
      address: authorAddress,
      ...(params.wallet
        ? { wallets: { [params.walletChainTicker ?? "eth"]: params.wallet } }
        : {}),
      ...(params.avatar ? { avatar: params.avatar } : {})
    },
    signature: {
      type: "ed25519",
      signature: "",
      publicKey: params.signerPublicKey ?? "mock-public-key",
      signedPropertyNames: []
    }
  } as unknown as PublicationWithCommunityAuthorFromDecryptedChallengeRequest;
};

const createWalletMessage = (authorAddress: string, timestamp: number): string => {
  const message: Record<string, string | number> = {};
  message.domainSeparator = "plebbit-author-wallet";
  message.authorAddress = authorAddress;
  message.timestamp = timestamp;
  return JSON.stringify(message);
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
  authorAddress: string;
  corrupted?: boolean;
  timestamp?: number;
}): Promise<AuthorWallet> => {
  const timestamp = params.timestamp ?? Math.round(Date.now() / 1000);
  const message = createWalletMessage(params.authorAddress, timestamp);
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
}): Promise<ChallengeResultInput> => {
  const settings = params.settings ?? createChallengeSettings();
  const community = params.community ?? createCommunity();

  currentMockClient = params.mockClient;

  const challengeFile = evmContractChallenge({ challengeSettings: settings });
  const result = await challengeFile.getChallenge({
    challengeSettings: settings,
    challengeRequestMessage: { comment: params.publication } as unknown as GetChallengeArgsInput["challengeRequestMessage"],
    challengeIndex: 0,
    community: community as unknown as GetChallengeArgsInput["community"]
  });

  if (!("success" in result)) {
    throw new Error("Expected a challenge result");
  }

  return result;
};

describe("evmContractChallenge", () => {
  it("passes when wallet balance is over threshold", async () => {
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

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
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

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
        "nftWalletAddressFailureReason='Author has no avatar NFT set'"
    );
  });

  it("passes when wallet fails but NFT owner wallet passes", async () => {
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });
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

  it("fails when both wallet and NFT wallets are below threshold", async () => {
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });
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
    const wallet = await signWalletProof({
      authorAddress: DEFAULT_AUTHOR_ADDRESS,
      corrupted: true
    });

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
        "walletFailureReason='The signature of the wallet is invalid', " +
        "ensAuthorAddressFailureReason='Author address is not a .bso/.eth domain', " +
        "nftWalletAddressFailureReason='Author has no avatar NFT set'"
    );
  });

  it("fails with invalid NFT signature", async () => {
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
      wallet: await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS })
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
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

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
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

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
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

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
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

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
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

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
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

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
      challengeSettings: createChallengeSettings({ chainTicker: "matic" })
    });

    expect(file.type).toBe("chain/matic");
  });

  it("rejects a domain wallet address whose name record resolves elsewhere", async () => {
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });
    // author.wallets[chainTicker].address may be a domain rather than a 0x address, in which case its
    // pkc-author-address record has to resolve to the publication signer.
    const domainWallet = { ...wallet, address: "wallet-owner.eth" } as typeof wallet;
    const resolveAuthorNameCalls: Array<{ name: string }> = [];

    const result = await executeChallenge({
      publication: createPublication({ wallet: domainWallet }),
      mockClient: createClient({
        verifyMessage: async () => true,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      }),
      community: createCommunity({
        resolveAuthorName: async (args) => {
          resolveAuthorNameCalls.push(args);
          return { resolvedAuthorName: "someone-else" };
        }
      })
    });

    // pkc-js 0.0.85 takes { name } and returns { resolvedAuthorName }, not an address and a bare string.
    expect(resolveAuthorNameCalls).toEqual([{ name: "wallet-owner.eth" }]);

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain(
      "walletFailureReason='The author wallet address's pkc-author-address text record should resolve to the public key of the signature'"
    );
  });

  it("rejects a domain wallet address that does not resolve at all", async () => {
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });
    const domainWallet = { ...wallet, address: "wallet-owner.eth" } as typeof wallet;

    const result = await executeChallenge({
      publication: createPublication({ wallet: domainWallet }),
      mockClient: createClient({
        verifyMessage: async () => true,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      }),
      community: createCommunity({
        resolveAuthorName: async () => ({ resolvedAuthorName: null })
      })
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain(
      "walletFailureReason='The author wallet address's pkc-author-address text record should resolve to the public key of the signature'"
    );
  });

  it("builds the contract-call client with the chain the chainTicker names", async () => {
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

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

  it("falls through to the NFT check when the ENS lookup throws", async () => {
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

  it("falls through to the NFT check when the wallet address is a domain whose record matches", async () => {
    // The domain check above passes, and the domain then reached verifyMessage, which throws
    // InvalidAddressError for anything but a 0x address. The throw left getChallenge, so the ENS and
    // NFT checks never ran and the author got an exception instead of a challenge result.
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });
    const domainWallet = { ...wallet, address: "wallet-owner.eth" } as typeof wallet;
    const avatar = await signAvatarProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

    const result = await executeChallenge({
      publication: createPublication({ wallet: domainWallet, avatar }),
      mockClient: createClient({
        verifyMessage,
        readContract: async () => account.address,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      }),
      community: createCommunity({
        resolveAuthorName: async () => ({ resolvedAuthorName: DEFAULT_AUTHOR_ADDRESS })
      })
    });

    expect(result).toEqual({ success: true });
  });

  it("reports a domain wallet address as a wallet failure, not an exception", async () => {
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });
    const domainWallet = { ...wallet, address: "wallet-owner.eth" } as typeof wallet;

    const result = await executeChallenge({
      publication: createPublication({ wallet: domainWallet }),
      mockClient: createClient({
        verifyMessage,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      }),
      community: createCommunity({
        resolveAuthorName: async () => ({ resolvedAuthorName: DEFAULT_AUTHOR_ADDRESS })
      })
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain(
      "walletFailureReason='The author wallet address is not a valid EVM address'"
    );
  });

  it("falls through to the NFT check when the wallet signature check throws", async () => {
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });
    const avatar = await signAvatarProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

    const result = await executeChallenge({
      publication: createPublication({ wallet, avatar }),
      mockClient: createClient({
        verifyMessage: async (args) => {
          if (args.message.includes("plebbit-author-wallet")) {
            throw new Error("verifier is down");
          }
          return verifyMessage(args);
        },
        readContract: async () => account.address,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      })
    });

    expect(result).toEqual({ success: true });
  });

  it("falls through to the NFT check when resolving a domain wallet address throws", async () => {
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });
    const domainWallet = { ...wallet, address: "wallet-owner.eth" } as typeof wallet;
    const avatar = await signAvatarProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

    const result = await executeChallenge({
      publication: createPublication({ wallet: domainWallet, avatar }),
      mockClient: createClient({
        verifyMessage,
        readContract: async () => account.address,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      }),
      community: createCommunity({
        resolveAuthorName: async () => {
          throw new Error("name resolver is down");
        }
      })
    });

    expect(result).toEqual({ success: true });
  });

  it("reports a throwing NFT signature check as a challenge failure, not an exception", async () => {
    const avatar = await signAvatarProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

    const result = await executeChallenge({
      publication: createPublication({ avatar }),
      mockClient: createClient({
        verifyMessage: async () => {
          throw new Error("verifier is down");
        },
        readContract: async () => account.address,
        call: async () => ({ data: HIGH_BALANCE_DATA })
      })
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain(
      "nftWalletAddressFailureReason='Failed to verify the nft avatar signature: verifier is down'"
    );
  });

  // A viem error's message also carries transport details such as the request URL. Reasons built from
  // one use its shortMessage instead.
  describe("failure reasons from a viem error", () => {
    const RPC_URL = "https://eth.example/v2/rpc-path";
    const createRpcError = () =>
      new HttpRequestError({
        url: RPC_URL,
        body: { method: "eth_getCode" },
        details: "fetch failed"
      });

    it("uses the short message in the wallet signature reason", async () => {
      const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

      const result = await executeChallenge({
        publication: createPublication({ wallet }),
        mockClient: createClient({
          verifyMessage: async () => {
            throw createRpcError();
          },
          call: async () => ({ data: HIGH_BALANCE_DATA })
        })
      });

      expect(result.success).toBe(false);
      const error = (result as { error?: string }).error;
      expect(error).toContain(
        "walletFailureReason='Failed to verify the wallet signature: HTTP request failed.'"
      );
      expect(error).not.toContain(RPC_URL);
    });

    it("uses the short message in the nft avatar signature reason", async () => {
      const avatar = await signAvatarProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

      const result = await executeChallenge({
        publication: createPublication({ avatar }),
        mockClient: createClient({
          verifyMessage: async () => {
            throw createRpcError();
          },
          readContract: async () => account.address,
          call: async () => ({ data: HIGH_BALANCE_DATA })
        })
      });

      expect(result.success).toBe(false);
      const error = (result as { error?: string }).error;
      expect(error).toContain(
        "nftWalletAddressFailureReason='Failed to verify the nft avatar signature: HTTP request failed.'"
      );
      expect(error).not.toContain(RPC_URL);
    });

    it("uses the short message in the ENS lookup reason", async () => {
      const result = await executeChallenge({
        publication: createPublication({ authorAddress: "plebbit.eth" }),
        mockClient: createClient({
          verifyMessage,
          getEnsAddress: async () => {
            throw createRpcError();
          },
          call: async () => ({ data: HIGH_BALANCE_DATA })
        })
      });

      expect(result.success).toBe(false);
      const error = (result as { error?: string }).error;
      expect(error).toContain(
        "ensAuthorAddressFailureReason='Failed to resolve ENS address of author.address: HTTP request failed.'"
      );
      expect(error).not.toContain(RPC_URL);
    });
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

  it("throws a message naming rpcUrls when the chainTicker has no built-in RPC", async () => {
    const wallet = await signWalletProof({ authorAddress: DEFAULT_AUTHOR_ADDRESS });

    const { rpcUrls: _unused, ...optionsWithoutRpcUrls } = DEFAULT_OPTIONS;

    await expect(
      executeChallenge({
        publication: createPublication({
          wallet,
          walletChainTicker: "notachain"
        }),
        mockClient: createClient({ verifyMessage }),
        settings: {
          name: "@bitsocial/evm-contract-challenge",
          options: { ...optionsWithoutRpcUrls, chainTicker: "notachain" }
        }
      })
    ).rejects.toThrow(/option rpcUrls is required for chainTicker "notachain"/);
  });

  // A wallet signed over to a new author with a newer timestamp stops working for the previous one.
  // These cover the ways a second author used to keep sharing the wallet anyway.
  describe("wallet signature replay guard", () => {
    const TIMESTAMP = 1_700_000_000;

    // An author is the key that signs their publications. author.address is that key's address, or
    // the author's name when they have one.
    interface Author {
      address: string;
      signerPublicKey: string;
    }

    const AUTHOR_1: Author = { address: "author-1", signerPublicKey: "author-1-public-key" };
    const AUTHOR_2: Author = { address: "author-2", signerPublicKey: "author-2-public-key" };

    const runWithWallet = (params: {
      author: Author;
      wallet: AuthorWallet;
      community: ReturnType<typeof createCommunity>;
      chainTicker?: string;
    }) =>
      executeChallenge({
        publication: createPublication({
          authorAddress: params.author.address,
          signerPublicKey: params.author.signerPublicKey,
          wallet: params.wallet,
          ...(params.chainTicker ? { walletChainTicker: params.chainTicker } : {})
        }),
        settings: createChallengeSettings(
          params.chainTicker ? { chainTicker: params.chainTicker } : {}
        ),
        mockClient: createClient({
          verifyMessage,
          call: async () => ({ data: HIGH_BALANCE_DATA })
        }),
        community: params.community
      });

    it("rejects the previous author once the wallet is signed for another with a newer timestamp", async () => {
      const community = createCommunity();
      const oldWallet = await signWalletProof({ authorAddress: AUTHOR_1.address, timestamp: TIMESTAMP });
      const newWallet = await signWalletProof({ authorAddress: AUTHOR_2.address, timestamp: TIMESTAMP + 1 });

      expect(await runWithWallet({ author: AUTHOR_1, wallet: oldWallet, community })).toEqual({ success: true });
      expect(await runWithWallet({ author: AUTHOR_2, wallet: newWallet, community })).toEqual({ success: true });

      const replay = await runWithWallet({ author: AUTHOR_1, wallet: oldWallet, community });
      expect(replay.success).toBe(false);
      expect((replay as { error?: string }).error).toContain(
        "walletFailureReason='The author is trying to use an old wallet signature'"
      );
    });

    it("does not let a second author share the wallet by signing with the same timestamp", async () => {
      // The guard only rejected a strictly older timestamp, so two authors signed with the same one
      // both passed for as long as the wallet signed nothing newer.
      const community = createCommunity();
      const firstWallet = await signWalletProof({ authorAddress: AUTHOR_1.address, timestamp: TIMESTAMP });
      const secondWallet = await signWalletProof({ authorAddress: AUTHOR_2.address, timestamp: TIMESTAMP });

      expect(await runWithWallet({ author: AUTHOR_1, wallet: firstWallet, community })).toEqual({ success: true });

      const second = await runWithWallet({ author: AUTHOR_2, wallet: secondWallet, community });
      expect(second.success).toBe(false);
      expect((second as { error?: string }).error).toContain(
        "walletFailureReason='Another author already uses this wallet with a signature of the same timestamp'"
      );

      // The author holding the wallet keeps reusing the same signature, as every publication does.
      expect(await runWithWallet({ author: AUTHOR_1, wallet: firstWallet, community })).toEqual({ success: true });
    });

    it("keeps passing the same signer after its author address changes to a name", async () => {
      // Clients re-sign a wallet with the timestamp they stored for it. An author who sets a name
      // gets a new author.address, so the re-signed wallet has the same timestamp and a different
      // author address, but it is still the same signer and the same person.
      const community = createCommunity();
      const signerPublicKey = "alice-public-key";
      const keyAddress = "12D3KooWAliceKeyAddress";
      const keyWallet = await signWalletProof({ authorAddress: keyAddress, timestamp: TIMESTAMP });
      const nameWallet = await signWalletProof({ authorAddress: "alice.bso", timestamp: TIMESTAMP });

      expect(
        await runWithWallet({ author: { address: keyAddress, signerPublicKey }, wallet: keyWallet, community })
      ).toEqual({ success: true });
      expect(
        await runWithWallet({ author: { address: "alice.bso", signerPublicKey }, wallet: nameWallet, community })
      ).toEqual({ success: true });
      // And back again, if the author clears the name.
      expect(
        await runWithWallet({ author: { address: keyAddress, signerPublicKey }, wallet: keyWallet, community })
      ).toEqual({ success: true });
    });

    it("treats another spelling of the wallet address as the same wallet", async () => {
      // The record was keyed by the address exactly as typed, so the lowercase spelling of a
      // checksummed address had a record of its own and an older signature passed through it.
      const community = createCommunity();
      const newWallet = await signWalletProof({ authorAddress: AUTHOR_2.address, timestamp: TIMESTAMP + 1 });
      const oldWallet = await signWalletProof({ authorAddress: AUTHOR_1.address, timestamp: TIMESTAMP });
      const lowercasedOldWallet = { ...oldWallet, address: oldWallet.address.toLowerCase() };

      expect(lowercasedOldWallet.address).not.toBe(oldWallet.address);
      expect(await runWithWallet({ author: AUTHOR_2, wallet: newWallet, community })).toEqual({ success: true });

      const replay = await runWithWallet({ author: AUTHOR_1, wallet: lowercasedOldWallet, community });
      expect(replay.success).toBe(false);
      expect((replay as { error?: string }).error).toContain(
        "walletFailureReason='The author is trying to use an old wallet signature'"
      );
    });

    it("still honours a record stored as a bare timestamp by earlier versions", async () => {
      // Earlier versions stored the timestamp alone, under the chainTicker plus the address as the
      // author sent it, which is the checksummed spelling clients send. Until the holder publishes
      // again, that row is all that stops the previous author after an upgrade.
      const storage = new Map<string, unknown>([[`eth${account.address}`, TIMESTAMP + 1]]);
      const community = createCommunity({ storage });
      const oldWallet = await signWalletProof({ authorAddress: AUTHOR_1.address, timestamp: TIMESTAMP });
      const holderWallet = await signWalletProof({ authorAddress: AUTHOR_2.address, timestamp: TIMESTAMP + 1 });

      expect(account.address).not.toBe(account.address.toLowerCase());
      const replay = await runWithWallet({ author: AUTHOR_1, wallet: oldWallet, community });
      expect(replay.success).toBe(false);
      expect((replay as { error?: string }).error).toContain(
        "walletFailureReason='The author is trying to use an old wallet signature'"
      );

      // The old row names no signer, so the holder's signature with the same timestamp still passes,
      // and from then on the new record keeps the previous author out.
      expect(await runWithWallet({ author: AUTHOR_2, wallet: holderWallet, community })).toEqual({ success: true });
      expect((await runWithWallet({ author: AUTHOR_1, wallet: oldWallet, community })).success).toBe(false);
    });

    it("finds a record stored by earlier versions under the other spelling of the address", async () => {
      const oldWallet = await signWalletProof({ authorAddress: AUTHOR_1.address, timestamp: TIMESTAMP });
      const lowercasedOldWallet = { ...oldWallet, address: oldWallet.address.toLowerCase() };
      const cases: Array<{ storedUnder: string; wallet: AuthorWallet }> = [
        { storedUnder: `eth${account.address}`, wallet: lowercasedOldWallet },
        { storedUnder: `eth${account.address.toLowerCase()}`, wallet: oldWallet }
      ];

      for (const { storedUnder, wallet } of cases) {
        const community = createCommunity({
          storage: new Map<string, unknown>([[storedUnder, TIMESTAMP + 1]])
        });

        const replay = await runWithWallet({ author: AUTHOR_1, wallet, community });
        expect(replay.success, `record under ${storedUnder}, wallet sent as ${wallet.address}`).toBe(false);
        expect((replay as { error?: string }).error).toContain(
          "walletFailureReason='The author is trying to use an old wallet signature'"
        );
      }
    });

    it("does not let an older bare timestamp under the new key hide a newer record of earlier versions", async () => {
      // With the usual "eth" chainTicker, an earlier version's lowercase row sits at the new key. It
      // names no signer, so the other spelling's row still counts, and here it holds the newer timestamp.
      const storage = new Map<string, unknown>([
        [`eth${account.address.toLowerCase()}`, TIMESTAMP],
        [`eth${account.address}`, TIMESTAMP + 1]
      ]);
      const community = createCommunity({ storage });
      const oldWallet = await signWalletProof({ authorAddress: AUTHOR_1.address, timestamp: TIMESTAMP });

      const replay = await runWithWallet({ author: AUTHOR_1, wallet: oldWallet, community });
      expect(replay.success).toBe(false);
      expect((replay as { error?: string }).error).toContain(
        "walletFailureReason='The author is trying to use an old wallet signature'"
      );
    });

    it("finds a record stored by earlier versions under the chainTicker as configured", async () => {
      // Earlier versions did not normalize the chainTicker, so with "ETH" configured their rows start
      // with "ETH" while the new key starts with "eth".
      const oldWallet = await signWalletProof({ authorAddress: AUTHOR_1.address, timestamp: TIMESTAMP });
      const lowercasedOldWallet = { ...oldWallet, address: oldWallet.address.toLowerCase() };
      const cases: Array<{ storedUnder: string; wallet: AuthorWallet }> = [
        { storedUnder: `ETH${account.address.toLowerCase()}`, wallet: oldWallet },
        { storedUnder: `ETH${account.address}`, wallet: lowercasedOldWallet }
      ];

      for (const { storedUnder, wallet } of cases) {
        const community = createCommunity({
          storage: new Map<string, unknown>([[storedUnder, TIMESTAMP + 1]])
        });

        const replay = await runWithWallet({ author: AUTHOR_1, wallet, community, chainTicker: "ETH" });
        expect(replay.success, `record under ${storedUnder}, wallet sent as ${wallet.address}`).toBe(false);
        expect((replay as { error?: string }).error).toContain(
          "walletFailureReason='The author is trying to use an old wallet signature'"
        );
      }
    });
  });

  // docs/nft.md is the guide a client follows to build an avatar payload, and nothing executed it, so
  // it drifted from the verifier: it signed a "pkc-author-avatar" separator and stored the signature
  // as a bare string, neither of which this challenge can read. These tests run the guide's own code
  // against the real verification path so the two cannot separate again silently.
  describe("docs/nft.md", () => {
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
      const wallet = await signWalletProof({
        authorAddress: DEFAULT_AUTHOR_ADDRESS
      });
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
