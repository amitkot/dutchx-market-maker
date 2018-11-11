/* global artifacts */
/* eslint no-undef: "error" */

const DxMarketMaker = artifacts.require("DxMarketMaker")
const DutchExchangeProxy = artifacts.require("DutchExchangeProxy")
const EtherToken = artifacts.require("EtherToken")
const MockKyberNetworkProxy = artifacts.require("MockKyberNetworkProxy")

module.exports = async function(deployer, network, accounts) {
    deployer.then(async () => {
        if (network === 'development') {
            const dx = await DutchExchangeProxy.deployed()
            const weth = await EtherToken.deployed()
            console.log('Deployed DutchExchange to address %s', dx.address)
            const mockKyberNetworkProxy = await deployer.deploy(
                MockKyberNetworkProxy,
                // TODO: use actual KyberNetworkProxy value!
                500
            )
            console.log(
                'Deployed MockKyberNetworkProxy to address %s',
                mockKyberNetworkProxy.address
            )
            const dxMarketMaker = await deployer.deploy(
                DxMarketMaker,
                dx.address,
                weth.address,
                mockKyberNetworkProxy.address
            )
            console.log('Deployed DxMarketMaker to address %s with DutchExchange at %s', dxMarketMaker.address, dx.address)
        }
    })
}