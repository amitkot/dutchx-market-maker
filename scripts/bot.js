const fs = require('fs')
const Web3 = require('web3')
const web3 = new Web3()
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

const SLEEP_TIME = process.env.SLEEP_TIME || 10000

// TODO: move to .env
// Kovan
// const DXMM_ADDRESS = '0x4Dea0d19bD0A8181aa27C9921A24524569Ecd5C6'
const DXMM_ADDRESS = '0x5017A545b09ab9a30499DE7F431DF0855bCb7275'
const KNC_ADDRESS = '0xA586074FA4Fe3E546A132a16238abe37951D41fE'

// TODO: Compile the contracts or use these?
const ERC20_COMPILED = 'build/contracts/ERC20.json'
const WETH_COMPILED = 'build/contracts/EtherToken.json'
const DXMM_COMPILED = 'build/contracts/DxMarketMaker.json'
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
async function waitTimeInSeconds(seconds) {
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

const _printThings = async (web3, gasPriceGwei) => {
  const account = (await web3.eth.getAccounts())[0]
  logger.info(`Running from account: ${account}`)

  const _loadContract = (abiFilename, address) => {
    const abiFile = fs.readFileSync(abiFilename, { encoding: 'utf-8' })
    const abi = JSON.parse(abiFile)['abi']
    return new web3.eth.Contract(abi, address)
  }

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
      gasLimit = 500 * 1000
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

  const _loadContracts = async () => {
    logger.verbose('loading contracts')
    // const dxmm = _loadContract(DXMM_COMPILED, DXMM_ADDRESS)
    // const knc = _loadContract(ERC20_COMPILED, KNC_ADDRESS)
    // const weth = _loadContract(WETH_COMPILED, await dxmm.methods.weth().call())
    // const dx = _loadContract(DX_COMPILED, await dxmm.methods.dx().call())
    const dxmm = _loadContract(DXMM_COMPILED, DXMM_ADDRESS)
    const contracts = {
      dxmm: dxmm,
      knc: _loadContract(ERC20_COMPILED, KNC_ADDRESS),
      weth: _loadContract(WETH_COMPILED, await dxmm.methods.weth().call()),
      dx: _loadContract(DX_COMPILED, await dxmm.methods.dx().call())
    }
    Object.entries(contracts).forEach(([key, value]) => {
      logger.verbose(`${key} address:\t${value.options.address}`)
    })
    return contracts
  }
  const { dxmm, knc, weth, dx } = await _loadContracts()

  const auctionState = {}
  auctionState[await dxmm.methods.NO_AUCTION_TRIGGERED().call()] =
    'NO_AUCTION_TRIGGERED'
  auctionState[await dxmm.methods.AUCTION_TRIGGERED_WAITING().call()] =
    'AUCTION_TRIGGERED_WAITING'
  auctionState[await dxmm.methods.AUCTION_IN_PROGRESS().call()] =
    'AUCTION_IN_PROGRESS'

  const verifyHasEnoughTokens = async (sellToken, buyToken) => {
    logger.info('Checking dxmm has enough tokens')
    const missingTokens = await dxmm.methods
      .calculateMissingTokenForAuctionStart(
        sellToken.options.address,
        buyToken.options.address
      )
      .call()
    logger.verbose(`Missing KNC tokens to start auction: ${missingTokens}`)

    const missingTokensWithFee = await dxmm.methods.addFee(missingTokens).call()
    logger.verbose(`Missing KNC tokens with fee: ${missingTokensWithFee}`)

    const balance = await dx.methods
      .balances(knc.options.address, dxmm.options.address)
      .call()
    logger.verbose(`KNC balance on DX: ${balance} `)

    const missingOnDx = web3.utils
      .toBN(missingTokensWithFee)
      .sub(web3.utils.toBN(balance))
    logger.verbose(`KNC missing from DX balance: ${missingOnDx} `)

    if (missingOnDx > 0) {
      logger.info(`Missing KNC on DX: ${missingOnDx}, depositing...`)

      const tokenBalance = await knc.methods
        .balanceOf(dxmm.options.address)
        .call()
      logger.debug(`KNC.balanceOf(dxmm) = ${tokenBalance}`)

      if (tokenBalance < missingOnDx) {
        logger.verbose('Transfering KNC to dxmm')
        await sendTx(
          knc.methods.transfer(dxmm.options.address, missingTokensWithFee)
        )
      }

      logger.verbose('dxmm.depositToDx()')
      await sendTx(
        dxmm.methods.depositToDx(
          sellToken.options.address,
          missingTokensWithFee
        )
      )
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

    // TODO: maybe act only if got specific flag from user
    if (dxWethBalance < requiredBuyTokens) {
      logger.info('Sending WETH to dxmm balance on dx')

      logger.verbose('Deposit WETH -> WETH')
      await sendTx(buyToken.methods.deposit(), requiredBuyTokens /* value */)

      logger.verbose('Transfer WETH to dxmm')
      await sendTx(
        buyToken.methods.transfer(dxmm.options.address, requiredBuyTokens)
      )

      logger.verbose('Deposit to dx')
      await sendTx(
        dxmm.methods.depositToDx(buyToken.options.address, requiredBuyTokens)
      )
    }
  }

  const _prepareStatus = async shouldAct => {
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

  const sellToken = knc
  const buyToken = weth

  let state = await dxmm.methods
    .getAuctionState(sellToken.options.address, buyToken.options.address)
    .call()
  logger.debug(`State is ${auctionState[state]}`)

  // TODO: maybe call only if required to trigger auction?
  await verifyHasEnoughTokens(sellToken, buyToken)

  // TODO: maybe call only if required to clear auction?
  await verifyHasEnoughWeth(sellToken, buyToken)

  let shouldAct

  logger.info('Starting loop')
  while (true) {
    shouldAct = await dxmm.methods
      .magic(sellToken.options.address, buyToken.options.address)
      .call()

    logger.verbose(await _prepareStatus(shouldAct))

    if (shouldAct) {
      await sendTx(
        dxmm.methods.magic(sellToken.options.address, buyToken.options.address)
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
    // await waitTimeInSeconds(SLEEP_TIME / 1000)
    // XXX: making things go fast
    await waitTimeInSeconds(5 * 60)
  }
}

const run = async (network, gasPriceGwei) => {
  const provider = _getProvider(network, _getNetworkURL(network))
  web3.setProvider(provider)

  await _printThings(web3, gasPriceGwei)

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
      await run(argv.net, argv.gasPriceGwei)
    }
  )
  .help().argv
