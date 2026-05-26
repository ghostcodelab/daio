// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {Consensus} from "./Consensus.sol";
import {PerformanceFee} from "./PerformanceFee.sol";

/// @notice Penalizes agents whose revealed proposals diverged grossly from the
/// resolved consensus allocation when the consensus was profitable. Slash
/// magnitude is proportional to L1 distance from the winning cluster median.
contract Slashing is Ownable {
    error NotImplemented();
    error EpochNotResolved();
    error AlreadyProcessed();

    AgentRegistry public immutable registry;
    Consensus public immutable consensus;
    PerformanceFee public immutable fees;

    uint16 public slashRateBps;
    uint16 public divergenceThresholdBps;

    mapping(uint256 => bool) public processed;

    event AgentSlashedForEpoch(uint256 indexed epoch, address indexed agent, uint256 amount, uint16 divergenceBps);

    constructor(address registry_, address consensus_, address fees_, uint16 slashRateBps_, uint16 thresholdBps_)
        Ownable(msg.sender)
    {
        registry = AgentRegistry(registry_);
        consensus = Consensus(consensus_);
        fees = PerformanceFee(fees_);
        slashRateBps = slashRateBps_;
        divergenceThresholdBps = thresholdBps_;
    }

    function processEpoch(uint256 epoch) external {
        // TODO: only run if epoch was profitable; for each revealer not in winning cluster,
        // measure L1 divergence from median; if above threshold, call registry.slash
        revert NotImplemented();
    }
}
