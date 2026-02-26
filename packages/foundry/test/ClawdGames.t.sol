// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../contracts/MockGameToken.sol";
import "../contracts/LootBoxGame.sol";
import "../contracts/GameTokenFeeSplitter.sol";
import "../contracts/DeterministicDice.sol";

contract ClawdGamesTest is Test {
    using DeterministicDice for DeterministicDice.State;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    MockGameToken        public token;
    LootBoxGame          public game;
    GameTokenFeeSplitter public splitter;

    address public keeper  = address(0xBEEF);
    address public player  = address(0xA1CE);
    address public creator = address(0xC1EA);

    uint256 constant BET  = 100 ether;
    uint256 constant POOL = 100_000 ether;

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    function setUp() public {
        token   = new MockGameToken();
        game    = new LootBoxGame(address(token), keeper);
        splitter = new GameTokenFeeSplitter(creator);

        // Seed prize pool
        token.mint(address(this), POOL);
        token.approve(address(game), POOL);
        game.loadPrizePool(POOL);

        // Fund player
        token.mint(player, 10_000 ether);
        vm.prank(player);
        token.approve(address(game), type(uint256).max);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    /// @dev Commitment = keccak256(playerSecret || betAmount)  (simple format for tests)
    function _makeCommitment(bytes32 secret, uint256 betAmount) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(secret, betAmount));
    }

    /// @dev Compute finalSeed the same way the contract does
    function _computeSeed(bytes32 commitment, bytes32 keeperSecret, uint256 blockNum)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(commitment, keeperSecret, blockNum));
    }

    /// @dev Predict outcome the same way the contract's predictOutcome does
    function _predictWin(bytes32 seed) internal pure returns (bool) {
        DeterministicDice.State memory dice = DeterministicDice.create(seed);
        for (uint8 i = 0; i < 5; i++) {
            dice.roll(100);
        }
        return dice.roll(10) == 0;
    }

    /// @dev Find a keeper secret that results in a WIN
    function _findWinningKeeperSecret(bytes32 commitment) internal view returns (bytes32 ks) {
        for (uint256 i = 1; i <= 10_000; i++) {
            bytes32 candidate = bytes32(i);
            bytes32 seed      = _computeSeed(commitment, candidate, block.number);
            if (_predictWin(seed)) {
                return candidate;
            }
        }
        revert("no win found in range");
    }

    /// @dev Find a keeper secret that results in a LOSS
    function _findLosingKeeperSecret(bytes32 commitment) internal view returns (bytes32 ks) {
        for (uint256 i = 1; i <= 10_000; i++) {
            bytes32 candidate = bytes32(i);
            bytes32 seed      = _computeSeed(commitment, candidate, block.number);
            if (!_predictWin(seed)) {
                return candidate;
            }
        }
        revert("no loss found in range");
    }

    /// @dev Full commit + keeper fulfill. Returns finalSeed.
    function _commitAndFulfill(address _player, bytes32 secret, bytes32 keeperSecret)
        internal
        returns (bytes32 finalSeed)
    {
        bytes32 commitment = _makeCommitment(secret, BET);

        vm.prank(_player);
        game.commitPlay(commitment, BET);

        vm.prank(keeper);
        game.fulfillSeed(_player, keeperSecret);

        (,bytes32 s,,,, ) = game.getPendingRun(_player);
        return s;
    }

    // =========================================================================
    // MockGameToken
    // =========================================================================

    function test_Mint() public {
        address recipient = address(0xDEAD);
        token.mint(recipient, 500 ether);
        assertEq(token.balanceOf(recipient), 500 ether);
        assertEq(token.decimals(), 18);
    }

    function test_MintEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit MockGameToken.Minted(address(0xDEAD), 100 ether);
        token.mint(address(0xDEAD), 100 ether);
    }

    // =========================================================================
    // DeterministicDice library
    // =========================================================================

    function test_DiceRoll_WithinRange() public pure {
        DeterministicDice.State memory dice = DeterministicDice.create(keccak256("test"));
        for (uint256 i = 0; i < 20; i++) {
            uint256 v = dice.roll(10);
            assertLt(v, 10);
        }
    }

    function test_DiceRoll_Deterministic() public pure {
        bytes32 seed = keccak256("same seed");
        DeterministicDice.State memory d1 = DeterministicDice.create(seed);
        DeterministicDice.State memory d2 = DeterministicDice.create(seed);

        for (uint256 i = 0; i < 10; i++) {
            assertEq(d1.roll(100), d2.roll(100));
        }
    }

    function test_DiceRoll_Rehash() public pure {
        // Exhaust entropy (64 nibbles at 1 hex char per roll(16) call)
        DeterministicDice.State memory dice = DeterministicDice.create(bytes32(uint256(0xabc)));
        for (uint256 i = 0; i < 80; i++) {
            uint256 v = dice.roll(16);
            assertLt(v, 16);
        }
    }

    // =========================================================================
    // LootBoxGame — commitPlay
    // =========================================================================

    function test_CommitPlay_LocksTokens() public {
        uint256 balBefore = token.balanceOf(player);
        bytes32 commitment = _makeCommitment(keccak256("secret"), BET);

        vm.prank(player);
        game.commitPlay(commitment, BET);

        assertEq(token.balanceOf(player), balBefore - BET);

        (, , uint256 bet, bool active, , ) = game.getPendingRun(player);
        assertEq(bet, BET);
        assertTrue(active);
    }

    function test_CommitPlay_EmitsEvent() public {
        bytes32 commitment = _makeCommitment(keccak256("secret"), BET);

        vm.expectEmit(true, false, false, true);
        emit LootBoxGame.Committed(player, commitment, BET, block.number);

        vm.prank(player);
        game.commitPlay(commitment, BET);
    }

    function test_CommitPlay_RejectsDouble() public {
        bytes32 commitment = _makeCommitment(keccak256("secret"), BET);

        vm.startPrank(player);
        game.commitPlay(commitment, BET);
        vm.expectRevert(LootBoxGame.AlreadyPending.selector);
        game.commitPlay(commitment, BET);
        vm.stopPrank();
    }

    function test_CommitPlay_RejectZeroBet() public {
        vm.prank(player);
        vm.expectRevert(LootBoxGame.BetTooLow.selector);
        game.commitPlay(keccak256("x"), 0);
    }

    // =========================================================================
    // LootBoxGame — fulfillSeed
    // =========================================================================

    function test_FulfillSeed_StoresSeed() public {
        bytes32 commitment = _makeCommitment(keccak256("s"), BET);
        vm.prank(player);
        game.commitPlay(commitment, BET);

        bytes32 ks = bytes32(uint256(42));
        vm.prank(keeper);
        game.fulfillSeed(player, ks);

        (, bytes32 storedSeed, , , bool fulfilled, ) = game.getPendingRun(player);
        assertTrue(fulfilled);
        assertEq(storedSeed, _computeSeed(commitment, ks, block.number));
    }

    function test_FulfillSeed_OnlyKeeper() public {
        bytes32 commitment = _makeCommitment(keccak256("s"), BET);
        vm.prank(player);
        game.commitPlay(commitment, BET);

        vm.expectRevert(LootBoxGame.NotKeeper.selector);
        vm.prank(player);
        game.fulfillSeed(player, keccak256("ks"));
    }

    function test_FulfillSeed_CannotFulfillTwice() public {
        bytes32 commitment = _makeCommitment(keccak256("s"), BET);
        vm.prank(player);
        game.commitPlay(commitment, BET);

        vm.prank(keeper);
        game.fulfillSeed(player, bytes32(uint256(1)));

        vm.expectRevert(LootBoxGame.AlreadyFulfilled.selector);
        vm.prank(keeper);
        game.fulfillSeed(player, bytes32(uint256(2)));
    }

    // =========================================================================
    // LootBoxGame — resolve WIN
    // =========================================================================

    function test_Resolve_Win() public {
        bytes32 secret     = keccak256("player secret");
        bytes32 commitment = _makeCommitment(secret, BET);
        bytes32 winKs      = _findWinningKeeperSecret(commitment);

        // Commit
        vm.prank(player);
        game.commitPlay(commitment, BET);

        // Fulfill
        vm.prank(keeper);
        game.fulfillSeed(player, winKs);

        (, bytes32 seed, , , , ) = game.getPendingRun(player);
        assertTrue(_predictWin(seed), "seed should be a win");

        uint256 balBefore = token.balanceOf(player);

        // Resolve as WIN
        vm.prank(keeper);
        game.resolve(player, true);

        uint256 payout = BET * 9;
        assertEq(token.balanceOf(player), balBefore + payout, "payout mismatch");
        assertEq(game.totalWins(player), 1);
    }

    // =========================================================================
    // LootBoxGame — resolve LOSS
    // =========================================================================

    function test_Resolve_Loss() public {
        bytes32 secret     = keccak256("player secret");
        bytes32 commitment = _makeCommitment(secret, BET);
        bytes32 lossKs     = _findLosingKeeperSecret(commitment);

        vm.prank(player);
        game.commitPlay(commitment, BET);

        vm.prank(keeper);
        game.fulfillSeed(player, lossKs);

        (, bytes32 seed, , , , ) = game.getPendingRun(player);
        assertFalse(_predictWin(seed), "seed should be a loss");

        uint256 balBefore = token.balanceOf(player);

        vm.prank(keeper);
        game.resolve(player, false);

        assertEq(token.balanceOf(player), balBefore, "no payout on loss");
        assertEq(game.totalLosses(player), 1);
    }

    // =========================================================================
    // LootBoxGame — resolve guards
    // =========================================================================

    function test_Resolve_RevertsIfNoSeed() public {
        bytes32 commitment = _makeCommitment(keccak256("s"), BET);
        vm.prank(player);
        game.commitPlay(commitment, BET);

        vm.expectRevert(LootBoxGame.SeedNotFulfilled.selector);
        vm.prank(keeper);
        game.resolve(player, true);
    }

    function test_Resolve_CannotResolveDouble() public {
        bytes32 secret     = keccak256("player secret");
        bytes32 commitment = _makeCommitment(secret, BET);

        vm.prank(player);
        game.commitPlay(commitment, BET);

        vm.prank(keeper);
        game.fulfillSeed(player, bytes32(uint256(1)));

        vm.prank(keeper);
        game.resolve(player, false);

        vm.expectRevert(LootBoxGame.NoPendingRun.selector);
        vm.prank(keeper);
        game.resolve(player, false);
    }

    // =========================================================================
    // LootBoxGame — pure helpers
    // =========================================================================

    function test_GetObstacles_WithinRange() public view {
        bytes32 seed = keccak256("obs-test");
        uint8[5] memory obs = game.getObstacles(seed);
        for (uint8 i = 0; i < 5; i++) {
            assertLt(obs[i], 100);
        }
    }

    function test_PredictOutcome_Deterministic() public view {
        bytes32 seed = keccak256("predict-test");
        bool r1 = game.predictOutcome(seed);
        bool r2 = game.predictOutcome(seed);
        assertEq(r1, r2);
    }

    function test_FullFlow_CanPlayAgainAfterResolve() public {
        bytes32 secret     = keccak256("player secret");
        bytes32 commitment = _makeCommitment(secret, BET);

        vm.prank(player);
        game.commitPlay(commitment, BET);
        vm.prank(keeper);
        game.fulfillSeed(player, bytes32(uint256(1)));
        vm.prank(keeper);
        game.resolve(player, false);

        // Should be able to play again
        vm.prank(player);
        game.commitPlay(_makeCommitment(keccak256("secret2"), BET), BET);
        (, , , bool active, , ) = game.getPendingRun(player);
        assertTrue(active);
    }

    // =========================================================================
    // GameTokenFeeSplitter
    // =========================================================================

    function test_FeeSplitter() public {
        uint256 amount = 1000 ether;
        token.mint(address(this), amount);
        token.approve(address(splitter), amount);

        uint256 creatorBefore = token.balanceOf(creator);
        uint256 burnBefore    = token.balanceOf(splitter.BURN_ADDRESS());

        splitter.distribute(address(token), amount);

        assertEq(token.balanceOf(creator)            - creatorBefore, 800 ether);
        assertEq(token.balanceOf(splitter.BURN_ADDRESS()) - burnBefore,    200 ether);
    }

    // =========================================================================
    // Fuzz
    // =========================================================================

    function testFuzz_DiceObstaclesInRange(bytes32 seed) public pure {
        DeterministicDice.State memory dice = DeterministicDice.create(seed);
        for (uint8 i = 0; i < 5; i++) {
            assertLt(dice.roll(100), 100);
        }
    }

    function testFuzz_PredictOutcomeNeverReverts(bytes32 seed) public view {
        game.predictOutcome(seed); // should never revert
    }
}
