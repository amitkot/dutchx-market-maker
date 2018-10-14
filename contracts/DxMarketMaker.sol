pragma solidity ^0.4.23;

import "@gnosis.pm/dx-contracts/contracts/DutchExchange.sol";
import "@gnosis.pm/util-contracts/contracts/EtherToken.sol";

contract DxMarketMaker {
    // TODO: calculate a more reasonable value
    uint constant INITIAL_DEPOSIT_WETH_WEI = 100 * 10 ** 18;

    DutchExchange public dx;
    EtherToken public weth;

    constructor(address _dx, address _weth) {
        require(address(_dx) != address(0));
        require(address(_weth) != address(0));

        dx = DutchExchange(_dx);
        weth = EtherToken(_weth);
    }

    function addToken(
        address token,
        uint amountEthWei,
        uint tokenToEthNum,
        uint tokenToEthDen
    )
        public
        returns (bool)
    {
        // fund
        require(weth.transferFrom(msg.sender, this, amountEthWei));

        weth.approve(dx, amountEthWei);
        dx.deposit(weth, amountEthWei);

        // add token pair
        dx.addTokenPair(
            weth,
            token,
            amountEthWei,   // weth funding
            0,              // other token funding
            tokenToEthNum,
            tokenToEthDen
        );

        return true;
    }
}
