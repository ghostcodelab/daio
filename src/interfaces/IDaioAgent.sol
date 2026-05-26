// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Shape of an allocation proposal emitted by a Daio member agent.
interface IDaioAgent {
    struct Allocation {
        address[] tokens;
        uint16[] weightsBps;
    }

    struct Proposal {
        uint256 epoch;
        Allocation allocation;
        bytes32 rationaleHash;
        bytes signature;
    }

    /// @notice EIP-712 type hash for Proposal. Replace with computed value when finalized.
    function PROPOSAL_TYPEHASH() external view returns (bytes32);
}
