# Changelog

## [0.2.0](https://github.com/bitsocialnet/evm-contract-challenge/compare/v0.1.7...v0.2.0) (2026-11-22)

### ⚠ BREAKING CHANGES

* proofs signed with plebbit-author-wallet, pkc-author-wallet,
  over author.address, or without walletAddress are no longer accepted. Authors
  re-sign. The NFT avatar source no longer grants a pass.

### Bug Fixes

* lowercase the verified wallet address before the contract call ([05ec9ab](https://github.com/bitsocialnet/evm-contract-challenge/commit/05ec9abde78ab416326a24c1c152fb0a1a29d9f6))
* reject a publication with an invalid wallet entry instead of falling through ([6d65212](https://github.com/bitsocialnet/evm-contract-challenge/commit/6d65212bf3bb1d0ee6fcc92989fd7d4c53196927))
* verify wallet proofs per BSIP-22, bound to the author's signing key ([6df76ea](https://github.com/bitsocialnet/evm-contract-challenge/commit/6df76ea44e9c3425c6e5627fd3e88c6ed9dd272b))

## [0.1.7](https://github.com/bitsocialnet/evm-contract-challenge/compare/v0.1.6...v0.1.7) (2026-09-03)

### Bug Fixes

* **deps:** remediate Dependabot alerts [skip github-alerts] ([45c28fe](https://github.com/bitsocialnet/evm-contract-challenge/commit/45c28fe9f050a97bd7446267a363cbe8c7614b79))

## [0.1.6](https://github.com/bitsocialnet/evm-contract-challenge/compare/v0.1.5...v0.1.6) (2026-08-21)

### Bug Fixes

* **deps:** scope the nested overrides by range so npm ci stays in sync ([7acd8f5](https://github.com/bitsocialnet/evm-contract-challenge/commit/7acd8f548ba83029166f44a0239477c2ea18eff5))

## [0.1.5](https://github.com/bitsocialnet/evm-contract-challenge/compare/v0.1.4...v0.1.5) (2026-08-21)

### Features

* validate challenge settings on edit instead of per author ([0906703](https://github.com/bitsocialnet/evm-contract-challenge/commit/09067032c7986ae0fa60f38ba6dcffb9fa5c48fa))

### Bug Fixes

* give the viem client a chain so rpcUrls and ENS work ([72c6e99](https://github.com/bitsocialnet/evm-contract-challenge/commit/72c6e9942ad0f63a9e1ceda459f2174991200faf))
* make the settings hook and the challenge parse a condition the same way ([05105a2](https://github.com/bitsocialnet/evm-contract-challenge/commit/05105a2d471d5c76918ccdd3b282333c8f5f86ec)), closes [#2](https://github.com/bitsocialnet/evm-contract-challenge/issues/2)

## [0.1.4](https://github.com/bitsocialnet/evm-contract-challenge/compare/v0.1.3...v0.1.4) (2026-04-24)

## [0.1.3](https://github.com/bitsocialnet/evm-contract-challenge/compare/v0.1.2...v0.1.3) (2026-04-11)

### Features

* rename rpcUrl to rpcUrls with comma-separated multi-RPC support ([98c93c1](https://github.com/bitsocialnet/evm-contract-challenge/commit/98c93c1064f71c5d04fcb29a12af7f4dc6872cd1))

### Bug Fixes

* install @pkcprotocol/pkc-js from npm instead of GitHub ([26a0316](https://github.com/bitsocialnet/evm-contract-challenge/commit/26a0316356baed41f457550fcdb7c8abd9502e44))
* make rpcUrl optional and rewrite README ([3e01fc1](https://github.com/bitsocialnet/evm-contract-challenge/commit/3e01fc1a015d7cbf19aa0975ec0cd6abc6bea135))
* update repository URL and README for renamed repo ([823dcd7](https://github.com/bitsocialnet/evm-contract-challenge/commit/823dcd70ba545d4b339aa3ec51c5f63605766f2e))
* validate ABI structure in parseChallengeAbi with clear error messages ([0fc37db](https://github.com/bitsocialnet/evm-contract-challenge/commit/0fc37db25b090f83b8d07a27d58476da8fa74fc7))

## [0.1.2](https://github.com/bitsocialnet/evm-contract-call/compare/v0.1.1...v0.1.2) (2026-04-11)

### Bug Fixes

* add registry-url to setup-node for OIDC npm publishing ([d4e3dce](https://github.com/bitsocialnet/evm-contract-call/commit/d4e3dcec2497462b8d4ebd46ce0b2fa532626c0a))

## 0.1.1 (2026-04-10)

### Features

* add automated versioning with release-it and GitHub CI ([d67c1e9](https://github.com/bitsocialnet/evm-contract-call/commit/d67c1e9d5569dbd6cbea0a395998e1e1337c4851))
* add standalone evm contract challenge package ([cbc633d](https://github.com/bitsocialnet/evm-contract-call/commit/cbc633d8c07029c4bf0942868fa8b9af101d4212))
* migrate from plebbit-js to pkc-js and add npm publishing ([d2cc62f](https://github.com/bitsocialnet/evm-contract-call/commit/d2cc62f419ad334d85eb6912a3e7373df73fdf5f))

### Bug Fixes

* no-op to test automated release pipeline ([a94b178](https://github.com/bitsocialnet/evm-contract-call/commit/a94b1782ac509c1d78fd100da9b933ef1db4128e))
