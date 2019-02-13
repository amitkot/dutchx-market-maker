pragma solidity 0.5.2;

import "../ERC20Interface.sol";


contract MockKyberNetworkProxy {
    // This is the representation of ETH as a Token for Kyber Network.
    address constant internal KYBER_ETH_ADDRESS = address(
        0x00eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
    );

    // Token -> Token -> rate
    mapping(address => mapping(address => uint)) public rates;

    event RateUpdated(
        ERC20 src,
        uint rate
    );

    function setRate(
        ERC20 token,
        uint rate
    )
        public
    {
        require(address(token) != address(0), "Source token address cannot be 0");
        require(rate > 0, "Rate must be larger than 0");

        rates[address(token)][KYBER_ETH_ADDRESS] = rate;
				// As rates are returned in (num=rate, den=10**18) format, we multiply the
				// reverse rate (of 10**18 / rate) by 10**18 to offset the later division.
        rates[KYBER_ETH_ADDRESS][address(token)] = 10**36 / rate;

        emit RateUpdated(token, rate);
    }

    function getExpectedRate(ERC20 src, ERC20 dest, uint srcQty)
        public
        view
        returns (uint expectedRate, uint slippageRate) {
            // Removing compilation warnings
            srcQty;

            return (rates[address(src)][address(dest)], 0);
        }
}
