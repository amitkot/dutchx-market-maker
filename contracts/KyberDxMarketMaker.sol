pragma solidity 0.5.2;

import "./ERC20Interface.sol";
import "./Withdrawable.sol";
import "@gnosis.pm/dx-contracts/contracts/DutchExchange.sol";
import "@gnosis.pm/util-contracts/contracts/EtherToken.sol";


interface KyberNetworkProxy {
    function getExpectedRate(ERC20 src, ERC20 dest, uint srcQty)
        external
        view
        returns (uint expectedRate, uint slippageRate);
}


// TODO: add support to token -> token
contract KyberDxMarketMaker is Withdrawable {
    // This is the representation of ETH as an ERC20 Token for Kyber Network.
    ERC20 constant internal KYBER_ETH_TOKEN = ERC20(
        0x00eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
    );

    // Declared in DutchExchange contract but not public.
    uint public constant DX_AUCTION_START_WAITING_FOR_FUNDING = 1;

    enum AuctionState {
        WAITING_FOR_FUNDING,
        WAITING_FOR_OPP_FUNDING,
        WAITING_FOR_SCHEDULED_AUCTION,
        AUCTION_IN_PROGRESS,
        WAITING_FOR_OPP_TO_FINISH
    }

    // Exposing the enum values to external tools.
    AuctionState constant public WAITING_FOR_FUNDING = AuctionState.WAITING_FOR_FUNDING;
    AuctionState constant public WAITING_FOR_OPP_FUNDING = AuctionState.WAITING_FOR_OPP_FUNDING;
    AuctionState constant public WAITING_FOR_SCHEDULED_AUCTION = AuctionState.WAITING_FOR_SCHEDULED_AUCTION;
    AuctionState constant public AUCTION_IN_PROGRESS = AuctionState.AUCTION_IN_PROGRESS;
    AuctionState constant public WAITING_FOR_OPP_TO_FINISH = AuctionState.WAITING_FOR_OPP_TO_FINISH;

    DutchExchange public dx;
    EtherToken public weth;
    KyberNetworkProxy public kyberNetworkProxy;

    // Token => Token => auctionIndex
    mapping (address => mapping (address => uint)) public lastClaimedAuction;

    constructor(
        DutchExchange _dx,
        KyberNetworkProxy _kyberNetworkProxy
    ) public {
        require(
            address(_dx) != address(0),
            "DutchExchange address cannot be 0"
        );
        require(
            address(_kyberNetworkProxy) != address(0),
            "KyberNetworkProxy address cannot be 0"
        );

        dx = DutchExchange(_dx);
        weth = EtherToken(dx.ethToken());
        kyberNetworkProxy = KyberNetworkProxy(_kyberNetworkProxy);
    }

    event AmountDepositedToDx(
        address indexed token,
        uint amount
    );

    function depositToDx(
        address token,
        uint amount
    )
        public
        onlyOperator
        returns (uint)
    {
        require(ERC20(token).approve(address(dx), amount), "Cannot approve deposit");
        uint deposited = dx.deposit(token, amount);
        emit AmountDepositedToDx(token, deposited);
        return deposited;
    }

    event AmountWithdrawnFromDx(
        address indexed token,
        uint amount
    );

    function withdrawFromDx(
        address token,
        uint amount
    )
        public
        onlyOperator
        returns (uint)
    {
        uint withdrawn = dx.withdraw(token, amount);
        emit AmountWithdrawnFromDx(token, withdrawn);
        return withdrawn;
    }

    event AuctionTokensClaimed(
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
        if (lastCompletedAuction <= initialLastClaimed) return (0, 0);

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
        emit AuctionTokensClaimed(
            sellToken,
            buyToken,
            initialLastClaimed,
            lastCompletedAuction,
            sellerFunds,
            buyerFunds
        );
    }

    /**
        Participates in the auction by taking the appropriate step according to
        the auction state.

        Returns true if there is a step to be taken in this auction at this
        stage, false otherwise.
    */
    // TODO: consider removing onlyOperator limitation
    function step(
        address sellToken,
        address buyToken
    )
        public
        onlyOperator
        returns (bool)
    {
        // KyberNetworkProxy.getExpectedRate() always returns a rate between
        // tokens (and not between token wei as DutchX does.
        // For this reason the rate is currently compatible only for tokens that
        // have 18 decimals and is handled as though it is rate / 10**18.
        // TODO: handle tokens with number of decimals other than 18.
        require(
            ERC20(sellToken).decimals() == 18 && ERC20(buyToken).decimals() == 18,
            "Only 18 decimals tokens are supported"
        );

        // Deposit dxmm token balance to DutchX.
        depositAllBalance(sellToken);
        depositAllBalance(buyToken);

        AuctionState state = getAuctionState(sellToken, buyToken);
        uint auctionIndex = dx.getAuctionIndex(sellToken, buyToken);
        emit CurrentAuctionState(sellToken, buyToken, auctionIndex, state);

        if (state == AuctionState.WAITING_FOR_FUNDING) {
            claimAuctionTokens(sellToken, buyToken);
            require(fundAuctionDirection(sellToken, buyToken));
            return true;
        }

        if (state == AuctionState.WAITING_FOR_OPP_FUNDING ||
            state == AuctionState.WAITING_FOR_SCHEDULED_AUCTION) {
            return false;
        }

        if (state == AuctionState.AUCTION_IN_PROGRESS) {
            if (isPriceRightForBuying(sellToken, buyToken, auctionIndex)) {
                return buyInAuction(sellToken, buyToken);
            }
            return false;
        }

        if (state == AuctionState.WAITING_FOR_OPP_TO_FINISH) {
            return false;
        }

        // Should be unreachable.
        revert("Unknown auction state");
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
        uint outstandingVolume = atleastZero(int(div(mul(sellVolume, num), sub(den, buyVolume))));
        return amount >= outstandingVolume;
    }

    // TODO: consider adding a "safety margin" to compensate for accuracy issues.
    function thresholdNewAuctionToken(
        address token
    )
        public
        view
        returns (uint)
    {
        uint priceTokenNum;
        uint priceTokenDen;
        (priceTokenNum, priceTokenDen) = dx.getPriceOfTokenInLastAuction(token);

        // TODO: maybe not add 1 if token is WETH
        // Rounding up to make sure we pass the threshold
        return 1 + div(
            // mul() takes care of overflows
            mul(
                dx.thresholdNewAuction(),
                priceTokenDen
            ),
            mul(
                dx.ethUSDOracle().getUSDETHPrice(),
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
            return sub(thresholdTokenWei, currentAuctionSellVolume);
        }

        return 0;
    }

    function addFee(
        uint amount
    )
        public
        view
        returns (uint)
    {
        uint num;
        uint den;
        (num, den) = dx.getFeeRatio(msg.sender);

        // amount / (1 - num / den)
        return div(
            mul(amount, den),
            sub(den, num)
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

        // Unfunded auctions have an auctionStart time equal to a constant (1)
        uint auctionStart = dx.getAuctionStart(sellToken, buyToken);
        if (auctionStart == DX_AUCTION_START_WAITING_FOR_FUNDING) {
            // Other side might also be not fully funded, but we're primarily
            // interested in this direction.
            if (calculateMissingTokenForAuctionStart(sellToken, buyToken) > 0) {
                return AuctionState.WAITING_FOR_FUNDING;
            }

            return AuctionState.WAITING_FOR_OPP_FUNDING;
        }

        // DutchExchange logic uses auction start time.
        /* solhint-disable not-rely-on-time */
        if (auctionStart > now) {
            return AuctionState.WAITING_FOR_SCHEDULED_AUCTION;
        }

        uint auctionIndex = dx.getAuctionIndex(sellToken, buyToken);
        uint closingPriceDen;
        (, closingPriceDen) = dx.closingPrices(sellToken, buyToken, auctionIndex);
        if (closingPriceDen == 0) {
            return AuctionState.AUCTION_IN_PROGRESS;
        }

        return AuctionState.WAITING_FOR_OPP_TO_FINISH;
    }

    function getKyberRate(
        address _sellToken,
        address _buyToken,
        uint amount
    )
        public
        view
        returns (uint num, uint den)
    {
        // KyberNetworkProxy.getExpectedRate() always returns a rate between
        // tokens (and not between token wei as DutchX does.
        // For this reason the rate is currently compatible only for tokens that
        // have 18 decimals and is handled as though it is rate / 10**18.
        // TODO: handle tokens with number of decimals other than 18.
        require(
            ERC20(_sellToken).decimals() == 18 && ERC20(_buyToken).decimals() == 18,
            "Only 18 decimals tokens are supported"
        );

        // Kyber uses a special constant address for representing ETH.
        ERC20 sellToken = _sellToken == address(weth) ? KYBER_ETH_TOKEN : ERC20(_sellToken);
        ERC20 buyToken = _buyToken == address(weth) ? KYBER_ETH_TOKEN : ERC20(_buyToken);
        uint rate;
        (rate, ) = kyberNetworkProxy.getExpectedRate(
            sellToken,
            buyToken,
            amount
        );

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

        uint num;
        uint den;
        (num, den) = dx.getCurrentAuctionPrice(
            sellToken,
            buyToken,
            auctionIndex
        );

        // No price for this auction, it is a future one.
        if (den == 0) return 0;

        uint wantedBuyVolume = div(mul(sellVolume, num), den);

        uint auctionSellVolume = dx.sellVolumesCurrent(sellToken, buyToken);
        uint buyVolume = dx.buyVolumes(sellToken, buyToken);
        uint outstandingBuyVolume = atleastZero(
            int(mul(auctionSellVolume, num) / den - buyVolume)
        );

        return wantedBuyVolume < outstandingBuyVolume
            ? wantedBuyVolume
            : outstandingBuyVolume;
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

    event AuctionTriggered(
        address indexed sellToken,
        address indexed buyToken,
        uint indexed auctionIndex,
        uint sellTokenAmount,
        uint sellTokenAmountWithFee
    );

    // TODO: maybe verify that pair is listed in dutchx
    function fundAuctionDirection(
        address sellToken,
        address buyToken
    )
        internal
        returns (bool)
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
            "Not enough tokens to fund auction direction"
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

    // TODO: check for all the requirements of dutchx
    event BoughtInAuction(
        address indexed sellToken,
        address indexed buyToken,
        uint auctionIndex,
        uint buyTokenAmount,
        bool clearedAuction
    );

    /**
        Will calculate the amount that the bot has sold in current auction and
        buy that amount.

        Returns false if ended up not buying.
        Revets if no auction active or not enough tokens for buying.
    */
    function buyInAuction(
        address sellToken,
        address buyToken
    )
        internal
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
        if (buyTokenAmount == 0) {
            // If price has dropped to 0 we buy in the auction to clear it.
            uint num;
            (num,) = dx.getCurrentAuctionPrice(sellToken, buyToken, auctionIndex);
            if (num == 0) {
                dx.postBuyOrder(sellToken, buyToken, auctionIndex, buyTokenAmount);
                emit BoughtInAuction(sellToken, buyToken, auctionIndex, buyTokenAmount, true /* willClearAuction */);
                return true;
            }
            return false;
        }

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

    function depositAllBalance(
        address token
    )
        internal
        returns (uint)
    {
        uint amount;
        uint balance = ERC20(token).balanceOf(address(this));
        if (balance > 0) {
            amount = depositToDx(token, balance);
        }
        return amount;
    }

    event CurrentAuctionState(
        address indexed sellToken,
        address indexed buyToken,
        uint auctionIndex,
        AuctionState auctionState
    );

    event PriceIsRightForBuying(
        address indexed sellToken,
        address indexed buyToken,
        uint auctionIndex,
        uint amount,
        uint dutchExchangePriceNum,
        uint dutchExchangePriceDen,
        uint kyberPriceNum,
        uint kyberPriceDen
    );

    function isPriceRightForBuying(
        address sellToken,
        address buyToken,
        uint auctionIndex
    )
        internal
        returns (bool)
    {
        uint amount = calculateAuctionBuyTokens(
            sellToken,
            buyToken,
            auctionIndex,
            address(this)
        );

        uint dNum;
        uint dDen;
        (dNum, dDen) = dx.getCurrentAuctionPrice(
            sellToken,
            buyToken,
            auctionIndex
        );

        uint kNum;
        uint kDen;
        (kNum, kDen) = getKyberRate(sellToken, buyToken, amount);

        // TODO: Check for overflow explicitly?
        bool shouldBuy = mul(dNum, kDen) <= mul(kNum, dDen);
        // TODO: should we add a boolean for shouldBuy?
        emit PriceIsRightForBuying(
            sellToken,
            buyToken,
            auctionIndex,
            amount,
            dNum,
            dDen,
            kNum,
            kDen
        );
        return shouldBuy;
    }

    // --- Safe Math functions ---
    // (https://github.com/OpenZeppelin/openzeppelin-solidity/blob/master/contracts/math/SafeMath.sol)
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

    /**
    * @dev Subtracts two unsigned integers, reverts on overflow (i.e. if
        subtrahend is greater than minuend).
    */
    function sub(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b <= a);
        uint256 c = a - b;

        return c;
    }
}
