#!/usr/bin/env node

const Web3 = require('web3')
const fs = require('fs')
const path = require('path')
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
const solc = require('solc')

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
const sender = account.address
const gasPrice = new BigNumber(10).pow(9).mul(gasPriceGwei)
console.log(`gasPrice: ${gasPrice}`)
const signedTxs = []
let nonce
let chainId = chainIdInput

console.log('from', sender)

async function sendTx(txObject) {
  const txTo = txObject._parent.options.address

  let gasLimit
  try {
    gasLimit = await txObject.estimateGas()
  } catch (e) {
    console.log(`Note: estimateGas failed`)
    gasLimit = 5000 * 1000
  }

  if (txTo !== null) {
    console.log(`Note: setting gasLimit manually`)
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
    to: txTo,
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
    web3.eth.sendSignedTransaction(signedTx.rawTransaction, {
      from: sender
    })
  }
}

async function deployContract(
  solcOutput,
  contractFile,
  contractName,
  ctorArgTypes,
  ctorArgs
) {
  const bytecode =
    solcOutput.contracts[contractFile][contractName].evm.bytecode.object
  const abi = solcOutput.contracts[contractFile][contractName].abi
  const myContract = new web3.eth.Contract(abi)
  const deploy = myContract.deploy({
    data: '0x' + bytecode,
    arguments: ctorArgs
  })
  let address =
    '0x' +
    web3.utils
      .sha3(RLP.encode([sender, nonce]))
      .slice(12)
      .substring(14)
  address = web3.utils.toChecksumAddress(address)

  await sendTx(deploy)

  const encodedCtorArgs = web3.eth.abi.encodeParameters(ctorArgTypes, ctorArgs)
  console.log('ABI-Encoded onstructor args:', encodedCtorArgs)

  myContract.options.address = address

  return [address, myContract]
}

const contractPath = path.join(__dirname, '../contracts/')
const dxContractsPath = path.join(
  contractPath,
  '../node_modules/@gnosis.pm/dx-contracts/contracts/'
)
const dxContractsBasePath = path.join(
  contractPath,
  '../node_modules/@gnosis.pm/dx-contracts/contracts/base/'
)
const owlContractsPath = path.join(
  contractPath,
  '../node_modules/@gnosis.pm/owl-token/contracts/'
)
const dxUtilContractsPath = path.join(
  contractPath,
  '../node_modules/@gnosis.pm/util-contracts/contracts/'
)

const sources = {
  'ERC20Interface.sol': {
    content: fs.readFileSync(contractPath + 'ERC20Interface.sol', 'utf8')
  },
  'PermissionGroups.sol': {
    content: fs.readFileSync(contractPath + 'PermissionGroups.sol', 'utf8')
  },
  'Withdrawable.sol': {
    content: fs.readFileSync(contractPath + 'Withdrawable.sol', 'utf8')
  },
  'KyberDxMarketMaker.sol': {
    content: fs.readFileSync(contractPath + 'KyberDxMarketMaker.sol', 'utf8')
  },
  '@gnosis.pm/util-contracts/contracts/Math.sol': {
    content: fs.readFileSync(dxUtilContractsPath + 'Math.sol', 'utf8')
  },
  '@gnosis.pm/util-contracts/contracts/Proxy.sol': {
    content: fs.readFileSync(dxUtilContractsPath + 'Proxy.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/TokenFRT.sol': {
    content: fs.readFileSync(dxContractsPath + 'TokenFRT.sol', 'utf8')
  },
  '@gnosis.pm/owl-token/contracts/TokenOWL.sol': {
    content: fs.readFileSync(owlContractsPath + 'TokenOWL.sol', 'utf8')
  },
  '@gnosis.pm/util-contracts/contracts/Token.sol': {
    content: fs.readFileSync(dxUtilContractsPath + 'Token.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/base/SafeTransfer.sol': {
    content: fs.readFileSync(dxContractsBasePath + 'SafeTransfer.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/base/TokenWhitelist.sol': {
    content: fs.readFileSync(dxContractsBasePath + 'TokenWhitelist.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/base/DxMath.sol': {
    content: fs.readFileSync(dxContractsBasePath + 'DxMath.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/DSAuth.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/DSAuth.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/DSMath.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/DSMath.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/DSNote.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/DSNote.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/DSThing.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/DSThing.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/DSValue.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/DSValue.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/Medianizer.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/Medianizer.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/PriceFeed.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/PriceFeed.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/PriceOracleInterface.sol': {
    content: fs.readFileSync(
      dxContractsPath + 'Oracle/PriceOracleInterface.sol',
      'utf8'
    )
  },
  '@gnosis.pm/dx-contracts/contracts/base/EthOracle.sol': {
    content: fs.readFileSync(dxContractsBasePath + 'EthOracle.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/base/DxUpgrade.sol': {
    content: fs.readFileSync(dxContractsBasePath + 'DxUpgrade.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/base/AuctioneerManaged.sol': {
    content: fs.readFileSync(
      dxContractsBasePath + 'AuctioneerManaged.sol',
      'utf8'
    )
  },
  '@gnosis.pm/dx-contracts/contracts/DutchExchange.sol': {
    content: fs.readFileSync(dxContractsPath + 'DutchExchange.sol', 'utf8')
  },
  '@gnosis.pm/util-contracts/contracts/GnosisStandardToken.sol': {
    content: fs.readFileSync(
      dxUtilContractsPath + 'GnosisStandardToken.sol',
      'utf8'
    )
  },
  '@gnosis.pm/util-contracts/contracts/EtherToken.sol': {
    content: fs.readFileSync(dxUtilContractsPath + 'EtherToken.sol', 'utf8')
  }
}

// Rinkeby
const DUTCH_EXCHANGE_ADDRESS = '0x25b8c27508a59bf498646d8819dc349876789f83' // Rinkeby
const KYBER_NETWORK_PROXY_ADDRESS = '0x882281F5c2D58F05e969Ea74f9D8A733dfdCCe77' // Rinkeby

async function main() {
  nonce = await web3.eth.getTransactionCount(sender)
  console.log('nonce', nonce)

  chainId = chainId || (await web3.eth.net.getId())
  console.log('chainId', chainId)

  console.log('starting compilation')

  const input = {
    language: 'Solidity',
    sources: sources,
    settings: {
      optimizer: { enabled: true },
      outputSelection: {
        '*': {
          '*': ['*']
        }
      }
    }
  }

  const output = JSON.parse(solc.compile(JSON.stringify(input)))

  if (output.errors) {
    output.errors.forEach(err => {
      console.log(err.formattedMessage)
    })
  }
  console.log('finished compilation')

  if (!dontSendTx) {
    // tmp:
    await waitForEth()
  }

  const [deployedAddress, deployedContract] = await deployContract(
    output,
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
    const balance = await web3.eth.getBalance(sender)
    console.log('waiting for balance to account ' + sender)
    if (balance.toString() !== '0') {
      console.log('received ' + balance.toString() + ' wei')
      return
    } else await sleep(10000)
  }
}

main()
