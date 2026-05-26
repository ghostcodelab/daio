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

/// @notice Demo-recording variant of Deploy.s.sol with **60s commit + 60s reveal**
/// windows so a full epoch fits inside a 2-minute recording clip. Otherwise
/// identical to Deploy.s.sol.
contract DeployShort is Script {
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
        // SHORT windows: 60s commit + 60s reveal (Deploy.s.sol uses 300+300).
        ProposalRound round = new ProposalRound(address(registry), 60, 60);
        Consensus consensus = new Consensus(address(round), address(registry), 500);
        AllocationExecutor executor = new AllocationExecutor(address(consensus), address(vault));
        PerformanceFee fee = new PerformanceFee(address(vault), address(consensus), 1000);
        Slashing slasher = new Slashing(address(registry), address(consensus), address(fee), 500, 2000);

        registry.setSlasher(address(slasher));
        vault.setAllocator(address(executor));
        vault.setFeeCollector(address(fee));

        vm.stopBroadcast();

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
