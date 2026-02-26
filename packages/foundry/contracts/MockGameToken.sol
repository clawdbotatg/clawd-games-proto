// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockGameToken — Publicly mintable ERC-20 for prototype testing
/// @notice Anyone can mint freely — for testnet/local use only
contract MockGameToken is ERC20 {
    uint8 private constant DECIMALS = 18;

    event Minted(address indexed to, uint256 amount);

    constructor() ERC20("Mock GAME Token", "GAME") { }

    /// @notice Mint tokens to any address — no auth, testnet only
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
        emit Minted(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }
}
