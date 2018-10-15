const BigNumber = web3.BigNumber
const Helper = require("./helper.js")

require("chai")
    .use(require("chai-as-promised"))
    .use(require('chai-bignumber')(BigNumber))
    .should()

const DutchExchange = artifacts.require("DutchExchange")
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

    async function getTokenListingFundingInWei() {
        // TODO: threshold is in USD / 1e18, convert to ETH using their Oracle.
        // return await dx.thresholdNewTokenPair()
        return 1e20
    }

    before('setup accounts', async () => {
        admin = accounts[0]
        seller1 = accounts[1]
        buyer1 = accounts[2]
        weth = await EtherToken.deployed()
        dxmm = await DxMarketMaker.deployed()
        dx = DutchExchange.at(await dxmm.dx())
    })

    // beforeEach('setup contract for each test', async () => {
    //     dxmm = DxMarketMaker.new()
    // })

    it("should have deployed the contract", async () => {
        dxmm.should.exist
    })

    it("admin should deploy token, add to dx, and conclude the first auction", async () => {
        const lister = admin
        const initialWethWei = 1e20
        const knc = await deployToken()
        const kncSymbol = await knc.symbol()
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
        const auctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
        dbg(`\n--- waited 6 hours for auction ${auctionIndex} to start`)

        const dbgVolumesAndPrices = async (st, bt) => {
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
            const remainingSellVolume = sellVolume - buyVolume * num / den
            const remainingBuyVolume = sellVolume * num / den - buyVolume
            dbg(`...... sellVolumesCurrent: ${sellVolume} ${stSymbol}`)
            dbg(`...... buyVolumes: ${buyVolume} ${btSymbol}`)
            dbg(`...... price ${stSymbol}/${btSymbol} is ${num}/${den}`)
            dbg(`...... remaining SELL tokens: ${remainingSellVolume} ${stSymbol}`)
            dbg(`...... remaining BUY tokens: ${remainingBuyVolume} ${btSymbol}`)
            return [remainingSellVolume, remainingBuyVolume]
        }
        dbg(`\n--- available for auction:`)
        const [, remainingBuyVolume] = await dbgVolumesAndPrices(weth, knc)
        await dbgVolumesAndPrices(knc, weth)

        dbg(`\n--- lister wants to buy it all`)
        dbg(`fee is ${await dx.getFeeRatio(lister)}`)
        const calculateAmountWithFee = async (amount) => {
            const [num, den] = await dx.getFeeRatio(lister)
            return amount / (1 - num / den)
        }
        dbg(`remaining sell volume in ${kncSymbol} is ${remainingBuyVolume}`)
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
        dbg(`\n--- lister bought ${buyAmount} ${kncSymbol}`)
        dbg(`\n--- remaining:`)
        await dbgVolumesAndPrices(weth, knc)
        await dbgVolumesAndPrices(knc, weth)

        const currentAuctionIndex = await dx.getAuctionIndex(knc.address, weth.address)
        dbg(`\n--- is auction still open? ${currentAuctionIndex == auctionIndex}`)

        dbg(`+++ current lister balance:`)
        dbg(`   lister WETH balance is ${await dx.balances(weth.address, lister)}`)
        dbg(`   lister KNC balance is ${await dx.balances(knc.address, lister)}`)

        const [fundsRetuned, frtsIssued] = await dx.claimSellerFunds.call(
            weth.address,
            knc.address,
            lister,
            auctionIndex
        )
        await dx.claimSellerFunds(
            weth.address,
            knc.address,
            lister,
            auctionIndex
        )
        dbg(`\n--- lister claimed seller funds`)
        dbg(`claimed funds S:weth, B:knc: ${fundsRetuned}`)

        const [fundsRetuned1, ] = await dx.claimBuyerFunds.call(
            weth.address,
            knc.address,
            lister,
            auctionIndex
        )
        await dx.claimBuyerFunds(
            weth.address,
            knc.address,
            lister,
            auctionIndex
        )
        dbg(`\n--- lister claimed buyer funds`)
        dbg(`claimed funds S:weth, B:knc: ${fundsRetuned1}`)

        const [fundsRetuned2, ] = await dx.claimBuyerFunds.call(
            knc.address,
            weth.address,
            lister,
            auctionIndex
        )
        await dx.claimBuyerFunds(
            knc.address,
            weth.address,
            lister,
            auctionIndex
        )
        dbg(`claimed funds S:knc, B:weth: ${fundsRetuned2}`)

        const listerWethBalance = await dx.balances(weth.address, lister)
        const listerKncBalance = await dx.balances(knc.address, lister)
        dbg(`+++ current lister balance:`)
        dbg(`   lister DX WETH balance is ${listerWethBalance}`)
        dbg(`   lister DX KNC balance is ${listerKncBalance}`)
        dbg(`   lister WETH balance is ${await weth.balanceOf(lister)}`)
        dbg(`   lister KNC balance is ${await knc.balanceOf(lister)}`)

        await dx.withdraw(weth.address, listerWethBalance)
        await dx.withdraw(knc.address, listerKncBalance)
        dbg(`--- lister withdrew WETH and KNC balances`)
        dbg(`+++ current lister balance:`)
        dbg(`   lister DX WETH balance is ${await dx.balances(weth.address, lister)}`)
        dbg(`   lister DX KNC balance is ${await dx.balances(knc.address, lister)}`)
        dbg(`   lister WETH balance is ${await weth.balanceOf(lister)}`)
        dbg(`   lister KNC balance is ${await knc.balanceOf(lister)}`)

        assert(false)
    })

    it("should clear the auction when we buy everything")
    it("should be able to add token, wait for initial sell to end, then start new sale")
    it("should be able to check if should buy back (using kyber price)")
    it("should be able to withdraw all the money from dxmm")
    it("should be able to withdraw all of the money from dx")
    it("should start sale only if has enough ETH to end")
})

async function waitTimeInSeconds(seconds) {
     await Helper.sendPromise('evm_increaseTime', [seconds])
     await Helper.sendPromise('evm_mine', [])
}

async function dbg(...args) {
    if (DEBUG) console.log(...args)
}

function blockChainTime() {
    return web3.eth.getBlock(web3.eth.blockNumber).timestamp
}
