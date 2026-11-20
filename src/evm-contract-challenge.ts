import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  isAddress,
  type AbiFunction,
  type Chain,
  type PublicClient,
  type Transport
} from "viem";
import {
  arbitrum,
  avalanche,
  base,
  blast,
  bsc,
  celo,
  fantom,
  gnosis,
  linea,
  mainnet,
  optimism,
  polygon,
  scroll,
  zksync
} from "viem/chains";
import { normalize } from "viem/ens";
import type {
  ChallengeFileInput,
  ChallengeInput,
  ChallengeResultInput,
  GetChallengeArgsInput,
  HexAddress,
  PKC,
  PublicationWithCommunityAuthorFromDecryptedChallengeRequest,
  CommunityChallengeSetting
} from "./types.js";

const optionInputs: NonNullable<ChallengeFileInput["optionInputs"]> = [
  {
    option: "chainTicker",
    label: "chainTicker",
    default: "eth",
    description: "The chain ticker",
    placeholder: "eth",
    required: true
  },
  {
    option: "rpcUrls",
    label: "RPC URLs",
    default: "",
    description:
      "Comma-separated JSON-RPC URLs for the chain. Optional for a chainTicker with a built-in RPC, " +
      "required otherwise. Recommended even when optional: the built-in RPC is shared and rate-limited.",
    placeholder: "https://eth.llamarpc.com,https://rpc.ankr.com/eth"
  },
  {
    option: "address",
    label: "Address",
    default: "",
    description: "The contract address.",
    placeholder: "0x...",
    required: true
  },
  {
    option: "abi",
    label: "ABI",
    default: "",
    description: "The ABI of the contract method.",
    placeholder:
      '{"constant":true,"inputs":[{"internalType":"address","name":"account...',
    required: true
  },
  {
    option: "condition",
    label: "Condition",
    default: "",
    description: "The condition the contract call response must pass.",
    placeholder: ">1000",
    required: true
  },
  {
    option: "error",
    label: "Error",
    default: "Contract call response doesn't pass condition.",
    description: "The error to display to the author."
  }
];

const description =
  "The response from an EVM contract call passes a condition, e.g. a token balance challenge.";

const nftAbi: readonly unknown[] = [
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  }
];

const supportedConditionOperators = ["=", ">", "<"] as const;

type SupportedConditionOperator =
  (typeof supportedConditionOperators)[number];

type ConditionComparable = bigint | string;

// chainTicker is free-form in pkc-js (ChainTickerSchema is z.string().min(1)), so this map is ours to
// own and will always be partial. It is not a convenience: viem's http() transport has no default RPC
// unless the client is given a chain, and it throws UrlRequiredError at construction rather than
// falling back to anything. A ticker outside this map therefore has no default and must ship rpcUrls,
// which is what validateChallengeSettings turns into a rejected edit instead of a per-author failure.
const chainsByTicker: Record<string, Chain> = {
  eth: mainnet,
  matic: polygon,
  pol: polygon,
  op: optimism,
  arb: arbitrum,
  base: base,
  avax: avalanche,
  bnb: bsc,
  bsc: bsc,
  gno: gnosis,
  xdai: gnosis,
  celo: celo,
  ftm: fantom,
  linea: linea,
  scroll: scroll,
  zksync: zksync,
  blast: blast
};

const knownChainTickers = Object.keys(chainsByTicker);

const normalizeChainTicker = (chainTicker: string): string =>
  chainTicker.trim().toLowerCase();

// hasOwnProperty rather than a bare index: chainsByTicker is an object literal, so a chainTicker of
// "constructor", "toString" or "valueOf" would otherwise resolve to an inherited function. That would
// read as "this ticker has a built-in RPC", letting validateChallengeSettings accept it without
// rpcUrls and handing createPublicClient something that is not a Chain.
const getChainFromTicker = (chainTicker: string): Chain | undefined => {
  const ticker = normalizeChainTicker(chainTicker);

  return Object.prototype.hasOwnProperty.call(chainsByTicker, ticker)
    ? chainsByTicker[ticker]
    : undefined;
};

const parseRpcUrls = (rpcUrls: string | undefined): string[] =>
  (rpcUrls ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

// No `rank: true` on the fallback: ranking starts a loop that pings every endpoint every few seconds
// and viem has no way to stop it. Cached clients are never evicted (a challenge file has no teardown
// hook), so a ranked client kept polling its endpoints for the life of the node, including those of
// an rpcUrls value the owner had since replaced. Unranked, endpoints are tried in the listed order
// and a client sends nothing until it is used.
const createTransport = (urls: string[]): Transport =>
  urls.length === 0
    ? http()
    : urls.length === 1
      ? http(urls[0])
      : fallback(urls.map((u) => http(u)));

// Clients are cached per (chainTicker, rpcUrls) rather than built per call: a single challenge attempt
// builds a client for the wallet check, the ENS check, the NFT check and each contract call.
const viemClientCache = new Map<string, PublicClient>();

// Test seam: the cache is keyed by config, so nothing invalidates it within a process. Tests that swap
// the underlying client between cases need it emptied.
const _clearViemClientCache = (): void => {
  viemClientCache.clear();
};

const getCachedViemClient = (
  cacheKey: string,
  create: () => PublicClient
): PublicClient => {
  const cached = viemClientCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const client = create();
  viemClientCache.set(cacheKey, client);
  return client;
};

const createViemClient = (
  rpcUrls: string | undefined,
  chainTicker: string
): PublicClient => {
  const urls = parseRpcUrls(rpcUrls);
  const chain = getChainFromTicker(chainTicker);

  // Same condition validateChallengeSettings rejects an edit on. Repeated here because getChallenge
  // also runs for settings written before the hook existed, and because viem's own UrlRequiredError
  // says nothing about which option the owner has to fix.
  if (urls.length === 0 && !chain) {
    throw new Error(
      `option rpcUrls is required for chainTicker "${chainTicker}": it has no built-in RPC. ` +
        `Tickers with a built-in RPC are: ${knownChainTickers.join(", ")}.`
    );
  }

  return getCachedViemClient(
    `call\n${normalizeChainTicker(chainTicker)}\n${urls.join(",")}`,
    () =>
      createPublicClient({ chain, transport: createTransport(urls) })
  );
};

// ENS names live on Ethereum mainnet, so a .eth/.bso lookup resolves there whatever chain the contract
// call targets. The community's own rpcUrls are reused only when they already point at mainnet;
// otherwise this falls back to viem's built-in mainnet RPC, which is shared and rate-limited. Without
// an explicit chain viem refuses the lookup outright ("client chain not configured").
const createEnsViemClient = (
  rpcUrls: string | undefined,
  chainTicker: string
): PublicClient => {
  const urls =
    getChainFromTicker(chainTicker)?.id === mainnet.id ? parseRpcUrls(rpcUrls) : [];

  return getCachedViemClient(`ens\n${urls.join(",")}`, () =>
    createPublicClient({ chain: mainnet, transport: createTransport(urls) })
  );
};

interface PKCWithOptionalAddressResolver extends PKC {
  getPKCAddressFromPublicKey?: (publicKey: string) => Promise<string>;
}

interface SharedVerifyProps {
  publication: PublicationWithCommunityAuthorFromDecryptedChallengeRequest;
  chainTicker: string;
  condition: string;
  abi: Record<string, unknown>;
  error: string | undefined;
  contractAddress: string;
  pkc: PKC;
  rpcUrls: string | undefined;
}

const publicationFieldNames = [
  "comment",
  "vote",
  "commentEdit",
  "commentModeration",
  "communityEdit"
] as const;

const isStringDomain = (value: string | undefined): value is string =>
  typeof value === "string" && value.includes(".");

const isEthAliasDomain = (address: string): boolean => {
  const lowerAddress = address.toLowerCase();
  return lowerAddress.endsWith(".eth") || lowerAddress.endsWith(".bso");
};

const normalizeEthAliasDomain = (address: string): string => {
  return address.toLowerCase().endsWith(".bso")
    ? `${address.slice(0, -4)}.eth`
    : address;
};

const derivePublicationFromChallengeRequest = (
  challengeRequestMessage: GetChallengeArgsInput["challengeRequestMessage"]
): PublicationWithCommunityAuthorFromDecryptedChallengeRequest => {
  for (const fieldName of publicationFieldNames) {
    const publication = challengeRequestMessage[fieldName];
    if (publication) {
      return publication;
    }
  }

  throw new Error("Failed to find publication on ChallengeRequest");
};

// Failure reasons are shown to the author. A viem error's message also carries transport details such
// as the request URL, so a viem error contributes only its shortMessage. Checked by shape rather than
// instanceof BaseError so an error from any copy of viem is covered.
const describeError = (e: unknown): string => {
  if (!(e instanceof Error)) {
    return String(e);
  }
  const { shortMessage } = e as Error & { shortMessage?: unknown };
  return typeof shortMessage === "string" ? shortMessage : e.message;
};

const getPublicationSignerAddress = async (
  pkc: PKC,
  publication: PublicationWithCommunityAuthorFromDecryptedChallengeRequest
): Promise<string> => {
  const maybeResolver = (pkc as PKCWithOptionalAddressResolver)
    .getPKCAddressFromPublicKey;
  if (typeof maybeResolver === "function") {
    return maybeResolver(publication.signature.publicKey);
  }

  return publication.author.address;
};

interface LastWalletSignature {
  timestamp: number;
  signerPublicKey?: string;
}

// Versions before the signer was recorded stored a bare timestamp, read here as a record whose
// signer is unknown.
const parseLastWalletSignature = (
  value: unknown
): LastWalletSignature | undefined => {
  if (typeof value === "number") {
    return { timestamp: value };
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const { timestamp, signerPublicKey } = value as Record<string, unknown>;
  if (typeof timestamp !== "number") {
    return undefined;
  }
  return typeof signerPublicKey === "string"
    ? { timestamp, signerPublicKey }
    : { timestamp };
};

// Those versions also keyed the record by the chainTicker as configured plus the address as the author
// sent it, lowercase or checksummed. One of those rows can sit at the new key itself, so until the
// wallet has a record that names its signer, the newest of all of them decides. Otherwise an upgrade
// would let a superseded author's old signature pass again.
const readLastWalletSignature = async (
  cache: Awaited<ReturnType<PKC["_createStorageLRU"]>>,
  cacheKey: string,
  chainTicker: string,
  walletAddress: string
): Promise<LastWalletSignature | undefined> => {
  const current = parseLastWalletSignature(await cache.getItem(cacheKey));
  if (current?.signerPublicKey !== undefined) {
    return current;
  }

  const legacyKeys = new Set([
    chainTicker + walletAddress.toLowerCase(),
    chainTicker + getAddress(walletAddress)
  ]);
  legacyKeys.delete(cacheKey);

  let newest = current;
  for (const legacyKey of legacyKeys) {
    const signature = parseLastWalletSignature(await cache.getItem(legacyKey));
    if (signature && (!newest || signature.timestamp > newest.timestamp)) {
      newest = signature;
    }
  }
  return newest;
};

// pkc-js runs challenges concurrently, and checking a wallet's record and writing it back takes several
// awaits. Two publications from different signers with the same wallet timestamp could both read the
// record before either wrote theirs, and both pass. Checks of one wallet therefore run one at a time.
const walletRecordQueues = new Map<string, Promise<unknown>>();

const runWithWalletRecord = async <T>(
  cacheKey: string,
  task: () => Promise<T>
): Promise<T> => {
  const previous = walletRecordQueues.get(cacheKey) ?? Promise.resolve();
  const current = previous.then(task);
  const settled = current.catch(() => undefined);
  walletRecordQueues.set(cacheKey, settled);
  try {
    return await current;
  } finally {
    if (walletRecordQueues.get(cacheKey) === settled) {
      walletRecordQueues.delete(cacheKey);
    }
  }
};

const verifyAuthorWalletAddress = async (
  props: SharedVerifyProps
): Promise<string | undefined> => {
  const authorWallet = props.publication.author.wallets?.[props.chainTicker];
  if (typeof authorWallet?.address !== "string") {
    return "The author wallet address is not defined";
  }

  // Like the ENS lookup and the NFT read, the steps below run on author-supplied input and can throw.
  // The wallet is one of three sources of a wallet address, so a throw here is returned as this
  // source's reason and getChallenge goes on to the ENS and NFT checks.
  if (isStringDomain(authorWallet.address)) {
    let resolvedAuthorName: string | null | undefined;
    try {
      ({ resolvedAuthorName } = await props.pkc.resolveAuthorName({
        name: authorWallet.address
      }));
    } catch (e) {
      return `Failed to resolve the author wallet address: ${describeError(e)}`;
    }
    const publicationSignatureAddress = await getPublicationSignerAddress(
      props.pkc,
      props.publication
    );

    if (resolvedAuthorName !== publicationSignatureAddress) {
      return "The author wallet address's pkc-author-address text record should resolve to the public key of the signature";
    }
  }

  // A domain whose record matches still cannot be checked against a signature: verifyMessage throws
  // InvalidAddressError for anything but a 0x address. Strict, like the encoder the contract call
  // uses, so a wrongly checksummed address fails here rather than at that call.
  if (!isAddress(authorWallet.address)) {
    return "The author wallet address is not a valid EVM address";
  }

  const viemClient = createViemClient(props.rpcUrls, props.chainTicker);

  const messageToBeSigned: Record<string, string | number> = {};
  messageToBeSigned.domainSeparator = "plebbit-author-wallet";
  messageToBeSigned.authorAddress = props.publication.author.address;
  messageToBeSigned.timestamp = authorWallet.timestamp;

  let valid: boolean;
  try {
    valid = await viemClient.verifyMessage({
      address: authorWallet.address,
      message: JSON.stringify(messageToBeSigned),
      signature: authorWallet.signature.signature as HexAddress
    });
  } catch (e) {
    return `Failed to verify the wallet signature: ${describeError(e)}`;
  }

  if (!valid) {
    return "The signature of the wallet is invalid";
  }

  const cache = await props.pkc._createStorageLRU({
    cacheName: "challenge_evm_contract_call_v1_wallet_last_timestamp",
    maxItems: Number.MAX_SAFE_INTEGER
  });

  // One record per wallet: the newest signature timestamp seen and the key that signed the publication
  // it came with. A wallet signed over to a new author with a newer timestamp stops working for the
  // previous one, so the record has to say who holds that timestamp, or a second author signed with the
  // same timestamp passes too. The author is identified by the signer key pkc-js has already verified,
  // not by author.address: that is the author's name when they have one, so it changes when they set or
  // clear the name, and clients re-sign the wallet with the timestamp they stored for it. The address
  // is lowercased so another spelling of the same wallet shares the record.
  const cacheKey =
    normalizeChainTicker(props.chainTicker) + authorWallet.address.toLowerCase();
  const signerPublicKey = props.publication.signature.publicKey;

  const replayFailure = await runWithWalletRecord(cacheKey, async () => {
    const lastSignature = await readLastWalletSignature(
      cache,
      cacheKey,
      props.chainTicker,
      authorWallet.address
    );

    if (lastSignature && lastSignature.timestamp > authorWallet.timestamp) {
      return "The author is trying to use an old wallet signature";
    }

    const sameTimestamp = lastSignature?.timestamp === authorWallet.timestamp;
    if (
      sameTimestamp &&
      lastSignature.signerPublicKey !== undefined &&
      lastSignature.signerPublicKey !== signerPublicKey
    ) {
      return "Another author already uses this wallet with a signature of the same timestamp";
    }

    if (!sameTimestamp || lastSignature.signerPublicKey !== signerPublicKey) {
      await cache.setItem(cacheKey, {
        timestamp: authorWallet.timestamp,
        signerPublicKey
      });
    }
    return undefined;
  });
  if (replayFailure) {
    return replayFailure;
  }

  const walletValidationFailure = await validateWalletAddressWithCondition({
    authorWalletAddress: authorWallet.address,
    condition: props.condition,
    contractAddress: props.contractAddress,
    chainTicker: props.chainTicker,
    abi: props.abi,
    error: props.error,
    rpcUrls: props.rpcUrls
  });

  return walletValidationFailure;
};

const verifyAuthorENSAddress = async (
  props: SharedVerifyProps
): Promise<string | undefined> => {
  const authorAddress = props.publication.author.address;
  if (!isEthAliasDomain(authorAddress)) {
    return "Author address is not a .bso/.eth domain";
  }

  const ensAddress = normalizeEthAliasDomain(authorAddress);

  const viemClient = createEnsViemClient(props.rpcUrls, props.chainTicker);

  if (typeof viemClient.getEnsAddress !== "function") {
    return "Failed to get owner of ENS address of author.address";
  }

  // A failure here is one of three sources of a wallet address, not the end of the challenge: an ENS
  // lookup that throws must fall through to the NFT check the same way a non-.eth author does, so the
  // reason is returned rather than thrown.
  let ownerOfAddress: HexAddress | null | undefined;
  try {
    ownerOfAddress = await viemClient.getEnsAddress({
      name: normalize(ensAddress)
    });
  } catch (e) {
    return `Failed to resolve ENS address of author.address: ${describeError(e)}`;
  }

  if (!ownerOfAddress) {
    return "Failed to get owner of ENS address of author.address";
  }

  const walletValidationFailure = await validateWalletAddressWithCondition({
    authorWalletAddress: ownerOfAddress,
    condition: props.condition,
    contractAddress: props.contractAddress,
    chainTicker: props.chainTicker,
    abi: props.abi,
    error: props.error,
    rpcUrls: props.rpcUrls
  });

  return walletValidationFailure;
};

const verifyAuthorNftWalletAddress = async (
  props: SharedVerifyProps
): Promise<string | undefined> => {
  if (!props.publication.author.avatar) {
    return "Author has no avatar NFT set";
  }

  const nftAvatar = props.publication.author.avatar;

  const viemClient = createViemClient(props.rpcUrls, props.chainTicker);

  let currentOwner: HexAddress;
  try {
    if (typeof viemClient.readContract !== "function") {
      throw new Error("Viem readContract unavailable");
    }

    currentOwner = (await viemClient.readContract({
      abi: nftAbi,
      address: nftAvatar.address as HexAddress,
      functionName: "ownerOf",
      args: [nftAvatar.id]
    })) as HexAddress;
  } catch {
    return "Failed to read NFT contract";
  }

  const messageToBeSigned: Record<string, string | number> = {};
  messageToBeSigned.domainSeparator = "plebbit-author-avatar";
  messageToBeSigned.authorAddress = props.publication.author.address;
  messageToBeSigned.timestamp = nftAvatar.timestamp;
  messageToBeSigned.tokenAddress = nftAvatar.address;
  messageToBeSigned.tokenId = String(nftAvatar.id);

  let valid: boolean;
  try {
    valid = await viemClient.verifyMessage({
      address: currentOwner,
      message: JSON.stringify(messageToBeSigned),
      signature: nftAvatar.signature.signature as HexAddress
    });
  } catch (e) {
    return `Failed to verify the nft avatar signature: ${describeError(e)}`;
  }

  if (!valid) {
    return "The signature of the nft avatar is invalid";
  }

  const nftWalletValidationFailure = await validateWalletAddressWithCondition({
    authorWalletAddress: currentOwner,
    condition: props.condition,
    contractAddress: props.contractAddress,
    chainTicker: props.chainTicker,
    abi: props.abi,
    error: props.error,
    rpcUrls: props.rpcUrls
  });

  return nftWalletValidationFailure;
};

const getContractCallResponse = async (props: {
  chainTicker: string;
  contractAddress: string;
  abi: Record<string, unknown>;
  authorWalletAddress: string;
  rpcUrls: string | undefined;
}): Promise<unknown> => {
  const viemClient = createViemClient(props.rpcUrls, props.chainTicker);

  const encodedParameters = encodeFunctionData({
    abi: [props.abi as AbiFunction],
    args: [props.authorWalletAddress as HexAddress]
  } as never);

  const encodedData = await viemClient.call({
    data: encodedParameters,
    to: props.contractAddress as HexAddress
  });

  if (!encodedData.data) {
    throw new Error("The call did not return with data");
  }

  const decodedData = decodeFunctionResult({
    abi: [props.abi as AbiFunction],
    data: encodedData.data
  } as never);

  return decodedData;
};

const parseCondition = (condition: string): {
  operator: SupportedConditionOperator;
  value: string;
} => {
  const operatorInCondition = supportedConditionOperators.find((operator) =>
    condition.startsWith(operator)
  );

  if (!operatorInCondition) {
    throw new Error(
      "Incorrect condition is set, make sure the condition operator is supported"
    );
  }

  const valueInCondition = condition.slice(operatorInCondition.length).trim();
  return {
    operator: operatorInCondition,
    value: valueInCondition
  };
};

// Whether evaluateConditionString will compare as bigints or as strings. A condition value of all
// digits is numeric; anything else falls back to a string comparison.
const isNumericConditionValue = (value: string): boolean => /^\d+$/.test(value);

// The settings-time counterpart of parseCondition, with messages naming the option rather than
// describing the parser's internals.
const validateConditionOption = (condition: string): void => {
  const operator = supportedConditionOperators.find((supportedOperator) =>
    condition.startsWith(supportedOperator)
  );

  if (!operator) {
    throw new Error(
      `option condition must start with one of ${supportedConditionOperators.join(", ")} ` +
        `(e.g. ">1000"), got "${condition}"`
    );
  }

  // Extracted with parseCondition rather than re-parsed here, so the hook can never bless a value the
  // challenge then reads differently. When these two drifted, "> 1000" validated as numeric and ran as
  // a String() comparison, which a balance of "99" satisfies.
  const { value } = parseCondition(condition);

  if (value === "") {
    throw new Error(
      `option condition "${condition}" has no value after the "${operator}" operator`
    );
  }

  // "=" against a string return value is a legitimate check. Ordering operators are not: a non-numeric
  // value makes evaluateConditionString compare with String(), so ">100" against a value of "99" would
  // pass on lexicographic order. That is always a misconfiguration rather than an intent.
  if (operator !== "=" && !isNumericConditionValue(value)) {
    throw new Error(
      `option condition "${condition}" compares with "${operator}" against a non-numeric value ` +
        `"${value}". Ordering comparisons need an unsigned integer, e.g. ">1000".`
    );
  }
};

const toComparableValue = (
  value: unknown,
  numeric: boolean
): ConditionComparable => {
  if (numeric) {
    return BigInt(value as string | number | bigint);
  }

  return String(value);
};

const evaluateConditionString = (
  condition: string,
  responseValue: unknown
): boolean => {
  const parsedCondition = parseCondition(condition);

  const isNumericCondition = isNumericConditionValue(parsedCondition.value);
  const conditionValueParsed = toComparableValue(
    parsedCondition.value,
    isNumericCondition
  );
  const responseValueParsed = toComparableValue(responseValue, isNumericCondition);

  if (typeof conditionValueParsed !== typeof responseValueParsed) {
    throw new Error("value of condition and response should be the same");
  }

  if (parsedCondition.operator === "=") {
    return responseValueParsed === conditionValueParsed;
  }
  if (parsedCondition.operator === ">") {
    return responseValueParsed > conditionValueParsed;
  }
  if (parsedCondition.operator === "<") {
    return responseValueParsed < conditionValueParsed;
  }

  throw new Error("Failed to parse condition. Please double check code and set condition");
};

const validateWalletAddressWithCondition = async (props: {
  authorWalletAddress: string;
  condition: string;
  chainTicker: string;
  contractAddress: string;
  abi: Record<string, unknown>;
  error: string | undefined;
  rpcUrls: string | undefined;
}): Promise<string | undefined> => {
  let contractCallResponse: unknown;
  try {
    contractCallResponse = await getContractCallResponse({
      chainTicker: props.chainTicker,
      contractAddress: props.contractAddress,
      abi: props.abi,
      authorWalletAddress: props.authorWalletAddress,
      rpcUrls: props.rpcUrls
    });
  } catch {
    return "Failed getting contract call response from blockchain.";
  }

  if (!evaluateConditionString(props.condition, contractCallResponse)) {
    return props.error || "Contract call response doesn't pass condition.";
  }

  return undefined;
};

const parseChallengeAbi = (abi: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(abi) as unknown;
  } catch (cause) {
    throw new Error(
      `option abi is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("option abi must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if ("type" in obj && obj["type"] !== undefined) {
    if (obj["type"] !== "function") {
      throw new Error(
        `option abi "type" must be "function", got "${String(obj["type"])}"`
      );
    }
  } else {
    obj["type"] = "function";
  }

  if (typeof obj["name"] !== "string" || obj["name"].length === 0) {
    throw new Error(
      'option abi must have a "name" string property (the contract function name, e.g. "balanceOf")'
    );
  }

  if (!Array.isArray(obj["inputs"])) {
    throw new Error('option abi must have an "inputs" array property');
  }
  if (obj["inputs"].length !== 1) {
    throw new Error(
      'option abi "inputs" must have exactly one parameter (the address input for the wallet to check)'
    );
  }
  const firstInput = obj["inputs"][0] as Record<string, unknown> | undefined;
  if (
    typeof firstInput !== "object" ||
    firstInput === null ||
    firstInput["type"] !== "address"
  ) {
    throw new Error('option abi "inputs[0].type" must be "address"');
  }

  if (!Array.isArray(obj["outputs"])) {
    throw new Error('option abi must have an "outputs" array property');
  }
  if (obj["outputs"].length === 0) {
    throw new Error('option abi "outputs" must have at least one entry');
  }

  const validMutabilities = ["pure", "view", "nonpayable", "payable"];
  if (!("stateMutability" in obj) || obj["stateMutability"] === undefined) {
    if (obj["constant"] === true) {
      obj["stateMutability"] = "view";
    } else {
      obj["stateMutability"] = "nonpayable";
    }
  } else if (!validMutabilities.includes(obj["stateMutability"] as string)) {
    throw new Error(
      'option abi "stateMutability" must be one of: pure, view, nonpayable, payable'
    );
  }

  return obj;
};

// Semantic validation of the owner's settings, run by pkc-js on every edit, community creation and
// community start. Core already enforces what optionInputs describes (undeclared keys, missing
// required options, publicOptions naming an option that does not exist), so everything here is a check
// only this package can make. Sync and no network on purpose: it runs on every community start, so an
// RPC reachability check here would turn a provider outage into a startup failure. That check belongs
// in getChallenge, where an outage costs one publish.
//
// Every rejection below currently surfaces as a per-author challenge failure at publish time, which is
// the wrong audience: the author cannot fix the community's ABI.
const validateChallengeSettings = ({
  challengeSettings
}: {
  challengeSettings: CommunityChallengeSetting;
}): void => {
  const options = challengeSettings.options ?? {};
  const { chainTicker, address, abi, condition, rpcUrls } = options;

  // Publication is the owner's call for every option but this one. RPC URLs routinely carry a provider
  // API key in the path (https://eth-mainnet.g.alchemy.com/v2/<KEY>), the published record is public and
  // permanent, and no client needs them anyway since the community node is what makes the contract call.
  // A leak with no upside is not a policy choice, so it is refused rather than left to the owner.
  if (challengeSettings.publicOptions?.includes("rpcUrls")) {
    throw new Error(
      "rpcUrls cannot be listed in publicOptions: RPC URLs commonly embed a provider API key, " +
        "and publishing one exposes it to everyone. Clients never use these endpoints, only the community node does."
    );
  }

  for (const url of parseRpcUrls(rpcUrls)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`option rpcUrls contains an entry that is not a valid URL: "${url}"`);
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(
        `option rpcUrls entry "${url}" must use http: or https:, got "${parsedUrl.protocol}"`
      );
    }
  }

  // Without a ticker viem has no built-in RPC to fall back on, and every call throws UrlRequiredError
  // before it is even sent. chainTicker is `required` so core has already rejected a missing one; this
  // only covers a ticker that is set but not one this package can map to a chain.
  if (
    chainTicker !== undefined &&
    parseRpcUrls(rpcUrls).length === 0 &&
    !getChainFromTicker(chainTicker)
  ) {
    throw new Error(
      `option rpcUrls is required for chainTicker "${chainTicker}": it has no built-in RPC. ` +
        `Tickers with a built-in RPC are: ${knownChainTickers.join(", ")}.`
    );
  }

  // strict: false because checksum casing is not what makes an address usable here, and an owner who
  // pastes a lowercased address from a block explorer has not made a mistake worth blocking an edit for.
  if (address !== undefined && !isAddress(address, { strict: false })) {
    throw new Error(
      `option address is not a valid EVM address: "${address}". It must be 0x followed by 40 hex characters.`
    );
  }

  // Same parser getChallenge uses, so an ABI accepted here cannot be rejected at challenge time.
  if (abi !== undefined) {
    parseChallengeAbi(abi);
  }

  if (condition !== undefined) {
    validateConditionOption(condition);
  }
};

const getChallenge = async ({
  challengeSettings,
  challengeRequestMessage,
  community
}: GetChallengeArgsInput): Promise<ChallengeResultInput> => {
  let { chainTicker, address, abi, condition, error, rpcUrls } =
    challengeSettings?.options || {};

  if (!chainTicker) {
    throw new Error("missing option chainTicker");
  }
  if (!address) {
    throw new Error("missing option address");
  }
  if (!abi) {
    throw new Error("missing option abi");
  }
  if (!condition) {
    throw new Error("missing option condition");
  }

  const doesConditionStartWithSupportedOperator =
    supportedConditionOperators.find((operator) => condition.startsWith(operator));
  if (!doesConditionStartWithSupportedOperator) {
    throw new Error("Condition uses unsupported comparison operator");
  }

  const parsedAbi = parseChallengeAbi(abi);
  const publication = derivePublicationFromChallengeRequest(challengeRequestMessage);

  const sharedProps: SharedVerifyProps = {
    pkc: community._pkc,
    abi: parsedAbi,
    condition,
    error,
    chainTicker,
    publication,
    contractAddress: address,
    rpcUrls
  };

  const walletFailureReason = await verifyAuthorWalletAddress(sharedProps);
  if (!walletFailureReason) {
    return { success: true };
  }

  const ensAuthorAddressFailureReason = await verifyAuthorENSAddress(sharedProps);
  if (!ensAuthorAddressFailureReason) {
    return { success: true };
  }

  const nftWalletAddressFailureReason = await verifyAuthorNftWalletAddress(
    sharedProps
  );
  if (!nftWalletAddressFailureReason) {
    return { success: true };
  }

  const errorString =
    `Author (${publication.author.address}) has failed all EVM challenges, ` +
    `walletFailureReason='${walletFailureReason}', ` +
    `ensAuthorAddressFailureReason='${ensAuthorAddressFailureReason}', ` +
    `nftWalletAddressFailureReason='${nftWalletAddressFailureReason}'`;

  return { success: false, error: errorString };
};

function evmContractChallenge({
  challengeSettings
}: {
  challengeSettings: CommunityChallengeSetting;
}): ChallengeFileInput {
  const chainTicker = challengeSettings?.options?.chainTicker;
  const type = `chain/${chainTicker || "eth"}` as ChallengeInput["type"];
  return {
    getChallenge,
    optionInputs,
    type,
    description,
    validateChallengeSettings
  };
}

// createViemClient/createEnsViemClient/getChainFromTicker are exported for the tests only: index.ts
// re-exports just the default and the types, so these are not part of the package's public API.
export {
  description,
  optionInputs,
  validateChallengeSettings,
  createViemClient,
  createEnsViemClient,
  getChainFromTicker,
  _clearViemClientCache
};
export default evmContractChallenge;
