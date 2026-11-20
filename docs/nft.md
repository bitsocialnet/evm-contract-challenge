> **Disabled.** The NFT avatar source of `@bitsocial/evm-contract-challenge` is switched off. The message below is signed over the runtime `author.address` with a legacy `plebbit-` separator, which has the same problems BSIP-22 fixed for wallet proofs, and no BSIP defines the avatar proof yet. Do not build clients against it. This guide stays as a reference until the avatar proof is specified ([BSIP discussion](https://github.com/bitsocialnet/BSIPs/issues/40), [tracking issue](https://github.com/bitsocialnet/evm-contract-challenge/issues/11)).

### How to resolve and verify NFT avatars

```js
import { createPublicClient, http } from 'viem'
import { mainnet, avalanche, polygon } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverMessageAddress } from 'viem'

// this setting can be edited in the account or pkc-js settings, possible to use a local node
const ipfsGatewayUrl = 'https://ipfs.io'

// the user can edit these blockchain settings in the account or pkc-js settings
const chainProviders = {
  eth: { chain: mainnet, url: undefined }, // default public RPC
  avax: { chain: avalanche, url: 'https://api.avax.network/ext/bc/C/rpc' },
  matic: { chain: polygon, url: 'https://polygon-rpc.com' }
}

// cache the viem public clients because only 1 should be running at the same time per chain
const cachedChainClients = {}
const getChainClient = (chainTicker) => {
  if (cachedChainClients[chainTicker]) return cachedChainClients[chainTicker]
  const config = chainProviders[chainTicker]
  if (!config) throw Error(`no chain provider settings for chain ticker '${chainTicker}'`)
  cachedChainClients[chainTicker] = createPublicClient({
    chain: config.chain,
    transport: http(config.url)
  })
  return cachedChainClients[chainTicker]
}

const nftAbi = [
  { inputs: [{ name: 'tokenId', type: 'uint256' }], name: 'tokenURI', outputs: [{ type: 'string' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'tokenId', type: 'uint256' }], name: 'ownerOf', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' }
]

const getNftImageUrl = async (nft) => {
  const client = getChainClient(nft.chainTicker)
  let nftUrl = await client.readContract({
    address: nft.address,
    abi: nftAbi,
    functionName: 'tokenURI',
    args: [BigInt(nft.id)]
  })

  // if the nft uri is an ipfs url, get the gateway url
  if (nftUrl.startsWith('ipfs://')) {
    nftUrl = `${ipfsGatewayUrl}/${nftUrl.replace('://', '/')}`
  }

  // if the ipfs file is json, it probably has an 'image' property
  try {
    const json = await fetch(nftUrl).then(resp => resp.json())
    nftUrl = json.image
    if (nftUrl.startsWith('ipfs://')) {
      nftUrl = `${ipfsGatewayUrl}/${nftUrl.replace('://', '/')}`
    }
  } catch (e) {}

  return nftUrl
}

const getNftMessageToSign = (authorAddress, timestamp, tokenAddress, tokenId) => {
  // use plain JSON so the user can read what he's signing
  // property names must always be in this order for signature to match so don't use JSON.stringify
  return `{"domainSeparator":"plebbit-author-avatar","authorAddress":"${authorAddress}","timestamp":${timestamp},"tokenAddress":"${tokenAddress}","tokenId":"${tokenId}"}`
}

const createNftSignature = async (nft, authorAddress, account) => {
  const messageToSign = getNftMessageToSign(authorAddress, nft.timestamp, nft.address, nft.id)
  // the viem account is usually a WalletClient from metamask; for tests, use privateKeyToAccount
  return account.signMessage({ message: messageToSign })
}

const verifyNftSignature = async (nft, authorAddress) => {
  const client = getChainClient(nft.chainTicker)
  const currentNftOwnerAddress = await client.readContract({
    address: nft.address,
    abi: nftAbi,
    functionName: 'ownerOf',
    args: [BigInt(nft.id)]
  })

  const messageThatShouldBeSigned = getNftMessageToSign(authorAddress, nft.timestamp, nft.address, nft.id)
  const signatureAddress = await recoverMessageAddress({
    message: messageThatShouldBeSigned,
    signature: nft.signature.signature
  })
  if (currentNftOwnerAddress.toLowerCase() !== signatureAddress.toLowerCase()) {
    throw Error(`invalid nft signature address '${signatureAddress}' does not equal '${currentNftOwnerAddress}'`)
  }
}

const avatarNft = {
  chainTicker: 'eth',
  address: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
  timestamp: Math.round(Date.now() / 1000),
  id: 100
}
const avatarNft2 = {
  chainTicker: 'matic',
  address: '0xf6d8e606c862143556b342149a7fe0558c220375',
  timestamp: Math.round(Date.now() / 1000),
  id: 100
}
const author = {
  address: 'some test address...',
  avatar: avatarNft
}

;(async () => {
  const nftImageUrl = await getNftImageUrl(avatarNft)
  const nftImageUrl2 = await getNftImageUrl(avatarNft2)
  console.log({ nftImageUrl, nftImageUrl2 })

  // this is a test private key; in production, the WalletClient comes from a browser wallet
  const testPrivateKey = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const account = privateKeyToAccount(testPrivateKey)

  const signature = await createNftSignature(avatarNft, author.address, account)
  // pkc-js types the avatar signature as an object, and the challenge reads signature.signature
  const nftWithSignature = { ...avatarNft, signature: { signature, type: 'eip191' } }
  console.log({ nftWithSignature })

  try {
    await verifyNftSignature(nftWithSignature, author.address)
  } catch (e) {
    console.log(`nft signature is not verified because our test private key doesn't own a bored ape`)
  }
})()
```
