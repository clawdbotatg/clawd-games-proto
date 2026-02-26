// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title GameTokenFeeSplitter — 80% creator / 20% burn on each distribution
contract GameTokenFeeSplitter {
    using SafeERC20 for IERC20;

    address public immutable creator;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    event FeesDistributed(address indexed creator, uint256 creatorAmount, uint256 burnAmount);

    error ZeroAmount();
    error ZeroAddress();

    constructor(address _creator) {
        if (_creator == address(0)) revert ZeroAddress();
        creator = _creator;
    }

    /// @notice Distribute `amount` of `token`: 80% to creator, 20% to 0xdead
    /// @dev Caller must approve this contract to spend `amount` tokens
    function distribute(address token, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        uint256 creatorAmount = (amount * 80) / 100;
        uint256 burnAmount    = amount - creatorAmount; // remainder avoids rounding dust

        IERC20(token).safeTransferFrom(msg.sender, creator, creatorAmount);
        IERC20(token).safeTransferFrom(msg.sender, BURN_ADDRESS, burnAmount);

        emit FeesDistributed(creator, creatorAmount, burnAmount);
    }
}
