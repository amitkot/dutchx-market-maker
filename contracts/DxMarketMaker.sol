pragma solidity ^0.4.23;

import "./ERC20Interface.sol";
import "./Withdrawable.sol";
import "@gnosis.pm/dx-contracts/contracts/DutchExchange.sol";
import "@gnosis.pm/util-contracts/contracts/EtherToken.sol";


interface KyberNetworkProxy {
    function getExpectedRate(ERC20 src, ERC20 dest, uint srcQty)
        public
        view
        returns (uint expectedRate, uint slippageRate);
}


contract DxMarketMaker is Withdrawable {
    // This is the representation of ETH as an ERC20 Token for Kyber Network.
    ERC20 constant internal ETH_TOKEN_ADDRESS = ERC20(
        0x00eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
    );

    DutchExchange public dx;
    EtherToken public weth;
    KyberNetworkProxy public kyberNetworkProxy;

    constructor(address _dx, address _weth, address _kyberNetworkProxy) public {
        require(address(_dx) != address(0));
        require(address(_weth) != address(0));
        require(address(_kyberNetworkProxy) != address(0));

        dx = DutchExchange(_dx);
        weth = EtherToken(_weth);
        kyberNetworkProxy = KyberNetworkProxy(_kyberNetworkProxy);
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
        require(weth.transferFrom(msg.sender, address(this), amountEthWei));

        weth.approve(address(dx), amountEthWei);
        dx.deposit(address(weth), amountEthWei);

        // add token pair
        dx.addTokenPair(
            address(weth),
            address(token),
            amountEthWei,   // weth funding
            0,              // other token funding
            tokenToEthNum,
            tokenToEthDen
        );

        return true;
    }

    // TODO: should this be allowed for non-admin users?
    function depositToDx(address tokenAddress, uint amount)
        public
        onlyAdmin
        returns (uint)
    {
        ERC20(tokenAddress).approve(dx, amount);
        return dx.deposit(tokenAddress, amount);
    }

    // TODO: should this be allowed for non-admin users?
    function withdrawFromDx(address tokenAddress, uint amount)
        public
        onlyAdmin
        returns (uint)
    {
        return dx.withdraw(tokenAddress, amount);
    }
}
