const fs = require('fs')
const Web3 = require('web3')
// TODO: maybe create web3 later?
const web3 = new Web3('http://')
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

const SLEEP_TIME = process.env.SLEEP_TIME || 10000

// TODO: Compile the contracts instead
const ERC20_COMPILED = 'build/contracts/ERC20WithSymbol.json'
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
    return new Promise(function(resolve, reject) {
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
            resolve(result)
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
  const account = (await web3.eth.getAccounts())[0]
  logger.info(`Running from account: ${account}`)

  // Signs and sends transactions.
  const sendTx = async (txObject, to, value = 0) => {
    logger.debug('Preparing transaction')
    const nonce = await web3.eth.getTransactionCount(account)
    const chainId = await web3.eth.net.getId()
    const txTo = to

    let gasLimit
    try {
      gasLimit = await txObject.estimateGas()
    } catch (e) {
      gasLimit = 1000 * 1000
      logger.debug(`estimateGas failed, using default limit (${gasLimit})`)
    }

    if (txTo !== null) {
      gasLimit = 500 * 1000
    }

    const txData = txObject.encodeABI()
    const txFrom = account

    const calcGasPrice = iteration => {
      // TODO: extract to settings
      const TX_RESEND_GAS_PRICE_FACTOR = 1.2

      return web3.utils
        .toBN(gasPriceGwei * TX_RESEND_GAS_PRICE_FACTOR ** iteration)
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
      return web3.eth.signTransaction(tx)
    }

    let iteration = 0
    let gasPrice

    // Returning a promise to make the the sending of the tx awaitable
    return new Promise(async (resolve, reject) => {
      try {
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
          .sendSignedTransaction(signedTx.raw, { from: account })
          .once('transactionHash', hash => {
            logger.debug(`onceTransactionHash hash: ${hash}`)
          })
          .once('receipt', receipt => {
            logger.debug(`onceReceipt receipt: ${str(receipt)}`)
          })
          // .on('confirmation', (confirmationNumber, receipt) => {
          //   logger.debug(
          //     `onConfirmation ConfirmationNumber: ${confirmationNumber}`
          //   )
          //   logger.debug(`onConfirmation Receipt: ${receipt}`)
          // })
          .on('error', error => {
            // confirmation timeout
            if (
              error.message.startsWith(
                'Timeout exceeded during the transaction confirmation process'
              )
            ) {
              logger.debug(`TX confirmation timout, try increasing gas price`)
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

  // Loads the contracts that the bot interacts with
  // TODO: compile the contracts as part of this script
  const _loadContracts = async () => {
    const _loadContract = (abiFilename, address) => {
      const abiFile = fs.readFileSync(abiFilename, { encoding: 'utf-8' })
      const abi = JSON.parse(abiFile)['abi']
      return new web3.eth.Contract(abi, address)
    }

    const dxmm = _loadContract(DXMM_COMPILED, DXMM_ADDRESS)

    logger.verbose('loading contracts')
    const contracts = {
      dxmm: dxmm,
      sellToken: _loadContract(ERC20_COMPILED, sellTokenAddress),
      buyToken: _loadContract(ERC20_COMPILED, buyTokenAddress),
      dx: _loadContract(DX_COMPILED, await dxmm.methods.dx().call())
    }
    Object.entries(contracts).forEach(([key, value]) => {
      logger.verbose(`${key} address:\t${value.options.address}`)
    })
    return contracts
  }
  const { dxmm, sellToken, buyToken, dx } = await _loadContracts()
  logger.info(
    `Handle ${await sellToken.methods
      .symbol()
      .call()} -> ${await buyToken.methods.symbol().call()}`
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
  auctionState[await dxmm.methods.AUCTION_EXPIRED().call()] = 'AUCTION_EXPIRED'

  // TODO: remove from script
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
      //     sellToken.methods.transfer(dxmm.options.address, missingTokensWithFee),
      //     dxmm.options.address
      //   )
      // }
    }
  }

  // TODO: remove from script
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
      // await sendTx(buyToken.methods.deposit(),
      // dxmm.options.address),
      // requiredBuyTokens /* value */,
      //
      // logger.verbose('Transfer WETH to dxmm')
      // await sendTx(
      //   buyToken.methods.transfer(dxmm.options.address, requiredBuyTokens), dxmm.options.address
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
    try {
      // logger.debug(
      // `step.call(${sellToken.options.address}, ${buyToken.options.address})`
      // )
      console.log(1)
      try {
        // TODO: New web3js versions cannot call() a state-changing function:
        // https://github.com/ethereum/web3.js/issues/2411
        // shouldAct = await dxmm.methods
        // .step(sellToken.options.address, buyToken.options.address)
        // .call({ from: account })
        let encoded = await dxmm.methods
          .step(sellToken.options.address, buyToken.options.address)
          .encodeABI()
        shouldAct = Boolean(
          Number(
            await web3.eth.call({
              to: dxmm.options.address,
              from: account,
              data: encoded
            })
          )
        )
      } catch (error) {
        console.log(`1.1 error: ${error}`)
      }

      console.log(2)
      logger.verbose(await _prepareStatus(sellToken, buyToken, shouldAct))

      console.log(3)
      // XXX
      // shouldAct = true
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
      await sleep(SLEEP_TIME)

      // XXX: only in development
      // XXX: making things go fast
      // await devNetworkWaitTimeInSeconds(60 * 60)
    } catch (error) {
      console.log(8)
      logger.error(`Caught error during loop: ${error}`)
      await sleep(SLEEP_TIME)
    }
  }
}

const runWithWeb3 = async (network, whatToRun) => {
  const provider = _getProvider(network, _getNetworkURL(network))
  web3.setProvider(provider)
  // TODO: extract transactionPollingTimeout as a configurable param
  web3.options = { transactionPollingTimeout: 1 }

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
          describe: 'Initial gas price in Gwei',
          type: 'number'
        })
        .option('maxGasPriceFactor', {
          demandOption: false,
          default: '2',
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
