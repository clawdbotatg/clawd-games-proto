// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import { DeployClawdGames } from "./DeployClawdGames.s.sol";

contract DeployScript is ScaffoldETHDeploy {
    function run() external {
        DeployClawdGames deploy = new DeployClawdGames();
        deploy.run();
    }
}
