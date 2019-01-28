pragma solidity 0.5.2;

import "../KyberDxMarketMaker.sol";


contract TestingKyberDxMarketMaker is KyberDxMarketMaker {
    constructor(
        DutchExchange _dx,
        KyberNetworkProxy _kyberNetworkProxy
    )
        KyberDxMarketMaker(_dx, _kyberNetworkProxy)
        public
    {
    }

    function testTriggerAuction(
        address sellToken,
        address buyToken
    )
        public
        returns (bool)
    {
        return triggerAuction(sellToken, buyToken);
    }

    function testBuyInAuction(
        address sellToken,
        address buyToken
    )
        public
        returns (bool bought)
    {
        return buyInAuction(sellToken, buyToken);
    }
}
