const BigNumber = web3.BigNumber
const Helper = require("./helper.js")

require("chai")
    .use(require("chai-as-promised"))
    .use(require('chai-bignumber')(BigNumber))
    .should()

const DutchExchange = artifacts.require("DutchExchange")
const PriceOracleInterface = artifacts.require("PriceOracleInterface")
const DxMarketMaker = artifacts.require("DxMarketMaker")
const TestToken = artifacts.require("TestToken")
const EtherToken = artifacts.require("EtherToken")

tokenDeployedIndex = 0

DEBUG = true

contract('DxMarketMaker', async (accounts) => {
    async function deployToken() {
        dbg('Deploying token number ' + tokenDeployedIndex)
        return await TestToken.new(
            "Some Token",
            "KNC" + tokenDeployedIndex++,
            18,
            {from: admin}
        )
    }

    // async function getTokenListingFundingInWei() {
    //     // TODO: threshold is in USD / 1e18, convert to ETH using their Oracle.
    //     // return await dx.thresholdNewTokenPair()
    //     return 1e20
    // }

    // TODO: use oracle, last price, etc.
    const enoughKncToStartAuction = () => 1e22

    const dbgVolumesAndPrices = async (st, bt, auctionIndex) => {
        const stSymbol = await st.symbol()
        const btSymbol = await bt.symbol()
        dbg(`... ST: ${stSymbol}, BT: ${btSymbol}`)
        const sellVolume = await dx.sellVolumesCurrent(st.address, bt.address)
        const buyVolume = await dx.buyVolumes(st.address, bt.address)
        const [num, den] = await dx.getCurrentAuctionPrice(
            st.address,
            bt.address,
            auctionIndex
        )
        const remainingSellVolume = sellVolume - buyVolume.mul(num).div(den)
        const remainingBuyVolume = sellVolume.mul(num).div(den) - buyVolume
        dbg(`...... sellVolumesCurrent: ${sellVolume} ${stSymbol}`)
        dbg(`...... buyVolumes: ${buyVolume} ${btSymbol}`)
        dbg(`...... price ${stSymbol}/${btSymbol} is ${num}/${den}`)
        dbg(`...... remaining SELL tokens: ${remainingSellVolume} ${stSymbol}`)
        dbg(`...... remaining BUY tokens: ${remainingBuyVolume} ${btSymbol}`)
        return [remainingSellVolume, remainingBuyVolume]
    }

    async function deployTokenAddToDxAndClearFirstAuction() {
        const lister = admin
        const initialWethWei = 1e20
        const knc = await deployToken()
        const kncSymbol = await knc.symbol()
        dbg(`======================================`)
        dbg(`= Start initializing ${kncSymbol}`)
        dbg(`======================================`)
        dbg(`\n--- deployed ${kncSymbol}`)

        await weth.deposit({value: 1e22, from: lister})
        dbg(`\n--- prepared lister funds`)
        dbg(`lister has ${await weth.balanceOf(lister)} WETH`)
        dbg(`lister has ${await knc.balanceOf(lister)} ${kncSymbol}`)

        await weth.approve(dx.address, initialWethWei, {from: lister})
        await dx.deposit(weth.address, initialWethWei, {from: lister})
        dbg(`\n--- lister deposited ${initialWethWei} WETH in DX`)

        await dx.addTokenPair(
            weth.address,
            knc.address,
            initialWethWei,
            0,
            100, /* tokenToEthNum */
            1, /* tokenToEthDen */
            {from: lister}
        )
        dbg(`\n--- lister added ${kncSymbol} to DX`)

        await waitTimeInSeconds(6 * 60 * 60)
        const auctionIndex = await dx.getAuctionIndex(weth.address, knc.address)
        dbg(`\n--- waited 6 hours for auction ${auctionIndex} to start`)

        dbg(`\n--- available for auction:`)
        const [, remainingBuyVolume] = await dbgVolumesAndPrices(weth, knc, auctionIndex)
        await dbgVolumesAndPrices(knc, weth, auctionIndex)

        dbg(`\n--- lister wants to buy it all`)
        dbg(`fee is ${await dx.getFeeRatio(lister)}`)
        // const calculateAmountWithFee = async (amount) => {
        //     const [num, den] = await dx.getFeeRatio(lister)
        //     return amount / (1 - num / den)
        // }
        dbg(`remaining buy volume in ${kncSymbol} is ${remainingBuyVolume}`)
        // TODO: no fees if closing the auction??
        // const buyAmount = await calculateAmountWithFee(remainingBuyVolume)
        const buyAmount = remainingBuyVolume
        dbg(`lister will buy using ${buyAmount} ${kncSymbol}`)

        await knc.approve(dx.address, buyAmount, {from: lister})
        await dx.deposit(knc.address, buyAmount, {from: lister})
        dbg(`\n--- lister deposited ${buyAmount} ${kncSymbol}`)

        dbg(`+++ current lister balance:`)
        dbg(`   lister WETH balance is ${await dx.balances(weth.address, lister)}`)
        dbg(`   lister KNC balance is ${await dx.balances(knc.address, lister)}`)

        await dx.postBuyOrder(
            weth.address,
            knc.address,
            auctionIndex,
            buyAmount,
            {from: lister}
        )
        dbg(`\n--- lister bought using ${buyAmount} ${kncSymbol}`)
        dbg(`\n--- remaining:`)
        await dbgVolumesAndPrices(weth, knc, auctionIndex)
        await dbgVolumesAndPrices(knc, weth, auctionIndex)

        const currentAuctionIndex = await dx.getAuctionIndex(weth.address, knc.address)
        dbg(`\n--- is auction still open? ${currentAuctionIndex.equals(auctionIndex)}`)

        dbg(`+++ current lister balance:`)
        dbg(`   lister WETH balance is ${await dx.balances(weth.address, lister)}`)
        dbg(`   lister KNC balance is ${await dx.balances(knc.address, lister)}`)

        dbg(`XXX (4)`)
        dbg(`X1 current auctionIndex(knc, weth) is ${await dx.getAuctionIndex(weth.address, knc.address)}`)
        dbg(`X2 my auctionIndex is ${auctionIndex}`)
        dbg(`X3 sellerBalance is ${await dx.sellerBalances(weth.address, knc.address, auctionIndex, lister)}`)
        dbg(`X4 closingPrice is ${await dx.closingPrices(weth.address, knc.address, auctionIndex)}`)
        const [fundsRetuned, ] = await dx.claimSellerFunds.call(
            weth.address,
            knc.address,
            lister,
            auctionIndex,
            {from: lister}
        )
        dbg(`YYY`)
        await dx.claimSellerFunds(
            weth.address,
            knc.address,
            lister,
            auctionIndex,
            {from: lister}
        )
        dbg(`\n--- lister claimed seller funds`)
        dbg(`claimed funds S:weth, B:knc: ${fundsRetuned}`)

        const [fundsRetuned1, ] = await dx.claimBuyerFunds.call(
            weth.address,
            knc.address,
            lister,
            auctionIndex,
            {from: lister}
        )
        await dx.claimBuyerFunds(
            weth.address,
            knc.address,
            lister,
            auctionIndex,
            {from: lister}
        )
        dbg(`\n--- lister claimed buyer funds`)
        dbg(`claimed funds S:weth, B:knc: ${fundsRetuned1}`)

        const [fundsRetuned2, ] = await dx.claimBuyerFunds.call(
            knc.address,
            weth.address,
            lister,
            auctionIndex,
            {from: lister}
        )
        await dx.claimBuyerFunds(
            knc.address,
            weth.address,
            lister,
            auctionIndex,
            {from: lister}
        )
        dbg(`claimed funds S:knc, B:weth: ${fundsRetuned2}`)

        const listerWethBalance = await dx.balances(weth.address, lister)
        const listerKncBalance = await dx.balances(knc.address, lister)
        dbg(`+++ current lister balance:`)
        dbg(`   lister DX WETH balance is ${listerWethBalance}`)
        dbg(`   lister DX KNC balance is ${listerKncBalance}`)
        dbg(`   lister WETH balance is ${await weth.balanceOf(lister)}`)
        dbg(`   lister KNC balance is ${await knc.balanceOf(lister)}`)

        await dx.withdraw(weth.address, listerWethBalance, {from: lister})
        await dx.withdraw(knc.address, listerKncBalance, {from: lister})
        dbg(`--- lister withdrew WETH and KNC balances`)
        dbg(`+++ current lister balance:`)
        dbg(`   lister DX WETH balance is ${await dx.balances(weth.address, lister)}`)
        dbg(`   lister DX KNC balance is ${await dx.balances(knc.address, lister)}`)
        dbg(`   lister WETH balance is ${await weth.balanceOf(lister)}`)
        dbg(`   lister KNC balance is ${await knc.balanceOf(lister)}`)

        dbg(`======================================`)
        dbg(`= Finished initializing ${kncSymbol}`)
        dbg(`======================================`)
        return knc
    }

    before('setup accounts', async () => {
        admin = accounts[0]
        seller1 = accounts[1]
        buyer1 = accounts[2]
        user = accounts[3]
        operator = accounts[4]

        weth = await EtherToken.deployed()
        dxmm = await DxMarketMaker.deployed()
        dx = DutchExchange.at(await dxmm.dx())
        dxPriceOracle = PriceOracleInterface.at(await dx.ethUSDOracle())

        await dxmm.addOperator(operator, {from: admin})

        token = await deployTokenAddToDxAndClearFirstAuction()
    })

    it("admin should deploy token, add to dx, and conclude the first auction", async () => {
        const knc = await deployTokenAddToDxAndClearFirstAuction()

        const nextAuctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
        nextAuctionIndex.should.be.bignumber.equal(2)
    })

    it("seller can sell KNC and buyer can buy it", async () => {
        const knc = await deployTokenAddToDxAndClearFirstAuction()
        const kncSymbol = await knc.symbol()

        const kncSellAmount = enoughKncToStartAuction()
        await knc.transfer(seller1, kncSellAmount, {from: admin})
        dbg(`\n--- seller now has ${await knc.balanceOf(seller1)} ${kncSymbol}`)

        dbg(`next auction starts at ${await dx.getAuctionStart(knc.address, weth.address)}`)

        await knc.approve(dx.address, kncSellAmount, {from: seller1})
        let [newBal, auctionIndex, newSellerBal] = await dx.depositAndSell.call(
            knc.address,
            weth.address,
            kncSellAmount,
            {from: seller1}
        )
        await dx.depositAndSell(
            knc.address,
            weth.address,
            kncSellAmount,
            {from: seller1}
        )
        dbg(`\n--- seller called depositAndSell: newBal: ${newBal}, auctionIndex: ${auctionIndex}, newSellerBal: ${newSellerBal}`)
        dbg(`seller DX WETH balance is ${await dx.balances(weth.address, seller1)}`)
        dbg(`seller DX KNC balance is ${await dx.balances(knc.address, seller1)}`)
        await dbgVolumesAndPrices(knc, weth, auctionIndex)

        const timeNow = await blockChainTime()
        const auctionStartTime = await dx.getAuctionStart(knc.address, weth.address)
        const secondsToWait = auctionStartTime - timeNow
        dbg(`time now is ${timeNow}`)
        dbg(`next auction starts at ${auctionStartTime} (in ${secondsToWait} seconds)`)

        await waitTimeInSeconds(secondsToWait)
        dbg(`\n--- waited until auction started`)
        dbg(`time now is ${await blockChainTime()}`)
        await dbgVolumesAndPrices(knc, weth, auctionIndex)

        // now check if buyer wants to buyAmount
        const [lastNum, lastDen] = await dx.getPriceOfTokenInLastAuction(knc.address)
        const targetPrice = lastNum / lastDen
        dbg(`\n--- buyer checks prices`)
        dbg(`buyer wants to buy at price of ${targetPrice}`)

        let num, den
        while(true) {
            [num, den] = await dx.getCurrentAuctionPrice(
                knc.address,
                weth.address,
                auctionIndex
            )
            if (num/den > targetPrice) {
                dbg(`... at ${await blockChainTime()} price is ${num/den} -> waiting 10 minutes.`)
                await waitTimeInSeconds(10 * 60)
            } else {
                dbg(`... at ${await blockChainTime()} price is ${num/den} -> Done waiting!`)
                break
            }
        }

        dbg(`\n--- buyer wants to buy everything`)
        const [, remainingBuyVolume] = await dbgVolumesAndPrices(knc, weth, auctionIndex)

        await weth.deposit({value: remainingBuyVolume, from: buyer1})
        await weth.approve(dx.address, remainingBuyVolume, {from: buyer1})
        await dx.deposit(weth.address, remainingBuyVolume, {from: buyer1})
        dbg(`buyer converted to WETH and deposited to DX`)
        dbg(`buyer DX WETH balance is ${await dx.balances(weth.address, buyer1)}`)

        await dx.postBuyOrder(
            knc.address,
            weth.address,
            auctionIndex,
            remainingBuyVolume,
            {from: buyer1}
        )
        dbg(`\n--- buyer bought everything`)
        await dbgVolumesAndPrices(knc, weth, auctionIndex)
        dbg(`buyer DX WETH balance is ${await dx.balances(weth.address, buyer1)}`)
        const currentAuctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
        dbg(`is auction still open? ${currentAuctionIndex.equals(auctionIndex)}`)

        await dx.claimBuyerFunds(
            knc.address,
            weth.address,
            buyer1,
            auctionIndex,
            {from: buyer1}
        )
        dbg(`\n--- buyer claimed the KNC`)
        const kncBalance = await dx.balances(knc.address, buyer1)
        dbg(`buyer DX KNC balance is ${kncBalance}`)
        dbg(`buyer DX WETH balance is ${await dx.balances(weth.address, buyer1)}`)

        await dx.withdraw(knc.address, kncBalance, {from: buyer1})
        dbg(`\n--- buyer withdrew all of the KNC`)
        dbg(`buyer KNC balance is ${await knc.balanceOf(buyer1)}`)
        dbg(`buyer DX KNC balance is ${await dx.balances(knc.address, buyer1)}`)
        dbg(`buyer DX WETH balance is ${await dx.balances(weth.address, buyer1)}`)

        dbg(`\n--- seller wants his money back as well`)
        dbg(`before:`)
        dbg(`seller WETH balance is ${await weth.balanceOf(seller1)}`)
        dbg(`seller DX WETH balance is ${await dx.balances(weth.address, seller1)}`)

        await dx.claimSellerFunds(
            knc.address,
            weth.address,
            seller1,
            auctionIndex,
            {from: seller1}
        )
        const wethBalance = await dx.balances(weth.address, seller1)
        dbg(`after claiming:`)
        dbg(`seller WETH balance is ${await weth.balanceOf(seller1)}`)
        dbg(`seller DX WETH balance is ${wethBalance}`)

        await dx.withdraw(weth.address, wethBalance, {from: seller1})
        dbg(`after withdrawing:`)
        dbg(`seller WETH balance is ${await weth.balanceOf(seller1)}`)
        dbg(`seller DX WETH balance is ${await dx.balances(weth.address, seller1)}`)

        assert(false)
    })

    it("should have a kyber network proxy configured", async () => {
        const kyberNetworkProxy = await dxmm.kyberNetworkProxy()

        kyberNetworkProxy.should.exist
    })

    it("reject creating dxmm with DutchExchange address 0", async () => {
        try {
            await DxMarketMaker.new(
                0,
                weth.address,
                await dxmm.kyberNetworkProxy()
            )
            assert(false, "throw was expected in line above.")
        } catch(e){
            assert(
                Helper.isRevertErrorMessage(e),
                "expected revert but got: " + e)
        }
    })

    it("reject creating dxmm with WETH address 0", async () => {
        try {
            await DxMarketMaker.new(
                dx.address,
                0,
                await dxmm.kyberNetworkProxy()
            )
        } catch(e){
            assert(
                Helper.isRevertErrorMessage(e),
                "expected revert but got: " + e)
        }
    })

    it("reject creating dxmm with KyberNetworkProxy address 0", async () => {
        try {
            await DxMarketMaker.new(dx.address, weth.address, 0)
        } catch(e){
            assert(
                Helper.isRevertErrorMessage(e),
                "expected revert but got: " + e)
        }
    })

    it("should allow admin to withdraw from dxmm", async () => {
        await weth.deposit({value: 1e10, from: admin})
        const initialWethBalance = await weth.balanceOf(admin)

        await weth.transfer(dxmm.address, 1e10, {from: admin})
        await dxmm.withdrawToken(weth.address, 1e10, admin), {from: admin}

        const wethBalance = await weth.balanceOf(admin)
        wethBalance.should.be.bignumber.equal(initialWethBalance)
    })

    it("reject withdrawing from dxmm by non-admin users", async () => {
        await weth.deposit({value: 1e10, from: admin})
        await weth.transfer(dxmm.address, 1e10, {from: admin})

        try {
            await dxmm.withdrawToken(weth.address, 1e10, user, {from: user})
        } catch(e){
            assert(
                Helper.isRevertErrorMessage(e),
                "expected revert but got: " + e)
        }
    })

    it("should allow depositing to DX by admin", async () => {
        await weth.deposit({value: 1e10, from: admin})
        await weth.transfer(dxmm.address, 1e10, {from: admin})
        const balanceBefore = await dx.balances(weth.address, dxmm.address)

        const updatedBalance = await dxmm.depositToDx.call(weth.address, 1e10, {from: admin})
        await dxmm.depositToDx(weth.address, 1e10, {from: admin})

        const balanceAfter = await dx.balances(weth.address, dxmm.address)
        updatedBalance.should.be.bignumber.equal(balanceAfter)
        balanceAfter.should.be.bignumber.equal(balanceBefore + 1e10)
    })

    it("reject depositing to DX by non-admins", async () => {
        await weth.deposit({value: 1e10, from: user})
        await weth.transfer(dxmm.address, 1e10, {from: user})

        try {
            await dxmm.depositToDx(weth.address, 1e10, {from: user})
        } catch(e){
            assert(
                Helper.isRevertErrorMessage(e),
                "expected revert but got: " + e)
        }
    })

    it("should allow withdrawing from DX by admin", async () => {
        await weth.deposit({value: 1e10, from: admin})
        await weth.transfer(dxmm.address, 1e10, {from: admin})
        const wethBalanceBefore = await weth.balanceOf(dxmm.address)
        const dxBalanceBefore = await dx.balances(weth.address, dxmm.address)

        await dxmm.depositToDx(weth.address, 1e10, {from: admin})
        await dxmm.withdrawFromDx(weth.address, 1e10, {from: admin})

        const dxBalanceAfter = await dx.balances(weth.address, dxmm.address)
        dxBalanceAfter.should.be.bignumber.equal(dxBalanceBefore)

        const wethBalanceAfter = await weth.balanceOf(dxmm.address)
        wethBalanceAfter.should.be.bignumber.equal(wethBalanceBefore)
    })

    it("reject withdrawing from DX by non-admins", async () => {
        await weth.deposit({value: 1e10, from: admin})
        await weth.transfer(dxmm.address, 1e10, {from: admin})
        await dxmm.depositToDx(weth.address, 1e10, {from: admin})

        try {
            await dxmm.withdrawFromDx(weth.address, 1e10, {from: user})
        } catch(e){
            assert(
                Helper.isRevertErrorMessage(e),
                "expected revert but got: " + e)
        }
    })

    xit("should allow checking if balance is above new auction threshold", async () => {
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

    it("should provide auction threshold in token", async () => {
        const dxmmThresholdNewAuction = await dxmm.thresholdNewAuction.call(token.address)
        await dxmm.thresholdNewAuction(token.address)

        const thresholdNewAuctionUSD = await dx.thresholdNewAuction()
        const usdEthPrice = await dxPriceOracle.getUSDETHPrice.call()
        const [lastPriceNum, lastPriceDen] = await dx.getPriceOfTokenInLastAuction(token.address)
        const thresholdNewAuctionToken = Number.parseInt(
            thresholdNewAuctionUSD.div(usdEthPrice.mul(lastPriceNum).div(lastPriceDen))
        )
        dbg(`new auction threashold is ${thresholdNewAuctionUSD} USD`)
        dbg(`oracle USDETH price is ${await usdEthPrice}`)
        dbg(`last auction price was ${lastPriceNum}/${lastPriceDen} (${lastPriceNum.div(lastPriceDen)})`)
        const tokenUsdPrice = usdEthPrice.mul(lastPriceNum).div(lastPriceDen)
        dbg(`Token price in USD is ${tokenUsdPrice}`)
        dbg(`new auction threashold is ${thresholdNewAuctionToken} TOKEN`)

        assert.equal(dxmmThresholdNewAuction, thresholdNewAuctionToken)
    })

    xit("should allow getting amount of KNC to start next auction", async () => {
        const knc = await deployTokenAddToDxAndClearFirstAuction()

        // TODO: make sure no auction is running or waiting
        const kncToStartAuction = await dxmm.tokenAmountToStartAuction(knc.address)

        const auctionThreshold = await dx.thresholdNewAuction()
        const [num, den] = await dx.getPriceOfTokenInLastAuction(knc.address)
        dbg(`new auction threashold is ${auctionThreshold} USD`)
        dbg(`last closing price was ${num}/${den}`)

        dbg(`new auction threshold is ${auctionThreshold} USD -> ${auctionThreholdKnc}`)

        kncToStartAuction.should.be.bignumber.equal(auctionThreholdKnc)
    })

    it("should allow getting amount of KNC to start next auction, after some other user already posted sell order")


    // ---------------

    it("should clear the auction when we buy everything")
    it("should be able to add token, wait for initial sell to end, then start new sale")
    it("should be able to check if should buy back (using kyber price)")
    it("should be able to withdraw all the money from dxmm")
    it("should be able to withdraw all of the money from dx")
    it("should start sale only if has enough ETH to end")

    const flow = `
        // claim unclaimed KNC and WETH
        if currentAuctionIndex > lastClaimedAuctionIndex:
            auctionIndices = [lastClaimedAuctionIndex + 1 to currentAuctionIndex(excluding)]
            claimTokensFromSeveralAuctionsAsSeller(knc, weth, auctionIndices)
            claimTokensFromSeveralAuctionsAsBuyer(knc, weth, auctionIndices)

        switch(KncAuctionState()):
            case WAITING_FOR_AUCTION_TIMEOUT:
                return  // nothing to do but wait now

            case NO_AUCTION_RUNNING_OR_WAITING:
                missingKncToStartAuction = calculateMissingTokenForAuctionStart(knc)
                if missingKncToStartAuction > 0:
                    if dxmm.balanace(KNC) < missingKncToStartAuction:
                        // TODO: buy required KNC, start the auction and then notify
                        FINISH WITH ERROR - desposit KNC
                    deposit(missingKncToStartAuction)

                // trigger Auction
                postSellOrder(KNC, WETH, minimumAuctionAmount)

            case AUCTION_RUNNING:
                if isKncCheaperThanOnKyber():
                    buy the KNC that we are selling in the auction
    `
})

// TODO: Extract to util class
async function waitTimeInSeconds(seconds) {
     await Helper.sendPromise('evm_increaseTime', [seconds])
     await Helper.sendPromise('evm_mine', [])
}

// TODO: Extract to util class
function blockChainTime() {
    return web3.eth.getBlock(web3.eth.blockNumber).timestamp
}

async function dbg(...args) {
    if (DEBUG) console.log(...args)
}
