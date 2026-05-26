// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {DaioVault} from "../src/DaioVault.sol";
import {ProposalRound} from "../src/ProposalRound.sol";
import {Consensus} from "../src/Consensus.sol";
import {AllocationExecutor} from "../src/AllocationExecutor.sol";
import {PerformanceFee} from "../src/PerformanceFee.sol";
import {Slashing} from "../src/Slashing.sol";
import {SynthUSDC} from "../src/synth/SynthUSDC.sol";
import {SynthRWA} from "../src/synth/SynthRWA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Robinhood Chain testnet deploy.
///
/// Mirrors Deploy.s.sol (5min + 5min epoch windows) so the Robinhood Chain
/// deployment is at production cadence. Use DeployShort.s.sol for the demo
/// recording chain.
///
/// Post Jun 2 workshop, revisit:
///   - Replace SynthUSDC with the canonical USDC equivalent on Robinhood
///     Chain (if one is published).
///   - Consider wiring the AllocationExecutor's swap routes to whatever
///     DEX or AMM ships with Robinhood Chain's testnet.
///   - If Robinhood Chain has native RWA primitives (their core thesis),
///     point mUSDY / mIB01 / mAAPL at those canonical addresses instead of
///     deploying SynthRWA copies.
///   - Block time on Robinhood Chain may differ from Arbitrum's. Adjust
///     commit/reveal windows if the default 300s feels too long or short.
///
/// Run:
///   cd daio
///   set -a; source .env; set +a
///   forge script script/DeployRobinhood.s.sol --rpc-url robinhood_testnet --broadcast
///   # add --verify once the Robinhood explorer + API key are configured
contract DeployRobinhood is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        SynthUSDC usdc = new SynthUSDC();
        SynthRWA mUSDY = new SynthRWA("Synth Ondo USDY", "mUSDY", 18);
        SynthRWA mIB01 = new SynthRWA("Synth Backed bIB01", "mIB01", 18);
        SynthRWA mAAPL = new SynthRWA("Synth AAPL (demo only)", "mAAPL", 18);

        AgentRegistry registry = new AgentRegistry(address(usdc), 1000e6, 3);
        DaioVault vault = new DaioVault(IERC20(address(usdc)));
        // Production cadence: 5 min commit + 5 min reveal. Tune after Jun 2.
        ProposalRound round = new ProposalRound(address(registry), 300, 300);
        Consensus consensus = new Consensus(address(round), address(registry), 500);
        AllocationExecutor executor = new AllocationExecutor(address(consensus), address(vault));
        PerformanceFee fee = new PerformanceFee(address(vault), address(consensus), 1000);
        Slashing slasher = new Slashing(address(registry), address(consensus), address(fee), 500, 2000);

        registry.setSlasher(address(slasher));
        vault.setAllocator(address(executor));
        vault.setFeeCollector(address(fee));

        vm.stopBroadcast();

        console2.log("=== Robinhood Chain testnet deploy ===");
        console2.log("USDC          ", address(usdc));
        console2.log("mUSDY         ", address(mUSDY));
        console2.log("mIB01         ", address(mIB01));
        console2.log("mAAPL         ", address(mAAPL));
        console2.log("AgentRegistry ", address(registry));
        console2.log("DaioVault     ", address(vault));
        console2.log("ProposalRound ", address(round));
        console2.log("Consensus     ", address(consensus));
        console2.log("Executor      ", address(executor));
        console2.log("PerformanceFee", address(fee));
        console2.log("Slashing      ", address(slasher));
        console2.log("Deployer      ", deployer);
    }
}
