import { describe, expect, it } from "vitest";
import evmContractChallenge, {
  validateChallengeSettings
} from "../src/evm-contract-challenge.js";
import type { CommunityChallengeSetting } from "../src/types.js";
import { createLogStub } from "./log-stub.js";

const CONTRACT_ADDRESS = "0xEA81DaB2e0EcBc6B5c4172DE4c22B6Ef6E55Bd8f";
const BALANCE_ABI_JSON =
  '{"constant":true,"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"}';

const VALID_OPTIONS = {
  chainTicker: "eth",
  rpcUrls: "https://eth.llamarpc.com",
  address: CONTRACT_ADDRESS,
  abi: BALANCE_ABI_JSON,
  condition: ">1000",
  error: "You need at least 1000 tokens to post."
};

const buildSettings = (
  overrides: Partial<Record<keyof typeof VALID_OPTIONS, string | undefined>> = {},
  publicOptions?: string[]
): CommunityChallengeSetting => {
  const options: Record<string, string> = { ...VALID_OPTIONS };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete options[key];
    } else {
      options[key] = value;
    }
  }

  return {
    name: "@bitsocial/evm-contract-challenge",
    options,
    ...(publicOptions ? { publicOptions } : {})
  };
};

const validate = (
  overrides: Parameters<typeof buildSettings>[0] = {},
  publicOptions?: string[]
): void =>
  validateChallengeSettings({
    challengeSettings: buildSettings(overrides, publicOptions),
    log: createLogStub().log
  });

describe("validateChallengeSettings", () => {
  describe("logging", () => {
    it("logs nothing for valid settings", () => {
      const logStub = createLogStub();
      validateChallengeSettings({ challengeSettings: buildSettings(), log: logStub.log });
      expect(logStub.lines()).toEqual([]);
    });

    it("logs a rejection at error level with the message it throws", () => {
      const logStub = createLogStub();
      expect(() =>
        validateChallengeSettings({
          challengeSettings: buildSettings({ condition: "~1000" }),
          log: logStub.log
        })
      ).toThrow(/option condition must start with/);
      expect(logStub.stub.error).toHaveBeenCalledWith(
        expect.stringMatching(/^Rejected the challenge settings: option condition must start with/)
      );
    });

    it("masks the rpcUrls entry that a rejection names", () => {
      const logStub = createLogStub();
      const secretRpcUrl = "ftp://rpc.example/v2/SECRET-KEY";
      expect(() =>
        validateChallengeSettings({
          challengeSettings: buildSettings({ rpcUrls: secretRpcUrl }),
          log: logStub.log
        })
      ).toThrow(/must use http: or https:/);
      expect(logStub.lines().join("\n")).not.toContain("SECRET-KEY");
      expect(logStub.stub.error).toHaveBeenCalledWith(expect.stringContaining("<rpcUrl>"));
    });

    it("masks a keyed RPC URL that another configured URL is a prefix of", () => {
      const logStub = createLogStub();
      // The short URL comes first and is valid; the keyed one is rejected and named in the message.
      const rpcUrls = "https://rpc.example,https://rpc.example:bad/SECRET-KEY";
      expect(() =>
        validateChallengeSettings({
          challengeSettings: buildSettings({ rpcUrls }),
          log: logStub.log
        })
      ).toThrow(/not a valid URL/);
      expect(logStub.lines().join("\n")).not.toContain("SECRET-KEY");
    });
  });

  it("is exposed on the challenge file so pkc-js can call it", () => {
    const challengeFile = evmContractChallenge({
      challengeSettings: buildSettings(),
      log: createLogStub().log
    });

    expect(typeof challengeFile.validateChallengeSettings).toBe("function");
  });

  it("accepts a valid settings entry", () => {
    expect(() => validate()).not.toThrow();
  });

  it("accepts a settings entry with no options at all", () => {
    // Core rejects missing required options before this hook is reached, so it must not double up on
    // that and must not crash on the empty case.
    expect(() =>
      validateChallengeSettings({
        challengeSettings: { name: "@bitsocial/evm-contract-challenge" },
        log: createLogStub().log
      })
    ).not.toThrow();
  });

  describe("publicOptions", () => {
    it("rejects publishing rpcUrls", () => {
      expect(() => validate({}, ["rpcUrls"])).toThrow(
        /rpcUrls cannot be listed in publicOptions/
      );
    });

    it("explains that the reason is a leaked provider API key", () => {
      expect(() => validate({}, ["address", "rpcUrls"])).toThrow(/API key/);
    });

    it("leaves publishing the rest of the ruleset to the owner", () => {
      expect(() =>
        validate({}, ["chainTicker", "address", "abi", "condition", "error"])
      ).not.toThrow();
    });
  });

  describe("rpcUrls", () => {
    it("rejects an entry that is not a URL", () => {
      expect(() => validate({ rpcUrls: "eth.llamarpc.com" })).toThrow(
        /option rpcUrls contains an entry that is not a valid URL/
      );
    });

    it("rejects one bad entry among good ones", () => {
      expect(() =>
        validate({ rpcUrls: "https://eth.llamarpc.com,not a url" })
      ).toThrow(/not a valid URL: "not a url"/);
    });

    it("rejects a non-http protocol", () => {
      expect(() => validate({ rpcUrls: "wss://eth.llamarpc.com" })).toThrow(
        /must use http: or https:/
      );
    });

    it("accepts http as well as https", () => {
      expect(() => validate({ rpcUrls: "http://localhost:8545" })).not.toThrow();
    });

    it("accepts several comma-separated URLs", () => {
      expect(() =>
        validate({
          rpcUrls: "https://eth.llamarpc.com, https://rpc.ankr.com/eth"
        })
      ).not.toThrow();
    });

    it("requires rpcUrls when the chainTicker has no built-in RPC", () => {
      expect(() =>
        validate({ chainTicker: "notachain", rpcUrls: undefined })
      ).toThrow(/option rpcUrls is required for chainTicker "notachain"/);
    });

    it("names the tickers that do have a built-in RPC", () => {
      expect(() =>
        validate({ chainTicker: "notachain", rpcUrls: undefined })
      ).toThrow(/eth/);
    });

    it("treats an empty rpcUrls the same as an absent one", () => {
      expect(() => validate({ chainTicker: "notachain", rpcUrls: "" })).toThrow(
        /option rpcUrls is required/
      );
    });

    it("allows omitting rpcUrls when the chainTicker has a built-in RPC", () => {
      expect(() => validate({ chainTicker: "matic", rpcUrls: undefined })).not.toThrow();
    });

    it("accepts an unknown chainTicker as long as rpcUrls is set", () => {
      expect(() =>
        validate({ chainTicker: "notachain", rpcUrls: "https://rpc.example" })
      ).not.toThrow();
    });

    it("requires rpcUrls for a ticker that only names an inherited object key", () => {
      // A bare chainsByTicker[ticker] lookup answers these with a function off Object.prototype, which
      // reads as "this ticker has a built-in RPC" and lets the edit through without rpcUrls.
      for (const ticker of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
        expect(() => validate({ chainTicker: ticker, rpcUrls: undefined })).toThrow(
          new RegExp(`option rpcUrls is required for chainTicker "${ticker}"`)
        );
      }
    });

    it("normalizes the chainTicker before deciding it has a built-in RPC", () => {
      expect(() => validate({ chainTicker: " ETH ", rpcUrls: undefined })).not.toThrow();
    });
  });

  describe("address", () => {
    it("rejects a malformed address", () => {
      expect(() => validate({ address: "0xnope" })).toThrow(
        /option address is not a valid EVM address/
      );
    });

    it("rejects an address of the wrong length", () => {
      expect(() => validate({ address: "0x1234" })).toThrow(
        /option address is not a valid EVM address/
      );
    });

    it("rejects an ENS name, which the contract call cannot use", () => {
      expect(() => validate({ address: "vitalik.eth" })).toThrow(
        /option address is not a valid EVM address/
      );
    });

    it("accepts a lowercased address", () => {
      expect(() =>
        validate({ address: CONTRACT_ADDRESS.toLowerCase() })
      ).not.toThrow();
    });

    it("accepts an address whose checksum casing is inconsistent", () => {
      // Checksum casing is not what makes an address usable, and an owner pasting from a block
      // explorer should not have an edit rejected over it.
      expect(() =>
        validate({ address: "0xEA81DAB2e0EcBc6B5c4172DE4c22B6Ef6E55Bd8f" })
      ).not.toThrow();
    });
  });

  describe("abi", () => {
    it("rejects an ABI that is not JSON", () => {
      expect(() => validate({ abi: "not json" })).toThrow(
        /option abi is not valid JSON/
      );
    });

    it("rejects a JSON array, the shape people reach for first", () => {
      expect(() => validate({ abi: `[${BALANCE_ABI_JSON}]` })).toThrow(
        /option abi must be a JSON object/
      );
    });

    it("rejects an ABI with no name", () => {
      expect(() => validate({ abi: '{"inputs":[],"outputs":[]}' })).toThrow(
        /option abi must have a "name" string property/
      );
    });

    it("rejects an ABI whose single input is not an address", () => {
      expect(() =>
        validate({
          abi: '{"name":"balanceOf","inputs":[{"name":"id","type":"uint256"}],"outputs":[{"type":"uint256"}],"stateMutability":"view"}'
        })
      ).toThrow(/option abi "inputs\[0\]\.type" must be "address"/);
    });

    it("rejects an ABI that returns nothing to compare against", () => {
      expect(() =>
        validate({
          abi: '{"name":"poke","inputs":[{"name":"a","type":"address"}],"outputs":[],"stateMutability":"view"}'
        })
      ).toThrow(/option abi "outputs" must have at least one entry/);
    });

    it("accepts the same ABIs getChallenge accepts", () => {
      expect(() =>
        validate({
          abi: '{"name":"getScore","inputs":[{"internalType":"address","name":"user","type":"address"}],"outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}'
        })
      ).not.toThrow();
    });
  });

  describe("condition", () => {
    it("rejects a condition with no comparison operator", () => {
      expect(() => validate({ condition: "1000" })).toThrow(
        /option condition must start with one of =, >, </
      );
    });

    it("rejects an unsupported operator", () => {
      expect(() => validate({ condition: ">=1000" })).toThrow(
        /compares with ">" against a non-numeric value/
      );
    });

    it("rejects an operator with no value after it", () => {
      expect(() => validate({ condition: ">" })).toThrow(
        /has no value after the ">" operator/
      );
    });

    it("rejects an ordering comparison against a non-numeric value", () => {
      // evaluateConditionString would fall back to String() comparison, where ">100" passes for "99".
      expect(() => validate({ condition: ">one thousand" })).toThrow(
        /compares with ">" against a non-numeric value/
      );
    });

    it("rejects a negative value, which the numeric path cannot parse", () => {
      expect(() => validate({ condition: ">-5" })).toThrow(
        /against a non-numeric value/
      );
    });

    it("accepts an equality check against a non-numeric value", () => {
      expect(() => validate({ condition: "=some-string" })).not.toThrow();
    });

    it("accepts an ordering comparison padded after the operator", () => {
      // Only worth accepting because parseCondition trims too. While it did not, this validated as
      // numeric and then ran as a String() comparison at challenge time.
      expect(() => validate({ condition: "> 1000" })).not.toThrow();
      expect(() => validate({ condition: ">  1000  " })).not.toThrow();
    });

    it("rejects a padded ordering comparison whose value is still non-numeric", () => {
      expect(() => validate({ condition: "> one thousand" })).toThrow(
        /against a non-numeric value/
      );
    });

    it("accepts the ordering comparisons", () => {
      expect(() => validate({ condition: ">0" })).not.toThrow();
      expect(() => validate({ condition: "<10000000000000000000" })).not.toThrow();
      expect(() => validate({ condition: "=1000" })).not.toThrow();
    });
  });
});
