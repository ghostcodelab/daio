// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IDaioAgent} from "./interfaces/IDaioAgent.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @notice Sealed-bid commit-reveal proposal window. Each epoch has a commit
/// phase (agents submit hashes) and a reveal phase (agents submit the proposal
/// + signature that hashes to the commit).
contract ProposalRound is Ownable {
    error NotImplemented();
    error WrongPhase();
    error AlreadyCommitted();
    error InvalidReveal();
    error NotRegisteredAgent();

    enum Phase {
        Idle,
        Commit,
        Reveal,
        Closed
    }

    struct Epoch {
        uint64 commitOpen;
        uint64 commitClose;
        uint64 revealClose;
        Phase phase;
    }

    AgentRegistry public immutable registry;
    uint64 public commitWindow;
    uint64 public revealWindow;

    uint256 public currentEpoch;
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(address => bytes32)) public commits;
    mapping(uint256 => mapping(address => IDaioAgent.Proposal)) internal _reveals;
    mapping(uint256 => address[]) internal _revealedAgents;

    function revealOf(uint256 epoch, address agent) external view returns (IDaioAgent.Proposal memory) {
        return _reveals[epoch][agent];
    }

    event EpochStarted(uint256 indexed epoch, uint64 commitOpen, uint64 commitClose, uint64 revealClose);
    event Committed(uint256 indexed epoch, address indexed agent, bytes32 commitHash);
    event Revealed(uint256 indexed epoch, address indexed agent, bytes32 allocationHash);

    constructor(address registry_, uint64 commitWindow_, uint64 revealWindow_) Ownable(msg.sender) {
        registry = AgentRegistry(registry_);
        commitWindow = commitWindow_;
        revealWindow = revealWindow_;
    }

    function startEpoch() external onlyOwner {
        uint256 epoch = ++currentEpoch;
        uint64 commitOpen = uint64(block.timestamp);
        uint64 commitClose = commitOpen + commitWindow;
        uint64 revealClose = commitClose + revealWindow;

        epochs[epoch] = Epoch({
            commitOpen: commitOpen,
            commitClose: commitClose,
            revealClose: revealClose,
            phase: Phase.Commit // informational; the source of truth is currentPhase()
        });

        emit EpochStarted(epoch, commitOpen, commitClose, revealClose);
    }

    function commit(bytes32 commitHash) external {
        if (currentPhase() != Phase.Commit) revert WrongPhase();
        if (!registry.isActive(msg.sender)) revert NotRegisteredAgent();
        if (commits[currentEpoch][msg.sender] != bytes32(0)) revert AlreadyCommitted();

        commits[currentEpoch][msg.sender] = commitHash;
        emit Committed(currentEpoch, msg.sender, commitHash);
    }

    function reveal(IDaioAgent.Proposal calldata proposal) external {
        if (currentPhase() != Phase.Reveal) revert WrongPhase();
        if (!registry.isActive(msg.sender)) revert NotRegisteredAgent();
        if (proposal.epoch != currentEpoch) revert InvalidReveal();

        bytes32 committed = commits[currentEpoch][msg.sender];
        if (committed == bytes32(0)) revert InvalidReveal();

        // Recompute the commit binding: epoch + agent + allocation + rationale salt.
        // Agent address inclusion prevents reveal-by-another-agent of the same hash.
        bytes32 recomputed = hashProposal(currentEpoch, msg.sender, proposal);
        if (recomputed != committed) revert InvalidReveal();

        // TODO: verify EIP-712 signature in proposal.signature. For MVP we trust msg.sender
        // since the commit binds to msg.sender; a third party cannot reveal someone else's
        // proposal because the recomputed hash includes msg.sender.

        _reveals[currentEpoch][msg.sender] = proposal;
        _revealedAgents[currentEpoch].push(msg.sender);

        emit Revealed(currentEpoch, msg.sender, _allocationHash(proposal.allocation));
    }

    /// @notice Time-derived phase. Authoritative; ignores the stored `phase` field.
    function currentPhase() public view returns (Phase) {
        if (currentEpoch == 0) return Phase.Idle;
        Epoch storage e = epochs[currentEpoch];
        uint256 nowTs = block.timestamp;
        if (nowTs < e.commitOpen) return Phase.Idle;
        if (nowTs < e.commitClose) return Phase.Commit;
        if (nowTs < e.revealClose) return Phase.Reveal;
        return Phase.Closed;
    }

    function revealsFor(uint256 epoch) external view returns (address[] memory) {
        return _revealedAgents[epoch];
    }

    /// @notice Canonical commit-hash binding agents use to produce their commits off-chain.
    function hashProposal(uint256 epoch, address agent, IDaioAgent.Proposal calldata p)
        public
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                epoch,
                agent,
                p.allocation.tokens,
                p.allocation.weightsBps,
                p.rationaleHash
            )
        );
    }

    function _allocationHash(IDaioAgent.Allocation memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(a.tokens, a.weightsBps));
    }
}
