// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Minimal fixed-supply ERC-20 sample for PalletDock indexing tests.
/// The deployer receives `initialSupply` base units (18 decimals).
contract PalletDockToken is ERC20 {
    constructor(uint256 initialSupply) ERC20("PalletDock Test Token", "PDTT") {
        _mint(msg.sender, initialSupply);
    }
}
