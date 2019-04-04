const Web3 = require('web3')
// TODO: maybe create the web3 instance later?
const web3 = new Web3('http://')
const yargs = require('yargs')
const winston = require('winston')

const { sleepInSeconds, str } = require('./util/misc.js')
const { compileSources } = require('./util/compileContracts.js')
const { setupSendTx, sendTxWithTimeout } = require('./util/sendTx.js')

// Setup environment variables from .env file
require('dotenv').config()

// Defaults
const DEFAULT_TX_TIMEOUT_SECONDS = 15
const DEFAULT_CYCLE_SLEEP_SECONDS = 10
const DEFAULT_TX_RESEND_GAS_PRICE_FACTOR = 1.2

const PRIVATE = process.env.PRIVATE
if (typeof PRIVATE === 'undefined') {
  console.log('PRIVATE key not configured')
  process.exit(1)
}

const DXMM_ADDRESS = process.env.DXMM_ADDRESS
if (typeof DXMM_ADDRESS === 'undefined') {
  console.log('DXMM_ADDRESS not configured')
  process.exit(1)
}

// Timeout after sending tx before increasing gas price
const TX_TIMEOUT_SECONDS =
  process.env.TX_TIMEOUT_SECONDS || DEFAULT_TX_TIMEOUT_SECONDS

// Time to wait in seconds between iteration cycles
const CYCLE_SLEEP_SECONDS =
  process.env.CYCLE_SLEEP_SECONDS || DEFAULT_CYCLE_SLEEP_SECONDS

// setup is called later when we know sell and buy token names
let logger

const _setupLogger = (logTime, sellToken, buyToken) => {
  logger = winston.createLogger({
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.cli(),
      winston.format.label({ label: `${sellToken}->${buyToken}` }),
      winston.format.printf(({ level, message, label, timestamp }) => {
        return logTime
          ? `${timestamp} [${label}] ${level}: ${message}`
          : `[${label}] ${level}: ${message}`
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
}

const priceStr = ({ num, den }, decimals = 10) => {
  if (den === 0) return 0
  return (num / den).toFixed(decimals)
}

const _getNetworkURL = net => {
  switch (net) {
    case 'rinkeby':
      return 'https://rinkeby.infura.io/'

    case 'kovan':
      return 'https://kovan.infura.io/'

    case 'main':
    case 'live':
      return 'https://mainnet.infura.io/'

    case 'development':
    default:
      return 'http://localhost:8545'
  }
}

const _runMarketMaker = async (
  web3,
  sellTokenAddress,
  buyTokenAddress,
  txResendGasPriceFactor,
  logTime
) => {
  // Loads the contracts that the bot interacts with
  const _loadContracts = async () => {
    const compiledContracts = compileSources()

    const _loadContract = (contractFile, contractName, address) => {
      const abi = compiledContracts.contracts[contractFile][contractName].abi
      return new web3.eth.Contract(abi, address)
    }

    const dxmm = _loadContract(
      'KyberDxMarketMaker.sol',
      'KyberDxMarketMaker',
      DXMM_ADDRESS
    )
    const contracts = {
      dxmm: dxmm,
      sellToken: _loadContract(
        'ERC20Interface.sol',
        'ERC20WithSymbol',
        sellTokenAddress
      ),
      buyToken: _loadContract(
        'ERC20Interface.sol',
        'ERC20WithSymbol',
        buyTokenAddress
      ),
      dx: _loadContract(
        '@gnosis.pm/dx-contracts/contracts/DutchExchange.sol',
        'DutchExchange',
        await dxmm.methods.dx().call()
      )
    }

    return contracts
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
        // TODO(web3js@1.0.0-beta.46): Call functions with single named return value return an object
        // https://github.com/ethereum/web3.js/pull/2420
        auctionIndex[0]
      )
      .call()

    const buyAmount = await dxmm.methods
      .calculateAuctionBuyTokens(
        sellToken.options.address,
        buyToken.options.address,
        // TODO(web3js@1.0.0-beta.46): Call functions with single named return value return an object
        // https://github.com/ethereum/web3.js/pull/2420
        auctionIndex[0],
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

    // TODO(web3js@1.0.0-beta.46): Call functions with single named return value return an object
    // https://github.com/ethereum/web3.js/pull/2420
    return `#${auctionIndex[0]}: ${auctionState[state]}, price: ${priceStr(
      price
    )}, kyber: ${priceStr(kyberPrice)}, diff: ${(
      priceStr(price) - priceStr(kyberPrice)
    ).toFixed(10)}, act? ${shouldAct}`
  }

  const _prepareAuctionStates = async dxmm => {
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
    auctionState[await dxmm.methods.AUCTION_EXPIRED().call()] =
      'AUCTION_EXPIRED'

    return auctionState
  }

  // ------------------------------------------------
  //                      SETUP
  // ------------------------------------------------
  const contracts = await _loadContracts()

  const sellTokenSymbol = await contracts.sellToken.methods.symbol().call()
  const buyTokenSymbol = await contracts.buyToken.methods.symbol().call()
  // TODO(web3js@1.0.0-beta.46): Call functions with single named return value return an object
  // https://github.com/ethereum/web3.js/pull/2420
  _setupLogger(logTime, sellTokenSymbol[0], buyTokenSymbol[0])

  Object.entries(contracts).forEach(([key, value]) => {
    logger.verbose(`${key} address:\t${value.options.address}`)
  })
  const { dxmm, sellToken, buyToken, dx } = contracts

  const auctionState = await _prepareAuctionStates(dxmm)

  const account = web3.eth.accounts.privateKeyToAccount(PRIVATE)
  logger.info(`Running from account: ${account.address}`)

  setupSendTx({
    web3: web3,
    logger: logger,
    fromAddress: account.address,
    fromPrivate: account.privateKey,
    pollingTimeoutInSeconds: TX_TIMEOUT_SECONDS,
    txResendGasPriceFactor: txResendGasPriceFactor
  })

  // ------------------------------------------------
  //                  FLOW START
  // ------------------------------------------------
  let state = await dxmm.methods
    .getAuctionState(sellToken.options.address, buyToken.options.address)
    .call()
  logger.debug(`State is ${auctionState[state]}`)

  logger.info('Starting loop')
  let shouldAct

  while (true) {
    try {
      try {
        // TODO: New web3js versions cannot call() a state-changing function:
        // https://github.com/ethereum/web3.js/issues/2411
        let encoded = await dxmm.methods
          .step(sellToken.options.address, buyToken.options.address)
          .encodeABI()
        shouldAct = Boolean(
          Number(
            await web3.eth.call({
              to: dxmm.options.address,
              from: account.address,
              data: encoded
            })
          )
        )
        // shouldAct = await dxmm.methods
        // .step(sellToken.options.address, buyToken.options.address)
        // .call({ from: account.address })
      } catch (error) {
        logger.error(`error running step.call(): ${error}`)
        shouldAct = false
      }

      logger.info(await _prepareStatus(sellToken, buyToken, shouldAct))

      if (shouldAct) {
        await sendTxWithTimeout(
          dxmm.methods.step(
            sellToken.options.address,
            buyToken.options.address
          ),
          dxmm.options.address /* to */
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

      await sleepInSeconds(CYCLE_SLEEP_SECONDS)
    } catch (error) {
      logger.error(`Caught error during loop: ${error}`)
      await sleepInSeconds(CYCLE_SLEEP_SECONDS)
    }
  }
}

const runWithWeb3 = async (network, whatToRun) => {
  web3.setProvider(new Web3.providers.HttpProvider(_getNetworkURL(network)))
  web3.eth.transactionPollingTimeout = TX_TIMEOUT_SECONDS

  await whatToRun(web3)
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
        .option('txResendGasPriceFactor', {
          demandOption: false,
          default: DEFAULT_TX_RESEND_GAS_PRICE_FACTOR,
          describe:
            'When TX times out the TX is resent using previous gas price * this factor',
          type: 'number'
        })
        .option('st', {
          alias: 'sellToken',
          demandOption: true,
          describe: 'Sell token address',
          type: 'string'
        })
        .option('bt', {
          alias: 'buyToken',
          demandOption: true,
          describe: 'Buy token address',
          type: 'string'
        })
        .option('logTime', {
          demandOption: false,
          default: false,
          describe: 'Should logging contain timestamps',
          type: 'bool'
        })
    },
    async function(argv) {
      await runWithWeb3(argv.net, web3 => {
        _runMarketMaker(
          web3,
          argv.sellToken,
          argv.buyToken,
          argv.txResendGasPriceFactor,
          argv.logTime
        )
      })
    }
  )
  .help().argv

// TODO: add command for withdrawing balance from dx and dxmm
// 1 - claim
// 2 - dxmm.withdrawFromDx
// 3 - use withdrawable calls
