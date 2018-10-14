/* global artifacts */
/* eslint no-undef: "error" */

const DxMarketMaker = artifacts.require("DxMarketMaker")
const DutchExchangeProxy = artifacts.require("DutchExchangeProxy")
const EtherToken = artifacts.require("EtherToken")

module.exports = async function(deployer, network, accounts) {
    deployer.then(async () => {
        if (network === 'development') {
            const dx = await DutchExchangeProxy.deployed()
            const weth = await EtherToken.deployed()
            console.log('Deployed DutchExchange to address %s', dx.address)
            const dxMarketMaker = await deployer.deploy(DxMarketMaker, dx.address, weth.address)
            console.log('Deployed DxMarketMaker to address %s with DutchExchange at %s', dxMarketMaker.address, dx.address)
        }
    })
}
