/* global artifacts */
/* eslint no-undef: "error" */

const KyberDxMarketMaker = artifacts.require("KyberDxMarketMaker")
const DutchExchangeProxy = artifacts.require("DutchExchangeProxy")
const MockKyberNetworkProxy = artifacts.require("MockKyberNetworkProxy")

module.exports = async function(deployer, network, accounts) {
    deployer.then(async () => {
        if (network === 'development') {
            const dx = await DutchExchangeProxy.deployed()
            console.log('Deployed DutchExchange to address %s', dx.address)
            const mockKyberNetworkProxy = await deployer.deploy(
                MockKyberNetworkProxy,
                // TODO: use actual KyberNetworkProxy value!
                1555000000000000
            )
            console.log(
                'Deployed MockKyberNetworkProxy to address %s',
                mockKyberNetworkProxy.address
            )
            const KyberDxMarketMaker = await deployer.deploy(
                KyberDxMarketMaker,
                dx.address,
                mockKyberNetworkProxy.address
            )
            console.log('Deployed KyberDxMarketMaker to address %s with DutchExchange at %s', KyberDxMarketMaker.address, dx.address)
        }
    })
}
