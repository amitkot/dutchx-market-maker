require('web3')

const Helper = require("./helper.js")

const BN = web3.utils.BN
// TODO: this change is not recognized for some reason in the test cases:
// TODO: Extract to util class
// Find Ceil(`this` / `num`)
BN.prototype.divCeil = function divCeil (num) {
    var dm = this.divmod(num)

    // Fast case - exact division
    if (dm.mod.isZero()) return dm.div

    // Round up
    return dm.div.negative !== 0 ? dm.div.isubn(1) : dm.div.iaddn(1)
}

require("chai")
    .use(require('bn-chai')(BN))
    // TODO: this chai-as-promised doesn't seem to work with bn-chai, open a bug
    // Install last to promisify all registered asserters
    // .use(require("chai-as-promised"))
    .should()

const truffleAssert = require('truffle-assertions');

const DutchExchange = artifacts.require("DutchExchange")
const PriceOracleInterface = artifacts.require("PriceOracleInterface")
const DxMarketMaker = artifacts.require("DxMarketMaker")
const TestToken = artifacts.require("TestToken")
const EtherToken = artifacts.require("EtherToken")
const MockKyberNetworkProxy = artifacts.require("MockKyberNetworkProxy")

tokenDeployedIndex = 0

DEBUG = true

contract("DxMarketMaker", async accounts => {
    const deployToken = async () => {
        dbg("Deploying token number " + tokenDeployedIndex)
        return await TestToken.new(
            "Some Token",
            "KNC" + tokenDeployedIndex++,
            18,
            {from: admin}
        )
    }

    const calculateRemainingBuyVolume = async (sellToken, buyToken, auctionIndex) => {
        const sellVolume = await dx.sellVolumesCurrent.call(sellToken.address, buyToken.address)
        const buyVolume = await dx.buyVolumes.call(sellToken.address, buyToken.address)
        const price = await dx.getCurrentAuctionPrice.call(
            sellToken.address,
            buyToken.address,
            auctionIndex
        )
        // Auction index is in the future.
        if (price.den == 0) return 0;

        return sellVolume.mul(price.num).div(price.den).sub(buyVolume)
    }

    const buyAuctionTokens = async (token, auctionIndex, amount, buyer, addFee) => {
        if (addFee) {
            amount = await dxmm.addFee(amount)
        }
        await weth.transfer(buyer, amount, { from: admin })
        await weth.approve(dx.address, amount, { from: buyer })
        await dx.deposit(weth.address, amount, {from: buyer})
        await dx.postBuyOrder(
            token.address /* sellToken */,
            weth.address /* buyToken */,
            auctionIndex,
            amount,
            {from: buyer}
        )
    }

    const sellTokens = async (token, amount, seller) => {
        tokenSellAmount = await dxmm.addFee(amount)
        await token.transfer(seller, tokenSellAmount, { from: admin })
        await token.approve(dx.address, tokenSellAmount, { from: seller })
        await dx.depositAndSell(
            token.address,
            weth.address,
            tokenSellAmount,
            {from: seller}
        )
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
        if (price.den != 0) {
            remainingSellVolume = (
                sellVolume.sub(buyVolume.mul(price.num).div(price.den))
            )
        }
        const remainingBuyVolume = await calculateRemainingBuyVolume(st, bt, auctionIndex)

        dbg(`...... sellVolumesCurrent: ${sellVolume} ${stSymbol}`)
        dbg(`...... buyVolumes: ${buyVolume} ${btSymbol}`)
        dbg(`...... price ${stSymbol}/${btSymbol} is ${price.num}/${price.den}`)
        dbg(`...... remaining SELL tokens: ${remainingSellVolume} ${stSymbol}`)
        dbg(`...... remaining BUY tokens: ${remainingBuyVolume} ${btSymbol}`)
    }

    async function deployTokenAddToDxAndClearFirstAuction() {
        const lister = admin
        const initialWethWei = web3.utils.toWei("100")
        const knc = await deployToken()
        const kncSymbol = await knc.symbol()
        dbg(`======================================`)
        dbg(`= Start initializing ${kncSymbol}`)
        dbg(`======================================`)
        dbg(`\n--- deployed ${kncSymbol}`)

        await weth.deposit({ value: web3.utils.toWei("10000"), from: lister })
        dbg(`\n--- prepared lister funds`)
        dbg(`lister has ${await weth.balanceOf(lister)} WETH`)
        dbg(`lister has ${await knc.balanceOf(lister)} ${kncSymbol}`)

        await weth.approve(dx.address, initialWethWei, { from: lister })
        await dx.deposit(weth.address, initialWethWei, { from: lister })
        dbg(`\n--- lister deposited ${initialWethWei} WETH in DX`)

        // Using 0 amount as mock kyber contract returns fixed rate anyway.
        const kyberRate = await dxmm.getKyberRate(knc.address, weth.address, 0)
        // dividing by 2 to make numbers smaller, avoid reverts due to fear
        // of overflow
        const initialClosingPriceNum = kyberRate.num.divn(2)
        const initialClosingPriceDen = kyberRate.den.divn(2)
        dbg(`initial rate is knc => weth is ${initialClosingPriceNum} / ${initialClosingPriceDen}`)
        dbg(`thresholdNewTokenPair is ${await dx.thresholdNewTokenPair()}`)
        dbg(`calling dx.addTokenPair(${weth.address}, ${knc.address}, ${initialWethWei}, 0, ${initialClosingPriceNum}, ${initialClosingPriceDen})`)
        await dx.addTokenPair(
            weth.address,
            knc.address,
            initialWethWei,
            0,
            // Passing the den and num in opposite direction as this is from
            // token to eth
            initialClosingPriceDen /* tokenToEthNum */,
            initialClosingPriceNum /* tokenToEthDen */,
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
        const remainingBuyVolume = await calculateRemainingBuyVolume(weth, knc, auctionIndex)
        dbg(`remaining buy volume in ${kncSymbol} is ${remainingBuyVolume}`)
        // TODO: no fees if closing the auction??
        // const buyAmount = await addFee(remainingBuyVolume)
        const buyAmount = remainingBuyVolume
        dbg(`lister will buy using ${buyAmount} ${kncSymbol}`)

        await knc.approve(dx.address, buyAmount, { from: lister })
        await dx.deposit(knc.address, buyAmount, { from: lister })
        dbg(`\n--- lister deposited ${buyAmount} ${kncSymbol}`)

        dbg(`+++ current lister balance:`)
        dbg(`   lister WETH balance is ${await dx.balances(weth.address, lister)}`)
        dbg(`   lister KNC balance is ${await dx.balances(knc.address, lister)}`)

        await dx.postBuyOrder(weth.address, knc.address, auctionIndex, buyAmount, {
            from: lister,
        })
        dbg(`\n--- lister bought using ${buyAmount} ${kncSymbol}`)
        dbg(`\n--- remaining:`)
        await dbgVolumesAndPrices(weth, knc, auctionIndex)
        await dbgVolumesAndPrices(knc, weth, auctionIndex)

        const currentAuctionIndex = await dx.getAuctionIndex(
            weth.address,
            knc.address
        )
        dbg(
            `\n--- is auction still open? ${currentAuctionIndex == auctionIndex}`
        )

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
            from: lister,
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
            from: lister,
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
            from: lister,
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

    // TODO: get sellToken, buyToken
    const triggerAuction = async (token, seller) => {
        const tokenSymbol = await token.symbol()
        let tokenSellAmount = await dxmm.calculateMissingTokenForAuctionStart(
            token.address,
            weth.address
        )
        dbg(`Missing amount without fee: ${tokenSellAmount}`)

        tokenSellAmount = await dxmm.addFee(tokenSellAmount)
        dbg(`Missing amount with fee: ${tokenSellAmount}`)

        await token.transfer(seller, tokenSellAmount, { from: admin })
        dbg(`\n--- seller now has ${await token.balanceOf(seller)} ${tokenSymbol}`)

        dbg(
            `next auction starts at ${await dx.getAuctionStart(
                token.address,
                weth.address
            )}`
        )

        await token.approve(dx.address, tokenSellAmount, { from: seller })
        let res = await dx.depositAndSell.call(
            token.address,
            weth.address,
            tokenSellAmount,
            { from: seller }
        )
        await dx.depositAndSell(token.address, weth.address, tokenSellAmount, {
            from: seller,
        })
        dbg(
            `\n--- seller called depositAndSell: newBal: ${res.newBal}, auctionIndex: ${res.auctionIndex}, newSellerBal: ${res.newSellerBal}`
        )
        dbg(`seller DX WETH balance is ${await dx.balances(weth.address, seller)}`)
        dbg(`seller DX KNC balance is ${await dx.balances(token.address, seller)}`)
        await dbgVolumesAndPrices(token, weth, res.auctionIndex)

        return res.auctionIndex
    }

    const waitForTriggeredAuctionToStart = async (sellToken, buyToken, auctionIndex) => {
        const timeNow = await blockChainTime()
        const auctionStartTime = await dx.getAuctionStart(sellToken.address, buyToken.address)
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

    const waitUntilKyberPriceReached = async (sellToken, buyToken, auctionIndex, amount) => {
        let price
        let kyberPrice
        while (true) {
            price = await dx.getCurrentAuctionPrice(
                sellToken.address,
                buyToken.address,
                auctionIndex
            )
            const t = await blockChainTime()
            kyberPrice = await dxmm.getKyberRate(sellToken.address, buyToken.address, amount)
            const a = price.num.mul(kyberPrice.den)
            const b = kyberPrice.num.mul(price.den)
            if (a <= b) {
                dbg(`... at ${t} price is ${price.num / price.den} -> Done waiting!`)
                break
            }

            const targetRate = kyberPrice.num / kyberPrice.den
            dbg(`... at ${t} price is ${price.num / price.den} (target: ${targetRate})-> waiting 10 minutes.`)
            await waitTimeInSeconds(10 * 60)
        }
    }

    const buyEverythingInAuction = async (knc, auctionIndex, buyer) => {
        dbg(`\n--- buyer wants to buy everything`)
        await dbgVolumesAndPrices(knc, weth, auctionIndex)
        const remainingBuyVolume = await calculateRemainingBuyVolume(knc, weth, auctionIndex)
        console.log("remainingBuyVolume:", remainingBuyVolume.toString())
        shouldBuyVolume = remainingBuyVolume.addn(1)
        console.log("shouldBuyVolume:", shouldBuyVolume.toString())

        await weth.deposit({ value: shouldBuyVolume, from: buyer })
        await weth.approve(dx.address, shouldBuyVolume, { from: buyer })
        await dx.deposit(weth.address, shouldBuyVolume, { from: buyer })
        dbg(`buyer converted to WETH and deposited to DX`)
        dbg(`buyer DX WETH balance is ${await dx.balances(weth.address, buyer)}`)

        await dx.postBuyOrder(
            knc.address,
            weth.address,
            auctionIndex,
            shouldBuyVolume,
            { from: buyer }
        )
    }

    const triggerAndClearAuction = async (sellToken, buyToken, user) => {
        // TODO: pass buyToken to helper functions
        dbg(`\n--- Triggerring and clearing new auction`)
        const auctionIndex = await triggerAuction(sellToken, user)
        await waitForTriggeredAuctionToStart(sellToken, buyToken, auctionIndex)
        await buyEverythingInAuction(sellToken, auctionIndex, user)

        const state = await dxmm.getAuctionState(sellToken.address, buyToken.address)
        state.should.be.eq.BN(NO_AUCTION_TRIGGERED)
    }

    const dxmmTriggerAndClearAuction = async (sellToken, buyToken) => {
        // Trigger an auction
        await fundDxmmAndDepositToDxToken(sellToken)
        await dxmm.triggerAuction(sellToken.address, buyToken.address)
        const auctionIndex = await dx.getAuctionIndex(sellToken.address, buyToken.address)

        // Wait for auction to start
        await waitForTriggeredAuctionToStart(sellToken, buyToken, auctionIndex)

        // Buy in auction
        await fundDxmmAndDepositToDxWethForAuction(sellToken, buyToken, auctionIndex)
        await dxmm.buyInAuction(sellToken.address, buyToken.address)

        return auctionIndex
    }

    const fundDxmmAndDepositToDxToken = async (token) => {
        const amount = web3.utils.toWei("100000000")
        dbg(`Funding dxmm with ${amount} WETH and depositing to DX`)
        await token.transfer(dxmm.address, amount, { from: admin })
        await dxmm.depositToDx(token.address, amount, { from: admin })
    }

    const fundDxmmAndDepositToDxWethForAuction = async (knc, weth, auctionIndex) => {
        // This is more WETH than will eventually be required as the rate
        // improves block by block and we waste a couple of blocks in These
        // deposits
        const tokensToBuy = await dxmm.calculateAuctionBuyTokens(
            knc.address,
            weth.address,
            auctionIndex,
            dxmm.address
        )
        await weth.deposit({ value: tokensToBuy, from: admin })
        await weth.transfer(dxmm.address, tokensToBuy, { from: admin })
        await dxmm.depositToDx(weth.address, tokensToBuy, { from: admin });
    }

    before("setup accounts", async () => {
        admin = accounts[0]
        seller1 = accounts[1]
        buyer1 = accounts[2]
        user = accounts[3]
        operator = accounts[4]

        weth = await EtherToken.deployed()
        dxmm = await DxMarketMaker.deployed()
        dx = await DutchExchange.at(await dxmm.dx())

        await dxmm.addOperator(operator, { from: admin })

        NO_AUCTION_TRIGGERED = await dxmm.NO_AUCTION_TRIGGERED()
        AUCTION_TRIGGERED_WAITING = await dxmm.AUCTION_TRIGGERED_WAITING()
        AUCTION_IN_PROGRESS = await dxmm.AUCTION_IN_PROGRESS()

        DX_AUCTION_START_WAITING_FOR_FUNDING = await dxmm.DX_AUCTION_START_WAITING_FOR_FUNDING()
    })

    it("admin should deploy token, add to dx, and conclude the first auction", async () => {
        const knc = await deployTokenAddToDxAndClearFirstAuction()

        const nextAuctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
        nextAuctionIndex.should.be.eq.BN(2)
    })

    it("seller can sell KNC and buyer can buy it", async () => {
        const knc = await deployTokenAddToDxAndClearFirstAuction()

        const auctionIndex = await triggerAuction(knc, seller1)
        await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

        // now check if buyer wants to buyAmount
        dbg(`\n--- buyer checks prices`)
        dbg(`buyer wants to buy and will wait for target price`)


        // TODO: use actual amount
        await waitUntilKyberPriceReached(knc, weth, auctionIndex, 10000)

        // Buyer buys everything
        await buyEverythingInAuction(knc, auctionIndex, buyer1)

        dbg(`\n--- buyer bought everything`)
        await dbgVolumesAndPrices(knc, weth, auctionIndex)
        dbg(`buyer DX WETH balance is ${await dx.balances(weth.address, buyer1)}`)
        const currentAuctionIndex = await dx.getAuctionIndex(
            knc.address,
            weth.address
        )

        dbg(`is auction still open? ${currentAuctionIndex == auctionIndex}`)
        currentAuctionIndex.should.not.eq.BN(auctionIndex)

        dbg(`dx.claimBuyerFunds(${knc.address}, ${weth.address}, ${buyer1}, ${auctionIndex})`)
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

        await dx.withdraw(knc.address, kncBalance, { from: buyer1 })
        dbg(`\n--- buyer withdrew all of the KNC`)
        dbg(`buyer KNC balance is ${await knc.balanceOf(buyer1)}`)
        dbg(`buyer DX KNC balance is ${await dx.balances(knc.address, buyer1)}`)
        dbg(`buyer DX WETH balance is ${await dx.balances(weth.address, buyer1)}`)

        dbg(`\n--- seller wants his money back as well`)
        dbg(`before:`)
        dbg(`seller WETH balance is ${await weth.balanceOf(seller1)}`)
        dbg(`seller DX WETH balance is ${await dx.balances(weth.address, seller1)}`)
        dbg(`seller KNC balance is ${await knc.balanceOf(seller1)}`)
        dbg(`seller DX KNC balance is ${await dx.balances(knc.address, seller1)}`)

        await dx.claimSellerFunds(
            knc.address,
            weth.address,
            seller1,
            auctionIndex,
            { from: seller1 }
        )
        const wethBalance = await dx.balances(weth.address, seller1)
        dbg(`after claiming:`)
        dbg(`seller WETH balance is ${await weth.balanceOf(seller1)}`)
        dbg(`seller DX WETH balance is ${wethBalance}`)
        dbg(`seller KNC balance is ${await knc.balanceOf(seller1)}`)
        dbg(`seller DX KNC balance is ${await dx.balances(knc.address, seller1)}`)

        await dx.withdraw(weth.address, wethBalance, { from: seller1 })
        dbg(`after withdrawing:`)
        dbg(`seller WETH balance is ${await weth.balanceOf(seller1)}`)
        dbg(`seller DX WETH balance is ${await dx.balances(weth.address, seller1)}`)
        dbg(`seller KNC balance is ${await knc.balanceOf(seller1)}`)
        dbg(`seller DX KNC balance is ${await dx.balances(knc.address, seller1)}`)
    })

    it("should have a kyber network proxy configured", async () => {
        const kyberNetworkProxy = await dxmm.kyberNetworkProxy()

        kyberNetworkProxy.should.exist
    })

    it("reject creating dxmm with DutchExchange address 0", async () => {
        try {
            await DxMarketMaker.new(0, weth.address, await dxmm.kyberNetworkProxy())
            assert(false, "throw was expected in line above.")
        } catch (e) {
            assert(Helper.isRevertErrorMessage(e), "expected revert but got: " + e)
        }
    })

    it("reject creating dxmm with WETH address 0", async () => {
        try {
            await DxMarketMaker.new(dx.address, 0, await dxmm.kyberNetworkProxy())
        } catch (e) {
            assert(Helper.isRevertErrorMessage(e), "expected revert but got: " + e)
        }
    })

    it("reject creating dxmm with KyberNetworkProxy address 0", async () => {
        try {
            await DxMarketMaker.new(dx.address, weth.address, 0)
        } catch (e) {
            assert(Helper.isRevertErrorMessage(e), "expected revert but got: " + e)
        }
    })

    it("should allow admin to withdraw from dxmm", async () => {
        const amount = web3.utils.toWei("1")
        await weth.deposit({ value: amount, from: admin })
        const initialWethBalance = await weth.balanceOf(admin)

        await weth.transfer(dxmm.address, amount, { from: admin })
        await dxmm.withdrawToken(weth.address, amount, admin), { from: admin }

        const wethBalance = await weth.balanceOf(admin)
        wethBalance.should.be.eq.BN(initialWethBalance)
    })

    it("reject withdrawing from dxmm by non-admin users", async () => {
        const amount = web3.utils.toWei("1")
        await weth.deposit({ value: amount, from: admin })
        await weth.transfer(dxmm.address, amount, { from: admin })

        try {
            await dxmm.withdrawToken(weth.address, amount, user, { from: user })
        } catch (e) {
            assert(Helper.isRevertErrorMessage(e), "expected revert but got: " + e)
        }
    })

    it("should allow depositing to DX by admin", async () => {
        const amount = web3.utils.toWei("1")
        await weth.deposit({ value: amount, from: admin })
        await weth.transfer(dxmm.address, amount, { from: admin })
        const balanceBefore = await dx.balances(weth.address, dxmm.address)

        const updatedBalance = await dxmm.depositToDx.call(
            weth.address,
            amount,
            {from: admin}
        )
        await dxmm.depositToDx(weth.address, amount, { from: admin })

        const balanceAfter = await dx.balances(weth.address, dxmm.address)
        updatedBalance.should.be.eq.BN(balanceAfter)
        balanceAfter.should.be.eq.BN(balanceBefore.add(new BN(amount)))
    })

    it("reject depositing to DX by non-admins", async () => {
        const amount = web3.utils.toWei("1")
        await weth.deposit({ value: amount, from: user })
        await weth.transfer(dxmm.address, amount, { from: user })

        try {
            await dxmm.depositToDx(weth.address, amount, { from: user })
        } catch (e) {
            assert(Helper.isRevertErrorMessage(e), "expected revert but got: " + e)
        }
    })

    it("should allow withdrawing from DX by admin", async () => {
        const amount = web3.utils.toWei("1")
        await weth.deposit({ value: amount, from: admin })
        await weth.transfer(dxmm.address, amount, { from: admin })
        const wethBalanceBefore = await weth.balanceOf(dxmm.address)
        const dxBalanceBefore = await dx.balances(weth.address, dxmm.address)

        await dxmm.depositToDx(weth.address, amount, { from: admin })
        await dxmm.withdrawFromDx(weth.address, amount, { from: admin })

        const dxBalanceAfter = await dx.balances(weth.address, dxmm.address)
        dxBalanceAfter.should.be.eq.BN(dxBalanceBefore)

        const wethBalanceAfter = await weth.balanceOf(dxmm.address)
        wethBalanceAfter.should.be.eq.BN(wethBalanceBefore)
    })

    it("reject withdrawing from DX by non-admins", async () => {
        const amount = web3.utils.toWei("1")
        await weth.deposit({ value: amount, from: admin })
        await weth.transfer(dxmm.address, amount, { from: admin })
        await dxmm.depositToDx(weth.address, amount, { from: admin })

        try {
            await dxmm.withdrawFromDx(weth.address, amount, { from: user })
        } catch (e) {
            assert(Helper.isRevertErrorMessage(e), "expected revert but got: " + e)
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
        const divCeil = (first, second) => {
            var dm = first.divmod(second)

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

    describe("missing tokens to next auction", () => {
        it("calculate missing tokens in wei to start next auction", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const missingInWei = (
                await dxmm.calculateMissingTokenForAuctionStart.call(
                    knc.address,
                    weth.address
                )
            )

            const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
                knc.address
            )
            missingInWei.should.be.eq.BN(thresholdTokenWei)
        })

        it("calculate missing tokens in wei to start next auction after some other user sold", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const otherSellerAlreadySellsSome = async (kncSellAmount) => {
                await knc.transfer(seller1, kncSellAmount, { from: admin })
                await knc.approve(dx.address, kncSellAmount, { from: seller1 })
                await dx.depositAndSell(
                    knc.address, weth.address, kncSellAmount, {from: seller1,}
                )
            }
            // 10050
            const amount = await dxmm.addFee(10000)
            await otherSellerAlreadySellsSome(amount)

            const missingInWei = (
                await dxmm.calculateMissingTokenForAuctionStart.call(
                    knc.address,
                    weth.address
                )
            )

            const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
                knc.address
            )
            missingInWei.should.be.eq.BN(thresholdTokenWei.subn(10000))
        })

        it("auction is in progress - missing amount to start auction is 0", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)

            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            const missingInWei = (
                await dxmm.calculateMissingTokenForAuctionStart.call(
                    knc.address,
                    weth.address
                )
            )

            missingInWei.should.be.eq.BN(0)
        })

        it("auction triggered, had not started - missing amount to start auction is 0", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)

            const missingInWei = (
                await dxmm.calculateMissingTokenForAuctionStart.call(
                    knc.address,
                    weth.address
                )
            )

            missingInWei.should.be.eq.BN(0)
        })

        it("auction started, everything bought, waiting for next auction to trigger - missing amount to start auction is threshold", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            // Buyer buys everything
            await buyEverythingInAuction(knc, auctionIndex, buyer1)

            const missingInWei = (
                await dxmm.calculateMissingTokenForAuctionStart.call(
                    knc.address,
                    weth.address
                )
            )

            const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
                knc.address
            )
            missingInWei.should.be.eq.BN(thresholdTokenWei)
        })
    })

    describe("auction state", () => {
        it("no auction planned", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const state = await dxmm.getAuctionState(knc.address, weth.address)
            state.should.be.eq.BN(NO_AUCTION_TRIGGERED)
        })

        it("auction triggered, waiting for it to start", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            await triggerAuction(knc, seller1)

            const state = await dxmm.getAuctionState(knc.address, weth.address)
            state.should.be.eq.BN(AUCTION_TRIGGERED_WAITING)
        })

        it("auction in progress", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            const state = await dxmm.getAuctionState(knc.address, weth.address)
            state.should.be.eq.BN(AUCTION_IN_PROGRESS)
        })

        it("after auction ended", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)
            await buyEverythingInAuction(knc, auctionIndex, buyer1)

            const state = await dxmm.getAuctionState(knc.address, weth.address)
            state.should.be.eq.BN(NO_AUCTION_TRIGGERED)
        })
    })

    describe("addFee", () => {
        it("for amount 0", async () => {
            const amountWithFee = await dxmm.addFee(0)

            amountWithFee.should.be.eq.BN(0)
        })

        it("for amount 200", async () => {
            const amountWithFee = await dxmm.addFee(200)

            amountWithFee.should.be.eq.BN(201)
        })
    })

    describe("sell funds in current auction", () => {
        it("auction in progress, single seller", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
                knc.address
            )

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            const tokensSoldInCurrentAuction = (
                await dxmm.tokensSoldInCurrentAuction(
                    knc.address /* sellToken */,
                    weth.address /* buyToken */,
                    auctionIndex /* auctionIndex */,
                    seller1 /* account */
                )
            )

            tokensSoldInCurrentAuction.should.be.eq.BN(auctionTokenSellAmount)
        })

        it("auction in progress, multiple sellers", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
                knc.address
            )

            // Other sellers sells KNC in auction
            await sellTokens(knc, 10000, user)

            const seller1TokenSellAmount = auctionTokenSellAmount.subn(10000)

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            const tokensSoldInCurrentAuction = (
                await dxmm.tokensSoldInCurrentAuction(
                    knc.address /* sellToken */,
                    weth.address /* buyToken */,
                    auctionIndex /* auctionIndex */,
                    seller1 /* account */
                )
            )

            tokensSoldInCurrentAuction.should.be.eq.BN(seller1TokenSellAmount)
        })

        it("auction triggered", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
                knc.address
            )

            const auctionIndex = await triggerAuction(knc, seller1)

            const tokensSoldInCurrentAuction = (
                await dxmm.tokensSoldInCurrentAuction(
                    knc.address /* sellToken */,
                    weth.address /* buyToken */,
                    auctionIndex /* auctionIndex */,
                    seller1 /* account */
                )
            )

            tokensSoldInCurrentAuction.should.be.eq.BN(auctionTokenSellAmount)
        })

        it("no auction triggered", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const tokensSoldInCurrentAuction = (
                await dxmm.tokensSoldInCurrentAuction(
                    knc.address /* sellToken */,
                    weth.address /* buyToken */,
                    await dx.getAuctionIndex(knc.address, weth.address) /* auctionIndex */,
                    seller1 /* account */
                )
            )

            tokensSoldInCurrentAuction.should.be.eq.BN(0)
        })
    })

    describe("calculate buy volume from sell volume in auction", () => {
        it("auction in progress, single seller, single buyer, calculation as expected", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
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

        it("auction in progress, single seller, single buyer, successfully buy calculated amount", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
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

            // 1 - Auction cleared
            const currentAuctionIndex = await dx.getAuctionIndex(
                knc.address,
                weth.address
            )
            currentAuctionIndex.should.be.eq.BN(auctionIndex.addn(1))

            // 2 - No WETH in user balance
            const balanceAfter = await dx.balances.call(weth.address, seller1)
            // No WETH left in balance means that we bought the exact amount in
            // the auction
            balanceAfter.should.be.eq.BN(balanceBefore)
        })

        it("auction in progress, single seller, multiple buyers", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            const expectedBuyTokens = await calculateRemainingBuyVolume(
                knc,
                weth,
                auctionIndex
            )

            // Note: this action is composed of a number of function calls, so a
            // couple of blocks may pass which might change the auction prices
            // and leave some WETH in the balance after buying.
            await buyAuctionTokens(knc, auctionIndex, 10000, user, true)

            const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
                knc.address /* sellToken */,
                weth.address /* buyToken */,
                auctionIndex /* auctionIndex */,
                seller1 /* account */
            )

            calculatedBuyTokens.should.be.eq.BN(expectedBuyTokens.subn(10000))
        })

        it("what to do if some other buyer bought? we might not have enough KNC for the next auction")

        it("auction in progress, multiple seller, single buyer", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
                knc.address
            )

            // Other sellers sells KNC in auction
            await sellTokens(knc, 1000000, user)

            const seller1TokenSellAmount = auctionTokenSellAmount.subn(1000000)

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            // Calculate expected buy volume based on the amount sold by seller1
            const calculateBuyVolumeForSellVolume = async (sellToken, buyToken, sellVolume, auctionIndex) => {
                const buyVolume = await dx.buyVolumes.call(sellToken.address, buyToken.address)
                const price = await dx.getCurrentAuctionPrice.call(
                    sellToken.address,
                    buyToken.address,
                    auctionIndex
                )
                return sellVolume.mul(price.num).div(price.den).sub(buyVolume)
            }
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

        it("auction in progress, multiple seller, multiple buyers", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
                knc.address
            )

            // Other sellers sells KNC in auction
            await sellTokens(knc, 1000000, user)

            const seller1TokenSellAmount = auctionTokenSellAmount.subn(1000000)

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            // Calculate expected buy volume based on the amount sold by seller1
            const calculateBuyVolumeForSellVolume = async (sellToken, buyToken, sellVolume, auctionIndex) => {
                const buyVolume = await dx.buyVolumes.call(sellToken.address, buyToken.address)
                const price = await dx.getCurrentAuctionPrice.call(
                    sellToken.address,
                    buyToken.address,
                    auctionIndex
                )
                return sellVolume.mul(price.num).div(price.den).sub(buyVolume)
            }
            const expectedBuyTokens = await calculateBuyVolumeForSellVolume(
                knc,
                weth,
                seller1TokenSellAmount,
                auctionIndex
            )

            await buyAuctionTokens(knc, auctionIndex, 10000, user, true)

            const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
                knc.address /* sellToken */,
                weth.address /* buyToken */,
                auctionIndex /* auctionIndex */,
                seller1 /* account */
            )

            calculatedBuyTokens.should.be.eq.BN(expectedBuyTokens.subn(10000))
        })

        it("no auction triggered", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await dx.getAuctionIndex(
                knc.address,
                weth.address
            )

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

    describe("will amount clear auction", () => {
        it("using calculated buy amount", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
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

        it("using less than calculated buy amount", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
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
                calculatedBuyTokens - 1 /* amount */
            )

            willClearAuction.should.be.false
        })

        it("using more than calculated buy amount", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
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

            const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
                knc.address
            )

            // Other sellers sells KNC in auction
            await sellTokens(knc, 10000, user)

            const seller1TokenSellAmount = auctionTokenSellAmount.subn(10000)

            const auctionIndex = await triggerAuction(knc, seller1)
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

    it("make sure dxmm has enough balance, else deposit")

    it("get kyber rates", async () => {
        const knc = await deployTokenAddToDxAndClearFirstAuction()
        const kyberProxy = await MockKyberNetworkProxy.at(
            await dxmm.kyberNetworkProxy()
        )

        // TODO: use actual value
        const kncAmountInAuction = 10000

        const kyberProxyRate = await kyberProxy.getExpectedRate(
            knc.address,
            weth.address,
            kncAmountInAuction
        )

        dbg(`direct kyber rate for knc => weth is ${kyberProxyRate.expectedRate}`)

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

    describe("claim tokens after auction", () => {
        it("single auction triggered and cleared, all amounts claimed", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            const auctionIndex = await dxmmTriggerAndClearAuction(knc, weth)

            const kncBalance0 = await dx.balances(knc.address, dxmm.address)
            const wethBalance0 = await dx.balances(weth.address, dxmm.address)
            const lastAuctionSellerBalance0 = await dx.sellerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            const lastAuctionBuyerBalance0 = await dx.buyerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )

            await dxmm.claimAuctionTokens(knc.address, weth.address)

            // Auction balances should be 0
            const sellerBalance = await dx.sellerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            sellerBalance.should.be.eq.BN(0)
            const buyerBalance = await dx.buyerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            buyerBalance.should.be.eq.BN(0)

            // tokens moved to dxmm balances
            const kncBalance = await dx.balances(knc.address, dxmm.address)
            kncBalance.should.be.eq.BN(kncBalance0.add(lastAuctionSellerBalance0))
            const wethBalance = await dx.balances(weth.address, dxmm.address)
            wethBalance.should.be.eq.BN(wethBalance0.add(lastAuctionBuyerBalance0))
        })

        it("single auction triggered and cleared, event emitted", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            const auctionIndex = await dxmmTriggerAndClearAuction(knc, weth)

            const claimedSellerAuction = (
                await dx.claimSellerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    auctionIndex
                )
            ).returned
            const claimedBuyerAuction = (
                await dx.claimBuyerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    auctionIndex
                )
            ).returned

            const claimed = await dxmm.claimAuctionTokens.call(knc.address, weth.address)
            const res = await dxmm.claimAuctionTokens(knc.address, weth.address)

            claimed.sellerFunds.should.be.eq.BN(claimedSellerAuction)
            claimed.buyerFunds.should.be.eq.BN(claimedBuyerAuction)

            dbg(`%%% ev.sellToken === ${knc.address}`)
            dbg(`%%% ev.buyToken === ${weth.address}`)
            dbg(`%%% ev.previousLastComletedAuction.eq(${0})`)
            dbg(`%%% ev.newLastCompletedAuction.eq(${auctionIndex})`)
            dbg(`%%% ev.sellerFunds.eq(${claimedSellerAuction})`)
            dbg(`%%% ev.buyerFunds.eq(${claimedBuyerAuction})`)

            truffleAssert.eventEmitted(res, 'ClaimedAuctionTokens', (ev) => {
                return (
                    ev.sellToken === knc.address
                    && ev.buyToken === weth.address
                    && ev.previousLastCompletedAuction.eq(new BN(0))
                    && ev.newLastCompletedAuction.eq(new BN(2))
                    && ev.sellerFunds.eq(claimedSellerAuction)
                    && ev.buyerFunds.eq(claimedBuyerAuction)
                )
            })
        })

        it("called once after multiple auctions finished", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            // Auctions 2, 3, 4
            await dxmmTriggerAndClearAuction(knc, weth)
            await dxmmTriggerAndClearAuction(knc, weth)
            await dxmmTriggerAndClearAuction(knc, weth)

            // Get balances before claiming
            const kncBalanceBefore = await dx.balances(knc.address, dxmm.address)
            const wethBalanceBefore = await dx.balances(weth.address, dxmm.address)

            // Get amounts to be claimed in the auctions
            const claimedSellerAuction2 = (
                await dx.claimSellerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    2
                )
            ).returned
            const claimedSellerAuction3 = (
                await dx.claimSellerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    3
                )
            ).returned
            const claimedSellerAuction4 = (
                await dx.claimSellerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    4
                )
            ).returned
            const claimedBuyerAuction2 = (
                await dx.claimBuyerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    2
                )
            ).returned
            const claimedBuyerAuction3 = (
                await dx.claimBuyerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    3
                )
            ).returned
            const claimedBuyerAuction4 = (
                await dx.claimBuyerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    4
                )
            ).returned

            await dxmm.claimAuctionTokens(knc.address, weth.address)

            // Verify all tokens were claimed
            let balance
            balance = await dx.sellerBalances(knc.address, weth.address, 2, dxmm.address)
            balance.should.be.eq.BN(0)
            balance = await dx.sellerBalances(knc.address, weth.address, 3, dxmm.address)
            balance.should.be.eq.BN(0)
            balance = await dx.sellerBalances(knc.address, weth.address, 4, dxmm.address)
            balance.should.be.eq.BN(0)
            balance = await dx.buyerBalances(knc.address, weth.address, 2, dxmm.address)
            balance.should.be.eq.BN(0)
            balance = await dx.buyerBalances(knc.address, weth.address, 3, dxmm.address)
            balance.should.be.eq.BN(0)
            balance = await dx.buyerBalances(knc.address, weth.address, 4, dxmm.address)
            balance.should.be.eq.BN(0)

            // Final token balances should contain claimed auction balances
            const kncBalanceAfter = await dx.balances(knc.address, dxmm.address)
            kncBalanceAfter.should.be.eq.BN(
                kncBalanceBefore
                .add(claimedBuyerAuction2)
                .add(claimedBuyerAuction3)
                .add(claimedBuyerAuction4)
            )
            const wethBalanceAfter = await dx.balances(weth.address, dxmm.address)
            wethBalanceAfter.should.be.eq.BN(
                wethBalanceBefore
                .add(claimedSellerAuction2)
                .add(claimedSellerAuction3)
                .add(claimedSellerAuction4)
            )
        })

        it("called multiple times after auctions finished", async () => {
            // This is a long test that after initializing a token performs
            // 3 cycles of triggering an auction, clearing it and claiming the
            // seller and buyer tokens using dxmm.
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            // =============
            //   Auction 2
            // =============
            await dxmmTriggerAndClearAuction(knc, weth)

            // Get balances before claiming
            const kncBalanceBeforeClaiming2 = await dx.balances(knc.address, dxmm.address)
            const wethBalanceBeforeClaiming2 = await dx.balances(weth.address, dxmm.address)

            // Get amounts to be claimed in the auctions
            const claimedSellerAuction2 = (
                await dx.claimSellerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    2
                )
            ).returned

            const claimedBuyerAuction2 = (
                await dx.claimBuyerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    2
                )
            ).returned

            await dxmm.claimAuctionTokens(knc.address, weth.address)

            const kncBalanceAfterClaiming2 = await dx.balances(knc.address, dxmm.address)
            const wethBalanceAfterClaiming2 = await dx.balances(weth.address, dxmm.address)

            // =============
            //   Auction 3
            // =============
            await dxmmTriggerAndClearAuction(knc, weth)

            // Get balances before claiming
            const kncBalanceBeforeClaiming3 = await dx.balances(knc.address, dxmm.address)
            const wethBalanceBeforeClaiming3 = await dx.balances(weth.address, dxmm.address)

            // Get amounts to be claimed in the auctions
            const claimedSellerAuction3 = (
                await dx.claimSellerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    3
                )
            ).returned

            const claimedBuyerAuction3 = (
                await dx.claimBuyerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    3
                )
            ).returned

            await dxmm.claimAuctionTokens(knc.address, weth.address)

            const kncBalanceAfterClaiming3 = await dx.balances(knc.address, dxmm.address)
            const wethBalanceAfterClaiming3 = await dx.balances(weth.address, dxmm.address)

            // =============
            //   Auction 3
            // =============
            await dxmmTriggerAndClearAuction(knc, weth)

            // Get balances before claiming
            const kncBalanceBeforeClaiming4 = await dx.balances(knc.address, dxmm.address)
            const wethBalanceBeforeClaiming4 = await dx.balances(weth.address, dxmm.address)

            // Get amounts to be claimed in the auctions
            const claimedSellerAuction4 = (
                await dx.claimSellerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    4
                )
            ).returned

            const claimedBuyerAuction4 = (
                await dx.claimBuyerFunds.call(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    4
                )
            ).returned

            await dxmm.claimAuctionTokens(knc.address, weth.address)

            const kncBalanceAfterClaiming4 = await dx.balances(knc.address, dxmm.address)
            const wethBalanceAfterClaiming4 = await dx.balances(weth.address, dxmm.address)


            // Verify all tokens were claimed
            let balance
            balance = await dx.sellerBalances(knc.address, weth.address, 2, dxmm.address)
            balance.should.be.eq.BN(0)
            balance = await dx.sellerBalances(knc.address, weth.address, 3, dxmm.address)
            balance.should.be.eq.BN(0)
            balance = await dx.sellerBalances(knc.address, weth.address, 4, dxmm.address)
            balance.should.be.eq.BN(0)
            balance = await dx.buyerBalances(knc.address, weth.address, 2, dxmm.address)
            balance.should.be.eq.BN(0)
            balance = await dx.buyerBalances(knc.address, weth.address, 3, dxmm.address)
            balance.should.be.eq.BN(0)
            balance = await dx.buyerBalances(knc.address, weth.address, 4, dxmm.address)
            balance.should.be.eq.BN(0)

            kncBalanceAfterClaiming2.should.be.eq.BN(kncBalanceBeforeClaiming2.add(claimedBuyerAuction2))
            kncBalanceAfterClaiming3.should.be.eq.BN(kncBalanceBeforeClaiming3.add(claimedBuyerAuction3))
            kncBalanceAfterClaiming4.should.be.eq.BN(kncBalanceBeforeClaiming4.add(claimedBuyerAuction4))

            wethBalanceAfterClaiming2.should.be.eq.BN(wethBalanceBeforeClaiming2.add(claimedSellerAuction2))
            wethBalanceAfterClaiming3.should.be.eq.BN(wethBalanceBeforeClaiming3.add(claimedSellerAuction3))
            wethBalanceAfterClaiming4.should.be.eq.BN(wethBalanceBeforeClaiming4.add(claimedSellerAuction4))
        })
    })

    describe("manually claim tokens by any user directly from DutchX", () => {
        it("dxmm triggered the auction and then cleared it", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            const auctionIndex = await dxmmTriggerAndClearAuction(knc, weth)

            const kncBalanceBefore = await dx.balances(knc.address, dxmm.address)
            const wethBalanceBefore = await dx.balances(weth.address, dxmm.address)

            const price = await dx.getCurrentAuctionPrice(knc.address, weth.address, auctionIndex)
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
            const buyerKncBalance = (
                await dx.getUnclaimedBuyerFunds(
                    knc.address,
                    weth.address,
                    dxmm.address,
                    auctionIndex
                )
            ).unclaimedBuyerFunds

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

    describe("buy token in auction", () => {
        it("should fail if auction not in progress (not triggered)", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            await truffleAssert.reverts(
                dxmm.buyInAuction(knc.address, weth.address),
                "No auction in progress"
            )
        })

        it("should fail if auction not in progress (triggered, waiting)", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await triggerAuction(knc, user)

            await truffleAssert.reverts(
                dxmm.buyInAuction(knc.address, weth.address),
                "No auction in progress"
            )
        })

        it("should buy nothing if nothing sold (other user triggered auction)", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, user)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)
            const buyerBalanceBefore = await dx.buyerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )

            const bought = await dxmm.buyInAuction.call(knc.address, weth.address)

            bought.should.be.false
            const buyerBalanceAfter = await dx.buyerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            buyerBalanceAfter.should.be.eq.BN(buyerBalanceBefore)
        })

        it("should buy the amount of sold tokens in auction", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            await fundDxmmAndDepositToDxToken(knc)

            await dxmm.triggerAuction(knc.address, weth.address)

            const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)
            const buyerBalanceBefore = await dx.buyerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            dbg(`%%% balance before is ${buyerBalanceBefore} (should be 0)`)

            // This is more WETH than will eventually be required as the rate
            // improves block by block and we waste a couple of blocks in These
            // deposits
            await fundDxmmAndDepositToDxWethForAuction(knc, weth, auctionIndex)

            // Rate lowers as time goes by
            const updatedTokensToBuy = await dxmm.calculateAuctionBuyTokens.call(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            const bought = await dxmm.buyInAuction.call(knc.address, weth.address)
            await dxmm.buyInAuction(knc.address, weth.address)

            bought.should.be.true
            const buyerBalanceAfter = await dx.buyerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            buyerBalanceAfter.should.be.eq.BN(buyerBalanceBefore.add(updatedTokensToBuy))
        })

        it("should fail if doesn't have enough WETH to buy sold amount", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            // Initialize dxmm WETH balance
            const dxBalance = await dx.balances(weth.address, dxmm.address)
            dbg(`%%% dxmm balance on dx: ${dxBalance}`)
            await dxmm.withdrawFromDx(weth.address, dxBalance, { from: admin })
            dbg(`%%% dxmm balance on dx after: ${await dx.balances(weth.address, dxmm.address)}`)
            const wethBalance = await weth.balanceOf(dxmm.address)
            dbg(`%%% dxmm WETH balance: ${wethBalance}`)
            // keep 1 ETH for gas?
            const withdrawAmount = wethBalance.sub(new BN(web3.utils.toWei("1")))
            dbg(`%%% dxmm withdraw amount: ${withdrawAmount}`)
            await dxmm.withdrawToken(weth.address, withdrawAmount, admin, { from: admin })
            dbg(`%%% dxmm balance after: ${await weth.balanceOf(dxmm.address)}`)

            await fundDxmmAndDepositToDxToken(knc)
            await dxmm.triggerAuction(knc.address, weth.address)
            const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            await truffleAssert.reverts(
                dxmm.buyInAuction(knc.address, weth.address),
                "Not enough buy token to buy required amount"
            )
        })

        it("should buy amount that it sold", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            await fundDxmmAndDepositToDxToken(knc)

            await dxmm.triggerAuction(knc.address, weth.address)
            const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)
            const buyerBalanceBefore = await dx.buyerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )

            // This is more WETH than will eventually be required as the rate
            // improves block by block and we waste a couple of blocks in These
            // deposits
            await fundDxmmAndDepositToDxWethForAuction(knc, weth, auctionIndex)

            // Rate lowers as time goes by
            const buyTokenAmount = await dxmm.calculateAuctionBuyTokens(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            const res = await dxmm.buyInAuction(knc.address, weth.address)

            dbg(`%%% ev.sellToken === ${knc.address}`)
            dbg(`%%% ev.buyToken === ${weth.address}`)
            dbg(`%%% ev.auctionIndex.eq(${auctionIndex})`)
            dbg(`%%% ev.buyTokenAmount.eq(${buyTokenAmount})`)
            dbg(`%%% ev.clearedAuction == true`)
            truffleAssert.eventEmitted(res, 'BoughtInAuction', (ev) => {
                return (
                    ev.sellToken === knc.address
                    && ev.buyToken === weth.address
                    && ev.auctionIndex.eq(auctionIndex)
                    && ev.buyTokenAmount.eq(buyTokenAmount)
                    && ev.clearedAuction == true
                )
            })
        })
    })

    describe("trigger auctions", () => {
        it("deposit and trigger auction", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)

            const triggered = await dxmm.triggerAuction.call(
                knc.address,
                weth.address
            )
            await dxmm.triggerAuction(knc.address, weth.address)

            triggered.should.be.true
            const auctionStart = await dx.getAuctionStart(knc.address, weth.address)
            auctionStart.should.not.be.eq.BN(DX_AUCTION_START_WAITING_FOR_FUNDING)
        })

        it("revert if doesn't have enough balance", async () => {
            dbg(`before deployTokenAddToDxAndClearFirstAuction()`)
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            dbg(`after deployTokenAddToDxAndClearFirstAuction()`)

            await truffleAssert.reverts(
                dxmm.triggerAuction(knc.address, weth.address),
                "Not enough tokens to trigger auction"
            )
        })

        it("fail if auction has already been triggered and waiting to start", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)

            await triggerAuction(knc, user)

            const triggered = await dxmm.triggerAuction.call(
                knc.address,
                weth.address
            )

            triggered.should.be.false
        })

        it("fail if auction is in progress", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)

            const auctionIndex = await triggerAuction(knc, user)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            const triggered = await dxmm.triggerAuction.call(
                knc.address,
                weth.address
            )

            triggered.should.be.false
        })

        it("should emit event with triggered auction info", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)
            const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
            const missingTokens = await dxmm.calculateMissingTokenForAuctionStart(knc.address, weth.address)
            const missingTokensWithFee = await dxmm.addFee(missingTokens)

            const triggered = await dxmm.triggerAuction.call(
                knc.address,
                weth.address
            )
            const res = await dxmm.triggerAuction(knc.address, weth.address)

            truffleAssert.eventEmitted(res, 'AuctionTriggered', (ev) => {
                return (
                    ev.sellToken === knc.address
                    && ev.buyToken === weth.address
                    && ev.auctionIndex.eq(auctionIndex)
                    && ev.sellTokenAmount.eq(missingTokens)
                    && ev.sellTokenAmountWithFee.eq(missingTokensWithFee)
                )
            })
        })
    })

    describe.only("unified flow", () => {
        const hasDxPriceReachedKyber = async (sellToken, buyToken, auctionIndex) => {
            // dutchX price should initially be higher than kyber price
            const amount = await dxmm.calculateAuctionBuyTokens(
                sellToken.address,
                buyToken.address,
                auctionIndex,
                dxmm.address
            )
            const dxPrice = await dx.getCurrentAuctionPrice(sellToken.address, buyToken.address, auctionIndex)
            const kyberPrice = await dxmm.getKyberRate(sellToken.address, buyToken.address, amount)
            const a = dxPrice.num.mul(kyberPrice.den)
            const b = kyberPrice.num.mul(dxPrice.den)
            dbg(`dutchx price is ${dxPrice.num}/${dxPrice.den} = ${dxPrice.num / dxPrice.den}`)
            dbg(`kyber  price is ${kyberPrice.num}/${kyberPrice.den} = ${kyberPrice.num / kyberPrice.den}`)
            dbg(`a is ${a}`)
            dbg(`b is ${b}`)
            dbg(`a <= b? ${a.lte(b)}`)
            return a.lte(b)
        }

        it("no auction in progress or planned - action required", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)

            const actionRequired = await dxmm.magic.call(knc.address, weth.address)

            actionRequired.should.be.true
        })

        it("no auction in progress or planned - trigger auction", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)

            const res = await dxmm.magic(knc.address, weth.address)

            truffleAssert.eventEmitted(res, 'AuctionTriggered', (ev) => {
                return (
                    ev.sellToken === knc.address
                    && ev.buyToken === weth.address
                    && ev.auctionIndex == 2
                )
            })
        })

        it("no auction in progress or planned - previous auction funds claimed", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            // Auctions 2, 3, 4
            await dxmmTriggerAndClearAuction(knc, weth)
            await dxmmTriggerAndClearAuction(knc, weth)
            await dxmmTriggerAndClearAuction(knc, weth)

            const res = await dxmm.magic(knc.address, weth.address)

            truffleAssert.eventEmitted(res, 'ClaimedAuctionTokens', (ev) => {
                return (
                    ev.sellToken === knc.address
                    && ev.buyToken === weth.address
                    && ev.previousLastCompletedAuction == 0
                    && ev.newLastCompletedAuction == 4
                )
            })
        })

        it("auction already triggered, waiting - no action required", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)
            await dxmm.triggerAuction(knc.address, weth.address)

            const actionRequired = await dxmm.magic.call(knc.address, weth.address)

            actionRequired.should.be.false
        })

        it("auction already triggered, waiting - no action performed", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)
            await dxmm.triggerAuction(knc.address, weth.address)

            const res = await dxmm.magic(knc.address, weth.address)

            // TODO: check that NO EVENT AT ALL has been emitted
            truffleAssert.eventNotEmitted(res, 'ClaimedAuctionTokens')
            truffleAssert.eventNotEmitted(res, 'AuctionTriggered')
            truffleAssert.eventNotEmitted(res, 'BoughtInAuction')
        })

        it("auction in progress but price not ready for buying, waiting - nothing to do", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)
            await dxmm.triggerAuction(knc.address, weth.address)
            const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            // dutchX price should initially be higher than kyber price
            const amount = await dxmm.calculateAuctionBuyTokens(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            const dxPrice = await dx.getCurrentAuctionPrice(knc.address, weth.address, auctionIndex)
            const kyberPrice = await dxmm.getKyberRate(knc.address, weth.address, amount)
            const a = kyberPrice.num.mul(dxPrice.den)
            const b = dxPrice.num.mul(kyberPrice.den)
            a.should.be.lt.BN(b)

            const actionRequired = await dxmm.magic.call(knc.address, weth.address)

            actionRequired.should.be.false
        })

        it("auction in progress but price not ready for buying, waiting - no action performed", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)
            await dxmm.triggerAuction(knc.address, weth.address)
            const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)
            const priceReachedKyber = await hasDxPriceReachedKyber(knc, weth, auctionIndex)
            priceReachedKyber.should.be.false

            const res = await dxmm.magic(knc.address, weth.address)

            // TODO: check that NO EVENT AT ALL has been emitted
            truffleAssert.eventNotEmitted(res, 'ClaimedAuctionTokens')
            truffleAssert.eventNotEmitted(res, 'AuctionTriggered')
            truffleAssert.eventNotEmitted(res, 'BoughtInAuction')
        })

        it("auction in progress, price ready for buying -> should buy", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)
            await dxmm.triggerAuction(knc.address, weth.address)
            const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            const amount = await dxmm.calculateAuctionBuyTokens(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            await waitUntilKyberPriceReached(knc, weth, auctionIndex, amount)

            const actionRequired = await dxmm.magic.call(knc.address, weth.address)

            const priceReachedKyber = await hasDxPriceReachedKyber(knc, weth, auctionIndex)
            priceReachedKyber.should.be.true
            actionRequired.should.be.true
        })

        it("auction in progress, price ready for buying -> bought and cleared auction", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await fundDxmmAndDepositToDxToken(knc)
            await dxmm.triggerAuction(knc.address, weth.address)
            const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
            await waitForTriggeredAuctionToStart(knc, weth, auctionIndex)

            const amount = await dxmm.calculateAuctionBuyTokens(
                knc.address,
                weth.address,
                auctionIndex,
                dxmm.address
            )
            await waitUntilKyberPriceReached(knc, weth, auctionIndex, amount)
            const priceReachedKyber = await hasDxPriceReachedKyber(knc, weth, auctionIndex)
            priceReachedKyber.should.be.true

            await fundDxmmAndDepositToDxWethForAuction(knc, weth, auctionIndex)

            const res = await dxmm.magic(knc.address, weth.address)

            truffleAssert.eventEmitted(res, 'BoughtInAuction', (ev) => {
                return (
                    ev.sellToken === knc.address
                    && ev.buyToken === weth.address
                    && auctionIndex === auctionIndex
                )
            })

            const state = await dxmm.getAuctionState(knc.address, weth.address)
            state.should.be.eq.BN(NO_AUCTION_TRIGGERED)
        })

        it("several cycles")

        it("does dxmm have sufficient funds? (token and weth)")
    })

    it("should start sale only if has enough ETH to end")
    it("calculate missing amount and postSell should be in 1 tx")
})


// TODO: Extract to util class
async function waitTimeInSeconds(seconds) {
    await Helper.sendPromise("evm_increaseTime", [seconds])
    await Helper.sendPromise("evm_mine", [])
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
