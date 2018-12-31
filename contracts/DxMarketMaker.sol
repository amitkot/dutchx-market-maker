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
    ERC20 constant internal KYBER_ETH_TOKEN = ERC20(
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
    mapping (address => mapping (address => uint)) public lastClaimedAuction;

    constructor(address _dx, address _kyberNetworkProxy) public {
        require(address(_dx) != address(0));
        require(address(_kyberNetworkProxy) != address(0));

        dx = DutchExchange(_dx);
        weth = EtherToken(dx.ethToken());
        kyberNetworkProxy = KyberNetworkProxy(_kyberNetworkProxy);
    }

    // TODO: emit event
    function depositToDx(address token, uint amount)
        public
        onlyAdmin
        returns (uint)
    {
        require(ERC20(token).approve(dx, amount));
        return dx.deposit(token, amount);
    }

    // TODO: emit event
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

    function getAuctionState(
        address sellToken,
        address buyToken
    )
        public
        view
        returns (AuctionState)
    {
        uint auctionStart = dx.getAuctionStart(sellToken, buyToken);
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
    function getKyberRate(address _sellToken, address _buyToken, uint amount)
        public
        view
        returns (uint num, uint den)
    {
        ERC20 sellToken = _sellToken == address(weth) ? KYBER_ETH_TOKEN : ERC20(_sellToken);
        ERC20 buyToken = _buyToken == address(weth) ? KYBER_ETH_TOKEN : ERC20(_buyToken);
        uint rate;
        (rate, ) = kyberNetworkProxy.getExpectedRate(
            sellToken,
            buyToken,
            amount
        );

        // KyberNetworkProxy.getExpectedRate() always returns a result that is
        // rate / 10**18.
        return (rate, 10 ** 18);
    }

    function tokensSoldInCurrentAuction(
        address sellToken,
        address buyToken,
        uint auctionIndex,
        address account
    )
        public
        view
        returns (uint)
    {
        return dx.sellerBalances(sellToken, buyToken, auctionIndex, account);
    }

    // The amount of tokens that matches the amount sold by provided account in
    // specified auction index, deducting the amount that was already bought.
    function calculateAuctionBuyTokens(
        address sellToken,
        address buyToken,
        uint auctionIndex,
        address account
    )
        public
        view
        returns (uint)
    {
        uint sellVolume = tokensSoldInCurrentAuction(
            sellToken,
            buyToken,
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

    event ClaimedAuctionTokens(
        address indexed sellToken,
        address indexed buyToken,
        uint previousLastCompletedAuction,
        uint newLastCompletedAuction,
        uint sellerFunds,
        uint buyerFunds
    );

    function claimAuctionTokens(
        address sellToken,
        address buyToken
    )
        public
        returns (uint sellerFunds, uint buyerFunds)
    {
        uint initialLastClaimed = lastClaimedAuction[sellToken][buyToken];

        uint lastCompletedAuction = dx.getAuctionIndex(sellToken, buyToken) - 1;
        if (lastCompletedAuction <= initialLastClaimed) return;

        uint amount;
        for (uint i = lastClaimedAuction[sellToken][buyToken] + 1; i <= lastCompletedAuction; i++) {
            if (dx.sellerBalances(sellToken, buyToken, i, address(this)) > 0) {
                (amount, ) = dx.claimSellerFunds(sellToken, buyToken, address(this), i);
                sellerFunds += amount;
            }
            if (dx.buyerBalances(sellToken, buyToken, i, address(this)) > 0) {
                (amount, ) = dx.claimBuyerFunds(sellToken, buyToken, address(this), i);
                buyerFunds += amount;
            }
        }

        lastClaimedAuction[sellToken][buyToken] = lastCompletedAuction;
        emit ClaimedAuctionTokens(
            sellToken,
            buyToken,
            initialLastClaimed,
            lastCompletedAuction,
            sellerFunds,
            buyerFunds
        );
    }

    event AuctionTriggered(
        address indexed sellToken,
        address indexed buyToken,
        uint indexed auctionIndex,
        uint sellTokenAmount,
        uint sellTokenAmountWithFee
    );

    // TODO: maybe verify that pair is listed in dutchx
    function triggerAuction(
        address sellToken,
        address buyToken
    )
        public
        returns (bool triggered)
    {
        uint missingTokens = calculateMissingTokenForAuctionStart(
            sellToken,
            buyToken
        );
        uint missingTokensWithFee = addFee(missingTokens);
        if (missingTokensWithFee == 0) return false;

        uint balance = dx.balances(sellToken, address(this));
        require(
            balance >= missingTokensWithFee,
            "Not enough tokens to trigger auction"
        );

        uint auctionIndex = dx.getAuctionIndex(sellToken, buyToken);
        dx.postSellOrder(sellToken, buyToken, auctionIndex, missingTokensWithFee);

        emit AuctionTriggered(
            sellToken,
            buyToken,
            auctionIndex,
            missingTokens,
            missingTokensWithFee
        );
        return true;
    }

    // TODO: emit event
    // TODO: check for all the requirements of dutchx
    event BoughtInAuction(
        address indexed sellToken,
        address indexed buyToken,
        uint auctionIndex,
        uint buyTokenAmount,
        bool clearedAuction
    );

    function buyInAuction(
        address sellToken,
        address buyToken
    )
        public
        returns (bool bought)
    {
        require(
            getAuctionState(sellToken, buyToken) == AuctionState.AUCTION_IN_PROGRESS,
            "No auction in progress"
        );

        uint auctionIndex = dx.getAuctionIndex(sellToken, buyToken);
        uint buyTokenAmount = calculateAuctionBuyTokens(
            sellToken,
            buyToken,
            auctionIndex,
            address(this)
        );
        if (buyTokenAmount == 0) return false;

        bool willClearAuction = willAmountClearAuction(
            sellToken,
            buyToken,
            auctionIndex,
            buyTokenAmount
        );
        if (!willClearAuction) {
            buyTokenAmount = addFee(buyTokenAmount);
        }

        require(
            dx.balances(buyToken, address(this)) >= buyTokenAmount,
            "Not enough buy token to buy required amount"
        );
        dx.postBuyOrder(sellToken, buyToken, auctionIndex, buyTokenAmount);
        emit BoughtInAuction(
            sellToken,
            buyToken,
            auctionIndex,
            buyTokenAmount,
            willClearAuction
        );
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

    function depositAllBalance(address token) public returns (uint amount) {
        uint balance = ERC20(token).balanceOf(address(this));
        if (balance > 0) {
            amount = depositToDx(token, balance);
        }
    }

    function magic(
        address sellToken,
        address buyToken
    )
        public
        returns (bool)
    {
        // Deposit dxmm token balance to DutchX.
        depositAllBalance(sellToken);
        depositAllBalance(buyToken);

        AuctionState state = getAuctionState(sellToken, buyToken);

        if (state == AuctionState.AUCTION_TRIGGERED_WAITING) {
            return false;
        }

        if (state == AuctionState.NO_AUCTION_TRIGGERED) {
            claimAuctionTokens(sellToken, buyToken);
            triggerAuction(sellToken, buyToken);
            return true;
        }

        if (state == AuctionState.AUCTION_IN_PROGRESS) {
            // TODO: extract into a new function
            uint auctionIndex = dx.getAuctionIndex(sellToken, buyToken);
            uint amount = calculateAuctionBuyTokens(
                sellToken,
                buyToken,
                auctionIndex,
                address(this)
            );
            uint dNum;
            uint dDen;
            (dNum, dDen) = dx.getCurrentAuctionPrice(sellToken, buyToken, auctionIndex);
            uint kNum;
            uint kDen;
            (kNum, kDen) = getKyberRate(sellToken, buyToken, amount);

            // TODO: Check for overflow explicitly?
            if (mul(dNum, kDen) > mul(kNum, dDen)) {
                return false;
            }

            buyInAuction(sellToken, buyToken);
            return true;
        }

        // Should be unreachable.
        require(false, "Unknown auction state");
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
