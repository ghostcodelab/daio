// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IDaioAgent} from "./interfaces/IDaioAgent.sol";
import {ProposalRound} from "./ProposalRound.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @notice Resolves revealed proposals into a single winning allocation.
///
/// MVP: stake-weighted median per token weight across ALL revealed agents
/// (no clustering — `clusterToleranceBps` is stored but unused in v1).
/// v2 will partition revealed agents into clusters by L1 distance under
/// the configured tolerance and only median within the highest-stake cluster.
contract Consensus is Ownable {
    error NotImplemented();
    error EpochNotReady();
    error AlreadyResolved();
    error NoReveals();
    error InconsistentTokenSet();
    error InvariantWeightsZero();

    uint16 public constant TOTAL_WEIGHT_BPS = 10_000;

    struct Cluster {
        address[] members;
        uint256 totalStake;
        IDaioAgent.Allocation median;
    }

    ProposalRound public immutable round;
    AgentRegistry public immutable registry;
    uint16 public clusterToleranceBps;

    mapping(uint256 => IDaioAgent.Allocation) internal _winningAllocation;
    mapping(uint256 => address[]) internal _winningMembers;
    mapping(uint256 => bool) public resolved;

    function getWinningMembers(uint256 epoch) external view returns (address[] memory) {
        return _winningMembers[epoch];
    }

    event EpochResolved(uint256 indexed epoch, uint256 winningStake, uint256 totalRevealedStake);

    constructor(address round_, address registry_, uint16 clusterToleranceBps_) Ownable(msg.sender) {
        round = ProposalRound(round_);
        registry = AgentRegistry(registry_);
        clusterToleranceBps = clusterToleranceBps_;
    }

    function resolve(uint256 epoch) external {
        if (resolved[epoch]) revert AlreadyResolved();
        // Resolve only past or just-closed epochs. Either epoch < currentEpoch (old),
        // or epoch == currentEpoch with phase past Reveal.
        if (epoch == round.currentEpoch()) {
            if (round.currentPhase() != ProposalRound.Phase.Closed) revert EpochNotReady();
        } else if (epoch > round.currentEpoch()) {
            revert EpochNotReady();
        }

        address[] memory revealed = round.revealsFor(epoch);
        uint256 n = revealed.length;
        if (n == 0) revert NoReveals();

        IDaioAgent.Proposal memory first = round.revealOf(epoch, revealed[0]);
        address[] memory tokens = first.allocation.tokens;
        uint256 t = tokens.length;
        if (t == 0) revert InconsistentTokenSet();

        // Collect each agent's weight vector + stake. Enforce same token list across all.
        uint16[][] memory weights = new uint16[][](n);
        uint256[] memory stakes = new uint256[](n);
        weights[0] = first.allocation.weightsBps;
        stakes[0] = _stakeOf(revealed[0]);

        for (uint256 i = 1; i < n; i++) {
            IDaioAgent.Proposal memory p = round.revealOf(epoch, revealed[i]);
            if (p.allocation.tokens.length != t) revert InconsistentTokenSet();
            for (uint256 k = 0; k < t; k++) {
                if (p.allocation.tokens[k] != tokens[k]) revert InconsistentTokenSet();
            }
            weights[i] = p.allocation.weightsBps;
            stakes[i] = _stakeOf(revealed[i]);
        }

        // Per-token stake-weighted median, then renormalise so the vector sums to 10_000.
        uint16[] memory medianWeights = new uint16[](t);
        uint256 sumBps = 0;
        for (uint256 k = 0; k < t; k++) {
            uint16[] memory col = new uint16[](n);
            uint256[] memory s = new uint256[](n);
            for (uint256 i = 0; i < n; i++) {
                col[i] = weights[i][k];
                s[i] = stakes[i];
            }
            medianWeights[k] = _weightedMedian(col, s);
            sumBps += medianWeights[k];
        }

        if (sumBps == 0) revert InvariantWeightsZero();

        // Renormalise. Distribute rounding remainder to the largest weight.
        if (sumBps != TOTAL_WEIGHT_BPS) {
            uint256 scaledSum = 0;
            uint256 maxIdx = 0;
            uint16 maxW = 0;
            for (uint256 k = 0; k < t; k++) {
                uint16 scaled = uint16((uint256(medianWeights[k]) * TOTAL_WEIGHT_BPS) / sumBps);
                medianWeights[k] = scaled;
                scaledSum += scaled;
                if (scaled > maxW) {
                    maxW = scaled;
                    maxIdx = k;
                }
            }
            if (scaledSum < TOTAL_WEIGHT_BPS) {
                medianWeights[maxIdx] += uint16(TOTAL_WEIGHT_BPS - scaledSum);
            } else if (scaledSum > TOTAL_WEIGHT_BPS) {
                medianWeights[maxIdx] -= uint16(scaledSum - TOTAL_WEIGHT_BPS);
            }
        }

        // Store winning allocation + members + mark resolved.
        _winningAllocation[epoch] = IDaioAgent.Allocation({tokens: tokens, weightsBps: medianWeights});
        _winningMembers[epoch] = revealed;
        resolved[epoch] = true;

        uint256 totalStake = 0;
        for (uint256 i = 0; i < n; i++) totalStake += stakes[i];

        // winningStake == totalRevealedStake until clustering is enabled.
        emit EpochResolved(epoch, totalStake, totalStake);
    }

    function getWinningAllocation(uint256 epoch) external view returns (IDaioAgent.Allocation memory) {
        return _winningAllocation[epoch];
    }

    /* ------------------------- internals ------------------------- */

    function _stakeOf(address agent) internal view returns (uint256 bond) {
        ( , bond, , , ) = registry.agents(agent);
    }

    /// @notice Stake-weighted median: sort weights ascending, walk cumulative stake,
    /// return the weight at which cumulative stake first reaches half of total.
    function _weightedMedian(uint16[] memory w, uint256[] memory s)
        internal
        pure
        returns (uint16)
    {
        uint256 n = w.length;
        // insertion sort by weight ascending (small n)
        for (uint256 i = 1; i < n; i++) {
            uint16 wk = w[i];
            uint256 sk = s[i];
            uint256 j = i;
            while (j > 0 && w[j - 1] > wk) {
                w[j] = w[j - 1];
                s[j] = s[j - 1];
                unchecked { j--; }
            }
            w[j] = wk;
            s[j] = sk;
        }

        uint256 total = 0;
        for (uint256 i = 0; i < n; i++) total += s[i];
        uint256 half = total / 2;

        uint256 cum = 0;
        for (uint256 i = 0; i < n; i++) {
            cum += s[i];
            if (cum > half) return w[i];
        }
        return w[n - 1];
    }
}
