/* global artifacts */
/* eslint no-undef: "error" */

// const KyberDxMarketMaker = artifacts.require('KyberDxMarketMaker')
const TestingKyberdxMarketMaker = artifacts.require('TestingKyberDxMarketMaker')
const DutchExchangeProxy = artifacts.require('DutchExchangeProxy')
const MockKyberNetworkProxy = artifacts.require('MockKyberNetworkProxy')

module.exports = async function(deployer, network, accounts) {
  const admin = accounts[1]
  deployer.then(async () => {
    if (network === 'development') {
      const dx = await DutchExchangeProxy.deployed()
      console.log('Deployed DutchExchange to address %s', dx.address)
      const mockKyberNetworkProxy = await deployer.deploy(
        MockKyberNetworkProxy,
        // TODO: use actual KyberNetworkProxy value!
        1555000000000000,
        { from: admin }
      )
      console.log(
        'Deployed MockKyberNetworkProxy to address %s',
        mockKyberNetworkProxy.address
      )

      await deployer.deploy(
        TestingKyberdxMarketMaker,
        dx.address,
        mockKyberNetworkProxy.address,
        { from: admin }
      )
      console.log(
        'Deployed TestingKyberdxMarketMaker to address %s with DutchExchange at %s',
        TestingKyberdxMarketMaker.address,
        dx.address
      )
    }
  })
}
