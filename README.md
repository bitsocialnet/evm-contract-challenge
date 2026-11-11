# @bitsocial/evm-contract-challenge

An automatic challenge for `@pkcprotocol/pkc-js` communities that verifies an author's EVM wallet address meets a condition from a smart contract call.

## How it works

When an author publishes to a community with this challenge enabled, the community node calls a read-only smart contract method with the author's wallet address as the argument and compares the return value against a configured condition (e.g. `>1000`). The challenge tries three sources for the wallet address:

1. **Wallet address** — the `author.wallets[chainTicker]` address, verified via EIP-191 signature
2. **ENS/BSO domain** — if the author's address is a `.eth` or `.bso` domain, it resolves to an on-chain address
3. **NFT avatar** — the current owner of the author's avatar NFT

If any source produces a wallet that passes the contract call condition, the challenge succeeds. No user interaction is required.

## Requirements

- Node.js `>=22`
- ESM-only environment

## Install

### With bitsocial-cli

```bash
bitsocial challenge install @bitsocial/evm-contract-challenge
```

Edit your community to use the challenge:

```bash
bitsocial community edit your-community.bso \
  '--settings.challenges[0].name' @bitsocial/evm-contract-challenge \
  '--settings.challenges[0].options.chainTicker' eth \
  '--settings.challenges[0].options.address' '0xEA81DaB2e0EcBc6B5c4172DE4c22B6Ef6E55Bd8f' \
  '--settings.challenges[0].options.abi' '{"constant":true,"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"}' \
  '--settings.challenges[0].options.condition' '>10000000000000000000' \
  '--settings.challenges[0].options.error' 'You need at least 10 Bitsocial tokens to post.'
```

### With pkc-js over RPC

If your RPC server is already running, first install the challenge on the server:

```bash
bitsocial challenge install @bitsocial/evm-contract-challenge
```

Then from your RPC client, connect and set the challenge on your community by name — no npm install or challenge registration needed on the client side:

```ts
import PKC from "@pkcprotocol/pkc-js";

const pkc = await PKC({
  pkcRpcClientsOptions: ["ws://localhost:9138"]
});

const community = await pkc.createCommunity({ address: "your-community-address.bso" });

await community.edit({
  settings: {
    challenges: [
      {
        name: "@bitsocial/evm-contract-challenge",
        options: {
          chainTicker: "eth",
          address: "0xEA81DaB2e0EcBc6B5c4172DE4c22B6Ef6E55Bd8f",
          abi: '{"constant":true,"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"}',
          condition: ">10000000000000000000",
          error: "You need at least 10 Bitsocial tokens to post."
        }
      }
    ]
  }
});
```

### With pkc-js (TypeScript)

If you are running your own node locally without connecting over RPC, you can install via npm and register the challenge manually:

```bash
npm install @bitsocial/evm-contract-challenge
```

```ts
import PKC from "@pkcprotocol/pkc-js";
import { evmContractChallenge } from "@bitsocial/evm-contract-challenge";

PKC.challenges["@bitsocial/evm-contract-challenge"] = evmContractChallenge;
```

Then set the challenge on your community:

```ts
await community.edit({
  settings: {
    challenges: [
      {
        name: "@bitsocial/evm-contract-challenge",
        options: {
          chainTicker: "eth",
          address: "0xEA81DaB2e0EcBc6B5c4172DE4c22B6Ef6E55Bd8f",
          abi: '{"constant":true,"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"}',
          condition: ">10000000000000000000",
          error: "You need at least 10 Bitsocial tokens to post."
        }
      }
    ]
  }
});
```

## Example Challenges

Each example uses a read-only contract function that takes a single `address` argument. The `condition` compares against the raw return value including decimal places (e.g. 10 USDC with 6 decimals = `10000000` raw).

### Common ABIs

<a id="balanceof-abi"></a>**`balanceOf`** — standard ERC-20 / ERC-721 token balance:

```json
{"constant":true,"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"}
```

<a id="getscore-abi"></a>**`getScore`** — Gitcoin Passport score (returns `uint256` with 4 decimals):

```json
{"inputs":[{"internalType":"address","name":"user","type":"address"}],"name":"getScore","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
```

### Examples

| Description | `chainTicker` | `address` | ABI | `condition` |
|---|---|---|---|---|
| At least 10 Bitsocial (BSO) tokens | `eth` | `0xEA81DaB2e0EcBc6B5c4172DE4c22B6Ef6E55Bd8f` | [`balanceOf`](#balanceof-abi) | `>10000000000000000000` |
| Minimum 10 USDC | `eth` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | [`balanceOf`](#balanceof-abi) | `>10000000` |
| Any WETH balance | `eth` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | [`balanceOf`](#balanceof-abi) | `>0` |
| Gitcoin Passport score above 20 (proof of personhood) | `op` | `0xd6c51bB9E23bD7f1fEa22A3F2f85E3BFC8338Cb0` | [`getScore`](#getscore-abi) | `>200000` |
| At least 10 MATIC on Polygon | `matic` | `0x0000000000000000000000000000000000001010` | [`balanceOf`](#balanceof-abi) | `>10000000000000000000` |
| Any stETH balance (Lido staked ETH) | `eth` | `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84` | [`balanceOf`](#balanceof-abi) | `>0` |

> Setting `rpcUrls` is recommended on every chain, including Ethereum mainnet. See [Challenge Options](#challenge-options).

## Challenge Options

All option values must be strings.

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `chainTicker` | yes | `"eth"` | The chain ticker (e.g. `eth`, `matic`) |
| `rpcUrls` | see below | — | Comma-separated JSON-RPC URLs for the chain |
| `address` | yes | — | The contract address to call |
| `abi` | yes | — | The ABI of the contract method as a JSON object (not an array) |
| `condition` | yes | — | Condition the return value must pass (`=`, `>`, or `<` followed by a value, e.g. `>1000`) |
| `error` | no | `"Contract call response doesn't pass condition."` | Custom error message shown when the condition fails |

### When `rpcUrls` is required

`rpcUrls` is **required unless `chainTicker` is one of the tickers below**, which have a built-in RPC endpoint:

`eth`, `matic` / `pol`, `op`, `arb`, `base`, `avax`, `bnb` / `bsc`, `gno` / `xdai`, `celo`, `ftm`, `linea`, `scroll`, `zksync`, `blast`

Setting it is still **recommended even for those**: the built-in endpoints are shared public RPCs and will rate-limit a busy community, which shows up as authors being rejected at random rather than as an obvious failure.

An unsupported ticker with no `rpcUrls` is rejected when you save the challenge settings, rather than failing later for every author who tries to publish.

## Publishing Options

`community.settings.challenges[i].options` is private. Nothing in it is published unless you name the option in `publicOptions`, which copies it into the public `community.challenges[i].publicOptions` record.

**Recommended: publish everything except `rpcUrls`.**

```ts
await community.edit({
  settings: {
    challenges: [
      {
        name: "@bitsocial/evm-contract-challenge",
        options: {
          /* ... */
        },
        publicOptions: ["chainTicker", "address", "abi", "condition", "error"]
      }
    ]
  }
});
```

| Option | Publish? | Why |
|--------|----------|-----|
| `chainTicker` | recommended | Already public in effect — the challenge's `type` is `chain/<chainTicker>` |
| `address` | recommended | A contract address is public on-chain data; hiding it buys no security |
| `abi` | recommended | The signature of a public method on that contract |
| `condition` | recommended | The threshold that makes the other three actionable |
| `error` | recommended | Authors see this string anyway when they fail |
| `rpcUrls` | **never — refused** | RPC URLs commonly embed a provider API key |

Published together, `chainTicker` + `address` + `abi` + `condition` let a client tell an author exactly what they are missing *before* they publish and burn a challenge attempt. Published partially, none of that works, so treat the four as one unit.

Keeping them private is a legitimate choice — you may not want the exact threshold known — and this package will not stop you. `rpcUrls` is the one exception: naming it in `publicOptions` is refused outright, because publishing a URL like `https://eth-mainnet.g.alchemy.com/v2/<KEY>` leaks a paid credential to everyone, permanently, and no client ever uses these endpoints. Only the community node does.

## Settings Validation

The challenge validates its own settings whenever you create a community, edit one, or start one, via pkc-js's `validateChallengeSettings` hook. A bad setting is rejected as a failed edit instead of silently rejecting every author at publish time.

Rejected settings:

- `publicOptions` naming `rpcUrls`
- `rpcUrls` entries that are not valid URLs, or that do not use `http:` / `https:`
- `rpcUrls` omitted for a `chainTicker` with no built-in RPC
- `address` that is not a well-formed EVM address
- `abi` that is not valid JSON, or not a single function entry taking one `address` and returning at least one value
- `condition` with no supported operator (`=`, `>`, `<`), no value after the operator, or an ordering comparison against a non-numeric value (e.g. `>abc`, which would otherwise compare as text)

pkc-js additionally rejects an option name that no option above declares, and any required option left unset, before this challenge's own validation runs.

## Multiple RPC URLs

You can provide multiple RPC endpoints as a comma-separated string:

```
https://eth.llamarpc.com,https://rpc.ankr.com/eth,https://eth.drpc.org
```

When multiple URLs are provided, viem's [`fallback`](https://viem.sh/docs/clients/transports/fallback) transport is used. This means:

- Requests are sent to the first RPC endpoint in the list
- If a request fails, it automatically falls back to the next endpoint, in the order listed
- No background traffic: endpoints are only contacted when an author publishes. Automatic ranking (`rank: true`) is deliberately off, because its background pinging can never be stopped and would keep polling endpoints you have since removed from `rpcUrls` until the node restarts
- A single URL works the same as before (no fallback overhead)
- If `rpcUrls` is omitted, the chain's built-in RPC is used, which requires a supported `chainTicker` (see [When `rpcUrls` is required](#when-rpcurls-is-required))

This improves reliability — if one RPC provider goes down, the challenge automatically uses the next available endpoint.

## Scripts

```bash
npm run typecheck
npm run build
npm test
```
