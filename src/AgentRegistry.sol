// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC8004} from "./interfaces/IERC8004.sol";

/// @notice Wraps ERC-8004 agent identity and adds Daio-specific bonding,
/// reputation tracking, and slashing hooks.
contract AgentRegistry is Ownable {
    using SafeERC20 for IERC20;

    error NotImplemented();
    error BondBelowMinimum();
    error AlreadyRegistered();
    error NotRegistered();
    error NotSlasher();

    struct AgentRecord {
        bytes32 specialty;
        uint256 bond;
        uint256 reputation;
        uint256 strikes;
        bool active;
    }

    IERC20 public immutable bondToken;
    uint256 public minBond;
    uint8 public maxStrikes;

    address public slasher;
    IERC8004 public erc8004;

    mapping(address => AgentRecord) public agents;
    address[] public agentList;

    event AgentBonded(address indexed agent, uint256 bond, bytes32 specialty);
    event AgentSlashed(address indexed agent, uint256 amount, string reason);
    event AgentEjected(address indexed agent);
    event ReputationUpdated(address indexed agent, uint256 newReputation);

    constructor(address bondToken_, uint256 minBond_, uint8 maxStrikes_) Ownable(msg.sender) {
        bondToken = IERC20(bondToken_);
        minBond = minBond_;
        maxStrikes = maxStrikes_;
    }

    function setSlasher(address slasher_) external onlyOwner {
        slasher = slasher_;
    }

    function setERC8004(address erc8004_) external onlyOwner {
        erc8004 = IERC8004(erc8004_);
    }

    function register(uint256 bondAmount, bytes32 specialty) external {
        if (bondAmount < minBond) revert BondBelowMinimum();
        if (agents[msg.sender].active) revert AlreadyRegistered();

        bondToken.safeTransferFrom(msg.sender, address(this), bondAmount);

        agents[msg.sender] = AgentRecord({
            specialty: specialty,
            bond: bondAmount,
            reputation: 0,
            strikes: 0,
            active: true
        });
        agentList.push(msg.sender);

        // TODO: register with erc8004 once a live registry address is configured.

        emit AgentBonded(msg.sender, bondAmount, specialty);
    }

    function slash(address agent, uint256 amount, string calldata reason) external {
        if (msg.sender != slasher) revert NotSlasher();
        AgentRecord storage rec = agents[agent];
        if (!rec.active) revert NotRegistered();

        uint256 take = amount > rec.bond ? rec.bond : amount;
        rec.bond -= take;
        rec.strikes += 1;
        emit AgentSlashed(agent, take, reason);

        if (rec.strikes >= maxStrikes || rec.bond < minBond) {
            rec.active = false;
            emit AgentEjected(agent);
        }
        // NOTE: slashed bond stays in this contract for now; v2 routes it to LPs or treasury.
    }

    function updateReputation(address agent, uint256 newReputation) external onlyOwner {
        // Owner-gated for MVP. v2: gated by Consensus + bounded delta.
        if (!agents[agent].active) revert NotRegistered();
        agents[agent].reputation = newReputation;
        emit ReputationUpdated(agent, newReputation);
    }

    function reputationOf(address agent) external view returns (uint256) {
        // MVP: local only. v2: compose ACHIVX / Andromeda / ClawLens reads.
        return agents[agent].reputation;
    }

    function isActive(address agent) external view returns (bool) {
        return agents[agent].active;
    }

    function activeAgentCount() external view returns (uint256 n) {
        // O(n) loop is acceptable while agentList is small (MVP).
        uint256 len = agentList.length;
        for (uint256 i = 0; i < len; i++) {
            if (agents[agentList[i]].active) n++;
        }
    }
}
