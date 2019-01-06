pragma solidity ^0.4.24;

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
        ERC20 sellToken,
        ERC20 buyToken
    )
        public
        returns (bool)
    {
        return triggerAuction(sellToken, buyToken);
    }

    function testBuyInAuction(
        ERC20 sellToken,
        ERC20 buyToken
    )
        public
        returns (bool bought)
    {
        return buyInAuction(sellToken, buyToken);
    }
}
