const { sleepInSeconds, str } = require('./util/misc.js')
const { compileSources } = require('./util/compile_contracts.js')

const fs = require('fs')
const Web3 = require('web3')
// TODO: maybe create the web3 instance later?
const web3 = new Web3('http://')
const yargs = require('yargs')
const winston = require('winston')

// Setup environment variables from .env file
require('dotenv').config()

// Defaults
const DEFAULT_TX_TIMEOUT_SECONDS = 15
const DEFAULT_CYCLE_SLEEP_SECONDS = 10

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

const _setupLogger = (sellToken, buyToken) => {
  logger = winston.createLogger({
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.cli(),
      winston.format.label({ label: `${sellToken}->${buyToken}` }),
      winston.format.printf(({ level, message, label, timestamp }) => {
        return `${timestamp} [${label}] ${level}: ${message}`
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
  gasPriceGwei,
  maxGasPriceFactor
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

    const sellTokenSymbol = await contracts.sellToken.methods.symbol().call()
    const buyTokenSymbol = await contracts.buyToken.methods.symbol().call()
    // TODO(web3js@1.0.0-beta.46): Call functions with single named return value return an object
    _setupLogger(sellTokenSymbol[0], buyTokenSymbol[0])

    Object.entries(contracts).forEach(([key, value]) => {
      logger.verbose(`${key} address:\t${value.options.address}`)
    })
    return contracts
  }

  const { dxmm, sellToken, buyToken, dx } = await _loadContracts()

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
  auctionState[await dxmm.methods.AUCTION_EXPIRED().call()] = 'AUCTION_EXPIRED'

  const account = web3.eth.accounts.privateKeyToAccount(PRIVATE)
  logger.info(`Running from account: ${account.address}`)

  // Signs and sends transactions.
  const sendTx = async (txObject, to, value = 0) => {
    logger.debug('Preparing transaction')
    const nonce = await web3.eth.getTransactionCount(account.address)
    const chainId = await web3.eth.net.getId()
    const txTo = to

    let gasLimit
    try {
      gasLimit = await txObject.estimateGas()
    } catch (e) {
      gasLimit = 500 * 1000
      logger.debug(
        `estimateGas failed: ${e}, using default limit (${gasLimit})`
      )
    }

    const txData = txObject.encodeABI()
    const txFrom = account.address

    const calcGasPrice = iteration => {
      // TODO: extract to settings
      const TX_RESEND_GAS_PRICE_FACTOR = 1.2

      let price = gasPriceGwei * TX_RESEND_GAS_PRICE_FACTOR ** iteration
      price -= price % 1
      // XXX
      return web3.utils
        .toBN(price)
        .mul(web3.utils.toBN(10 ** 9))
        .toNumber()
    }

    const prepareSignedTx = async gasPrice => {
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
      return web3.eth.accounts.signTransaction(
        tx,
        account.privateKey /* privateKey */
      )
    }

    let iteration = 0
    let gasPrice

    // Returning a promise to make the the sending of the tx awaitable
    return new Promise(async (resolve, reject) => {
      try {
        // TODO:Raise gas price each time send timeout is reached
        gasPrice = calcGasPrice(iteration)
        if (gasPrice > maxGasPriceFactor * gasPriceGwei * 10 ** 9) {
          // Cannot increase gas price any more
          const msg = 'Cannot increase gas price any more'
          logger.warning(msg)
          reject(msg)
        }

        logger.debug(`gasPrice is ${gasPrice}`)

        const signedTx = await prepareSignedTx(gasPrice)
        logger.debug(`signed tx: ${str(signedTx)}`)

        web3.eth
          .sendSignedTransaction(signedTx.rawTransaction)
          .once('transactionHash', hash => {
            logger.debug(`onceTransactionHash hash: ${hash}`)
          })
          .once('receipt', receipt => {
            logger.debug(`onceReceipt receipt: ${str(receipt)}`)
          })
          // XXX spamming?
          .on('confirmation', (confirmationNumber, receipt) => {
            logger.debug(
              `onConfirmation ConfirmationNumber: ${confirmationNumber}`
            )
            logger.debug(`onConfirmation Receipt: ${receipt.status}`)
          })
          .on('error', error => {
            // confirmation timeout
            if (
              error.message.startsWith(
                'Timeout exceeded during the transaction confirmation process'
              )
            ) {
              logger.debug(`TX confirmation timeout, try increasing gas price`)
              iteration++
              // previous tx already confirmed so nonce no longer available
            } else if (
              error.message.startsWith(
                "Error: the tx doesn't have the correct nonce."
              )
            ) {
              logger.debug(
                'Previously sent tx with this nonce already confirmed'
              )
            } else {
              logger.error(
                `onError during sendSignedTransaction: "${error}", returning`
              )
              reject(error)
            }
          })
          .then(receipt => {
            logger.debug(`then called with receipt: ${str(receipt)}`)
            logger.debug('done sending tx')
            resolve(receipt)
          })
      } catch (error) {
        logger.error(`Error during sendTx: "${error}", returning`)
        reject(error)
      }
    })
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
        auctionIndex[0]
      )
      .call()

    const buyAmount = await dxmm.methods
      .calculateAuctionBuyTokens(
        sellToken.options.address,
        buyToken.options.address,
        // TODO(web3js@1.0.0-beta.46): Call functions with single named return value return an object
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

  logger.info('Starting loop')
  let shouldAct

  while (true) {
    try {
      console.log(1)
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
        console.log(`1.1 error: ${error}`)
        shouldAct = false
      }

      console.log(2)
      logger.verbose(await _prepareStatus(sellToken, buyToken, shouldAct))

      console.log(3)
      // XXX
      shouldAct = true
      if (shouldAct) {
        console.log(4)
        await sendTx(
          dxmm.methods.step(
            sellToken.options.address,
            buyToken.options.address
          ),
          dxmm.options.address /* to */
        )

        console.log(5)
        state = await dxmm.methods
          .getAuctionState(sellToken.options.address, buyToken.options.address)
          .call()

        console.log(6)
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

      console.log(7)
      await sleepInSeconds(CYCLE_SLEEP_SECONDS)
    } catch (error) {
      console.log(8)
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
        .option('gasPriceGwei', {
          demandOption: false,
          default: '5',
          describe: 'Initial gas price in Gwei',
          type: 'number'
        })
        .option('maxGasPriceFactor', {
          demandOption: false,
          default: '10',
          describe:
            'Maximum factor for increased gas price (e.g. for initial 5 Gwei + factor 2 -> max is 10 Gwei)',
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
    },
    async function(argv) {
      await runWithWeb3(argv.net, web3 => {
        _runMarketMaker(
          web3,
          argv.sellToken,
          argv.buyToken,
          argv.gasPriceGwei,
          argv.maxGasPriceFactor
        )
      })
    }
  )
  .help().argv

// TODO: add command for withdrawing balance from dx and dxmm
// 1 - claim
// 2 - dxmm.withdrawFromDx
// 3 - use withdrawable calls

// TODO: add command for transfering tokens to dxmm
