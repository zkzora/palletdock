// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Accepts native-token payments tagged with an application order reference and
/// lets the deployer withdraw them. Events carry what an app needs to match a
/// payment to an order: payer, order reference, and amount.
contract PalletDockPayments {
    address public immutable owner;
    uint256 public totalReceived;

    event PaymentReceived(address indexed payer, bytes32 indexed orderRef, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAmount();
    error NotOwner();
    error NothingToWithdraw();
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    /// Pay for an order. `orderRef` is the application's order or invoice id.
    function pay(bytes32 orderRef) external payable {
        if (msg.value == 0) revert ZeroAmount();
        totalReceived += msg.value;
        emit PaymentReceived(msg.sender, orderRef, msg.value);
    }

    /// Send the whole contract balance to `to`. Owner only.
    function withdraw(address payable to) external {
        if (msg.sender != owner) revert NotOwner();
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToWithdraw();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
