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

contract('DxMarketMaker', async (accounts) => {
    async function fundAndAddToken(token) {
        // TODO: threshold is in USD / 1e18, convert to ETH using their Oracle.
        const initialDepositInWethWei = await dx.thresholdNewTokenPair()

        // if no WETH in the account
        await weth.deposit({value: initialDepositInWethWei})
        console.log('deposited %d ETH to WETH', initialDepositInWethWei)

        await weth.approve(dxmm.address, initialDepositInWethWei)
        console.log('approved %d weth to dxmm', initialDepositInWethWei)

        await dxmm.addToken(
            knc.address,
            initialDepositInWethWei,
            100 /* tokenToEthNum */,
            1 /* tokenToEthDen */
        )
    }
    
    before('setup accounts', async () => {
        account = accounts[0]
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

    it("should add KNC-WETH pair to DX", async () => {
        const knc = await TestToken.new("kyber crystals", "KNC", 18)
        const indexBefore = await dx.getAuctionIndex(weth.address, knc.address)

        await fundAndAddToken(knc)

        const indexAfter = await dx.getAuctionIndex(weth.address, knc.address)

        indexBefore.should.be.bignumber.equal(0)
        indexAfter.should.be.bignumber.equal(1)
    })

    it("should start new auction after 6 hours", async () => {
        // is it time yet?
        console.log(
            'threshold for new auction is',
            (await dx.thresholdNewAuction()).toNumber()
        )

    })


    it("should be able to check if should buy back (using kyber price)")
    it("should start sale only of has enough ETH to end")
    it("should be able to check if ")
    it("should be able to withdraw all the money from dxmm")
    it("should be able to withdraw all of the money from dx")
})

async function waitTimeInSeconds(seconds) {
     await Helper.sendPromise('evm_increaseTime', [seconds]);
}
