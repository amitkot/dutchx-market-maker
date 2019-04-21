const { str } = require('./misc.js')

const DEFAULT_TX_RESEND_GAS_PRICE_FACTOR = 1.2

// The web3 instance to use
let web3

// A logger to write progress updates to
let logger

// The sending account address and private key
let fromAddress
let fromPrivate

// Every time the tx times out the previous gas price is multiplied by this value
let txResendGasPriceFactor

// web3@1.0.0-beta.46
const WEB3_ERRORS = {
  CONFIRMATION_TIMEOUT: 'Transaction was not mined within',
  TX_WITH_NONCE_ALREADY_CONFIRMED:
    'Node error: {"code":-32000,"message":"nonce too low"}',
  UNKNOWN_ERROR: '### Unknown error'
}

/// / web3@1.0.0-beta.51
// const WEB3_ERRORS = {
// CONFIRMATION_TIMEOUT: 'Timeout exceeded during the transaction confirmation process',
// TX_WITH_NONCE_ALREADY_CONFIRMED:
// "Error: the tx doesn't have the correct nonce.",
// UNKNOWN_ERROR: '### Unknown error'
// }

const decodeWeb3Error = errorMessage => {
  let state = WEB3_ERRORS.UNKNOWN_ERROR
  Object.entries(WEB3_ERRORS).forEach(([key, value]) => {
    if (errorMessage.startsWith(value)) {
      state = value
    }
  })
  return state
}

const createConsoleLogger = () => {
  return {
    debug: (...args) => console.log(args),
    info: (...args) => console.log(args),
    warn: (...args) => console.log(args),
    error: (...args) => console.log(args)
  }
}

const setup = options => {
  if (!options.web3) {
    throw new Error('sendTx setup error: Must provide web3 instance')
  }

  web3 = options.web3
  logger = options.logger || createConsoleLogger()
  fromAddress = options.fromAddress
  fromPrivate = options.fromPrivate
  txResendGasPriceFactor =
    options.txResendGasPriceFactor || DEFAULT_TX_RESEND_GAS_PRICE_FACTOR

  if (options.pollingTimeoutInSeconds) {
    web3.eth.transactionPollingTimeout = options.pollingTimeoutInSeconds
  }
}

const sendTxWithTimeout = async (txObject, to, value = 0) => {
  logger.debug('Preparing transaction')
  const data = txObject.encodeABI()
  const nonce = await web3.eth.getTransactionCount(fromAddress)
  const chainId = await web3.eth.net.getId()

  let gasLimit
  try {
    gasLimit = await txObject.estimateGas({ from: fromAddress, value: value })
    logger.debug(`estimated gas calculated: ${gasLimit}`)
    gasLimit *= 1.2
    gasLimit -= gasLimit % 1
  } catch (e) {
    gasLimit = 500 * 1000
    logger.debug(`estimateGas failed: ${e}, using default limit (${gasLimit})`)
  }

  const initialGasPrice = await web3.eth.getGasPrice()
  logger.debug(`initial gas price is ${initialGasPrice}`)

  const calcGasPrice = iteration => {
    let price = initialGasPrice * txResendGasPriceFactor ** iteration
    price -= price % 1
    return price
  }

  const prepareSignedTx = async gasPrice => {
    const tx = {
      from: fromAddress,
      to: to,
      nonce: nonce,
      data: data,
      value: value,
      gas: gasLimit,
      chainId: chainId,
      gasPrice: gasPrice
    }
    logger.debug(`tx: ${str(tx)}`)
    return web3.eth.accounts.signTransaction(tx, fromPrivate)
  }

  // Returning a promise to make the the sending of the tx awaitable
  const trySendingTx = iteration => {
    return new Promise(async (resolve, reject) => {
      try {
        // TODO: reject if gasPrice too high
        const gasPrice = calcGasPrice(iteration)

        logger.debug(`gasPrice is ${gasPrice}`)

        const signedTx = await prepareSignedTx(gasPrice)
        logger.debug(`signed tx: ${str(signedTx)}`)

        web3.eth
          .sendSignedTransaction(signedTx.rawTransaction)
          .once('transactionHash', hash => {
            logger.verbose(`sent tx: ${hash}`)
          })
          .once('receipt', receipt => {
            logger.verbose(`tx receipt: ${str(receipt)}`)
          })
          .on('confirmation', (confirmationNumber, receipt) => {
            logger.debug(
              `tx confirmation for iteration ${iteration}, confirmation ${confirmationNumber}`
            )
            // Spammy
            // logger.debug(`onConfirmation Receipt: ${str(receipt)}`)
          })
          .then(receipt => {
            logger.debug(`then called with receipt: ${str(receipt)}`)
            logger.debug('done sending tx')
            resolve(receipt)
          })
          .catch(error => {
            // if (decodeWeb3Error(error.message) === WEB3_ERRORS.UNKNOWN_ERROR) {
            // logger.warn(`caught during sendSignedTransaction: "${error}"`)
            // }
            const state = decodeWeb3Error(error.message)
            if (state === WEB3_ERRORS.CONFIRMATION_TIMEOUT) {
              // confirmation timeout
              logger.debug(
                `TX confirmation timeout (iteration ${iteration}), increasing gas price`
              )
              resolve(trySendingTx(++iteration))
            } else if (state === WEB3_ERRORS.TX_WITH_NONCE_ALREADY_CONFIRMED) {
              // previous tx already confirmed so nonce no longer available
              logger.debug('Tx with this nonce already confirmed')
              // TODO: return the receipt for the confirmed tx
              resolve()
            } else {
              logger.error(
                `catch during sendSignedTransaction: "${error}", returning`
              )
              reject(error)
            }
          })
      } catch (error) {
        if (decodeWeb3Error(error.message) === WEB3_ERRORS.UNKNOWN_ERROR) {
          logger.error(`Error during sendTx: "${error}", returning`)
          reject(error)
        }
      }
    })
  }

  return trySendingTx(0 /* iteration */)
}

module.exports = { setupSendTx: setup, sendTxWithTimeout }
