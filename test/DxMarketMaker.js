const BigNumber = require('bignumber.js');
const Helper = require("./helper.js")

require("chai")
    .use(require("chai-as-promised"))
    .use(require("chai-bignumber")(BigNumber))
    .should()

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
        return await TestToken.new("Some Token", "KNC" + tokenDeployedIndex++, 18, {
            from: admin,
        })
    }

    const calculateRemainingBuyVolume = async (sellToken, buyToken, auctionIndex) => {
        const sellVolume = await dx.sellVolumesCurrent.call(sellToken.address, buyToken.address)
        const buyVolume = await dx.buyVolumes.call(sellToken.address, buyToken.address)
        const [num, den] = await dx.getCurrentAuctionPrice.call(
            sellToken.address,
            buyToken.address,
            auctionIndex
        )
        // Auction index is in the future.
        if (den == 0) return 0;

        return (
            new BigNumber(sellVolume)
            .mul(num)
            .dividedToIntegerBy(den)
            .sub(buyVolume)
        )
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
        const [num, den] = await dx.getCurrentAuctionPrice(
            st.address,
            bt.address,
            auctionIndex
        )
        const remainingSellVolume = (
            new BigNumber(sellVolume)
            .sub(
                new BigNumber(buyVolume)
                .mul(num)
                .dividedToIntegerBy(den)
            )
        )
        const remainingBuyVolume = await calculateRemainingBuyVolume(st, bt, auctionIndex)

        dbg(`...... sellVolumesCurrent: ${sellVolume} ${stSymbol}`)
        dbg(`...... buyVolumes: ${buyVolume} ${btSymbol}`)
        dbg(`...... price ${stSymbol}/${btSymbol} is ${num}/${den}`)
        dbg(`...... remaining SELL tokens: ${remainingSellVolume} ${stSymbol}`)
        dbg(`...... remaining BUY tokens: ${remainingBuyVolume} ${btSymbol}`)
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

        await weth.deposit({ value: 1e22, from: lister })
        dbg(`\n--- prepared lister funds`)
        dbg(`lister has ${await weth.balanceOf(lister)} WETH`)
        dbg(`lister has ${await knc.balanceOf(lister)} ${kncSymbol}`)

        await weth.approve(dx.address, initialWethWei, { from: lister })
        await dx.deposit(weth.address, initialWethWei, { from: lister })
        dbg(`\n--- lister deposited ${initialWethWei} WETH in DX`)

        const [initialRateNum, initialRateDen] = await dxmm.getKyberRate(knc.address, 0)
        dbg(`initial rate is knc => weth is ${initialRateNum} / ${initialRateDen} (=${initialRateNum/initialRateDen})`)

        // Using 0 amount as mock kyber contract returns fixed rate anyway.
        await dx.addTokenPair(
            weth.address,
            knc.address,
            initialWethWei,
            0,
            // dividing by 2 to make numbers smaller, avoid reverts due to fear
            // of overflow
            initialRateDen / 2 /* tokenToEthNum */,
            initialRateNum / 2 /* tokenToEthDen */,
            { from: lister }
        )
        dbg(`\n--- lister added ${kncSymbol} to DX`)

        const auctionIndex = await dx.getAuctionIndex(weth.address, knc.address)
        await waitForTriggeredAuctionToStart(knc, auctionIndex)

        dbg(`\n--- lister wants to buy it all`)
        dbg(`fee is ${await dx.getFeeRatio(lister)}`)
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
            `\n--- is auction still open? ${currentAuctionIndex.equals(auctionIndex)}`
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
        dbg(
            `closingPrice is ${await dx.closingPrices(
                weth.address,
                knc.address,
                auctionIndex
            )}`
        )
        const [fundsRetuned] = await dx.claimSellerFunds.call(
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
        dbg(`claimed funds S:weth, B:knc: ${fundsRetuned}`)

        const [fundsRetuned1] = await dx.claimBuyerFunds.call(
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
        dbg(`claimed funds S:weth, B:knc: ${fundsRetuned1}`)

        const [fundsRetuned2] = await dx.claimBuyerFunds.call(
            knc.address,
            weth.address,
            lister,
            auctionIndex,
            { from: lister }
        )
        await dx.claimBuyerFunds(knc.address, weth.address, lister, auctionIndex, {
            from: lister,
        })
        dbg(`claimed funds S:knc, B:weth: ${fundsRetuned2}`)

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
            token.address
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
        let [newBal, auctionIndex, newSellerBal] = await dx.depositAndSell.call(
            token.address,
            weth.address,
            tokenSellAmount,
            { from: seller }
        )
        await dx.depositAndSell(token.address, weth.address, tokenSellAmount, {
            from: seller,
        })
        dbg(
            `\n--- seller called depositAndSell: newBal: ${newBal}, auctionIndex: ${auctionIndex}, newSellerBal: ${newSellerBal}`
        )
        dbg(`seller DX WETH balance is ${await dx.balances(weth.address, seller)}`)
        dbg(`seller DX KNC balance is ${await dx.balances(token.address, seller)}`)
        await dbgVolumesAndPrices(token, weth, auctionIndex)

        return auctionIndex
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
        shouldBuyVolume = new BigNumber(remainingBuyVolume.toString()).add(1)
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

    before("setup accounts", async () => {
        admin = accounts[0]
        seller1 = accounts[1]
        buyer1 = accounts[2]
        user = accounts[3]
        operator = accounts[4]

        weth = await EtherToken.deployed()
        dxmm = await DxMarketMaker.deployed()
        dx = DutchExchange.at(await dxmm.dx())
        dxPriceOracle = PriceOracleInterface.at(await dx.ethUSDOracle())

        await dxmm.addOperator(operator, { from: admin })

        token = await deployTokenAddToDxAndClearFirstAuction()

        NO_AUCTION_TRIGGERED = await dxmm.NO_AUCTION_TRIGGERED()
        AUCTION_TRIGGERED_WAITING = await dxmm.AUCTION_TRIGGERED_WAITING()
        AUCTION_IN_PROGRESS = await dxmm.AUCTION_IN_PROGRESS()
    })

    it("admin should deploy token, add to dx, and conclude the first auction", async () => {
        const knc = await deployTokenAddToDxAndClearFirstAuction()

        const nextAuctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
        nextAuctionIndex.should.be.bignumber.equal(2)
    })

    it("seller can sell KNC and buyer can buy it", async () => {
        const knc = await deployTokenAddToDxAndClearFirstAuction()

        const auctionIndex = await triggerAuction(knc, seller1)
        await waitForTriggeredAuctionToStart(knc, auctionIndex)

        // now check if buyer wants to buyAmount
        dbg(`\n--- buyer checks prices`)
        dbg(`buyer wants to buy and will wait for target price`)

        let num, den
        while (true) {
            [num, den] = await dx.getCurrentAuctionPrice(
                knc.address,
                weth.address,
                auctionIndex
            )

            // TODO: use actual amount
            const amount = 10000
            const [kncNum, kncDen] = await dxmm.getKyberRate(knc.address, amount)
            const targetRate = (kncNum / kncDen)
            if (num / den <= targetRate) {
                dbg(
                    `... at ${await blockChainTime()} price is ${num /
                            den} -> Done waiting!`
                )
                break
            }

            dbg(
                `... at ${await blockChainTime()} price is ${num /
                        den} (target: ${targetRate})-> waiting 10 minutes.`
            )
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

        currentAuctionIndex.should.not.equal(auctionIndex)
        dbg(`is auction still open? ${currentAuctionIndex.equals(auctionIndex)}`)

        await dx.claimBuyerFunds(knc.address, weth.address, buyer1, auctionIndex, {
            from: buyer1,
        })
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
        await weth.deposit({ value: 1e10, from: admin })
        const initialWethBalance = await weth.balanceOf(admin)

        await weth.transfer(dxmm.address, 1e10, { from: admin })
        await dxmm.withdrawToken(weth.address, 1e10, admin), { from: admin }

        const wethBalance = await weth.balanceOf(admin)
        wethBalance.should.be.bignumber.equal(initialWethBalance)
    })

    it("reject withdrawing from dxmm by non-admin users", async () => {
        await weth.deposit({ value: 1e10, from: admin })
        await weth.transfer(dxmm.address, 1e10, { from: admin })

        try {
            await dxmm.withdrawToken(weth.address, 1e10, user, { from: user })
        } catch (e) {
            assert(Helper.isRevertErrorMessage(e), "expected revert but got: " + e)
        }
    })

    it("should allow depositing to DX by admin", async () => {
        await weth.deposit({ value: 1e10, from: admin })
        await weth.transfer(dxmm.address, 1e10, { from: admin })
        const balanceBefore = await dx.balances(weth.address, dxmm.address)

        const updatedBalance = await dxmm.depositToDx.call(weth.address, 1e10, {
            from: admin,
        })
        await dxmm.depositToDx(weth.address, 1e10, { from: admin })

        const balanceAfter = await dx.balances(weth.address, dxmm.address)
        updatedBalance.should.be.bignumber.equal(balanceAfter)
        balanceAfter.should.be.bignumber.equal(balanceBefore + 1e10)
    })

    it("reject depositing to DX by non-admins", async () => {
        await weth.deposit({ value: 1e10, from: user })
        await weth.transfer(dxmm.address, 1e10, { from: user })

        try {
            await dxmm.depositToDx(weth.address, 1e10, { from: user })
        } catch (e) {
            assert(Helper.isRevertErrorMessage(e), "expected revert but got: " + e)
        }
    })

    it("should allow withdrawing from DX by admin", async () => {
        await weth.deposit({ value: 1e10, from: admin })
        await weth.transfer(dxmm.address, 1e10, { from: admin })
        const wethBalanceBefore = await weth.balanceOf(dxmm.address)
        const dxBalanceBefore = await dx.balances(weth.address, dxmm.address)

        await dxmm.depositToDx(weth.address, 1e10, { from: admin })
        await dxmm.withdrawFromDx(weth.address, 1e10, { from: admin })

        const dxBalanceAfter = await dx.balances(weth.address, dxmm.address)
        dxBalanceAfter.should.be.bignumber.equal(dxBalanceBefore)

        const wethBalanceAfter = await weth.balanceOf(dxmm.address)
        wethBalanceAfter.should.be.bignumber.equal(wethBalanceBefore)
    })

    it("reject withdrawing from DX by non-admins", async () => {
        await weth.deposit({ value: 1e10, from: admin })
        await weth.transfer(dxmm.address, 1e10, { from: admin })
        await dxmm.depositToDx(weth.address, 1e10, { from: admin })

        try {
            await dxmm.withdrawFromDx(weth.address, 1e10, { from: user })
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
        const thresholdNewAuctionUSD = await dx.thresholdNewAuction.call()
        const usdEthPrice = await dxPriceOracle.getUSDETHPrice.call()
        const [lastPriceNum, lastPriceDen] = await dx.getPriceOfTokenInLastAuction.call(
            token.address
        )
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
        const thresholdNewAuctionToken = (
            new BigNumber(thresholdNewAuctionUSD)
                .mul(new BigNumber(lastPriceDen))
                .div(
                new BigNumber(usdEthPrice)
                .mul(new BigNumber(lastPriceNum))
            )
            .ceil()
        )
        dbg(`new auction threashold is ${thresholdNewAuctionUSD} USD`)
        dbg(`oracle USDETH price is ${await usdEthPrice}`)
        dbg(`last auction price was ${lastPriceNum}/${lastPriceDen}`)

        const tokenUsdPrice = (
            new BigNumber(usdEthPrice)
            .mul(new BigNumber(lastPriceNum))
            .div(new BigNumber(lastPriceDen))
        )
        dbg(`Token price in USD is ${tokenUsdPrice}`)
        dbg(`new auction threashold is ${thresholdNewAuctionToken} TOKEN`)

        const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
            token.address
        )

        thresholdTokenWei.should.be.bignumber.equal(thresholdNewAuctionToken)
    })

    describe("missing tokens to next auction", async () => {
        it("calculate missing tokens in wei to start next auction", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const missingInWei = (
                await dxmm.calculateMissingTokenForAuctionStart.call(
                    knc.address
                )
            )

            const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
                knc.address
            )
            missingInWei.should.be.bignumber.equal(thresholdTokenWei)
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
                    knc.address
                )
            )

            const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
                knc.address
            )
            missingInWei.should.be.bignumber.equal(thresholdTokenWei.sub(10000))
        })

        it("auction is in progress - missing amount to start auction is 0", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)

            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const missingInWei = (
                await dxmm.calculateMissingTokenForAuctionStart.call(
                    knc.address
                )
            )

            missingInWei.should.be.bignumber.equal(0)
        })

        it("auction triggered, had not started - missing amount to start auction is 0", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)

            const missingInWei = (
                await dxmm.calculateMissingTokenForAuctionStart.call(
                    knc.address
                )
            )

            missingInWei.should.be.bignumber.equal(0)
        })

        it("auction started, everything bought, waiting for next auction to trigger - missing amount to start auction is threshold", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            // Buyer buys everything
            await buyEverythingInAuction(knc, auctionIndex, buyer1)

            const missingInWei = (
                await dxmm.calculateMissingTokenForAuctionStart.call(
                    knc.address
                )
            )

            const thresholdTokenWei = await dxmm.thresholdNewAuctionToken.call(
                knc.address
            )
            missingInWei.should.be.bignumber.equal(thresholdTokenWei)
        })
    })

    describe("auction state", async () => {
        it("no auction planned", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const state = await dxmm.getAuctionState(knc.address)
            state.should.be.bignumber.equal(NO_AUCTION_TRIGGERED)
        })

        it("auction triggered, waiting for it to start", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            await triggerAuction(knc, seller1)

            const state = await dxmm.getAuctionState(knc.address)
            state.should.be.bignumber.equal(AUCTION_TRIGGERED_WAITING)
        })

        it("auction in progress", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const state = await dxmm.getAuctionState(knc.address)
            state.should.be.bignumber.equal(AUCTION_IN_PROGRESS)
        })

        it("after auction ended", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)
            await buyEverythingInAuction(knc, auctionIndex, buyer1)

            const state = await dxmm.getAuctionState(knc.address)
            state.should.be.bignumber.equal(NO_AUCTION_TRIGGERED)
        })
    })

    describe("addFee", async () => {
        it("for amount 0", async () => {
            const amountWithFee = await dxmm.addFee(0)

            amountWithFee.should.be.bignumber.equal(0)
        })

        it("for amount 200", async () => {
            const amountWithFee = await dxmm.addFee(200)

            amountWithFee.should.be.bignumber.equal(201)
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

            sellTokenAmountInCurrentAuction.should.be.bignumber.equal(
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

            const seller1TokenSellAmount = (
                new BigNumber(auctionTokenSellAmount)
                .sub(10000)
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

            sellTokenAmountInCurrentAuction.should.be.bignumber.equal(
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

            sellTokenAmountInCurrentAuction.should.be.bignumber.equal(
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

            sellTokenAmountInCurrentAuction.should.be.bignumber.equal(0)
        })
    })

    describe.only("calculate buy volume from sell volume in auction", async () => {
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

            calculatedBuyTokens.should.be.bignumber.equal(expectedBuyTokens)
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
            currentAuctionIndex.should.be.bignumber.equal(
                new BigNumber(auctionIndex).add(1)
            )

            // 2 - No WETH in user balance
            const balanceAfter = await dx.balances.call(weth.address, seller1)
            // No WETH left in balance means that we bought the exact amount in
            // the auction
            balanceAfter.should.be.bignumber.equal(balanceBefore)
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

            calculatedBuyTokens.should.be.bignumber.equal(
                new BigNumber(expectedBuyTokens).sub(10000)
            )
        })

        it("what to do if some other buyer bought? we might not have enough KNC for the next auction")

        it("auction in progress, multiple seller, single buyer", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
                knc.address
            )

            // Other sellers sells KNC in auction
            await sellTokens(knc, 1000000, user)

            const seller1TokenSellAmount = (
                new BigNumber(auctionTokenSellAmount)
                .sub(1000000)
            )

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            // Calculate expected buy volume based on the amount sold by seller1
            const calculateBuyVolumeForSellVolume = async (sellToken, buyToken, sellVolume, auctionIndex) => {
                const buyVolume = await dx.buyVolumes.call(sellToken.address, buyToken.address)
                const [num, den] = await dx.getCurrentAuctionPrice.call(
                    sellToken.address,
                    buyToken.address,
                    auctionIndex
                )
                return (
                    new BigNumber(sellVolume)
                    .mul(num)
                    .dividedToIntegerBy(den)
                    .sub(buyVolume)
                )
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

            calculatedBuyTokens.should.be.bignumber.equal(expectedBuyTokens)
        })

        it("auction in progress, multiple seller, multiple buyers", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionTokenSellAmount = await dxmm.thresholdNewAuctionToken(
                knc.address
            )

            // Other sellers sells KNC in auction
            await sellTokens(knc, 1000000, user)

            const seller1TokenSellAmount = (
                new BigNumber(auctionTokenSellAmount)
                .sub(1000000)
            )

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            // Calculate expected buy volume based on the amount sold by seller1
            const calculateBuyVolumeForSellVolume = async (sellToken, buyToken, sellVolume, auctionIndex) => {
                const buyVolume = await dx.buyVolumes.call(sellToken.address, buyToken.address)
                const [num, den] = await dx.getCurrentAuctionPrice.call(
                    sellToken.address,
                    buyToken.address,
                    auctionIndex
                )
                return (
                    new BigNumber(sellVolume)
                    .mul(num)
                    .dividedToIntegerBy(den)
                    .sub(buyVolume)
                )
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

            calculatedBuyTokens.should.be.bignumber.equal(
                new BigNumber(expectedBuyTokens).sub(10000)
            )
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
            calculatedBuyTokens.should.be.bignumber.equal(0)
        })
    })

    describe.skip("will amount clear auction", async () => {
        it("using calculated buy amount", async () => {
            const knc = await deployTokenAddToDxAndClearFirstAuction()

            const auctionIndex = await triggerAuction(knc, seller1)
            await waitForTriggeredAuctionToStart(knc, auctionIndex)

            const calculatedBuyTokens = await dxmm.calculateAuctionBuyTokens.call(
                knc.address /* token */,
                auctionIndex /* auctionIndex */,
                seller1 /* account */
            )

            const willClearAuction = await dxmm.willAmountClearAuction(calculatedBuyTokens)

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
                calculatedBuyTokens - 1
            )

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

        const [kncRate, ] = await kyberProxy.getExpectedRate(
            knc.address,
            weth.address,
            kncAmountInAuction
        )

        dbg(`direct kyber rate for knc => weth is ${kncRate}`)

        const [kyberRateNum, kyberRateDen] = await dxmm.getKyberRate(
            knc.address,
            kncAmountInAuction /* amount */
        )

        dbg(`dxmm kyber rate is (${kyberRateNum}, ${kyberRateDen})`)

        const dxmmValue = kyberRateNum.div(kyberRateDen)
        const kyberValue = kncRate.div(10**18)
        dxmmValue.should.be.bignumber.equal(kyberValue)
    })

    // TODO: work on after implementing calculating buy volume
    it.skip("should claim seller and buyer funds from finished auctions", async () => {
        const knc = await deployTokenAddToDxAndClearFirstAuction()

        dbg(`$$$ Before triggering auction, KNC balance: ${await dx.balances(knc.address, user)}`)
        dbg(`$$$ Before triggering auction, WETH balance: ${await dx.balances(weth.address, user)}`)

        const auctionIndex = await triggerAuction(knc, user)

        dbg(`$$$ After triggering auction, KNC balance: ${await dx.balances(knc.address, user)}`)
        dbg(`$$$ After triggering auction, WETH balance: ${await dx.balances(weth.address, user)}`)
        dbg(`$$$ After triggering auction, seller balance: ${await dx.sellerBalances(knc.address, weth.address, auctionIndex, user)}`)
        dbg(`$$$ After triggering auction, buyer balance: ${await dx.buyerBalances(knc.address, weth.address, auctionIndex, user)}`)

        await waitForTriggeredAuctionToStart(knc, auctionIndex)
        await buyEverythingInAuction(knc, auctionIndex, user)

        const state = await dxmm.getAuctionState(knc.address)
        state.should.be.bignumber.equal(NO_AUCTION_TRIGGERED)

        const kncBalance0 = await dx.balances(knc.address, user)
        const wethBalance0 = await dx.balances(weth.address, user)
        const lastAuctionSellerBalance0 = await dx.sellerBalances(knc.address, weth.address, auctionIndex, user)
        const lastAuctionBuyerBalance0 = await dx.buyerBalances(knc.address, weth.address, auctionIndex, user)

        dbg(`$$$ After auction, KNC balance: ${kncBalance0}`)
        dbg(`$$$ After auction, WETH balance: ${wethBalance0}`)
        dbg(`$$$ After auction, seller balance: ${lastAuctionSellerBalance0}`)
        dbg(`$$$ After auction, buyer balance: ${lastAuctionBuyerBalance0}`)

        await dxmm.claimAuctionTokens(knc.address, auctionIndex)

        const kncBalance = await dx.balances(knc.address, user)
        const wethBalance = await dx.balances(weth.address, user)
        const lastAuctionSellerBalance = await dx.sellerBalances(knc.address, weth.address, auctionIndex, user)
        const lastAuctionBuyerBalance = await dx.buyerBalances(knc.address, weth.address, auctionIndex, user)

        dbg(`$$$ After claiming, KNC balance: ${kncBalance0}`)
        dbg(`$$$ After claiming, WETH balance: ${wethBalance0}`)
        dbg(`$$$ After claiming, seller balance: ${lastAuctionSellerBalance0}`)
        dbg(`$$$ After claiming, buyer balance: ${lastAuctionBuyerBalance0}`)

        lastAuctionSellerBalance.should.be.bignumber.equal(0)
        lastAuctionBuyerBalance.should.be.bignumber.equal(0)
        kncBalance.should.be.bignumber.equal(kncBalance0 + lastAuctionSellerBalance0)
        wethBalance.should.be.bignumber.equal(wethBalance0 + lastAuctionBuyerBalance0)
    })

    it("does dxmm have sufficient funds? (token and weth)")

    // ---------------

    it("should be able to withdraw all the money from dxmm")
    it("should be able to withdraw all of the money from dx")

    it("should start sale only if has enough ETH to end")

    it("calculate missing amount and postSell should be in 1 tx")

    // TODO: Support the opposite direction
    const flow = `
    switch(KncAuctionState()):
        case AUCTION_TRIGGERED_WAITING:
            return  // nothing to do but wait now

        case NO_AUCTION_TRIGGERED:
            // Claim unclaimed KNC and WETH
            if currentAuctionIndex > lastClaimedAuctionIndex:
                auctionIndices = [lastClaimedAuctionIndex + 1 to currentAuctionIndex(excluding)]
                claimTokensFromSeveralAuctionsAsSeller(knc, weth, auctionIndices)
                claimTokensFromSeveralAuctionsAsBuyer(knc, weth, auctionIndices)

            // Trigger auction
            missingKncToStartAuction = calculateMissingTokenForAuctionStart(knc)
            if missingKncToStartAuction == 0:
                ERROR - Why auction has not started?

            if dxmm.balanace(KNC) < missingKncToStartAuction:
                // TODO: buy required KNC, start the auction and then notify
                FINISH WITH ERROR - desposit KNC
            deposit(missingKncToStartAuction)

            // trigger Auction
            postSellOrder(KNC, WETH, minimumAuctionAmount)

        case AUCTION_IN_PROGRESS:
            if isKncCheaperThanOnKyber():
                postBuyOrder(calculateKncWePutInAuction())

        ----
        # alternative flow:

        if not auctionTriggered():
            triggerAuction()

        if auctionRunning():
            maybeBuyKncIfCheaperThanKyber()

    `
})

// TODO: Extract to util class
async function waitTimeInSeconds(seconds) {
    await Helper.sendPromise("evm_increaseTime", [seconds])
    await Helper.sendPromise("evm_mine", [])
}

// TODO: Extract to util class
function blockChainTime() {
    return web3.eth.getBlock(web3.eth.blockNumber).timestamp
}

async function dbg(...args) {
    if (DEBUG) console.log(...args)
}
