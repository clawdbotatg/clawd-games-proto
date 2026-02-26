// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title IClawdGame — Interface every ClawdGames game contract must implement
interface IClawdGame {
    /// @notice Resolve a game round using a pre-fulfilled seed (called after commit-reveal)
    /// @param player      Address of the player
    /// @param betAmount   Wager in game tokens (already transferred to contract)
    /// @param seed        The final seed from RandomnessOracle
    /// @param gameState   ABI-encoded game-specific data (e.g. bool choice for CoinFlip)
    /// @return outcome    ABI-encoded game result
    /// @return payout     Tokens paid out to player (0 = loss)
    function resolveRound(
        address player,
        uint256 betAmount,
        bytes32 seed,
        bytes calldata gameState
    )
        external
        returns (bytes memory outcome, uint256 payout);

    /// @notice Pure simulation — predict outcome without any state changes
    function simulate(
        bytes32 seed,
        uint256 betAmount,
        bytes calldata gameState
    )
        external
        pure
        returns (bytes memory outcome, uint256 payout);
}
