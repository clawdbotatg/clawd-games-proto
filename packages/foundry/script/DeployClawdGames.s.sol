// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import "../contracts/MockGameToken.sol";
import "../contracts/LootBoxGame.sol";
import "../contracts/GameTokenFeeSplitter.sol";

/// @notice Deploy all ClawdGames contracts.
///         On local: keeper == deployer (account #9) so full flow can be tested without a separate keeper.
///         On live chains: set KEEPER_ADDRESS env var to your keeper wallet.
contract DeployClawdGames is ScaffoldETHDeploy {
    uint256 constant INITIAL_PRIZE_POOL = 100_000 ether; // local only

    function run() external ScaffoldEthDeployerRunner {
        // --- 1. Game Token ---
        MockGameToken gameToken = new MockGameToken();
        deployments.push(Deployment({ name: "MockGameToken", addr: address(gameToken) }));

        // --- 2. Keeper address (deployer on local, env var on live) ---
        address keeperAddr = vm.envOr("KEEPER_ADDRESS", deployer);

        // --- 3. LootBox Game ---
        LootBoxGame lootBox = new LootBoxGame(address(gameToken), keeperAddr);
        deployments.push(Deployment({ name: "LootBoxGame", addr: address(lootBox) }));

        // --- 4. Fee Splitter (creator = deployer for proto) ---
        GameTokenFeeSplitter splitter = new GameTokenFeeSplitter(deployer);
        deployments.push(Deployment({ name: "GameTokenFeeSplitter", addr: address(splitter) }));

        // --- 5. Seed prize pool on local only ---
        if (block.chainid == 31337) {
            gameToken.mint(deployer, INITIAL_PRIZE_POOL);
            gameToken.approve(address(lootBox), INITIAL_PRIZE_POOL);
            lootBox.loadPrizePool(INITIAL_PRIZE_POOL);
        }

        console.log("=== ClawdGames Deployed ===");
        console.log("MockGameToken       :", address(gameToken));
        console.log("LootBoxGame         :", address(lootBox));
        console.log("GameTokenFeeSplitter:", address(splitter));
        console.log("Keeper              :", keeperAddr);
        console.log("Chain ID            :", block.chainid);
        if (block.chainid == 31337) {
            console.log("Prize pool seeded   :", INITIAL_PRIZE_POOL / 1 ether, "GAME");
        }
    }
}
