// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DaioVault} from "./DaioVault.sol";
import {Consensus} from "./Consensus.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @notice Measures epoch returns and distributes the performance fee
/// pro-rata to winning cluster members. Pull-based (x402-compatible).
///
/// Flow per epoch:
///   1. snapshotOpen(epoch)  — records navOpen = vault.totalAssets()
///   2. consensus.resolve(epoch)  — sets winning members
///   3. measureClose(epoch)  — records navClose, computes totalFee, pulls
///      USDC from the vault, totals winning stake from registry
///   4. winning agents call claim(epoch) to pull their pro-rata share
contract PerformanceFee is Ownable {
    using SafeERC20 for IERC20;

    error EpochNotMeasured();
    error EpochNotResolved();
    error AlreadyClaimed();
    error AlreadyOpened();
    error AlreadyMeasured();
    error NotOpened();
    error NotAWinner();
    error InvalidFeeBps();

    uint16 public constant BPS_DENOMINATOR = 10_000;

    struct EpochMetrics {
        uint256 navOpen;
        uint256 navClose;
        uint256 totalFee;
        uint256 winningStake;
        bool opened;
        bool measured;
    }

    DaioVault public immutable vault;
    Consensus public immutable consensus;
    AgentRegistry public immutable registry;
    IERC20 public immutable asset;
    uint16 public feeBps;

    mapping(uint256 => EpochMetrics) public metrics;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event EpochSnapshotOpened(uint256 indexed epoch, uint256 navOpen);
    event EpochMeasured(uint256 indexed epoch, uint256 navOpen, uint256 navClose, uint256 totalFee);
    event FeeClaimed(uint256 indexed epoch, address indexed agent, uint256 amount);
    event FeeBpsSet(uint16 oldValue, uint16 newValue);

    constructor(address vault_, address consensus_, uint16 feeBps_) Ownable(msg.sender) {
        if (feeBps_ > BPS_DENOMINATOR) revert InvalidFeeBps();
        vault = DaioVault(vault_);
        consensus = Consensus(consensus_);
        registry = consensus.registry();
        asset = IERC20(vault.asset());
        feeBps = feeBps_;
    }

    function setFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        emit FeeBpsSet(feeBps, newBps);
        feeBps = newBps;
    }

    /* --------------------------------- flow ---------------------------------- */

    /// @notice Record vault NAV at the start of `epoch`. Idempotent per epoch.
    function snapshotOpen(uint256 epoch) external {
        EpochMetrics storage m = metrics[epoch];
        if (m.opened) revert AlreadyOpened();
        m.opened = true;
        m.navOpen = vault.totalAssets();
        emit EpochSnapshotOpened(epoch, m.navOpen);
    }

    /// @notice After consensus has resolved, compute the perf fee, pull USDC
    /// from the vault into this contract, and total the winning stake so
    /// `claim` can pro-rate. Idempotent per epoch.
    function measureClose(uint256 epoch) external {
        EpochMetrics storage m = metrics[epoch];
        if (!m.opened) revert NotOpened();
        if (m.measured) revert AlreadyMeasured();
        if (!consensus.resolved(epoch)) revert EpochNotResolved();

        m.navClose = vault.totalAssets();
        uint256 gain = m.navClose > m.navOpen ? m.navClose - m.navOpen : 0;
        m.totalFee = (gain * feeBps) / BPS_DENOMINATOR;

        address[] memory winners = consensus.getWinningMembers(epoch);
        uint256 totalStake;
        for (uint256 i = 0; i < winners.length; i++) {
            totalStake += _stakeOf(winners[i]);
        }
        m.winningStake = totalStake;
        m.measured = true;

        if (m.totalFee > 0) {
            vault.withdrawFee(address(this), m.totalFee);
        }

        emit EpochMeasured(epoch, m.navOpen, m.navClose, m.totalFee);
    }

    /// @notice Winning agent pulls their pro-rata share of `epoch`'s perf fee.
    function claim(uint256 epoch) external {
        EpochMetrics memory m = metrics[epoch];
        if (!m.measured) revert EpochNotMeasured();
        if (claimed[epoch][msg.sender]) revert AlreadyClaimed();

        uint256 amount = _pendingFor(epoch, msg.sender, m);
        if (amount == 0) revert NotAWinner();

        claimed[epoch][msg.sender] = true;
        asset.safeTransfer(msg.sender, amount);
        emit FeeClaimed(epoch, msg.sender, amount);
    }

    /* --------------------------------- views --------------------------------- */

    function pendingFor(uint256 epoch, address agent) external view returns (uint256) {
        EpochMetrics memory m = metrics[epoch];
        if (!m.measured || claimed[epoch][agent]) return 0;
        return _pendingFor(epoch, agent, m);
    }

    function _pendingFor(uint256 epoch, address agent, EpochMetrics memory m)
        internal
        view
        returns (uint256)
    {
        if (m.totalFee == 0 || m.winningStake == 0) return 0;

        address[] memory winners = consensus.getWinningMembers(epoch);
        bool isWinner;
        for (uint256 i = 0; i < winners.length; i++) {
            if (winners[i] == agent) { isWinner = true; break; }
        }
        if (!isWinner) return 0;

        uint256 stake = _stakeOf(agent);
        return (m.totalFee * stake) / m.winningStake;
    }

    function _stakeOf(address agent) internal view returns (uint256 bond) {
        ( , bond, , , ) = registry.agents(agent);
    }
}
