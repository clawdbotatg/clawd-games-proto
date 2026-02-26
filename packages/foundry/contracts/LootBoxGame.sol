// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./DeterministicDice.sol";

/// @title LootBoxGame — Lobster runner loot box. Keeper-trusted proto.
///
/// Flow:
///   1. Player calls commitPlay(commitment, betAmount) → tokens locked
///   2. Keeper calls fulfillSeed(player, keeperSecret) → finalSeed stored
///   3. Frontend reads finalSeed, player runs the game, records moves[]
///   4. Frontend POSTs to keeper API → keeper calls resolve(player, isWin)
///   5. Contract pays payout, emits RunCompleted
///
/// Win condition: DeterministicDice(finalSeed).roll(100)×5 then .roll(10)==0 → WIN (9×)
contract LootBoxGame {
    using SafeERC20 for IERC20;
    using DeterministicDice for DeterministicDice.State;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 public constant WIN_MULTIPLIER = 9;
    uint8   public constant OBSTACLE_COUNT = 5;

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    address public owner;
    address public keeper;
    IERC20  public immutable gameToken;

    struct PendingRun {
        bytes32 commitment;
        bytes32 finalSeed;
        uint256 betAmount;
        bool    active;        // true from commitPlay until resolve
        bool    seedFulfilled;
        bool    resolved;
    }

    mapping(address => PendingRun) public pendingRuns;

    mapping(address => uint256) public totalWins;
    mapping(address => uint256) public totalLosses;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event Committed(
        address indexed player,
        bytes32         commitment,
        uint256         betAmount,
        uint256         blockNumber
    );

    event SeedFulfilled(address indexed player, bytes32 finalSeed);

    event RunCompleted(
        address indexed player,
        bytes32         finalSeed,
        uint256         betAmount,
        bool            isWin,
        uint256         payout
    );

    event PrizePoolLoaded(address indexed by, uint256 amount);
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotOwner();
    error NotKeeper();
    error AlreadyPending();
    error NoPendingRun();
    error SeedNotFulfilled();
    error AlreadyResolved();
    error AlreadyFulfilled();
    error BetTooLow();
    error InsufficientPrizePool();
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _gameToken, address _keeper) {
        if (_gameToken == address(0) || _keeper == address(0)) revert ZeroAddress();
        owner     = msg.sender;
        keeper    = _keeper;
        gameToken = IERC20(_gameToken);
    }

    // -------------------------------------------------------------------------
    // Step 1 — Player commits
    // -------------------------------------------------------------------------

    /// @notice Lock tokens and register commitment.
    ///         commitment = keccak256(abi.encodePacked(playerSecret, betAmount))
    function commitPlay(bytes32 commitment, uint256 betAmount) external {
        if (betAmount == 0) revert BetTooLow();

        PendingRun storage run = pendingRuns[msg.sender];
        if (run.active) revert AlreadyPending();

        // State update before transfer (CEI)
        run.commitment = commitment;
        run.betAmount  = betAmount;
        run.active     = true;

        gameToken.safeTransferFrom(msg.sender, address(this), betAmount);

        emit Committed(msg.sender, commitment, betAmount, block.number);
    }

    // -------------------------------------------------------------------------
    // Step 2 — Keeper fulfills seed
    // -------------------------------------------------------------------------

    /// @notice Keeper fulfills randomness. finalSeed = keccak256(commitment || keeperSecret || block.number)
    function fulfillSeed(address player, bytes32 keeperSecret) external onlyKeeper {
        PendingRun storage run = pendingRuns[player];
        if (!run.active)       revert NoPendingRun();
        if (run.seedFulfilled) revert AlreadyFulfilled();
        if (run.resolved)      revert AlreadyResolved();

        bytes32 seed      = keccak256(abi.encodePacked(run.commitment, keeperSecret, block.number));
        run.finalSeed     = seed;
        run.seedFulfilled = true;

        emit SeedFulfilled(player, seed);
    }

    // -------------------------------------------------------------------------
    // Step 3 — Keeper resolves (after off-chain simulate)
    // -------------------------------------------------------------------------

    /// @notice Keeper calls this after running simulate(seed, moves) off-chain.
    ///         isWin = DeterministicDice(finalSeed).roll(100)×5 then .roll(10) == 0
    function resolve(address player, bool isWin) external onlyKeeper {
        PendingRun storage run = pendingRuns[player];
        if (!run.active)      revert NoPendingRun();
        if (!run.seedFulfilled) revert SeedNotFulfilled();
        if (run.resolved)     revert AlreadyResolved();

        // Update state before transfer (CEI)
        run.resolved = true;
        run.active   = false;

        uint256 betAmount = run.betAmount;
        bytes32 seed      = run.finalSeed;

        uint256 payout = 0;
        if (isWin) {
            payout = betAmount * WIN_MULTIPLIER;
            if (gameToken.balanceOf(address(this)) < payout) revert InsufficientPrizePool();
            gameToken.safeTransfer(player, payout);
            totalWins[player]++;
        } else {
            totalLosses[player]++;
        }

        emit RunCompleted(player, seed, betAmount, isWin, payout);
    }

    // -------------------------------------------------------------------------
    // Pure view helpers (for frontend / keeper verification)
    // -------------------------------------------------------------------------

    /// @notice Derive obstacle positions from seed. Matches DeterministicDice.roll(100) × 5
    function getObstacles(bytes32 seed) external pure returns (uint8[5] memory positions) {
        DeterministicDice.State memory dice = DeterministicDice.create(seed);
        for (uint8 i = 0; i < OBSTACLE_COUNT; i++) {
            positions[i] = uint8(dice.roll(100));
        }
    }

    /// @notice Predict loot box outcome. 5× roll(100) for obstacles, then roll(10) for loot box.
    function predictOutcome(bytes32 seed) external pure returns (bool isWin) {
        DeterministicDice.State memory dice = DeterministicDice.create(seed);
        for (uint8 i = 0; i < OBSTACLE_COUNT; i++) {
            dice.roll(100);
        }
        isWin = dice.roll(10) == 0;
    }

    // -------------------------------------------------------------------------
    // Owner / Admin
    // -------------------------------------------------------------------------

    function loadPrizePool(uint256 amount) external onlyOwner {
        gameToken.safeTransferFrom(msg.sender, address(this), amount);
        emit PrizePoolLoaded(msg.sender, amount);
    }

    function setKeeper(address _newKeeper) external onlyOwner {
        if (_newKeeper == address(0)) revert ZeroAddress();
        emit KeeperUpdated(keeper, _newKeeper);
        keeper = _newKeeper;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    function prizePool() external view returns (uint256) {
        return gameToken.balanceOf(address(this));
    }

    function getPendingRun(address player)
        external
        view
        returns (
            bytes32 commitment,
            bytes32 finalSeed,
            uint256 betAmount,
            bool    active,
            bool    seedFulfilled,
            bool    resolved
        )
    {
        PendingRun storage r = pendingRuns[player];
        return (r.commitment, r.finalSeed, r.betAmount, r.active, r.seedFulfilled, r.resolved);
    }
}
