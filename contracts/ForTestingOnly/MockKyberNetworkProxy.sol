pragma solidity 0.5.2;

import "../ERC20Interface.sol";


contract MockKyberNetworkProxy {
    uint public fixedRate;

    constructor(uint _fixedRate) public {
        fixedRate = _fixedRate;
    }

    function getExpectedRate(ERC20 src, ERC20 dest, uint srcQty)
        public
        view
        returns (uint expectedRate, uint slippageRate) {
            // Removing compilation warnings
            src;
            dest;
            srcQty;

            return (fixedRate, 0);
        }
}
