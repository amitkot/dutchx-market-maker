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


// TODO: add events for logging calculations and decisions
// TODO: add fail texts to require calls
// TODO: add support to token -> token
contract DxMarketMaker is Withdrawable {
    // This is the representation of ETH as an ERC20 Token for Kyber Network.
    ERC20 constant internal ETH_TOKEN_ADDRESS = ERC20(
        0x00eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
    );

    // Declared in DutchExchange contract but not public.
    uint public constant DX_AUCTION_START_WAITING_FOR_FUNDING = 1;

    enum AuctionState {
        NO_AUCTION_TRIGGERED,
        AUCTION_TRIGGERED_WAITING,
        AUCTION_IN_PROGRESS
    }

    AuctionState constant public NO_AUCTION_TRIGGERED = AuctionState.NO_AUCTION_TRIGGERED;
    AuctionState constant public AUCTION_TRIGGERED_WAITING = AuctionState.AUCTION_TRIGGERED_WAITING;
    AuctionState constant public AUCTION_IN_PROGRESS = AuctionState.AUCTION_IN_PROGRESS;

    DutchExchange public dx;
    EtherToken public weth;
    KyberNetworkProxy public kyberNetworkProxy;

    // Token => Token => auctionIndex
    mapping (address => mapping (address => uint)) public lastClaimedAuctionIndex;

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

    // TODO: consider adding a "safety margin" to compensate for accuracy issues.
    function thresholdNewAuctionToken(address token)
        public
        view
        returns (uint num)
    {
        uint priceTokenNum;
        uint priceTokenDen;
        (priceTokenNum, priceTokenDen) = dx.getPriceOfTokenInLastAuction(token);

        DxPriceOracleInterface priceOracle = DxPriceOracleInterface(
            dx.ethUSDOracle()
        );

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

    function calculateMissingTokenForAuctionStart(
        address sellToken,
        address buyToken
    )
        public
        view
        returns (uint)
    {
        uint currentAuctionSellVolume = dx.sellVolumesCurrent(sellToken, buyToken);
        uint thresholdTokenWei = thresholdNewAuctionToken(sellToken);

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
        if (auctionStart > DX_AUCTION_START_WAITING_FOR_FUNDING) {
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

    // TODO: support token -> token
    function getKyberRate(address _token, uint amount)
        public
        view
        returns (uint num, uint den)
    {
        ERC20 token = ERC20(_token);
        uint rate;
        (rate, ) = kyberNetworkProxy.getExpectedRate(
            token,
            ETH_TOKEN_ADDRESS,
            amount
        );

        return (rate, 10 ** token.decimals());
    }

    function sellTokenAmountInCurrentAuction(
        address token,
        uint auctionIndex,
        address account
    )
        public
        view
        returns (uint)
    {
        return dx.sellerBalances(token, weth, auctionIndex, account);
    }

    // The amount of tokens that matches the amount sold by provided account in
    // specified auction index, deducting the amount that was already bought.
    function calculateAuctionBuyTokens(
        address sellToken,
        uint auctionIndex,
        address account
    )
        public
        view
        returns (uint)
    {
        // TODO: support token -> token
        address buyToken = weth;
        uint sellVolume = sellTokenAmountInCurrentAuction(
            sellToken,
            auctionIndex,
            account
        );
        uint buyVolume = dx.buyVolumes(sellToken, buyToken);

        uint num;
        uint den;
        (num, den) = dx.getCurrentAuctionPrice(
            sellToken,
            buyToken,
            auctionIndex
        );

        // No price for this auction, it is a future one.
        if (den == 0) return 0;

        return mul(sellVolume, num) / den - buyVolume;
    }

    // XXX: DOES NOT SUPPORT MULTIPLE ACCOUNTS!
    function claimAuctionTokens(
        address sellToken,
        address buyToken,
        address account
    )
        public
    {
        uint lastCompletedAuction = dx.getAuctionIndex(sellToken, buyToken) - 1;

        if (lastCompletedAuction <= lastClaimedAuctionIndex[sellToken][buyToken]) return;

        for (uint i = lastClaimedAuctionIndex[sellToken][buyToken] + 1; i <= lastCompletedAuction; i++) {
            if (dx.sellerBalances(sellToken, buyToken, i, account) > 0) {
                dx.claimSellerFunds(sellToken, buyToken, account, i);
            }
            if (dx.buyerBalances(sellToken, buyToken, i, account) > 0) {
                dx.claimBuyerFunds(sellToken, buyToken, account, i);
            }
        }

        lastClaimedAuctionIndex[sellToken][buyToken] = lastCompletedAuction;
    }

    function claimSpecificAuctionTokens(
        address sellToken,
        address buyToken,
        uint auctionIndex
    )
        public
    {
    }

    event AuctionTriggered(
        address sellToken,
        address buyToken,
        uint auctionIndex,
        uint sellTokenAmount
    );

    function triggerAuction(
        address sellToken,
        address buyToken
    )
        public
        returns (bool triggered)
    {
        uint missingTokens = addFee(
            calculateMissingTokenForAuctionStart(
                sellToken,
                buyToken
            )
        );
        if (missingTokens == 0) return false;

        uint balance = dx.balances(sellToken, address(this));
        require(balance >= missingTokens, "Not enough tokens to trigger auction");

        uint auctionIndex = dx.getAuctionIndex(sellToken, buyToken);
        dx.postSellOrder(sellToken, buyToken, auctionIndex, missingTokens);

        emit AuctionTriggered(sellToken, buyToken, auctionIndex, missingTokens);
        return true;
    }

    function willAmountClearAuction(
        address sellToken,
        address buyToken,
        uint auctionIndex,
        uint amount
    )
        public
        view
        returns (bool)
    {
        // TODO: add similar requires here and in other places?
        // R1: auction must not have cleared
        // require(closingPrices[sellToken][buyToken][auctionIndex].den == 0);

        // uint auctionStart = getAuctionStart(sellToken, buyToken);

        // R2
        // require(auctionStart <= now);

        // R4
        // require(auctionIndex == getAuctionIndex(sellToken, buyToken));

        // R5: auction must not be in waiting period
        // require(auctionStart > AUCTION_START_WAITING_FOR_FUNDING);

        uint buyVolume = dx.buyVolumes(sellToken, buyToken);

        // R7
        // require(add(buyVolume, amount) < 10 ** 30);

        // Overbuy is when a part of a buy order clears an auction
        // In that case we only process the part before the overbuy
        // To calculate overbuy, we first get current price
        uint sellVolume = dx.sellVolumesCurrent(sellToken, buyToken);

        uint num;
        uint den;
        (num, den) = dx.getCurrentAuctionPrice(sellToken, buyToken, auctionIndex);
        // 10^30 * 10^37 = 10^67
        uint outstandingVolume = atleastZero(int(mul(sellVolume, num) / den - buyVolume));
        return amount >= outstandingVolume;
    }

    // --- Safe Math functions ---
    // ---------------------------
    /**
    * @dev Multiplies two numbers, reverts on overflow.
    */
    function mul(uint256 a, uint256 b) internal pure returns (uint256) {
        // Gas optimization: this is cheaper than requiring 'a' not being zero,
        // but the benefit is lost if 'b' is also tested.
        // See: https://github.com/OpenZeppelin/openzeppelin-solidity/pull/522
        if (a == 0) {
            return 0;
        }

        uint256 c = a * b;
        require(c / a == b);

        return c;
    }

    /**
    * @dev Integer division of two numbers truncating the quotient, reverts on
        division by zero.
    */
    function div(uint256 a, uint256 b) internal pure returns (uint256) {
        // Solidity only automatically asserts when dividing by 0
        require(b > 0);
        uint256 c = a / b;
        // assert(a == b * c + a % b); // There is no case in which this doesn't hold

        return c;
    }

    function atleastZero(int a)
        public
        pure
        returns (uint)
    {
        if (a < 0) {
            return 0;
        } else {
            return uint(a);
        }
    }

}
