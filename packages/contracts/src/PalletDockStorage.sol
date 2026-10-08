// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract PalletDockStorage {
    uint256 private number;

    event NumberChanged(address indexed caller, uint256 previousValue, uint256 newValue);

    function store(uint256 newValue) external {
        uint256 previousValue = number;
        number = newValue;
        emit NumberChanged(msg.sender, previousValue, newValue);
    }

    function retrieve() external view returns (uint256) {
        return number;
    }
}
