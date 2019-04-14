require('web3')

const Helper = require('./helper.js')

const BN = web3.utils.BN

const util = require('util')

// TODO: These changes do not influence the BN class that web3 returns. Why?
// TODO: Extract to util class
// Find Ceil(`this` / `num`)
BN.prototype.divCeil = function divCeil(num) {
  let dm = this.divmod(num)

  // Fast case - exact division
  if (dm.mod.isZero()) return dm.div

  // Round up
  return dm.div.negative !== 0 ? dm.div.isubn(1) : dm.div.iaddn(1)
}

// Change BN toString to use base 10
BN.prototype.inspect = function inspect() {
  return (this.red ? '<BN-R: ' : '<BN: ') + this.toString(10) + '>'
}

require('chai')
  .use(require('bn-chai')(BN))
  // TODO: this chai-as-promised doesn't seem to work with bn-chai, open a bug
  // Install last to promisify all registered asserters
  // .use(require("chai-as-promised"))
  .should()

const truffleAssert = require('truffle-assertions')

const DutchExchange = artifacts.require('DutchExchange')
const PriceOracleInterface = artifacts.require('PriceOracleInterface')
const TestingKyberDxMarketMaker = artifacts.require('TestingKyberDxMarketMaker')
const TestToken = artifacts.require('TestToken')
const EtherToken = artifacts.require('EtherToken')
const MockKyberNetworkProxy = artifacts.require('MockKyberNetworkProxy')

let tokenDeployedIndex = 0

let DEBUG = false

const ETH_TOKEN_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

let weth
let dx
let dxmm
let kyberNetworkProxy

let admin
let seller1
let buyer1
let user
let operator
let lister
let bank

let DX_AUCTION_START_WAITING_FOR_FUNDING
let WAITING_FOR_FUNDING
let WAITING_FOR_OPP_FUNDING
let WAITING_FOR_SCHEDULED_AUCTION
let AUCTION_IN_PROGRESS
let WAITING_FOR_OPP_TO_FINISH
let AUCTION_EXPIRED

contract('TestingKyberDxMarketMaker', async accounts => {
  const deployToken = async () => {
    const token = await TestToken.new(
      'Some Token',
      'KNC' + tokenDeployedIndex++,
      18,
      { from: bank }
    )
    dbg(`Deployed token number ${tokenDeployedIndex} at ${token.address}`)
    await kyberNetworkProxy.setRate(token.address, 1337000000000000)
    return token
  }

  const deployTokenVarialbeDecimals = async decimals => {
    const token = await TestToken.new(
      'Some Token',
      'KNC' + tokenDeployedIndex++,
      decimals,
      { from: bank }
    )
    dbg(
      `Deployed token number ${tokenDeployedIndex} with ${decimals} decimals at ${
        token.address
      }`
    )
    return token
  }

  const calculateRemainingBuyVolume = async (
    sellToken,
    buyToken,
    auctionIndex
  ) => {
    const sellVolume = await dx.sellVolumesCurrent.call(
      sellToken.address,
      buyToken.address
    )
    const buyVolume = await dx.buyVolumes.call(
      sellToken.address,
      buyToken.address
    )
    const price = await dx.getCurrentAuctionPrice.call(
      sellToken.address,
      buyToken.address,
      auctionIndex
    )
    // Auction index is in the future.
    if (price.den.eqn(0)) return 0

    return sellVolume
      .mul(price.num)
      .div(price.den)
      .sub(buyVolume)
  }

  const buyAuctionTokens = async (
    token,
    auctionIndex,
    amount,
    buyer,
    addFee
  ) => {
    if (addFee) {
      amount = await dxmm.addFee(amount)
    }
    await weth.deposit({ from: bank, value: amount })
    await weth.transfer(buyer, amount, { from: bank })
    await weth.approve(dx.address, amount, { from: buyer })
    await dx.deposit(weth.address, amount, { from: buyer })
    await dx.postBuyOrder(
      token.address /* sellToken */,
      weth.address /* buyToken */,
      auctionIndex,
      amount,
      { from: buyer }
    )
  }

  const sellTokens = async (token, amount, seller) => {
    const tokenSellAmount = await dxmm.addFee(amount)
    if (token === weth) {
      await weth.deposit({ value: amount, from: bank })
    }
    await token.transfer(seller, tokenSellAmount, { from: bank })
    await token.approve(dx.address, tokenSellAmount, { from: seller })
    await dx.depositAndSell(token.address, weth.address, tokenSellAmount, {
      from: seller
    })
  }

  const dbgVolumesAndPrices = async (st, bt, auctionIndex) => {
    const stSymbol = await st.symbol()
    const btSymbol = await bt.symbol()
    dbg(`... ST: ${stSymbol}, BT: ${btSymbol}`)
    const sellVolume = await dx.sellVolumesCurrent(st.address, bt.address)
    const buyVolume = await dx.buyVolumes(st.address, bt.address)
    const price = await dx.getCurrentAuctionPrice(
      st.address,
      bt.address,
      auctionIndex
    )
    let remainingSellVolume = 0
    if (!price.den.eqn(0)) {
      remainingSellVolume = sellVolume.sub(
        buyVolume.mul(price.num).div(price.den)
      )
    }
    const remainingBuyVolume = await calculateRemainingBuyVolume(
      st,
      bt,
      auctionIndex
    )

    dbg(`...... sellVolumesCurrent: ${sellVolume} ${stSymbol}`)
    dbg(`...... buyVolumes: ${buyVolume} ${btSymbol}`)
    dbg(`...... price ${stSymbol}/${btSymbol} is ${price.num}/${price.den}`)
    dbg(`...... remaining SELL tokens: ${remainingSellVolume} ${stSymbol}`)
    dbg(`...... remaining BUY tokens: ${remainingBuyVolume} ${btSymbol}`)
  }

  async function deployTokenAddToDxAndClearFirstAuction() {
    const initialWethWei = web3.utils.toWei(new BN(100))
    const knc = await deployToken()
    const kncSymbol = await knc.symbol()
    dbg(`======================================`)
    dbg(`= Start initializing ${kncSymbol}`)
    dbg(`======================================`)
    dbg(`\n--- deployed ${kncSymbol}`)

    await weth.deposit({
      value: web3.utils.toWei(new BN(10000)),
      from: lister
    })
    dbg(`\n--- prepared lister funds`)
    dbg(`lister has ${await weth.balanceOf(lister)} WETH`)
    dbg(`lister has ${await knc.balanceOf(lister)} ${kncSymbol}`)

    await weth.approve(dx.address, initialWethWei, { from: lister })
    await dx.deposit(weth.address, initialWethWei, { from: lister })
    dbg(`\n--- lister deposited ${initialWethWei} WETH in DX`)

    // Using 0 amount as mock kyber contract returns fixed rate anyway.
    const kyberRate = await dxmm.getKyberRate(knc.address, weth.address, 0)

    // 1 - dividing by 1000 to avoid reverts due to overflow
    // 2 - reduce price to have listed token in Kyber price (auction starts at x2
    //     and we close immediately)
    const initialClosingPriceNum = kyberRate.num.divn(1000).divn(2)
    const initialClosingPriceDen = kyberRate.den.divn(1000)
    dbg(
      `initial rate is knc => weth is ${initialClosingPriceNum} / ${initialClosingPriceDen}`
    )
    dbg(`thresholdNewTokenPair is ${await dx.thresholdNewTokenPair()}`)
    dbg(
      `calling dx.addTokenPair(${weth.address}, ${
        knc.address
      }, ${initialWethWei}, 0, ${initialClosingPriceDen}, ${initialClosingPriceNum})`
    )
    await dx.addTokenPair(
      weth.address,
      knc.address,
      initialWethWei,
      0,
      initialClosingPriceNum,
      initialClosingPriceDen,
      { from: lister }
    )
    dbg(`\n--- lister added ${kncSymbol} to DX`)

    const auctionIndex = await dx.getAuctionIndex(weth.address, knc.address)
    dbg(`auctionIndex is ${auctionIndex}`)
    await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

    dbg(`\n--- lister wants to buy it all`)
    const fee = await dx.getFeeRatio(lister)
    dbg(`fee is ${fee.num}/${fee.den}`)
    await dbgVolumesAndPrices(weth, knc, auctionIndex)
    const remainingBuyVolume = await calculateRemainingBuyVolume(
      weth,
      knc,
      auctionIndex
    )
    dbg(`remaining buy volume in ${kncSymbol} is ${remainingBuyVolume}`)
    // TODO: no fees if closing the auction??
    // const buyAmount = await addFee(remainingBuyVolume)
    const buyAmount = remainingBuyVolume
    dbg(`lister will buy using ${buyAmount} ${kncSymbol}`)

    await knc.transfer(lister, buyAmount, { from: bank })
    await knc.approve(dx.address, buyAmount, { from: lister })
    await dx.deposit(knc.address, buyAmount, { from: lister })
    dbg(`\n--- lister deposited ${buyAmount} ${kncSymbol}`)

    dbg(`+++ current lister balance:`)
    dbg(`   lister WETH balance is ${await dx.balances(weth.address, lister)}`)
    dbg(`   lister KNC balance is ${await dx.balances(knc.address, lister)}`)

    await dx.postBuyOrder(weth.address, knc.address, auctionIndex, buyAmount, {
      from: lister
    })
    dbg(`\n--- lister bought using ${buyAmount} ${kncSymbol}`)
    dbg(`\n--- remaining:`)
    await dbgVolumesAndPrices(weth, knc, auctionIndex)
    await dbgVolumesAndPrices(knc, weth, auctionIndex)

    const currentAuctionIndex = await dx.getAuctionIndex(
      weth.address,
      knc.address
    )
    dbg(`\n--- is auction still open? ${currentAuctionIndex.eq(auctionIndex)}`)

    dbg(`+++ current lister balance:`)
    dbg(`   lister WETH balance is ${await dx.balances(weth.address, lister)}`)
    dbg(`   lister KNC balance is ${await dx.balances(knc.address, lister)}`)

    dbg(
      `current auctionIndex(knc, weth) is ${await dx.getAuctionIndex(
        weth.address,
        knc.address
      )}`
    )
    dbg(`my auctionIndex is ${auctionIndex}`)
    dbg(
      `sellerBalance is ${await dx.sellerBalances(
        weth.address,
        knc.address,
        auctionIndex,
        lister
      )}`
    )
    const closingPrice = await dx.closingPrices(
      weth.address,
      knc.address,
      auctionIndex
    )
    dbg(`closingPrice is ${closingPrice.num} / ${closingPrice.den}`)
    const sellerClaim = await dx.claimSellerFunds.call(
      weth.address,
      knc.address,
      lister,
      auctionIndex,
      { from: lister }
    )
    await dx.claimSellerFunds(weth.address, knc.address, lister, auctionIndex, {
      from: lister
    })
    dbg(`\n--- lister claimed seller funds`)
    dbg(`claimed funds S:weth, B:knc: ${sellerClaim.returned}`)

    const buyerClaim1 = await dx.claimBuyerFunds.call(
      weth.address,
      knc.address,
      lister,
      auctionIndex,
      { from: lister }
    )
    await dx.claimBuyerFunds(weth.address, knc.address, lister, auctionIndex, {
      from: lister
    })
    dbg(`\n--- lister claimed buyer funds`)
    dbg(`claimed funds S:weth, B:knc: ${buyerClaim1.returned}`)

    const buyerClaim2 = await dx.claimBuyerFunds.call(
      knc.address,
      weth.address,
      lister,
      auctionIndex,
      { from: lister }
    )
    await dx.claimBuyerFunds(knc.address, weth.address, lister, auctionIndex, {
      from: lister
    })
    dbg(`claimed funds S:knc, B:weth: ${buyerClaim2.returned}`)

    const listerWethBalance = await dx.balances(weth.address, lister)
    const listerKncBalance = await dx.balances(knc.address, lister)
    dbg(`+++ current lister balance:`)
    dbg(`   lister DX WETH balance is ${listerWethBalance}`)
    dbg(`   lister DX KNC balance is ${listerKncBalance}`)
    dbg(`   lister WETH balance is ${await weth.balanceOf(lister)}`)
    dbg(`   lister KNC balance is ${await knc.balanceOf(lister)}`)

    await dx.withdraw(weth.address, listerWethBalance, { from: lister })
    await dx.withdraw(knc.address, listerKncBalance, { from: lister })
    dbg(`--- lister withdrew WETH and KNC balances`)
    dbg(`+++ current lister balance:`)
    dbg(
      `   lister DX WETH balance is ${await dx.balances(weth.address, lister)}`
    )
    dbg(`   lister DX KNC balance is ${await dx.balances(knc.address, lister)}`)
    dbg(`   lister WETH balance is ${await weth.balanceOf(lister)}`)
    dbg(`   lister KNC balance is ${await knc.balanceOf(lister)}`)

    dbg(`======================================`)
    dbg(`= Finished initializing ${kncSymbol}`)
    dbg(`======================================`)
    return knc
  }

  const fundDespositSell = async (sellToken, buyToken, seller) => {
    const sellTokenSymbol = await sellToken.symbol()
    const buyTokenSymbol = await buyToken.symbol()
    dbg(`--- fundDepositSell(${sellTokenSymbol}, ${buyTokenSymbol})`)
    let tokenSellAmount = await dxmm.calculateMissingTokenForAuctionStart(
      sellToken.address,
      buyToken.address
    )
    dbg(`Missing amount without fee: ${tokenSellAmount}`)
    tokenSellAmount = await dxmm.addFee(tokenSellAmount)
    dbg(`Missing amount with fee: ${tokenSellAmount}`)

    if (sellToken === weth) {
      await sellToken.deposit({ value: tokenSellAmount, from: bank })
    }

    await sellToken.transfer(seller, tokenSellAmount, { from: bank })
    dbg(
      `--- seller now has ${await sellToken.balanceOf(
        seller
      )} ${sellTokenSymbol}`
    )

    await sellToken.approve(dx.address, tokenSellAmount, { from: seller })
    let res = await dx.depositAndSell.call(
      sellToken.address,
      buyToken.address,
      tokenSellAmount,
      { from: seller }
    )
    await dx.depositAndSell(
      sellToken.address,
      buyToken.address,
      tokenSellAmount,
      {
        from: seller
      }
    )
    dbg(
      `--- seller called depositAndSell(${sellTokenSymbol}, ${buyTokenSymbol}): newBal: ${
        res.newBal
      }, auctionIndex: ${res.auctionIndex}, newSellerBal: ${res.newSellerBal}`
    )
    dbg(
      `seller DX ${sellTokenSymbol} balance is ${await dx.balances(
        sellToken.address,
        seller
      )}`
    )

    dbg(
      `Missing funding : ${await dxmm.calculateMissingTokenForAuctionStart(
        sellToken.address,
        buyToken.address
      )}`
    )

    await dbgVolumesAndPrices(
      sellToken,
      buyToken,
      await dx.getAuctionIndex(sellToken.address, buyToken.address)
    )
  }

  const triggerAuction = async (sellToken, buyToken, seller) => {
    await fundDespositSell(sellToken, buyToken, seller)
    await fundDespositSell(buyToken, sellToken, seller)

    const nextAuctionStart = await dx.getAuctionStart(
      sellToken.address,
      buyToken.address
    )
    dbg(`next auction starts at ${nextAuctionStart}`)
    nextAuctionStart.should.not.be.eq.BN(1)

    return dx.getAuctionIndex(sellToken.address, buyToken.address)
  }

  const waitForTriggeredAuctionToStart = async (
    sellToken,
    buyToken,
    auctionIndex
  ) => {
    const timeNow = await blockChainTime()
    const auctionStartTime = await dx.getAuctionStart(
      sellToken.address,
      buyToken.address
    )
    const secondsToWait = auctionStartTime - timeNow
    dbg(`time now is ${timeNow}`)
    dbg(
      `next auction starts at ${auctionStartTime} (in ${secondsToWait} seconds)`
    )

    await waitTimeInSeconds(secondsToWait)
    dbg(`\n--- waited ${secondsToWait / 60} minutes until auction started`)
    dbg(`time now is ${await blockChainTime()}`)
    await dbgVolumesAndPrices(sellToken, buyToken, auctionIndex)
  }

  const waitUntilKyberPriceReached = async (
    sellToken,
    buyToken,
    auctionIndex,
    buyAmount
  ) => {
    let price
    let kyberPrice
    while (true) {
      price = await dx.getCurrentAuctionPrice(
        sellToken.address,
        buyToken.address,
        auctionIndex
      )
      const t = await blockChainTime()
      // Paying with buyToken to get sellToken
      kyberPrice = await dxmm.getKyberRate(
        buyToken.address /* srcToken */,
        sellToken.address /* destToken */,
        buyAmount
      )
      const a = price.num.mul(kyberPrice.den)
      const b = kyberPrice.num.mul(price.den)
      if (a <= b) {
        dbg(`... at ${t} price is ${price.num / price.den} -> Done waiting!`)
        break
      }

      const targetRate = kyberPrice.num / kyberPrice.den
      dbg(
        `... at ${t} price is ${price.num /
          price.den} (target: ${targetRate})-> waiting 10 minutes.`
      )
      await waitTimeInSeconds(10 * 60)
    }
  }

  const buyEverythingInAuctionDirection = async (
    sellToken,
    buyToken,
    auctionIndex,
    buyer
  ) => {
    dbg(
      `\nBEFORE BUYING EVERYTHING (${await sellToken.symbol()} -> ${await buyToken.symbol()})`
    )
    await dbgVolumesAndPrices(sellToken, buyToken, auctionIndex)
    const remainingBuyVolume = await calculateRemainingBuyVolume(
      sellToken,
      buyToken,
      auctionIndex
    )
    dbg('remainingBuyVolume:', remainingBuyVolume.toString())
    let shouldBuyVolume = remainingBuyVolume.addn(1)
    dbg('shouldBuyVolume:', shouldBuyVolume.toString())

    if (buyToken === weth) {
      await buyToken.deposit({ value: shouldBuyVolume, from: bank })
    }
    // TODO: maybe fund buyer in a better point in the code
    await buyToken.transfer(buyer, shouldBuyVolume, { from: bank })
    await buyToken.approve(dx.address, shouldBuyVolume, { from: buyer })
    await dx.deposit(buyToken.address, shouldBuyVolume, { from: buyer })
    const symbol = await buyToken.symbol()
    dbg(`buyer deposited ${symbol} to DX`)
    dbg(
      `buyer DX ${symbol} balance is ${await dx.balances(
        buyToken.address,
        buyer
      )}`
    )

    await dx.postBuyOrder(
      sellToken.address,
      buyToken.address,
      auctionIndex,
      shouldBuyVolume,
      { from: buyer }
    )
    dbg(
      `AFTER BUYING EVERYTHING (${await sellToken.symbol()} -> ${await buyToken.symbol()})`
    )
    await dbgVolumesAndPrices(sellToken, buyToken, auctionIndex)
  }

  const triggerAndClearAuction = async (sellToken, buyToken, user) => {
    // TODO: pass buyToken to helper functions
    dbg(`\n--- Triggerring and clearing new auction`)
    const auctionIndex = await triggerAuction(sellToken, buyToken, user)
    await waitForTriggeredAuctionToStart(sellToken, buyToken, auctionIndex)
    await buyEverythingInAuctionDirection(
      sellToken,
      buyToken,
      auctionIndex,
      user
    )
    await buyEverythingInAuctionDirection(
      buyToken,
      sellToken,
      auctionIndex,
      user
    )

    const state = await dxmm.getAuctionState(
      sellToken.address,
      buyToken.address
    )
    state.should.be.eq.BN(WAITING_FOR_FUNDING)
  }

  const dxmmFundDepositTriggerBothSides = async (sellToken, buyToken) => {
    // trigger: sellToken -> buyToken
    await fundDxmmAndDepositToDx(sellToken)
    await dxmm.testFundAuctionDirection(sellToken.address, buyToken.address)

    // trigger: buyToken -> sellToken
    await fundDxmmAndDepositToDx(buyToken)
    await dxmm.testFundAuctionDirection(buyToken.address, sellToken.address)
  }

  const dxmmTriggerAndClearAuction = async (sellToken, buyToken) => {
    await dxmmFundDepositTriggerBothSides(sellToken, buyToken)

    const auctionIndex = await dx.getAuctionIndex(
      sellToken.address,
      buyToken.address
    )

    await waitForTriggeredAuctionToStart(sellToken, buyToken, auctionIndex)

    // buy: sell -> buy
    await fundDxmmAndDepositToDxToBuyInAuction(
      sellToken,
      buyToken,
      auctionIndex
    )
    await dxmm.testBuyInAuction(sellToken.address, buyToken.address)

    // buy: buy -> sell
    await fundDxmmAndDepositToDxToBuyInAuction(
      buyToken,
      sellToken,
      auctionIndex
    )
    await dxmm.testBuyInAuction(buyToken.address, sellToken.address)

    return auctionIndex
  }

  const fundDxmmAndDepositToDx = async (token, amount = null) => {
    if (amount === null) {
      amount = web3.utils.toWei(new BN(100000))
    }
    dbg(
      `Funding dxmm with ${amount} ${await token.symbol.call()} and depositing to DX`
    )
    if (token === weth) {
      await weth.deposit({ value: amount, from: bank })
    }
    await token.transfer(dxmm.address, amount, { from: bank })
    await dxmm.depositToDx(token.address, amount, { from: operator })
  }

  const fundDxmmAndDepositToDxToBuyInAuction = async (
    sellToken,
    buyToken,
    auctionIndex
  ) => {
    // This is more buyToken than will eventually be required as the rate
    // improves block by block and we waste a couple of blocks in These
    // deposits
    const tokenWeiToBuy = await dxmm.calculateAuctionBuyTokens(
      sellToken.address,
      buyToken.address,
      auctionIndex,
      dxmm.address
    )
    await fundDxmmAndDepositToDx(buyToken, tokenWeiToBuy)
  }

  // Calculate expected buy volume based on sell volume and current price
  const calculateBuyVolumeForSellVolume = async (
    sellToken,
    buyToken,
    sellVolume,
    auctionIndex
  ) => {
    const buyVolume = await dx.buyVolumes.call(
      sellToken.address,
      buyToken.address
    )
    const price = await dx.getCurrentAuctionPrice.call(
      sellToken.address,
      buyToken.address,
      auctionIndex
    )
    return sellVolume
      .mul(price.num)
      .div(price.den)
      .sub(buyVolume)
  }

  before('setup accounts', async () => {
    admin = accounts[1]
    user = accounts[2]
    seller1 = accounts[3]
    buyer1 = accounts[4]
    operator = accounts[5]
    lister = accounts[6]
    bank = accounts[7]

    weth = await EtherToken.deployed()
    dxmm = await TestingKyberDxMarketMaker.deployed()
    dx = await DutchExchange.at(await dxmm.dx())
    kyberNetworkProxy = await MockKyberNetworkProxy.at(
      await dxmm.kyberNetworkProxy()
    )

    await dxmm.addOperator(operator, { from: admin })

    WAITING_FOR_FUNDING = await dxmm.WAITING_FOR_FUNDING()
    WAITING_FOR_OPP_FUNDING = await dxmm.WAITING_FOR_OPP_FUNDING()
    WAITING_FOR_SCHEDULED_AUCTION = await dxmm.WAITING_FOR_SCHEDULED_AUCTION()
    AUCTION_IN_PROGRESS = await dxmm.AUCTION_IN_PROGRESS()
    WAITING_FOR_OPP_TO_FINISH = await dxmm.WAITING_FOR_OPP_TO_FINISH()
    AUCTION_EXPIRED = await dxmm.AUCTION_EXPIRED()

    DX_AUCTION_START_WAITING_FOR_FUNDING = await dxmm.DX_AUCTION_START_WAITING_FOR_FUNDING()
  })

  it('admin should deploy token, add to dx, and conclude the first auction', async () => {
    const knc = await deployTokenAddToDxAndClearFirstAuction()

    const nextAuctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
    nextAuctionIndex.should.be.eq.BN(2)
  })

  it('seller can sell KNC and buyer can buy it', async () => {
    const knc = await deployTokenAddToDxAndClearFirstAuction()

    const auctionIndex = await triggerAuction(knc, weth, seller1)
    await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

    // now check if buyer wants to buyAmount
    dbg(`\n--- buyer checks prices`)
    dbg(`buyer wants to buy and will wait for target price`)

    // TODO: use actual amount
    await waitUntilKyberPriceReached(knc, weth, auctionIndex, 10000)

    // Buyer buys everything
    await buyEverythingInAuctionDirection(knc, weth, auctionIndex, buyer1)
    await buyEverythingInAuctionDirection(weth, knc, auctionIndex, buyer1)

    dbg(`\n--- buyer bought everything`)
    await dbgVolumesAndPrices(knc, weth, auctionIndex)
    dbg(`buyer DX WETH balance is ${await dx.balances(weth.address, buyer1)}`)
    const currentAuctionIndex = await dx.getAuctionIndex(
      knc.address,
      weth.address
    )

    dbg(`is auction still open? ${currentAuctionIndex.eq(auctionIndex)}`)
    currentAuctionIndex.should.not.eq.BN(auctionIndex)

    const buyerClaim = async (sellToken, buyToken) => {
      dbg(
        `dx.claimBuyerFunds(${sellToken.address}, ${
          buyToken.address
        }, ${buyer1}, ${auctionIndex})`
      )
      await dx.claimBuyerFunds(
        sellToken.address,
        buyToken.address,
        buyer1,
        auctionIndex,
        {
          from: buyer1
        }
      )
      const symbol = await sellToken.symbol()
      const sellBalance = await dx.balances(sellToken.address, buyer1)
      dbg(
        `\n--- buyer claimed the ${symbol}, their DX balance is ${sellBalance}`
      )

      await dx.withdraw(sellToken.address, sellBalance, { from: buyer1 })
      dbg(`\n--- buyer withdrew all of the ${symbol}`)
    }
    await buyerClaim(knc, weth)
    await buyerClaim(weth, knc)

    dbg(`buyer KNC balance is ${await knc.balanceOf(buyer1)}`)
    dbg(`buyer WETH balance is ${await weth.balanceOf(buyer1)}`)
    dbg(`buyer DX KNC balance is ${await dx.balances(knc.address, buyer1)}`)
    dbg(`buyer DX WETH balance is ${await dx.balances(weth.address, buyer1)}`)

    dbg(`\n--- seller wants his money back as well`)
    dbg(`before:`)
    dbg(`seller WETH balance is ${await weth.balanceOf(seller1)}`)
    dbg(`seller DX WETH balance is ${await dx.balances(weth.address, seller1)}`)
    dbg(`seller KNC balance is ${await knc.balanceOf(seller1)}`)
    dbg(`seller DX KNC balance is ${await dx.balances(knc.address, seller1)}`)

    const sellerClaim = async (sellToken, buyToken) => {
      await dx.claimSellerFunds(
        sellToken.address,
        buyToken.address,
        seller1,
        auctionIndex,
        { from: seller1 }
      )
    }
    await sellerClaim(knc, weth)
    await sellerClaim(weth, knc)

    dbg(`\nafter claiming:`)
    dbg(`seller WETH balance is ${await weth.balanceOf(seller1)}`)
    dbg(`seller DX WETH balance is ${await dx.balances(weth.address, seller1)}`)
    dbg(`seller KNC balance is ${await knc.balanceOf(seller1)}`)
    dbg(`seller DX KNC balance is ${await dx.balances(knc.address, seller1)}`)

    const sellerWithdraw = async (sellToken, buyToken) => {
      const balance = await dx.balances(buyToken.address, seller1)
      await dx.withdraw(buyToken.address, balance, { from: seller1 })
    }
    await sellerWithdraw(knc, weth)
    await sellerWithdraw(weth, knc)

    dbg(`\nafter withdrawing:`)
    dbg(`seller WETH balance is ${await weth.balanceOf(seller1)}`)
    dbg(`seller DX WETH balance is ${await dx.balances(weth.address, seller1)}`)
    dbg(`seller KNC balance is ${await knc.balanceOf(seller1)}`)
    dbg(`seller DX KNC balance is ${await dx.balances(knc.address, seller1)}`)
  })

  it('should have a kyber network proxy configured', async () => {
    const kyberNetworkProxy = await dxmm.kyberNetworkProxy()

    kyberNetworkProxy.should.exist
  })

  it('reject creating dxmm with DutchExchange address 0', async () => {
    await truffleAssert.reverts(
      TestingKyberDxMarketMaker.new(
        '0x0000000000000000000000000000000000000000',
        await dxmm.kyberNetworkProxy()
      ),
      'DutchExchange address cannot be 0'
    )
  })

  it('reject creating dxmm with KyberNetworkProxy address 0', async () => {
    await truffleAssert.reverts(
      TestingKyberDxMarketMaker.new(
        dx.address,
        '0x0000000000000000000000000000000000000000'
      ),
      'KyberNetworkProxy address cannot be 0'
    )
  })

  it('should allow admin to withdraw from dxmm', async () => {
    const amount = web3.utils.toWei(new BN(1))
    await weth.deposit({ value: amount, from: admin })
    const initialWethBalance = await weth.balanceOf(admin)

    await weth.transfer(dxmm.address, amount, { from: admin })
    const res = await dxmm.withdrawToken(weth.address, amount, admin, {
      from: admin
    })

    const wethBalance = await weth.balanceOf(admin)
    wethBalance.should.be.eq.BN(initialWethBalance)

    truffleAssert.eventEmitted(res, 'TokenWithdraw', ev => {
      return (
        ev.token === weth.address && ev.amount.eq(amount) && ev.sendTo === admin
      )
    })
  })

  it('reject withdrawing from dxmm by non-admin users', async () => {
    const amount = web3.utils.toWei(new BN(1))
    await weth.deposit({ value: amount, from: admin })
    await weth.transfer(dxmm.address, amount, { from: admin })

    await truffleAssert.reverts(
      dxmm.withdrawToken(weth.address, amount, user, { from: user }),
      'Operation limited to admin'
    )
  })

  it('should allow depositing to DX by operator', async () => {
    const amount = web3.utils.toWei(new BN(1))
    await weth.deposit({ value: amount, from: admin })
    await weth.transfer(dxmm.address, amount, { from: admin })
    const balanceBefore = await dx.balances(weth.address, dxmm.address)

    const updatedBalance = await dxmm.depositToDx.call(weth.address, amount, {
      from: operator
    })
    const res = await dxmm.depositToDx(weth.address, amount, {
      from: operator
    })

    const balanceAfter = await dx.balances(weth.address, dxmm.address)
    updatedBalance.should.be.eq.BN(balanceAfter)
    balanceAfter.should.be.eq.BN(balanceBefore.add(new BN(amount)))

    truffleAssert.eventEmitted(res, 'AmountDepositedToDx', ev => {
      return ev.token === weth.address && ev.amount.eq(amount)
    })
  })

  it('reject depositing to DX by non-operators', async () => {
    const amount = web3.utils.toWei(new BN(1))
    await weth.deposit({ value: amount, from: user })
    await weth.transfer(dxmm.address, amount, { from: user })

    await truffleAssert.reverts(
      dxmm.depositToDx(weth.address, amount, { from: user }),
      'Operation limited to operator'
    )
  })

  it('should allow withdrawing from DX by operator', async () => {
    const amount = web3.utils.toWei(new BN(1))
    await weth.deposit({ value: amount, from: admin })
    await weth.transfer(dxmm.address, amount, { from: admin })
    const wethBalanceBefore = await weth.balanceOf(dxmm.address)
    const dxBalanceBefore = await dx.balances(weth.address, dxmm.address)

    await dxmm.depositToDx(weth.address, amount, { from: operator })
    const res = await dxmm.withdrawFromDx(weth.address, amount, {
      from: operator
    })

    const dxBalanceAfter = await dx.balances(weth.address, dxmm.address)
    dxBalanceAfter.should.be.eq.BN(dxBalanceBefore)

    const wethBalanceAfter = await weth.balanceOf(dxmm.address)
    wethBalanceAfter.should.be.eq.BN(wethBalanceBefore)

    truffleAssert.eventEmitted(res, 'AmountWithdrawnFromDx', ev => {
      return ev.token === weth.address && ev.amount.eq(amount)
    })
  })

  it('reject withdrawing from DX by non-operator', async () => {
    const amount = web3.utils.toWei(new BN(1))
    await weth.deposit({ value: amount, from: admin })
    await weth.transfer(dxmm.address, amount, { from: admin })
    await dxmm.depositToDx(weth.address, amount, { from: operator })

    await truffleAssert.reverts(
      dxmm.withdrawFromDx(weth.address, amount, { from: user }),
      'Operation limited to operator'
    )
  })

  xit('should allow checking if balance is above new auction threshold', async () => {
    const knc = await deployTokenAddToDxAndClearFirstAuction()

    // TODO: correct calculations
    const dxKncNextAuctionThreshold = 1e60
    const currentDxBalance = 1

    const aboveThreshold = await dxmm.isBalanceAboveNewAuctionThreshold()
    aboveThreshold.should.be.false()

    // TODO: Two tests!
    // Increase balances
    // const aboveThreshold = await dxmm.isBalanceAboveNewAuctionThreshold()
    // aboveThreshold.should.be.true()
  })

  it('should provide auction threshold in token', async () => {
    const divCeil = (first, second) => {
      let dm = first.divmod(second)

      // Fast case - exact division
      if (dm.mod.isZero()) return dm.div

      // Round up
      return dm.div.negative !== 0 ? dm.div.isubn(1) : dm.div.iaddn(1)
    }

    const token = await deployTokenAddToDxAndClearFirstAuction()

    const thresholdNewAuctionUSD = await dx.thresholdNewAuction.call()
    const dxPriceOracle = await PriceOracleInterface.at(await dx.ethUSDOracle())
    const usdEthPrice = await dxPriceOracle.getUSDETHPrice.call()
    const lastPrice = await dx.getPriceOfTokenInLastAuction(token.address)
    // TODO: different order of calculation gives slightly different results:
    // commented: 1.169208159697765936047e+21
    // uncommented: 1.169208159697765936041e+21
    // const thresholdNewAuctionToken = (
    //     new BigNumber(thresholdNewAuctionUSD)
    //     .div(
    //         new BigNumber(usdEthPrice)
    //         .mul(new BigNumber(lastPriceNum))
    //         .div(new BigNumber(lastPriceDen))
    //     )
    //     .ceil()
    // )
    const first = thresholdNewAuctionUSD.mul(lastPrice.den)
    const second = usdEthPrice.mul(lastPrice.num)
    const thresholdNewAuctionToken = divCeil(first, second)

    dbg(`new auction threashold is ${thresholdNewAuctionUSD} USD`)
    dbg(`oracle USDETH price is ${await usdEthPrice}`)
    dbg(`last auction price was ${lastPrice.num}/${lastPrice.den}`)

    const tokenUsdPrice = usdEthPrice.mul(lastPrice.num).div(lastPrice.den)
    dbg(`Token price in USD is ${tokenUsdPrice}`)
    dbg(`new auction threashold is ${thresholdNewAuctionToken} TOKEN`)

    const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
      token.address
    )

    thresholdTokenWei.should.be.eq.BN(thresholdNewAuctionToken)
  })

  describe('#setKyberNetworkProxy', () => {
    it('reject address 0', async () => {
      await truffleAssert.reverts(
        dxmm.setKyberNetworkProxy(
          '0x0000000000000000000000000000000000000000',
          { from: admin }
        ),
        'KyberNetworkProxy address cannot be 0'
      )
    })

    it('sets the value', async () => {
      const other = await TestingKyberDxMarketMaker.new(
        await dxmm.dx() /* dx */,
        '0x0000000000000000000000000000000000000001' /* kyberNetworkProxy */,
        { from: admin }
      )

      await other.setKyberNetworkProxy(
        '0x0000000000000000000000000000000000000005',
        { from: admin }
      )

      const newAddress = await other.kyberNetworkProxy()
      newAddress.should.equal('0x0000000000000000000000000000000000000005')
    })

    it('should return true', async () => {
      const other = await TestingKyberDxMarketMaker.new(
        await dxmm.dx() /* dx */,
        '0x0000000000000000000000000000000000000001' /* kyberNetworkProxy */,
        { from: admin }
      )

      const res = await other.setKyberNetworkProxy.call(
        '0x0000000000000000000000000000000000000005',
        { from: admin }
      )

      res.should.be.true
    })

    it('revert if not admin', async () => {
      await truffleAssert.reverts(
        dxmm.setKyberNetworkProxy('0x0000000000000000000000000000000000000000'),
        'Operation limited to admin',
        { from: user }
      )
    })

    it('emits event', async () => {
      const other = await TestingKyberDxMarketMaker.new(
        await dxmm.dx() /* dx */,
        '0x0000000000000000000000000000000000000001' /* kyberNetworkProxy */,
        { from: admin }
      )

      const res = await other.setKyberNetworkProxy(
        '0x0000000000000000000000000000000000000005',
        { from: admin }
      )

      truffleAssert.eventEmitted(res, 'KyberNetworkProxyUpdated', ev => {
        return (
          ev.kyberNetworkProxy === '0x0000000000000000000000000000000000000005'
        )
      })
    })
  })

  describe('#calculateMissingTokenForAuctionStart', () => {
    it('thresholdNewAuctionToken works correctly for ETH', async () => {
      const dxPriceOracle = await PriceOracleInterface.at(
        await dx.ethUSDOracle()
      )
      const usdEthPrice = await dxPriceOracle.getUSDETHPrice.call()
      const auctionUsdThreshold = await dx.thresholdNewAuction()

      const dxmmEthThreshold = await dxmm.thresholdNewAuctionToken(weth.address)

      dxmmEthThreshold.should.be.eq.BN(
        auctionUsdThreshold.div(usdEthPrice).addn(1)
      )
    })

    it('calculate missing tokens in wei to start next auction: sellToken is KNC', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const missingInWei = await dxmm.calculateMissingTokenForAuctionStart.call(
        knc.address,
        weth.address
      )

      const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
        knc.address
      )
      missingInWei.should.be.eq.BN(thresholdTokenWei)
    })

    it('calculate missing tokens in wei to start next auction: sellToken is WETH', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const missingInWei = await dxmm.calculateMissingTokenForAuctionStart.call(
        weth.address,
        knc.address
      )

      const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
        weth.address
      )
      missingInWei.should.be.eq.BN(thresholdTokenWei)
    })

    it('calculate missing tokens in wei to start next auction after some other user sold', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const otherSellerAlreadySellsSome = async kncSellAmount => {
        await knc.transfer(seller1, kncSellAmount, { from: bank })
        await knc.approve(dx.address, kncSellAmount, { from: seller1 })
        await dx.depositAndSell(knc.address, weth.address, kncSellAmount, {
          from: seller1
        })
      }
      // 10050
      const amount = await dxmm.addFee(10000)
      await otherSellerAlreadySellsSome(amount)

      const missingInWei = await dxmm.calculateMissingTokenForAuctionStart.call(
        knc.address,
        weth.address
      )

      const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
        knc.address
      )
      missingInWei.should.be.eq.BN(thresholdTokenWei.subn(10000))
    })

    it('auction is in progress - missing amount to start auction is 0', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await triggerAuction(knc, weth, seller1)

      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const missingInWei = await dxmm.calculateMissingTokenForAuctionStart.call(
        knc.address,
        weth.address
      )

      missingInWei.should.be.eq.BN(0)
    })

    it('auction triggered, had not started - missing amount to start auction is 0', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      await triggerAuction(knc, weth, seller1)

      const missingInWei = await dxmm.calculateMissingTokenForAuctionStart.call(
        knc.address,
        weth.address
      )

      missingInWei.should.be.eq.BN(0)
    })

    it('auction started, everything bought, waiting for next auction to trigger - missing amount to start auction is threshold', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      // Buyer buys everything
      await buyEverythingInAuctionDirection(knc, weth, auctionIndex, buyer1)
      await buyEverythingInAuctionDirection(weth, knc, auctionIndex, buyer1)

      const missingInWei = await dxmm.calculateMissingTokenForAuctionStart.call(
        knc.address,
        weth.address
      )

      const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
        knc.address
      )
      missingInWei.should.be.eq.BN(thresholdTokenWei)
    })
  })

  describe('#getAuctionState', () => {
    it('no auction planned', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_FUNDING)
    })

    it('opposite direction funded, waiting for funding this direction', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      await fundDespositSell(weth, knc, seller1)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_FUNDING)
    })

    it('direction funded, waiting for opposite direction to be funded', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      await fundDespositSell(knc, weth, seller1)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_OPP_FUNDING)
    })

    it('both directions funded, waiting for auction to start', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      await fundDespositSell(knc, weth, seller1)
      await fundDespositSell(weth, knc, seller1)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_SCHEDULED_AUCTION)
    })

    it('auction in progress', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(AUCTION_IN_PROGRESS)
    })

    it('after auction direction finished', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      // start new auction
      await fundDespositSell(knc, weth, seller1)
      await fundDespositSell(weth, knc, seller1)

      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      await buyEverythingInAuctionDirection(knc, weth, auctionIndex, buyer1)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_OPP_TO_FINISH)
    })

    it('after auction cleared', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      // start new auction
      await fundDespositSell(knc, weth, seller1)
      await fundDespositSell(weth, knc, seller1)

      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      await buyEverythingInAuctionDirection(knc, weth, auctionIndex, buyer1)
      await buyEverythingInAuctionDirection(weth, knc, auctionIndex, buyer1)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_FUNDING)
    })

    it('should detect expired auctions with only opposite side', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const TIME_25_HOURS_IN_SECONDS = 60 * 60 * 25
      // wait more than 24 hours so that an auction could be funded only in
      // one of the directions before starting
      await waitTimeInSeconds(TIME_25_HOURS_IN_SECONDS)

      // Fund the opposite direction
      await fundDxmmAndDepositToDx(weth)
      await dxmm.testFundAuctionDirection(weth.address, knc.address)

      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)

      // wait for opposite direction auction to end
      await waitTimeInSeconds(TIME_25_HOURS_IN_SECONDS)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      const oppState = await dxmm.getAuctionState(weth.address, knc.address)
      const auctionIndexExpired = await dx.getAuctionIndex(
        knc.address,
        weth.address
      )

      state.should.be.eq.BN(AUCTION_EXPIRED)
      oppState.should.be.eq.BN(AUCTION_EXPIRED)
      auctionIndexExpired.should.be.eq.BN(auctionIndex)
    })

    it('should detect expired auctions', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmFundDepositTriggerBothSides(knc, weth)

      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)

      // wait for opposite direction auction to end
      const TIME_25_HOURS_IN_SECONDS = 60 * 60 * 25
      await waitTimeInSeconds(TIME_25_HOURS_IN_SECONDS)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      const oppState = await dxmm.getAuctionState(weth.address, knc.address)
      const auctionIndexExpired = await dx.getAuctionIndex(
        knc.address,
        weth.address
      )

      state.should.be.eq.BN(AUCTION_EXPIRED)
      oppState.should.be.eq.BN(AUCTION_EXPIRED)
      auctionIndexExpired.should.be.eq.BN(auctionIndex)
    })

    it('over 24 hours after auction closes, opposite side funded - this side should required funding as well', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      // Over 24 hours pass
      const TIME_25_HOURS_IN_SECONDS = 60 * 60 * 25
      await waitTimeInSeconds(TIME_25_HOURS_IN_SECONDS)

      // Fund the opposite direction
      await fundDxmmAndDepositToDx(weth)
      await dxmm.testFundAuctionDirection(weth.address, knc.address)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      const oppState = await dxmm.getAuctionState(weth.address, knc.address)

      state.should.be.eq.BN(WAITING_FOR_FUNDING)
      oppState.should.be.eq.BN(WAITING_FOR_SCHEDULED_AUCTION)
    })
  })

  describe('#addFee', () => {
    it('for amount 0', async () => {
      const amountWithFee = await dxmm.addFee(0)

      amountWithFee.should.be.eq.BN(0)
    })

    it('for amount 200', async () => {
      const amountWithFee = await dxmm.addFee(200)

      amountWithFee.should.be.eq.BN(201)
    })
  })

  describe('#tokensSoldInCurrentAuction', () => {
    it('auction in progress, single seller', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
        knc.address
      )

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const tokensSoldInCurrentAuction = await dxmm.tokensSoldInCurrentAuction(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      tokensSoldInCurrentAuction.should.be.eq.BN(auctionTokenSellAmount)
    })

    it('auction in progress, multiple sellers', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
        knc.address
      )

      // Other sellers sells KNC in auction
      await sellTokens(knc, 10000, user)

      const seller1TokenSellAmount = auctionTokenSellAmount.subn(10000)

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const tokensSoldInCurrentAuction = await dxmm.tokensSoldInCurrentAuction(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      tokensSoldInCurrentAuction.should.be.eq.BN(seller1TokenSellAmount)
    })

    it('auction triggered', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
        knc.address
      )

      const auctionIndex = await triggerAuction(knc, weth, seller1)

      const tokensSoldInCurrentAuction = await dxmm.tokensSoldInCurrentAuction(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      tokensSoldInCurrentAuction.should.be.eq.BN(auctionTokenSellAmount)
    })

    it('no auction triggered', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const tokensSoldInCurrentAuction = await dxmm.tokensSoldInCurrentAuction(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        await dx.getAuctionIndex(knc.address, weth.address) /* auctionIndex */,
        seller1 /* account */
      )

      tokensSoldInCurrentAuction.should.be.eq.BN(0)
    })
  })

  describe('#calculateAuctionBuyTokens', () => {
    it('auction in progress, single seller, single buyer, calculation as expected', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const expectedBuyTokens = await calculateRemainingBuyVolume(
        knc,
        weth,
        auctionIndex
      )

      const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      calculatedBuyTokens.should.be.eq.BN(expectedBuyTokens)
    })

    it('auction in progress, single seller, single buyer, successfully buy calculated amount', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const balanceBefore = await dx.balances.call(weth.address, seller1)

      const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )
      dbg(`WETH required to buy amount sold: ${calculatedBuyTokens}`)

      // Note: this action is composed of a number of function calls, so a
      // couple of blocks may pass which might change the auction prices
      // and leave some WETH in the balance after buying.
      await buyAuctionTokens(
        knc,
        auctionIndex,
        calculatedBuyTokens,
        seller1,
        false /* addFee */
      )

      // Take care of the opposite direction
      await buyEverythingInAuctionDirection(weth, knc, auctionIndex, buyer1)

      // Auction cleared: getAuctionIndex() returns next auction index
      const currentAuctionIndex = await dx.getAuctionIndex(
        knc.address,
        weth.address
      )
      currentAuctionIndex.should.be.eq.BN(auctionIndex.addn(1))
    })

    it('auction in progress, single seller, multiple buyers', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const buyTokensBefore = await calculateRemainingBuyVolume(
        knc,
        weth,
        auctionIndex
      )

      const priceBefore = await dx.getCurrentAuctionPrice(
        knc.address,
        weth.address,
        auctionIndex
      )
      // Note: this action is composed of a number of function calls, so a
      // couple of blocks may pass which might change the auction prices
      // and leave some WETH in the balance after buying.
      await buyAuctionTokens(knc, auctionIndex, 10000, user, true /* addFee */)

      const priceAfter = await dx.getCurrentAuctionPrice(
        knc.address,
        weth.address,
        auctionIndex
      )

      const calculatedBuyTokensAfter = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      dbg('priceBefore', priceBefore.num.toString(), priceBefore.den.toString())
      dbg('priceAfter', priceAfter.num.toString(), priceAfter.den.toString())

      const priceNormalizedExpectedBuyTokensBefore = buyTokensBefore
        .subn(10000) // other user bought these
        .div(priceBefore.num)
        .mul(priceAfter.den)
      const priceNormalizedBuyTokensAfter = calculatedBuyTokensAfter
        .div(priceAfter.num)
        .mul(priceAfter.den)

      priceNormalizedBuyTokensAfter.should.be.eq.BN(
        priceNormalizedExpectedBuyTokensBefore
      )
    })

    it(
      'what to do if some other buyer bought? we might not have enough KNC for the next auction'
    )

    it('auction in progress, multiple seller, single buyer', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
        knc.address
      )

      // Other sellers sells KNC in auction
      await sellTokens(knc, 1000000, user)

      const seller1TokenSellAmount = auctionTokenSellAmount.subn(1000000)

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      // Calculate expected buy volume based on the amount sold by seller1
      const expectedBuyTokens = await calculateBuyVolumeForSellVolume(
        knc,
        weth,
        seller1TokenSellAmount,
        auctionIndex
      )

      const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      calculatedBuyTokens.should.be.eq.BN(expectedBuyTokens)
    })

    it('auction in progress, multiple seller, multiple buyers', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
        knc.address
      )

      // Other user sells KNC in auction
      await sellTokens(knc, auctionTokenSellAmount.divn(3), user)

      const seller1TokenSellAmount = auctionTokenSellAmount.divn(3).muln(2)

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const expectedBuyTokens = await calculateBuyVolumeForSellVolume(
        knc,
        weth,
        seller1TokenSellAmount,
        auctionIndex
      )

      const priceBefore = await dx.getCurrentAuctionPrice(
        knc.address,
        weth.address,
        auctionIndex
      )

      // Other user buys a little KNC in auction
      await buyAuctionTokens(knc, auctionIndex, 10000, user, true /* addFee */)

      const priceAfter = await dx.getCurrentAuctionPrice(
        knc.address,
        weth.address,
        auctionIndex
      )

      // seller1 buys the amount matching their sold amount
      const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      dbg('priceBefore', priceBefore.num.toString(), priceBefore.den.toString())
      dbg('priceAfter', priceAfter.num.toString(), priceAfter.den.toString())

      const priceNormalizedExpectedBuyTokensBefore = calculatedBuyTokens
        .div(priceBefore.num)
        .mul(priceAfter.den)
      const priceNormalizedBuyTokensAfter = calculatedBuyTokens
        .div(priceAfter.num)
        .mul(priceAfter.den)

      priceNormalizedBuyTokensAfter.should.be.eq.BN(
        priceNormalizedExpectedBuyTokensBefore
      )
    })

    // TODO: this is a flaky test as the price changes with time so in some runs the number will not
    // be equal
    it('multiple buyers, not enough available buy tokens -> buy available amount', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      // seller1 funds all of the auction
      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const auctionSellVolume = await dx.sellVolumesCurrent(
        knc.address,
        weth.address
      )

      // Other user buys half of available buy tokens
      const remainingBuyTokens = await calculateBuyVolumeForSellVolume(
        knc,
        weth,
        auctionSellVolume,
        auctionIndex
      )
      await buyAuctionTokens(
        knc,
        auctionIndex,
        remainingBuyTokens.divn(2) /* amount */,
        user,
        true /* addFee */
      )

      const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )
      dbg(`seller1 should buy ${calculatedBuyTokens}`)

      // seller1 cannot buy everything they sold so they buy the available amount.
      const p = await dx.getCurrentAuctionPrice(
        knc.address,
        weth.address,
        auctionIndex
      )
      const buyVolume1 = await dx.buyVolumes(knc.address, weth.address)
      const remainingBuyVolume = auctionSellVolume
        .mul(p.num)
        .div(p.den)
        .sub(buyVolume1)

      const diffIsSmall = calculatedBuyTokens
        .sub(remainingBuyVolume)
        .lte(remainingBuyVolume.divn(10000))
      diffIsSmall.should.be.true
    })

    it('no auction triggered', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)

      const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      // Auction is not triggered yet, no tokens to buy.
      calculatedBuyTokens.should.be.eq.BN(0)
    })
  })

  describe('#willAmountClearAuction', () => {
    it('using calculated buy amount', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      const willClearAuction = await dxmm.willAmountClearAuction(
        knc.address,
        weth.address,
        auctionIndex,
        calculatedBuyTokens
      )

      willClearAuction.should.be.true
    })

    it('using less than calculated buy amount', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      const willClearAuction = await dxmm.willAmountClearAuction(
        knc.address,
        weth.address,
        auctionIndex,
        calculatedBuyTokens.subn(10000) /* amount */
      )

      willClearAuction.should.be.false
    })

    it('using more than calculated buy amount', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      const willClearAuction = await dxmm.willAmountClearAuction(
        knc.address,
        weth.address,
        auctionIndex,
        calculatedBuyTokens + 1 /* amount */
      )

      willClearAuction.should.be.true
    })

    it("multiple sellers, single seller's matching buy amount should not clear", async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      // Other sellers sells KNC in auction
      await sellTokens(knc, 10000, user)

      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
        knc.address /* sellToken */,
        weth.address /* buyToken */,
        auctionIndex /* auctionIndex */,
        seller1 /* account */
      )

      const willClearAuction = await dxmm.willAmountClearAuction(
        knc.address,
        weth.address,
        auctionIndex,
        calculatedBuyTokens /* amount */
      )

      // seller1's recommended buy amount should not clear the auction as
      // it should not cover the sell amount that was added by "user".
      willClearAuction.should.be.false
    })
  })

  it('make sure dxmm has enough balance, else deposit')

  it('get kyber rates', async () => {
    const knc = await deployTokenAddToDxAndClearFirstAuction()
    const kyberProxy = await MockKyberNetworkProxy.at(
      await dxmm.kyberNetworkProxy()
    )

    // TODO: use actual value
    const kncAmountInAuction = 10000

    const kyberProxyRate = await kyberProxy.getExpectedRate(
      knc.address,
      ETH_TOKEN_ADDRESS,
      kncAmountInAuction
    )
    dbg(`direct kyber rate for knc => weth is ${kyberProxyRate.expectedRate}`)
    dbg(kyberProxyRate)

    const kyberRate = await dxmm.getKyberRate(
      knc.address,
      weth.address,
      kncAmountInAuction /* amount */
    )

    dbg(`dxmm kyber rate is (${kyberRate.num}, ${kyberRate.den})`)

    const dxmmValue = kyberRate.num / kyberRate.den
    const kyberValue = Number(web3.utils.fromWei(kyberProxyRate.expectedRate))
    dxmmValue.should.be.equal(kyberValue)
  })

  it('kyber rates provided only for 18 decimals sell tokens', async () => {
    const token9Decimals = await deployTokenVarialbeDecimals(9)

    await truffleAssert.reverts(
      dxmm.getKyberRate(token9Decimals.address, weth.address, 1 /* amount */),
      'Only 18 decimals tokens are supported'
    )
  })

  it('kyber rates provided only for 18 decimals buy tokens', async () => {
    const token9Decimals = await deployTokenVarialbeDecimals(9)

    await truffleAssert.reverts(
      dxmm.getKyberRate(weth.address, token9Decimals.address, 1 /* amount */),
      'Only 18 decimals tokens are supported'
    )
  })

  describe('#claimSpecificAuctionFunds', () => {
    it('returns user funds in specific auction', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmTriggerAndClearAuction(knc, weth)
      const unclaimedKnc = await dx.sellerBalances(
        knc.address,
        weth.address,
        2,
        dxmm.address
      )
      const unclaimedWeth = await dx.buyerBalances(
        knc.address,
        weth.address,
        2,
        dxmm.address
      )

      const res = await dxmm.claimSpecificAuctionFunds.call(
        knc.address,
        weth.address,
        2
      )

      res.sellerFunds.should.be.eq.BN(unclaimedWeth)
      res.buyerFunds.should.be.eq.BN(unclaimedKnc)
    })

    it('funds claimed', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmTriggerAndClearAuction(knc, weth)

      const kncBalanceBefore = await dx.balances(knc.address, dxmm.address)
      const wethBalanceBefore = await dx.balances(weth.address, dxmm.address)

      const unclaimedKnc = await dx.sellerBalances(
        knc.address,
        weth.address,
        2,
        dxmm.address
      )

      const unclaimedWeth = await dx.buyerBalances(
        knc.address,
        weth.address,
        2,
        dxmm.address
      )

      await dxmm.claimSpecificAuctionFunds(knc.address, weth.address, 2)

      const kncBalanceAfter = await dx.balances(knc.address, dxmm.address)
      kncBalanceAfter.should.be.eq.BN(kncBalanceBefore.add(unclaimedKnc))

      const wethBalanceAfter = await dx.balances(weth.address, dxmm.address)
      wethBalanceAfter.should.be.eq.BN(wethBalanceBefore.add(unclaimedWeth))
    })

    it('called twice on same auction, second call should do nothing', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmTriggerAndClearAuction(knc, weth)

      // First call should claim funds
      await dxmm.claimSpecificAuctionFunds(knc.address, weth.address, 2)

      const kncBalanceBefore = await dx.balances(knc.address, dxmm.address)
      const wethBalanceBefore = await dx.balances(weth.address, dxmm.address)

      // Second call should do nothing
      const res = await dxmm.claimSpecificAuctionFunds.call(
        knc.address,
        weth.address,
        2
      )
      await dxmm.claimSpecificAuctionFunds(knc.address, weth.address, 2)

      res.sellerFunds.should.be.eq.BN(0)
      res.buyerFunds.should.be.eq.BN(0)

      const kncBalanceAfter = await dx.balances(knc.address, dxmm.address)
      kncBalanceAfter.should.be.eq.BN(kncBalanceBefore)

      const wethBalanceAfter = await dx.balances(weth.address, dxmm.address)
      wethBalanceAfter.should.be.eq.BN(wethBalanceBefore)
    })
  })

  describe('manually claim tokens by any user directly from DutchX', () => {
    it('dxmm triggered the auction and then cleared it', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      const auctionIndex = await dxmmTriggerAndClearAuction(knc, weth)

      const kncBalanceBefore = await dx.balances(knc.address, dxmm.address)
      const wethBalanceBefore = await dx.balances(weth.address, dxmm.address)

      const price = await dx.getCurrentAuctionPrice(
        knc.address,
        weth.address,
        auctionIndex
      )
      const sellerKncBalance = await dx.sellerBalances(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )
      const sellerWethBalance = sellerKncBalance.mul(price.num).div(price.den)

      const buyerWethBalance = await dx.buyerBalances(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )
      const buyerKncBalance = (await dx.getUnclaimedBuyerFunds(
        knc.address,
        weth.address,
        dxmm.address,
        auctionIndex
      )).unclaimedBuyerFunds

      dbg(`--- kncBalanceBefore is ${kncBalanceBefore}`)
      dbg(`--- sellerKncBalance is ${sellerKncBalance}`)
      dbg(`--- sellerWethBalance is ${sellerWethBalance}`)
      dbg(`.`)
      dbg(`--- wethBalanceBefore is ${wethBalanceBefore}`)
      dbg(`--- buyerWethBalance is ${buyerWethBalance}`)
      dbg(`--- buyerKncBalance is ${buyerKncBalance}`)

      // Claiming by random user
      await dx.claimSellerFunds(
        knc.address,
        weth.address,
        dxmm.address,
        auctionIndex,
        { from: user }
      )
      await dx.claimBuyerFunds(
        knc.address,
        weth.address,
        dxmm.address,
        auctionIndex,
        { from: user }
      )

      const sellerBalanceAfter = await dx.sellerBalances(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )
      sellerBalanceAfter.should.be.eq.BN(0)

      const buyerBalanceAfter = await dx.buyerBalances(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )
      buyerBalanceAfter.should.be.eq.BN(0)

      const kncBalance = await dx.balances(knc.address, dxmm.address)
      kncBalance.should.be.eq.BN(kncBalanceBefore.add(buyerKncBalance))

      const wethBalance = await dx.balances(weth.address, dxmm.address)
      wethBalance.should.be.eq.BN(wethBalanceBefore.add(sellerWethBalance))
      dbg(`$$$ final kncBalance is ${kncBalance}`)
      dbg(`$$$ final wethBalance is ${wethBalance}`)
    })
  })

  describe('#buyInAuction', () => {
    it('should fail if auction not in progress (not triggered)', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      await truffleAssert.reverts(
        dxmm.testBuyInAuction(knc.address, weth.address),
        'No auction in progress'
      )
    })

    it('should fail if auction not in progress (triggered, waiting)', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await triggerAuction(knc, weth, user)

      await truffleAssert.reverts(
        dxmm.testBuyInAuction(knc.address, weth.address),
        'No auction in progress'
      )
    })

    it('should buy nothing if nothing sold (other user triggered auction)', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const auctionIndex = await triggerAuction(knc, weth, user)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)
      const buyerBalanceBefore = await dx.buyerBalances(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )

      const bought = await dxmm.testBuyInAuction.call(knc.address, weth.address)

      bought.should.be.false
      const buyerBalanceAfter = await dx.buyerBalances(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )
      buyerBalanceAfter.should.be.eq.BN(buyerBalanceBefore)
    })

    it('should buy the amount of sold tokens in auction', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      await dxmmFundDepositTriggerBothSides(knc, weth)

      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)
      const buyerBalanceBefore = await dx.buyerBalances(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )

      // This is more WETH than will eventually be required as the rate
      // improves block by block and we waste a couple of blocks in these
      // deposits
      await fundDxmmAndDepositToDxToBuyInAuction(knc, weth, auctionIndex)

      const bought = await dxmm.testBuyInAuction.call(knc.address, weth.address)
      await dxmm.testBuyInAuction(knc.address, weth.address)
      const auctionClosingPrice = await dx.closingPrices(
        knc.address,
        weth.address,
        auctionIndex
      )

      buyerBalanceBefore.should.be.eq.BN(0)
      bought.should.be.true

      // All sell volume bought, auction cleared.
      // When auction clears the closing price is updated.
      auctionClosingPrice.den.should.not.eq.BN(0)
    })

    it('should emit event with amount bought', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      await dxmmFundDepositTriggerBothSides(knc, weth)
      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      // This is more WETH than will eventually be required as the rate
      // improves block by block and we waste a couple of blocks in These
      // deposits
      await fundDxmmAndDepositToDxToBuyInAuction(knc, weth, auctionIndex)

      // Rate lowers as time goes by
      const buyTokenAmount = await dxmm.calculateAuctionBuyTokens.call(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )
      const res = await dxmm.testBuyInAuction(knc.address, weth.address)

      dbg(`%%% ev.sellToken === ${knc.address}`)
      dbg(`%%% ev.buyToken === ${weth.address}`)
      dbg(`%%% ev.auctionIndex.eq(${auctionIndex})`)
      dbg(`%%% ev.clearedAuction == true`)
      truffleAssert.eventEmitted(res, 'BoughtInAuction', ev => {
        return (
          ev.sellToken === knc.address &&
          ev.buyToken === weth.address &&
          ev.auctionIndex.eq(auctionIndex) &&
          ev.clearedAuction
        )
      })
    })

    it("should fail if doesn't have enough WETH to buy sold amount", async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      await dxmmFundDepositTriggerBothSides(knc, weth)
      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      // Make sure dxmm does not have enough WETH to buy
      const dxBalance = await dx.balances(weth.address, dxmm.address)
      dbg(`%%% dxmm balance on dx: ${dxBalance}`)
      await dxmm.withdrawFromDx(weth.address, dxBalance, { from: operator })
      dbg(
        `%%% dxmm balance on dx after: ${await dx.balances(
          weth.address,
          dxmm.address
        )}`
      )
      const wethBalance = await weth.balanceOf(dxmm.address)
      dbg(`%%% dxmm WETH balance: ${wethBalance}`)
      // keep 1 ETH for gas
      const withdrawAmount = wethBalance.subn(1)
      dbg(`%%% dxmm withdraw amount: ${withdrawAmount}`)
      await dxmm.withdrawToken(weth.address, withdrawAmount, admin, {
        from: admin
      })
      dbg(`%%% dxmm balance after: ${await weth.balanceOf(dxmm.address)}`)

      await truffleAssert.reverts(
        dxmm.testBuyInAuction(knc.address, weth.address),
        'Not enough buy token to buy required amount'
      )
    })
  })

  describe('#fundAuctionDirection', () => {
    it('deposit and trigger auction', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      // Prepare the opposite direction first
      await fundDxmmAndDepositToDx(weth)
      await dxmm.testFundAuctionDirection(weth.address, knc.address)

      await fundDxmmAndDepositToDx(knc)

      const triggered = await dxmm.testFundAuctionDirection.call(
        knc.address,
        weth.address
      )
      await dxmm.testFundAuctionDirection(knc.address, weth.address)

      triggered.should.be.true
      const auctionStart = await dx.getAuctionStart(knc.address, weth.address)
      auctionStart.should.not.be.eq.BN(DX_AUCTION_START_WAITING_FOR_FUNDING)
    })

    it("revert if doesn't have enough balance", async () => {
      dbg(`before deployTokenAddToDxAndClearFirstAuction()`)
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      dbg(`after deployTokenAddToDxAndClearFirstAuction()`)

      await truffleAssert.reverts(
        dxmm.testFundAuctionDirection(knc.address, weth.address),
        'Not enough tokens to fund auction direction'
      )
    })

    it('fail if auction has already been triggered and waiting to start', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmFundDepositTriggerBothSides(knc, weth)

      const triggered = await dxmm.testFundAuctionDirection.call(
        knc.address,
        weth.address
      )

      triggered.should.be.false
    })

    it('fail if auction is in progress', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmFundDepositTriggerBothSides(knc, weth)
      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const triggered = await dxmm.testFundAuctionDirection.call(
        knc.address,
        weth.address
      )

      triggered.should.be.false
    })

    it('should emit event with triggered auction info', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await fundDxmmAndDepositToDx(knc)
      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      const missingTokens = await dxmm.calculateMissingTokenForAuctionStart(
        knc.address,
        weth.address
      )
      const missingTokensWithFee = await dxmm.addFee(missingTokens)

      await dxmm.testFundAuctionDirection.call(knc.address, weth.address)
      const res = await dxmm.testFundAuctionDirection(knc.address, weth.address)

      truffleAssert.eventEmitted(res, 'AuctionDirectionFunded', ev => {
        return (
          ev.sellToken === knc.address &&
          ev.buyToken === weth.address &&
          ev.auctionIndex.eq(auctionIndex) &&
          ev.sellTokenAmount.eq(missingTokens) &&
          ev.sellTokenAmountWithFee.eq(missingTokensWithFee)
        )
      })
    })
  })

  describe('#step', () => {
    const hasDxPriceReachedKyber = async (
      sellToken,
      buyToken,
      auctionIndex
    ) => {
      // dutchX price should initially be higher than kyber price
      const buyAmount = await dxmm.calculateAuctionBuyTokens(
        sellToken.address,
        buyToken.address,
        auctionIndex,
        dxmm.address
      )
      const dxPrice = await dx.getCurrentAuctionPrice(
        sellToken.address,
        buyToken.address,
        auctionIndex
      )
      // The buyer of the auction pays in buyToken to get sellToken
      const kyberPrice = await dxmm.getKyberRate(
        buyToken.address /* srcToken */,
        sellToken.address /* destToken */,
        buyAmount
      )
      const a = dxPrice.num.mul(kyberPrice.den)
      const b = kyberPrice.num.mul(dxPrice.den)
      dbg(
        `dutchx price is ${dxPrice.num}/${dxPrice.den} = ${dxPrice.num /
          dxPrice.den}`
      )
      dbg(
        `kyber price is ${kyberPrice.num}/${kyberPrice.den} = ${kyberPrice.num /
          kyberPrice.den}`
      )
      dbg(`a is ${a}`)
      dbg(`b is ${b}`)
      dbg(`a <= b? ${a.lte(b)}`)
      return a.lte(b)
    }

    it('no auction in progress or planned - action required', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await fundDxmmAndDepositToDx(knc)

      const actionRequired = await dxmm.step.call(knc.address, weth.address, {
        from: operator
      })

      actionRequired.should.be.true
    })

    it('no auction in progress or planned - fund direction', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await fundDxmmAndDepositToDx(knc)

      const res = await dxmm.step(knc.address, weth.address, {
        from: operator
      })

      const missingTokensInDirection = await dxmm.calculateMissingTokenForAuctionStart(
        knc.address,
        weth.address
      )
      missingTokensInDirection.should.be.eq.BN(0)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_OPP_FUNDING)
    })

    it('no auction in progress or planned - trigger auction', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await fundDxmmAndDepositToDx(knc)

      // fund opposite direction
      await fundDespositSell(weth, knc, seller1)

      const auctionStartBefore = await dx.getAuctionStart(
        knc.address,
        weth.address
      )

      const res = await dxmm.step(knc.address, weth.address, {
        from: operator
      })

      const auctionStartAfter = await dx.getAuctionStart(
        knc.address,
        weth.address
      )

      auctionStartBefore.should.be.eq.BN(1)
      auctionStartAfter.should.not.be.eq.BN(1)
    })

    it('no auction in progress or planned - trigger auction event', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await fundDxmmAndDepositToDx(knc)

      const res = await dxmm.step(knc.address, weth.address, {
        from: operator
      })

      truffleAssert.eventEmitted(res, 'AuctionDirectionFunded', ev => {
        return (
          ev.sellToken === knc.address &&
          ev.buyToken === weth.address &&
          ev.auctionIndex.eqn(2)
        )
      })
    })

    it('no auction in progress or planned - previous auction funds claimed', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      // Auction 2
      await dxmmTriggerAndClearAuction(knc, weth)

      const res = await dxmm.step(knc.address, weth.address, {
        from: operator
      })

      const sellerBalance = await dx.sellerBalances(
        knc.address,
        weth.address,
        2,
        dxmm.address
      )
      sellerBalance.should.be.eq.BN(0)
      const buyerBalance = await dx.buyerBalances(
        knc.address,
        weth.address,
        2,
        dxmm.address
      )
      buyerBalance.should.be.eq.BN(0)
    })

    it('auction already triggered, waiting - no action required', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmFundDepositTriggerBothSides(knc, weth)

      const actionRequired = await dxmm.step.call(knc.address, weth.address, {
        from: operator
      })

      actionRequired.should.be.false
      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_SCHEDULED_AUCTION)
    })

    it('auction side funded, waiting for opposite side - no action required', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await fundDxmmAndDepositToDx(knc)
      await dxmm.testFundAuctionDirection(knc.address, weth.address)

      const actionRequired = await dxmm.step.call(knc.address, weth.address, {
        from: operator
      })

      actionRequired.should.be.false
      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_OPP_FUNDING)
    })

    it('auction already triggered, waiting - no action performed', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmFundDepositTriggerBothSides(knc, weth)

      const res = await dxmm.step(knc.address, weth.address, {
        from: operator
      })

      // TODO: check that NO EVENT AT ALL has been emitted
      truffleAssert.eventNotEmitted(res, 'AuctionDirectionFunded')
      truffleAssert.eventNotEmitted(res, 'BoughtInAuction')
    })

    it('auction in progress but price not ready for buying, waiting - nothing to do', async () => {
      // list
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      // trigger auction
      await dxmmFundDepositTriggerBothSides(knc, weth)
      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      // dutchX price should initially be higher than kyber price
      const dxPrice = await dx.getCurrentAuctionPrice(
        knc.address,
        weth.address,
        auctionIndex
      )

      // The buyer of the auction pays in WETH to get KNC
      const wethAmount = await dxmm.calculateAuctionBuyTokens(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )
      const kyberPrice = await dxmm.getKyberRate(
        weth.address /* srcToken */,
        knc.address /* destToken */,
        wethAmount
      )

      dbg(`dx price ${dxPrice.num.toString()} / ${dxPrice.den.toString()}`)
      dbg(
        `kyber price ${kyberPrice.num.toString()} / ${kyberPrice.den.toString()}`
      )

      const a = kyberPrice.num.mul(dxPrice.den)
      const b = dxPrice.num.mul(kyberPrice.den)
      a.should.be.lt.BN(b)

      const actionRequired = await dxmm.step.call(knc.address, weth.address, {
        from: operator
      })

      // actionRequired.should.be.false
      if (actionRequired) {
        console.log('--- Expected actionRequire to be false, but it is true')
        const state = await dxmm.getAuctionState(knc.address, weth.address)
        console.log('state:', state)
        console.log('triggerring step to see event')
        await dxmm.step(knc.address, weth.address, {
          from: operator
        })
        assert(false)
      }
    })

    it('auction in progress but price not ready for buying, waiting - no action performed', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      await dxmmFundDepositTriggerBothSides(knc, weth)
      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)
      const priceReachedKyber = await hasDxPriceReachedKyber(
        knc,
        weth,
        auctionIndex
      )
      priceReachedKyber.should.be.false

      const res = await dxmm.step(knc.address, weth.address, {
        from: operator
      })

      // TODO: check that NO EVENT AT ALL has been emitted
      truffleAssert.eventNotEmitted(res, 'AuctionDirectionFunded')
      truffleAssert.eventNotEmitted(res, 'BoughtInAuction')
    })

    it('auction in progress, price ready for buying -> should buy', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmFundDepositTriggerBothSides(knc, weth)
      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const buyAmount = await dxmm.calculateAuctionBuyTokens(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )
      await waitUntilKyberPriceReached(knc, weth, auctionIndex, buyAmount)

      const actionRequired = await dxmm.step.call(knc.address, weth.address, {
        from: operator
      })

      const priceReachedKyber = await hasDxPriceReachedKyber(
        knc,
        weth,
        auctionIndex
      )
      priceReachedKyber.should.be.true
      actionRequired.should.be.true
    })

    it('auction in progress, price ready for buying -> bought and finished auction side', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmFundDepositTriggerBothSides(knc, weth)
      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const buyAmount = await dxmm.calculateAuctionBuyTokens(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )
      await waitUntilKyberPriceReached(knc, weth, auctionIndex, buyAmount)
      const priceReachedKyber = await hasDxPriceReachedKyber(
        knc,
        weth,
        auctionIndex
      )
      priceReachedKyber.should.be.true

      await fundDxmmAndDepositToDxToBuyInAuction(knc, weth, auctionIndex)

      const res = await dxmm.step(knc.address, weth.address, {
        from: operator
      })

      truffleAssert.eventEmitted(res, 'BoughtInAuction', ev => {
        return (
          ev.sellToken === knc.address &&
          ev.buyToken === weth.address &&
          ev.auctionIndex.eq(auctionIndex)
        )
      })

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_OPP_TO_FINISH)
    })

    it('auction in progress, price ready for buying -> bought and finished auction side + buy opp side -> clear auction', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      await dxmmFundDepositTriggerBothSides(knc, weth)
      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

      const buyAmount = await dxmm.calculateAuctionBuyTokens(
        knc.address,
        weth.address,
        auctionIndex,
        dxmm.address
      )
      await waitUntilKyberPriceReached(knc, weth, auctionIndex, buyAmount)
      const priceReachedKyber = await hasDxPriceReachedKyber(
        knc,
        weth,
        auctionIndex
      )
      priceReachedKyber.should.be.true

      await fundDxmmAndDepositToDxToBuyInAuction(knc, weth, auctionIndex)

      const res = await dxmm.step(knc.address, weth.address, {
        from: operator
      })

      // Now finish the opposite direction
      await buyEverythingInAuctionDirection(weth, knc, auctionIndex, buyer1)

      const state = await dxmm.getAuctionState(knc.address, weth.address)
      state.should.be.eq.BN(WAITING_FOR_FUNDING)
    })

    it('should deposit all token balance to dx', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      await fundDxmmAndDepositToDx(knc)

      const amount = web3.utils.toWei(new BN(10).pow(new BN(6)))

      // transfer KNC
      await knc.transfer(dxmm.address, amount, { from: bank })

      // transfer WETH
      await weth.deposit({ value: amount, from: bank })
      await weth.transfer(dxmm.address, amount, { from: bank })

      await dxmm.step(knc.address, weth.address, { from: operator })

      const wethBalance = await weth.balanceOf(dxmm.address)
      const kncBalance = await knc.balanceOf(dxmm.address)

      wethBalance.should.be.eq.BN(0)
      kncBalance.should.be.eq.BN(0)
    })

    it('Support only Tokens with 18 decimals for sellToken', async () => {
      const token9Decimals = await deployTokenVarialbeDecimals(9)

      await truffleAssert.reverts(
        dxmm.step(token9Decimals.address, weth.address, { from: operator }),
        'Only 18 decimals tokens are supported'
      )
    })

    it('Support only Tokens with 18 decimals for buyToken', async () => {
      const token9Decimals = await deployTokenVarialbeDecimals(9)

      await truffleAssert.reverts(
        dxmm.step(weth.address, token9Decimals.address, { from: operator }),
        'Only 18 decimals tokens are supported'
      )
    })

    it('auction in progress with right price, but did not fund so does not buy', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()
      const auctionIndex = await triggerAuction(knc, weth, seller1)
      await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)
      // fake amount
      const buyAmount = 1000
      await waitUntilKyberPriceReached(knc, weth, auctionIndex, buyAmount)

      const shouldAct = await dxmm.step.call(knc.address, weth.address, {
        from: operator
      })

      shouldAct.should.be.false
    })

    it('step after opposite direction ended with no buyers should close auction', async () => {
      const knc = await deployTokenAddToDxAndClearFirstAuction()

      const TIME_25_HOURS_IN_SECONDS = 60 * 60 * 25
      // wait more than 24 hours so that an auction could be funded only in
      // one of the directions before starting
      await waitTimeInSeconds(TIME_25_HOURS_IN_SECONDS)

      // Fund the opposite direction
      await fundDxmmAndDepositToDx(weth)
      await dxmm.testFundAuctionDirection(weth.address, knc.address)

      const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)

      // wait for opposite direction auction to end
      await waitTimeInSeconds(TIME_25_HOURS_IN_SECONDS)

      await fundDxmmAndDepositToDx(knc)
      const shouldAct = await dxmm.step.call(knc.address, weth.address, {
        from: operator
      })
      const res = await dxmm.step(knc.address, weth.address, {
        from: operator
      })

      shouldAct.should.be.true
      const newAuctionIndex = await dx.getAuctionIndex(
        knc.address,
        weth.address
      )
      newAuctionIndex.should.be.eq.BN(auctionIndex.addn(1))
    })

    it('several cycles')

    it('does dxmm have sufficient funds? (token and weth)')
  })

  it('should start sale only if has enough ETH to end')
  it('calculate missing amount and postSell should be in 1 tx')
})

// TODO: Extract to util class
async function waitTimeInSeconds(seconds) {
  await Helper.sendPromise('evm_increaseTime', [seconds])
  await Helper.sendPromise('evm_mine', [])
}

// TODO: Extract to util class
async function blockChainTime() {
  const blockNumber = await web3.eth.getBlockNumber()
  dbg(`web3.eth.blockNumber is ${blockNumber}`)
  const currentBlock = await web3.eth.getBlock(blockNumber)
  return currentBlock.timestamp
}

async function dbg(...args) {
  if (DEBUG) console.log(...args)
}

// Called with a collection of variables and print their name and values.
// e.g.:
// const a = 'banana'
// dbgVars({ a })
const dbgVars = varObj => {
  if (!DEBUG) return
  // console.log(
  // util.inspect(varObj, { showHidden: true, depth: null, colors: true })
  // )
  for (let key in varObj) {
    const v = varObj[key]
    if (BN.isBN(v)) {
      // varObj[key].prototype.inspect = function inspect() {
      // return (this.red ? '<BN-R: ' : '<BN: ') + this.toString(10) + '>'
      // }
      v.inspect = () => {
        return (v.red ? '<BN-R: ' : '<BN: ') + v.toString(10) + '>'
      }
    }
    console.log(
      `${key}:`,
      util.inspect(v, { showHidden: true, depth: null, colors: true })
    )
  }
}

const dbgHex = varObj => {
  if (!DEBUG) return
  console.log(
    util.inspect(varObj, { showHidden: true, depth: null, colors: true })
  )
}
