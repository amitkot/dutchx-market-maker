pragma solidity ^0.4.23;

import "../ERC20Interface.sol";


contract MockKyberNetworkProxy {
    uint public fixedRate;

    constructor(uint _fixedRate) {
        fixedRate = _fixedRate;
    }

    function getExpectedRate(ERC20 src, ERC20 dest, uint srcQty)
        public
        view
        returns (uint expectedRate, uint slippageRate) {
            return (fixedRate, 0);
        }
}
