pragma solidity ^0.4.23;

import "./ERC20Interface.sol";
import "./Withdrawable.sol";
import "@gnosis.pm/dx-contracts/contracts/DutchExchange.sol";
import "@gnosis.pm/dx-contracts/contracts/Oracle/PriceOracleInterface.sol";
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

    function depositToDx(address token, uint amount)
        public
        onlyAdmin
        returns (uint)
    {
        ERC20(token).approve(dx, amount);
        return dx.deposit(token, amount);
    }

    function withdrawFromDx(address token, uint amount)
        public
        onlyAdmin
        returns (uint)
    {
        return dx.withdraw(token, amount);
    }

    function thresholdNewAuction(address token)
        public
        // TODO: can this be a view function? It uses oracle's non-view function...
        // view
        returns (uint)
    {
        uint priceTokenNum;
        uint priceTokenDen;
        (priceTokenNum, priceTokenDen) = dx.getPriceOfTokenInLastAuction(token);

        PriceOracleInterface priceOracle = PriceOracleInterface(dx.ethUSDOracle());

        return div(
            mul(
                dx.thresholdNewAuction(),
                priceTokenDen
            ),
            mul(
                priceOracle.getUSDETHPrice(),
                priceTokenNum
            )
        );
    }

    // --- Safe Math functions ---
    // ---------------------------
    /**
    * @dev Multiplies two numbers, reverts on overflow.
    */
    function mul(uint256 a, uint256 b) internal pure returns (uint256) {
        // Gas optimization: this is cheaper than requiring 'a' not being zero, but the
        // benefit is lost if 'b' is also tested.
        // See: https://github.com/OpenZeppelin/openzeppelin-solidity/pull/522
        if (a == 0) {
            return 0;
        }

        uint256 c = a * b;
        require(c / a == b);

        return c;
    }

    /**
    * @dev Integer division of two numbers truncating the quotient, reverts on division by zero.
    */
    function div(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b > 0); // Solidity only automatically asserts when dividing by 0
        uint256 c = a / b;
        // assert(a == b * c + a % b); // There is no case in which this doesn't hold

        return c;
    }
}
