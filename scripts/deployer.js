#!/usr/bin/env node

const { compileSources } = require('./util/compile_contracts.js')

const Web3 = require('web3')
const fs = require('fs')
const RLP = require('rlp')
const BigNumber = require('bignumber.js')

process.on('unhandledRejection', console.error.bind(console))

// current run command: npx node scripts/deployer.js --gas-price-gwei 10 --rpc-url https://mainnet.infura.io
const {
  gasPriceGwei,
  printPrivateKey,
  rpcUrl,
  signedTxOutput,
  dontSendTx,
  chainId: chainIdInput
} = require('yargs')
  .usage(
    'Usage: $0 --gas-price-gwei [gwei] --print-private-key [bool] --rpc-url [url] --signed-tx-output [path] --dont-send-tx [bool] --chain-id'
  )
  .demandOption(['gasPriceGwei', 'rpcUrl'])
  .boolean('printPrivateKey')
  .boolean('dontSendTx').argv
const web3 = new Web3(new Web3.providers.HttpProvider(rpcUrl))

const rand = web3.utils.randomHex(7)

const privateKey = web3.utils.sha3('in love we trust' + rand)
console.log('privateKey', privateKey)

if (printPrivateKey) {
  let path = 'privatekey_' + web3.utils.randomHex(7) + '.txt'
  fs.writeFileSync(path, privateKey, function(err) {
    if (err) {
      return console.log(err)
    }
  })
}

const account = web3.eth.accounts.privateKeyToAccount(privateKey)
const gasPrice = new BigNumber(10).pow(9).mul(gasPriceGwei)
console.log(`gasPrice: ${gasPrice}`)
const signedTxs = []
let nonce
let chainId = chainIdInput

console.log('from', account.address)

async function sendTx(txObject) {
  let gasLimit
  try {
    gasLimit = await txObject.estimateGas()
  } catch (e) {
    console.log(`Note: estimateGas failed`)
    gasLimit = 5000 * 1000
  }

  gasLimit *= 1.2
  gasLimit -= gasLimit % 1
  console.log(`gasLimit: ${gasLimit}`)

  const txData = txObject.encodeABI()
  const txFrom = account.address
  const txKey = account.privateKey

  const tx = {
    from: txFrom,
    nonce: nonce,
    data: txData,
    gas: gasLimit,
    chainId,
    gasPrice
  }

  const signedTx = await web3.eth.accounts.signTransaction(tx, txKey)
  nonce++
  // don't wait for confirmation
  signedTxs.push(signedTx.rawTransaction)
  if (!dontSendTx) {
    web3.eth.sendSignedTransaction(signedTx.rawTransaction)
  }
}

async function deployContract(
  solcOutput,
  contractFile,
  contractName,
  ctorArgTypes,
  ctorArgs
) {
  const compiledContract = solcOutput.contracts[contractFile][contractName]
  const bytecode = compiledContract.evm.bytecode.object
  const abi = compiledContract.abi
  const myContract = new web3.eth.Contract(abi)
  const deploy = myContract.deploy({
    data: '0x' + bytecode,
    arguments: ctorArgs
  })

  let address =
    '0x' +
    web3.utils
      .sha3(RLP.encode([account.address, nonce]))
      .slice(12)
      .substring(14)
  address = web3.utils.toChecksumAddress(address)

  await sendTx(deploy)

  const encodedCtorArgs = web3.eth.abi.encodeParameters(ctorArgTypes, ctorArgs)
  console.log('ABI-Encoded onstructor args:', encodedCtorArgs)

  myContract.options.address = address

  return [address, myContract]
}

// Rinkeby
const DUTCH_EXCHANGE_ADDRESS = '0x25b8c27508a59bf498646d8819dc349876789f83' // Rinkeby
const KYBER_NETWORK_PROXY_ADDRESS = '0x3f380cBF53583bD3b3F29bf7C3e652cf1A70e58E' // Rinkeby

async function main() {
  nonce = await web3.eth.getTransactionCount(account.address)
  console.log('nonce', nonce)

  chainId = chainId || (await web3.eth.net.getId())
  console.log('chainId', chainId)

  const compiledContracts = compileSources()

  if (!dontSendTx) {
    // tmp:
    await waitForEth()
  }

  const [deployedAddress, deployedContract] = await deployContract(
    compiledContracts,
    'KyberDxMarketMaker.sol',
    'KyberDxMarketMaker',
    ['address', 'address'],
    [DUTCH_EXCHANGE_ADDRESS, KYBER_NETWORK_PROXY_ADDRESS]
  )

  console.log('deployedAddress: ' + deployedAddress)
  console.log('last nonce is', nonce)
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

async function waitForEth() {
  while (true) {
    const balance = await web3.eth.getBalance(account.address)
    console.log('waiting for balance to account ' + account.address)
    if (balance.toString() !== '0') {
      console.log('received ' + balance.toString() + ' wei')
      return
    } else await sleep(10000)
  }
}

main()
