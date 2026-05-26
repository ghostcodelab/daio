// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal placeholder for ERC-8004 agent identity. Replace after the
/// Jun 1 workshop with the upstream interface.
interface IERC8004 {
    struct AgentMetadata {
        address controller;
        bytes32 specialty;
        string endpoint;
        uint256 registeredAt;
    }

    event AgentRegistered(address indexed agent, address indexed controller, bytes32 specialty);
    event AgentUpdated(address indexed agent, string endpoint);

    function register(bytes32 specialty, string calldata endpoint) external;

    function metadataOf(address agent) external view returns (AgentMetadata memory);

    function isRegistered(address agent) external view returns (bool);
}
