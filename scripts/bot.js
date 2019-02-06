const fs = require('fs')
const Web3 = require('web3')
// TODO: maybe create web3 later?
const web3 = new Web3('http://', {})
const HDWalletProvider = require('truffle-hdwallet-provider')
const yargs = require('yargs')

// Setup environment variables from .env file
require('dotenv').config()

const winston = require('winston')
const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.cli(),
    winston.format.printf(info => {
      return `${info.timestamp} ${info.level}: ${info.message}`
    })
  ),
  transports: [new winston.transports.Console({ level: 'debug' })]
})

if (process.env.LOGGLY_TOKEN && process.env.LOGGLY_SUBDOMAIN) {
  const { Loggly } = require('winston-loggly-bulk')
  logger.add(
    new Loggly({
      inputToken: process.env.LOGGLY_TOKEN,
      subdomain: process.env.LOGGLY_SUBDOMAIN,
      tags: ['dxmm'],
      json: true
    })
  )
}

const MNEMONIC = process.env.MNEMONIC
const PRIVATE = process.env.PRIVATE

const DXMM_ADDRESS = process.env.DXMM_ADDRESS
if (typeof DXMM_ADDRESS === 'undefined') {
  logger.error('Please configure DXMM_ADDRESS')
  process.exit(1)
}

const SELL_TOKEN_ADDRESS = process.env.SELL_TOKEN_ADDRESS
if (typeof SELL_TOKEN_ADDRESS === 'undefined') {
  logger.error('Please configure SELL_TOKEN_ADDRESS')
  process.exit(1)
}

const SLEEP_TIME = process.env.SLEEP_TIME || 10000

// TODO: Compile the contracts instead
const ERC20_COMPILED = 'build/contracts/ERC20WithSymbol.json'
const WETH_COMPILED = 'build/contracts/EtherToken.json'
const DXMM_COMPILED = 'build/contracts/KyberDxMarketMaker.json'
const DX_COMPILED = 'build/contracts/DutchExchange.json'

// TODO: move to util file
const str = data => {
  return JSON.stringify(data, null, 2)
}

const priceStr = ({ num, den }, decimals = 10) => {
  if (den === 0) return 0
  return (num / den).toFixed(decimals)
}

// TODO: move to util file
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// XXX: only for development
async function devNetworkWaitTimeInSeconds(seconds) {
  const sendPromise = (method, params) => {
    return new Promise(function(fulfill, reject) {
      web3.currentProvider.send(
        {
          jsonrpc: '2.0',
          method,
          params: params || [],
          id: new Date().getTime()
        },
        function(err, result) {
          if (err) {
            reject(err)
          } else {
            fulfill(result)
          }
        }
      )
    })
  }
  await sendPromise('evm_increaseTime', [seconds])
  await sendPromise('evm_mine', [])
}

// TODO: move to util file
const _getProvider = (network, url) => {
  const secret = MNEMONIC || PRIVATE
  if (secret) {
    return new HDWalletProvider(secret, url)
    // if network isn't specified, defaulting to development
  } else if (network === undefined || network === 'development') {
    return new Web3.providers.HttpProvider(url)
    // else abort as we need MNEMONIC or a private KEY
  } else {
    throw new Error('No KEY or MNEMONIC supplied, aborting')
  }
}

// TODO: move to util file
const _getNetworkURL = net => {
  switch (net) {
    case 'rinkeby':
      return 'https://rinkeby.infura.io/'

    case 'kovan':
      return 'https://kovan.infura.io/'

    case 'main':
    case 'live':
      return 'https://main.infura.io/'

    case 'development':
    default:
      return 'http://localhost:8545'
  }
}

const _runMarketMaker = async (web3, gasPriceGwei) => {
  const account = (await web3.eth.getAccounts())[0]
  logger.info(`Running from account: ${account}`)

  // Signs and sends transactions.
  const sendTx = async (txObject, value) => {
    logger.debug('Preparing transaction')
    const gasPrice = web3.utils
      .toBN(gasPriceGwei)
      .mul(web3.utils.toBN(10 ** 9))
      .toNumber()
    const nonce = await web3.eth.getTransactionCount(account)
    const chainId = await web3.eth.net.getId()
    const txTo = txObject._parent.options.address

    let gasLimit
    try {
      gasLimit = await txObject.estimateGas()
    } catch (e) {
      logger.debug(`Error in estimateGas: ${e}`)
      gasLimit = 1000 * 1000
    }

    if (txTo !== null) {
      gasLimit = 500 * 1000
    }

    const txData = txObject.encodeABI()
    const txFrom = account

    const tx = {
      from: txFrom,
      to: txTo,
      nonce: nonce,
      data: txData,
      value: value,
      gas: gasLimit,
      chainId: chainId,
      gasPrice: gasPrice
    }
    logger.debug(`tx: ${str(tx)}`)

    const signedTx = await web3.eth.signTransaction(tx)
    logger.debug(`signed tx: ${str(signedTx)}`)

    const receipt = await web3.eth.sendSignedTransaction(signedTx.raw, {
      from: account
    })
    logger.debug(`sent transaction: ${str(receipt)}`)
    return receipt
  }

  // Loads the contracts that the bot interacts with
  // TODO: compile the contracts as part of this script
  const _loadContracts = async () => {
    const _loadContract = (abiFilename, address) => {
      const abiFile = fs.readFileSync(abiFilename, { encoding: 'utf-8' })
      const abi = JSON.parse(abiFile)['abi']
      return new web3.eth.Contract(abi, address)
    }

    logger.verbose('loading contracts')
    const dxmm = _loadContract(DXMM_COMPILED, DXMM_ADDRESS)
    const contracts = {
      dxmm: dxmm,
      sellToken: _loadContract(ERC20_COMPILED, SELL_TOKEN_ADDRESS),
      weth: _loadContract(WETH_COMPILED, await dxmm.methods.weth().call()),
      dx: _loadContract(DX_COMPILED, await dxmm.methods.dx().call())
    }
    Object.entries(contracts).forEach(([key, value]) => {
      logger.verbose(`${key} address:\t${value.options.address}`)
    })
    return contracts
  }
  const { dxmm, sellToken, weth: buyToken, dx } = await _loadContracts()
  logger.info(
    `Handle ${await buyToken.methods
      .symbol()
      .call()} -> ${await sellToken.methods.symbol().call()}`
  )

  // Setting up useful data from the dxmm contract.
  const auctionState = {}
  auctionState[await dxmm.methods.WAITING_FOR_FUNDING().call()] =
    'WAITING_FOR_FUNDING'
  auctionState[await dxmm.methods.WAITING_FOR_OPP_FUNDING().call()] =
    'WAITING_FOR_OPP_FUNDING'
  auctionState[await dxmm.methods.WAITING_FOR_SCHEDULED_AUCTION().call()] =
    'WAITING_FOR_SCHEDULED_AUCTION'
  auctionState[await dxmm.methods.AUCTION_IN_PROGRESS().call()] =
    'AUCTION_IN_PROGRESS'
  auctionState[await dxmm.methods.WAITING_FOR_OPP_TO_FINISH().call()] =
    'WAITING_FOR_OPP_TO_FINISH'

  const verifyHasEnoughTokens = async (sellToken, buyToken) => {
    logger.info('Checking dxmm has enough sell tokens')
    const missingTokens = await dxmm.methods
      .calculateMissingTokenForAuctionStart(
        sellToken.options.address,
        buyToken.options.address
      )
      .call()
    logger.verbose(`Missing sell tokens to start auction: ${missingTokens}`)

    const missingTokensWithFee = await dxmm.methods.addFee(missingTokens).call()
    logger.verbose(`Missing tokens with fee: ${missingTokensWithFee}`)

    const balance = await dx.methods
      .balances(sellToken.options.address, dxmm.options.address)
      .call()
    logger.verbose(`Sell token balance on DX: ${balance} `)

    const missingOnDx = web3.utils
      .toBN(missingTokensWithFee)
      .sub(web3.utils.toBN(balance))

    if (missingOnDx > 0) {
      logger.error(`Sell token missing from DX balance: ${missingOnDx} `)
      logger.error(
        'Steps to fix:\n(1) sellToken.transfer(dxmm.address, tokenAmount)'
      )
      process.exit(1)

      // XXX only in development
      // logger.info(`Missing sell token on DX: ${missingOnDx}, depositing...`)
      //
      // const tokenBalance = await sellToken.methods
      //   .balanceOf(dxmm.options.address)
      //   .call()
      // logger.debug(`KNC.balanceOf(dxmm) = ${tokenBalance}`)
      //
      // if (tokenBalance < missingOnDx) {
      //   logger.verbose('Transfering KNC to dxmm')
      //   await sendTx(
      //     sellToken.methods.transfer(dxmm.options.address, missingTokensWithFee)
      //   )
      // }
    }
  }

  const verifyHasEnoughWeth = async (sellToken, buyToken) => {
    logger.info('Check dxmm has enough WETH')
    const auctionIndex = await dx.methods
      .getAuctionIndex(sellToken.options.address, buyToken.options.address)
      .call()
    logger.verbose(`current auction index is ${auctionIndex}`)

    const requiredBuyTokens = await dxmm.methods
      .calculateAuctionBuyTokens(
        sellToken.options.address,
        buyToken.options.address,
        auctionIndex,
        dxmm.options.address
      )
      .call()
    logger.verbose(`required WETH: ${requiredBuyTokens}`)

    const dxWethBalance = await dx.methods
      .balances(buyToken.options.address, dxmm.options.address)
      .call()
    logger.verbose(`dxmm balance of WETH on dx: ${dxWethBalance}`)

    const missing = web3.utils
      .toBN(requiredBuyTokens)
      .sub(web3.utils.toBN(dxWethBalance))

    if (missing > 0) {
      logger.error(`WETH missing from DX balance: ${missing} `)
      logger.error(
        'Steps to fix:\n' +
          '(1) weth.deposit(amount)\n' +
          '(2) weth.transfer(dxmm.address, amount)'
      )
      process.exit(1)

      // XXX only in development
      // logger.info('Sending WETH to dxmm balance on dx')
      //
      // logger.verbose('Deposit WETH -> WETH')
      // await sendTx(buyToken.methods.deposit(), requiredBuyTokens /* value */)
      //
      // logger.verbose('Transfer WETH to dxmm')
      // await sendTx(
      //   buyToken.methods.transfer(dxmm.options.address, requiredBuyTokens)
      // )
    }
  }

  const _prepareStatus = async (sellToken, buyToken, shouldAct) => {
    const state = await dxmm.methods
      .getAuctionState(sellToken.options.address, buyToken.options.address)
      .call()

    const auctionIndex = await dx.methods
      .getAuctionIndex(sellToken.options.address, buyToken.options.address)
      .call()

    const price = await dx.methods
      .getCurrentAuctionPrice(
        sellToken.options.address,
        buyToken.options.address,
        auctionIndex
      )
      .call()

    const buyAmount = await dxmm.methods
      .calculateAuctionBuyTokens(
        sellToken.options.address,
        buyToken.options.address,
        auctionIndex,
        dxmm.options.address
      )
      .call()
    // logger.verbose(`buyAmount: ${buyAmount}`)

    const kyberPrice = await dxmm.methods
      .getKyberRate(
        sellToken.options.address,
        buyToken.options.address,
        buyAmount
      )
      .call()

    return `#${auctionIndex}: ${auctionState[state]}, price: ${priceStr(
      price
    )}, kyber: ${priceStr(kyberPrice)}, diff: ${(
      priceStr(price) - priceStr(kyberPrice)
    ).toFixed(10)}, act? ${shouldAct}`
  }

  // ------------------------------------------------
  //                  FLOW START
  // ------------------------------------------------
  let state = await dxmm.methods
    .getAuctionState(sellToken.options.address, buyToken.options.address)
    .call()
  logger.debug(`State is ${auctionState[state]}`)

  // TODO: maybe call only if required to trigger auction?
  // TODO: remove
  // await verifyHasEnoughTokens(sellToken, buyToken)

  // TODO: maybe call only if required to clear auction?
  // TODO: remove
  // await verifyHasEnoughWeth(sellToken, buyToken)

  logger.info('Starting loop')
  let shouldAct

  while (true) {
    shouldAct = await dxmm.methods
      .step(sellToken.options.address, buyToken.options.address)
      .call({ from: account })

    logger.verbose(await _prepareStatus(sellToken, buyToken, shouldAct))

    if (shouldAct) {
      await sendTx(
        dxmm.methods.step(sellToken.options.address, buyToken.options.address)
      )

      state = await dxmm.methods
        .getAuctionState(sellToken.options.address, buyToken.options.address)
        .call()

      logger.verbose(
        `State after acting is ${
          auctionState[state]
        }, dx balances: {sell: ${await dx.methods
          .balances(sellToken.options.address, dxmm.options.address)
          .call()}, buy: ${await dx.methods
          .balances(buyToken.options.address, dxmm.options.address)
          .call()}}`
      )
    }

    await sleep(SLEEP_TIME)

    // XXX: only in development
    // XXX: making things go fast
    // await devNetworkWaitTimeInSeconds(5 * 60)
  }
}

const runWithWeb3 = async (network, whatToRun) => {
  const provider = _getProvider(network, _getNetworkURL(network))
  web3.setProvider(provider)

  await whatToRun(web3)

  // Cleanup
  provider.engine.stop()
}

// .usage('$0 <cmd> [args]')
yargs
  .command(
    'run',
    'Run the bot',
    yargs => {
      yargs
        .option('n', {
          alias: 'net',
          demandOption: false,
          default: 'development',
          describe: 'Ethereum network',
          type: 'string'
        })
        .option('gasPriceGwei', {
          demandOption: false,
          default: '5',
          describe: 'Gas price in Gwei',
          type: 'int'
        })
    },
    async function(argv) {
      await runWithWeb3(argv.net, web3 => {
        _runMarketMaker(web3, argv.gasPriceGwei)
      })
    }
  )
  .help().argv

// TODO: add command for withdrawing balance from dx and dxmm
// 1 - claim
// 2 - dxmm.withdrawFromDx
// 3 - use withdrawable calls

// TODO: add command for transfering tokens to dxmm
