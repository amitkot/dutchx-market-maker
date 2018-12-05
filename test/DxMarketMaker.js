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
    .use(require("chai-as-promised"))
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
    async function deployToken() {
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
        const kyberRate = await dxmm.getKyberRate(knc.address, 0)
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
        await waitForTriggeredAuctionToStart(knc, auctionIndex)

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

    const waitForTriggeredAuctionToStart = async (knc, auctionIndex) => {
        const timeNow = await blockChainTime()
        const auctionStartTime = await dx.getAuctionStart(knc.address, weth.address)
        const secondsToWait = auctionStartTime - timeNow
        dbg(`time now is ${timeNow}`)
        dbg(
            `next auction starts at ${auctionStartTime} (in ${secondsToWait} seconds)`
        )

        await waitTimeInSeconds(secondsToWait)
        dbg(`\n--- waited ${secondsToWait / 60} minutes until auction started`)
        dbg(`time now is ${await blockChainTime()}`)
        await dbgVolumesAndPrices(knc, weth, auctionIndex)
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

    const triggerAndClearAuction = async (token, user) => {
        dbg(`\n--- Triggerring and clearing new auction`)
        const auctionIndex = await triggerAuction(token, user)
        await waitForTriggeredAuctionToStart(token, auctionIndex)
        await buyEverythingInAuction(token, auctionIndex, user)

        const state = await dxmm.getAuctionState(token.address)
        state.should.be.eq.BN(NO_AUCTION_TRIGGERED)
    }

    const flow = async (token) => {
        console.log(`Running flow iteration for ${await token.symbol()}`)
        switch(await dxmm.getAuctionState()) {
            case AUCTION_TRIGGERED_WAITING:
                // do nothing
                console.log(`Auction has been triggered, waiting for it to start`)
                break

            case NO_AUCTION_TRIGGERED:
                await dxmm.claimAuctionTokens(token.address, weth.address)

                // Trigger auction
                // TODO: move this as a contract function:
                    const missingTokensToStartAuction = calculateMissingTokenForAuctionStart(
                        token.address,
                        weth.address
                    )
                    console.log(`missing tokens to start auction: ${missingTokensToStartAuction}`)

                    if (missingKncToStartAuction == 0) {
                        console.log(`ERROR: how come missing tokens are 0 and no auction triggered?`)
                        throw 'ERROR: 0 missing tokens and no auction'
                    }

                    if (dxmm.balanace(KNC) < missingKncToStartAuction) {
                        // TODO: buy required KNC, start the auction and then notify
                        // FINISH WITH ERROR - desposit KNC
                    }
                    deposit(missingKncToStartAuction)

                    // trigger Auction
                    postSellOrder(KNC, WETH, minimumAuctionAmount)
                break

            case AUCTION_IN_PROGRESS:
                if (isKncCheaperThanOnKyber()) {
                    postBuyOrder(calculateKncWePutInAuction())
                }
                break
        }
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
        await waitForTriggeredAuctionToStart(knc, auctionIndex)

        // now check if buyer wants to buyAmount
        dbg(`\n--- buyer checks prices`)
        dbg(`buyer wants to buy and will wait for target price`)

        let price
        let kyberPrice
        while (true) {
            price = await dx.getCurrentAuctionPrice(
                knc.address,
                weth.address,
                auctionIndex
            )

            // TODO: use actual amount
            const amount = 10000
            kyberPrice = await dxmm.getKyberRate(knc.address, amount)
            const targetRate = kyberPrice.num / kyberPrice.den
            const p = price.num / price.den
            const t = await blockChainTime()
            if (p <= targetRate) {
                dbg(`... at ${t} price is ${p} -> Done waiting!`)
                break
            }

            dbg(`... at ${t} price is ${p} (target: ${targetRate})-> waiting 10 minutes.`)
            await waitTimeInSeconds(10 * 60)
        }

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

    describe("missing tokens to next auction", async () => {
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

            await waitForTriggeredAuctionToStart(knc, auctionIndex)

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
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

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

    describe("auction state", async () => {
        it("no auction planned", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const state = await dxmm.getAuctionState(knc.address)
            state.should.be.eq.BN(NO_AUCTION_TRIGGERED)
        })

        it("auction triggered, waiting for it to start", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            await triggerAuction(knc, seller1)

            const state = await dxmm.getAuctionState(knc.address)
            state.should.be.eq.BN(AUCTION_TRIGGERED_WAITING)
        })

        it("auction in progress", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const state = await dxmm.getAuctionState(knc.address)
            state.should.be.eq.BN(AUCTION_IN_PROGRESS)
        })

        it("after auction ended", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)
            await buyEverythingInAuction(knc, auctionIndex, buyer1)

            const state = await dxmm.getAuctionState(knc.address)
            state.should.be.eq.BN(NO_AUCTION_TRIGGERED)
        })
    })

    describe("addFee", async () => {
        it("for amount 0", async () => {
            const amountWithFee = await dxmm.addFee(0)

            amountWithFee.should.be.eq.BN(0)
        })

        it("for amount 200", async () => {
            const amountWithFee = await dxmm.addFee(200)

            amountWithFee.should.be.eq.BN(201)
        })
    })

    describe("sell funds in current auction", async () => {
        it("auction in progress, single seller", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
                knc.address
            )

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const sellTokenAmountInCurrentAuction = (
                await dxmm.sellTokenAmountInCurrentAuction(
                    knc.address /* token */,
                    auctionIndex /* auctionIndex */,
                    seller1 /* account */
                )
            )

            sellTokenAmountInCurrentAuction.should.be.eq.BN(
                auctionTokenSellAmount
            )
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
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const sellTokenAmountInCurrentAuction = (
                await dxmm.sellTokenAmountInCurrentAuction(
                    knc.address /* token */,
                    auctionIndex /* auctionIndex */,
                    seller1 /* account */
                )
            )

            sellTokenAmountInCurrentAuction.should.be.eq.BN(
                seller1TokenSellAmount
            )
        })

        it("auction triggered", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
                knc.address
            )

            const auctionIndex = await triggerAuction(knc, seller1)

            const sellTokenAmountInCurrentAuction = (
                await dxmm.sellTokenAmountInCurrentAuction(
                    knc.address /* token */,
                    auctionIndex /* auctionIndex */,
                    seller1 /* account */
                )
            )

            sellTokenAmountInCurrentAuction.should.be.eq.BN(
                auctionTokenSellAmount
            )
        })

        it("no auction triggered", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const sellTokenAmountInCurrentAuction = (
                await dxmm.sellTokenAmountInCurrentAuction(
                    knc.address /* token */,
                    await dx.getAuctionIndex(knc.address, weth.address) /* auctionIndex */,
                    seller1 /* account */
                )
            )

            sellTokenAmountInCurrentAuction.should.be.eq.BN(0)
        })
    })

    describe("calculate buy volume from sell volume in auction", async () => {
        it("auction in progress, single seller, single buyer, calculation as expected", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const expectedBuyTokens = await calculateRemainingBuyVolume(
                knc,
                weth,
                auctionIndex
            )

            const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
                knc.address /* token */,
                auctionIndex /* auctionIndex */,
                seller1 /* account */
            )

            calculatedBuyTokens.should.be.eq.BN(expectedBuyTokens)
        })

        it("auction in progress, single seller, single buyer, successfully buy calculated amount", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const balanceBefore = await dx.balances.call(weth.address, seller1)

            const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
                knc.address /* token */,
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
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

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
                knc.address /* token */,
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
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

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
                knc.address /* token */,
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
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

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
                knc.address /* token */,
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
                knc.address /* token */,
                auctionIndex /* auctionIndex */,
                seller1 /* account */
            )

            // Auction is not triggered yet, no tokens to buy.
            calculatedBuyTokens.should.be.eq.BN(0)
        })
    })

    describe("will amount clear auction", async () => {
        it("using calculated buy amount", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
                knc.address /* token */,
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
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
                knc.address /* token */,
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
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
                knc.address /* token */,
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
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
                knc.address /* token */,
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

    it("sell from dxmm")

    it("buy from dxmm")

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
            kncAmountInAuction /* amount */
        )

        dbg(`dxmm kyber rate is (${kyberRate.num}, ${kyberRate.den})`)

        const dxmmValue = kyberRate.num / kyberRate.den
        const kyberValue = Number(web3.utils.fromWei(kyberProxyRate.expectedRate))
        dxmmValue.should.be.equal(kyberValue)
    })

    describe("claim tokens after auction", async () => {
        it("single auction finished", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, user)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)
            await buyEverythingInAuction(knc, auctionIndex, user)

            const state = await dxmm.getAuctionState(knc.address)
            state.should.be.eq.BN(NO_AUCTION_TRIGGERED)

            const kncBalance0 = await dx.balances(knc.address, user)
            const wethBalance0 = await dx.balances(weth.address, user)
            const lastAuctionSellerBalance0 = await dx.sellerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                user
            )
            const lastAuctionBuyerBalance0 = await dx.buyerBalances(
                knc.address,
                weth.address,
                auctionIndex,
                user
            )

            await dxmm.claimAuctionTokens(knc.address, weth.address, user)

            // Auction balances should be 0
            dx.sellerBalances(knc.address, weth.address, auctionIndex, user)
                    .should.eventually.be.eq.BN(0)
            dx.buyerBalances(knc.address, weth.address, auctionIndex, user)
                    .should.eventually.be.eq.BN(0)

            // tokens moved to user balances
            dx.balances(knc.address, user).should.eventually.be.eq.BN(
                kncBalance0.add(lastAuctionSellerBalance0)
            )
            dx.balances(weth.address, user).should.eventually.be.eq.BN(
                wethBalance0.add(lastAuctionBuyerBalance0)
            )
        })

        it("called once after multiple auctions finished", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            // Auctions 2, 3, 4
            await triggerAndClearAuction(knc, user)
            await triggerAndClearAuction(knc, user)
            await triggerAndClearAuction(knc, user)

            // Get balances before claiming
            const kncBalanceBefore = await dx.balances(knc.address, user)
            const wethBalanceBefore = await dx.balances(weth.address, user)

            const sellerBalanceAuction2 = await dx.sellerBalances(knc.address, weth.address, 2, user)
            const sellerBalanceAuction3 = await dx.sellerBalances(knc.address, weth.address, 3, user)
            const sellerBalanceAuction4 = await dx.sellerBalances(knc.address, weth.address, 4, user)
            const buyerBalanceAuction2 = await dx.buyerBalances(knc.address, weth.address, 2, user)
            const buyerBalanceAuction3 = await dx.buyerBalances(knc.address, weth.address, 3, user)
            const buyerBalanceAuction4 = await dx.buyerBalances(knc.address, weth.address, 4, user)

            await dxmm.claimAuctionTokens(knc.address, weth.address, user)

            // Verify all tokens were claimed
            dx.sellerBalances(knc.address, weth.address, 2, user).should.eventually.be.eq.BN(0)
            dx.sellerBalances(knc.address, weth.address, 3, user).should.eventually.be.eq.BN(0)
            dx.sellerBalances(knc.address, weth.address, 4, user).should.eventually.be.eq.BN(0)
            dx.buyerBalances(knc.address, weth.address, 2, user).should.eventually.be.eq.BN(0)
            dx.buyerBalances(knc.address, weth.address, 3, user).should.eventually.be.eq.BN(0)
            dx.buyerBalances(knc.address, weth.address, 4, user).should.eventually.be.eq.BN(0)

            // Final token balances should contain claimed auction balances
            dx.balances(knc.address, user).should.eventually.be.eq.BN(
                kncBalanceBefore
                .add(sellerBalanceAuction2)
                .add(sellerBalanceAuction3)
                .add(sellerBalanceAuction4)
            )
            dx.balances(weth.address, user).should.eventually.be.eq.BN(
                wethBalanceBefore
                .add(buyerBalanceAuction2)
                .add(buyerBalanceAuction3)
                .add(buyerBalanceAuction4)
            )
        })

        it.skip("called multiple times after auctions finished", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            // Auctions 2, 3
            await triggerAndClearAuction(knc, user)
            await triggerAndClearAuction(knc, user)

            // Get balances before claiming
            const sellerBalanceAuction2 = await dx.sellerBalances(knc.address, weth.address, 2, user)
            const sellerBalanceAuction3 = await dx.sellerBalances(knc.address, weth.address, 3, user)
            const buyerBalanceAuction2 = await dx.buyerBalances(knc.address, weth.address, 2, user)
            const buyerBalanceAuction3 = await dx.buyerBalances(knc.address, weth.address, 3, user)

            const kncBalanceBefore1 = await dx.balances(knc.address, user)
            const wethBalanceBefore1 = await dx.balances(weth.address, user)

            // Claim tokens
            await dxmm.claimAuctionTokens(knc.address, weth.address, user)

            const kncBalanceAfter1 = await dx.balances(knc.address, user)
            const wethBalanceAfter1 = await dx.balances(weth.address, user)

            // Auction 4
            await triggerAndClearAuction(knc, user)

            // Get balances before claiming
            const sellerBalanceAuction4 = await dx.sellerBalances(knc.address, weth.address, 4, user)
            const buyerBalanceAuction4 = await dx.buyerBalances(knc.address, weth.address, 4, user)

            const kncBalanceBefore2 = await dx.balances(knc.address, user)
            const wethBalanceBefore2 = await dx.balances(weth.address, user)

            // Claim tokens
            await dxmm.claimAuctionTokens(knc.address, weth.address, user)

            // Verify all tokens were claimed
            dx.sellerBalances(knc.address, weth.address, 2, user).should.eventually.be.eq.BN(0)
            dx.sellerBalances(knc.address, weth.address, 3, user).should.eventually.be.eq.BN(0)
            dx.sellerBalances(knc.address, weth.address, 4, user).should.eventually.be.eq.BN(0)
            dx.buyerBalances(knc.address, weth.address, 2, user).should.eventually.be.eq.BN(0)
            dx.buyerBalances(knc.address, weth.address, 3, user).should.eventually.be.eq.BN(0)
            dx.buyerBalances(knc.address, weth.address, 4, user).should.eventually.be.eq.BN(0)

            dbg(`knc balance before 1: ${kncBalanceBefore1}`)
            dbg(`seller balance auction 2: ${sellerBalanceAuction2}`)
            dbg(`seller balance auction 3: ${sellerBalanceAuction3}`)
            dbg(`knc balance after 1: ${kncBalanceAfter1}`)
            kncBalanceAfter1.should.be.eq.BN(
                kncBalanceBefore1
                .add(sellerBalanceAuction2)
                .add(sellerBalanceAuction3)
            )
            wethBalanceAfter1.should.be.eq.BN(
                wethBalanceBefore1
                .add(buyerBalanceAuction2)
                .add(buyerBalanceAuction3)
            )

            // Final token balances should contain claimed auction balances
            dx.balances(knc.address, user).should.eventually.be.eq.BN(
                kncBalanceBefore2.add(sellerBalanceAuction4)
            )
            dx.balances(weth.address, user).should.eventually.be.eq.BN(
                wethBalanceBefore2.add(buyerBalanceAuction4)
            )
        })
    })

    describe.skip("manually claim tokens", async () => {
        it("did not participate in auction, balance not changed by claiming", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()
            await triggerAndClearAuction(knc, seller1)

            const kncBalanceBefore = await dx.balances(knc.address, dxmm.address)
            const wethBalanceBefore = await dx.balances(weth.address, dxmm.address)

            dxmm.claimSpecificAuctionTokens(knc.address, weth.address, 2)

            dx.balances(knc.address, dxmm.address).should.eventually.be.eq.BN(kncBalanceBefore)
            dx.balances(weth.address, dxmm.address).should.eventually.be.eq.BN(wethBalanceBefore)
        })

        it("dxmm triggered the auction and then cleared it", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            await dxmm.triggerAuction(knc.address, weth.address)
            const auctionIndex = dx.getAuctionIndex(knc.address, weth.address)
            await waitForTriggeredAuctionToStart(auctionIndex)
            await dxmm.buyInAuction(knc.address, weth.address)

            const kncBalanceBefore = await dx.balances(knc.address, dxmm.address)
            const wethBalanceBefore = await dx.balances(weth.address, dxmm.address)

            const auctionSellerBalance = await dx.sellerBalances(knc.address, weth.address, 2, dxmm.address)
            const auctionBuyerBalance = await dx.buyerBalances(knc.address, weth.address, 2, dxmm.address)

            dxmm.claimSpecificAuctionTokens(knc.address, weth.address, 2)

            dx.balances(knc.address, dxmm.address).should.eventually.be.eq.BN(
                // KNC received as buyer
                kncBalanceBefore.add(auctionBuyerBalance)
            )
            dx.balances(weth.address, dxmm.address).should.eventually.be.eq.BN(
                // WETH received as seller
                wethBalanceBefore.add(auctionSellerBalance)
            )
        })

        it("dxmm triggered the auction and some user cleared it")
    })

    describe("trigger auctions", async () => {
        it("deposit and trigger auction", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const amount = web3.utils.toWei("100000000")
            await knc.transfer(dxmm.address, amount, { from: admin })
            await dxmm.depositToDx(knc.address, amount, { from: admin })

            const triggered = await dxmm.triggerAuction.call(
                knc.address,
                weth.address
            )
            await dxmm.triggerAuction(knc.address, weth.address)

            triggered.should.be.true
            dx.getAuctionStart(knc.address, weth.address)
            .should.eventually.not.be.eq.BN(
                DX_AUCTION_START_WAITING_FOR_FUNDING
            )
        })

        it("revert if doesn't have enough balance", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            await truffleAssert.reverts(
                dxmm.triggerAuction(knc.address, weth.address),
                "Not enough tokens to trigger auction"
            )
        })

        it("fail if auction has been triggered", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, user)

            const amount = web3.utils.toWei("100000000")
            await knc.transfer(dxmm.address, amount, { from: admin })
            await dxmm.depositToDx(knc.address, amount, { from: admin })

            const triggered = await dxmm.triggerAuction.call(
                knc.address,
                weth.address
            )

            triggered.should.be.false
        })

        it("fail if auction is in progress", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, user)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const amount = web3.utils.toWei("100000000")
            await knc.transfer(dxmm.address, amount, { from: admin })
            await dxmm.depositToDx(knc.address, amount, { from: admin })

            const triggered = await dxmm.triggerAuction.call(
                knc.address,
                weth.address
            )

            triggered.should.be.false
        })
    })

    it("does dxmm have sufficient funds? (token and weth)")

    // ---------------

    it("should be able to withdraw all the money from dxmm")
    it("should be able to withdraw all of the money from dx")

    it("should start sale only if has enough ETH to end")

    it("calculate missing amount and postSell should be in 1 tx")

    // TODO: Support the opposite direction
    it.skip("sell to start auction, wait until price is right, then buy everything", async () => {
        const knc = await deployTokenAddToDxAndClearFirstAuction()

        await flow()

        // verify auction closed successfully
    })
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
