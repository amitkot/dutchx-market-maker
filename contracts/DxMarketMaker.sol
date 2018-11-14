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

interface DxPriceOracleInterface {
    function getUSDETHPrice() public view returns (uint256);
}

// TODO: add support to token -> token
contract DxMarketMaker is Withdrawable {
    // This is the representation of ETH as an ERC20 Token for Kyber Network.
    ERC20 constant internal ETH_TOKEN_ADDRESS = ERC20(
        0x00eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
    );

    // Declared in DutchExchange contract but not public.
    uint internal constant DX_AUCTION_START_WAITING_FOR_FUNDING = 1;

    DutchExchange public dx;
    EtherToken public weth;
    KyberNetworkProxy public kyberNetworkProxy;

    enum AuctionState {
        NO_AUCTION_TRIGGERED,
        AUCTION_TRIGGERED_WAITING,
        AUCTION_IN_PROGRESS
    }

    AuctionState constant public NO_AUCTION_TRIGGERED = AuctionState.NO_AUCTION_TRIGGERED;
    AuctionState constant public AUCTION_TRIGGERED_WAITING = AuctionState.AUCTION_TRIGGERED_WAITING;
    AuctionState constant public AUCTION_IN_PROGRESS = AuctionState.AUCTION_IN_PROGRESS;

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

    function thresholdNewAuctionToken(address token)
        public
        view
        returns (uint num)
    {
        uint priceTokenNum;
        uint priceTokenDen;
        (priceTokenNum, priceTokenDen) = dx.getPriceOfTokenInLastAuction(token);

        DxPriceOracleInterface priceOracle = DxPriceOracleInterface(dx.ethUSDOracle());

        // Rounding up to make sure we pass the threshold
        return 1 + div(
            // mul() takes care of overflows
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

    function calculateMissingTokenForAuctionStart(address token)
        public
        view
        returns (uint)
    {
        uint currentAuctionSellVolume = dx.sellVolumesCurrent(token, weth);
        uint thresholdTokenWei = thresholdNewAuctionToken(token);
        
        if (thresholdTokenWei > currentAuctionSellVolume) {
            return thresholdTokenWei - currentAuctionSellVolume;
        }

        return 0;
    }

    function addFee(uint amount) public view returns (uint) {
        uint num;
        uint den;
        (num, den) = dx.getFeeRatio(msg.sender);

        // amount / (1 - num / den)
        return div(
            mul(amount, den),
            (den - num)
        );
    }

    function getAuctionState(address token) public view returns (AuctionState) {
        uint auctionStart = dx.getAuctionStart(token, weth);
        if (auctionStart != DX_AUCTION_START_WAITING_FOR_FUNDING) {
            // DutchExchange logic uses auction start time.
            /* solhint-disable not-rely-on-time */
            if (auctionStart > now) {
                return AuctionState.AUCTION_TRIGGERED_WAITING;
            } else {
                return AuctionState.AUCTION_IN_PROGRESS;
            }
        }
        return AuctionState.NO_AUCTION_TRIGGERED;
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
