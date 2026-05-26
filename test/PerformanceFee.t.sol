// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PerformanceFee} from "../src/PerformanceFee.sol";
import {AllocationExecutor} from "../src/AllocationExecutor.sol";
import {Consensus} from "../src/Consensus.sol";
import {ProposalRound} from "../src/ProposalRound.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {DaioVault} from "../src/DaioVault.sol";
import {SynthUSDC} from "../src/synth/SynthUSDC.sol";
import {IDaioAgent} from "../src/interfaces/IDaioAgent.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PerformanceFeeTest is Test {
    PerformanceFee internal fee;
    AllocationExecutor internal executor;
    Consensus internal consensus;
    ProposalRound internal round;
    AgentRegistry internal registry;
    DaioVault internal vault;
    SynthUSDC internal usdc;

    address internal alice = address(0xA11CE);
    address internal bob   = address(0xB0B);
    address internal carol = address(0xCA201);
    address internal lp    = address(0x1111);

    address internal mUSDY = address(0x1001);
    address internal mIB01 = address(0x1002);
    address internal mAAPL = address(0x1003);

    uint64 constant COMMIT_WIN = 300;
    uint64 constant REVEAL_WIN = 300;
    uint256 constant BOND = 1_000e6;
    uint256 constant LP_DEPOSIT = 1_000_000e6; // 1M USDC
    uint16 constant FEE_BPS = 1_000;           // 10% performance fee

    function setUp() public {
        usdc = new SynthUSDC();
        registry = new AgentRegistry(address(usdc), BOND, 3);
        round = new ProposalRound(address(registry), COMMIT_WIN, REVEAL_WIN);
        consensus = new Consensus(address(round), address(registry), 500);
        vault = new DaioVault(IERC20(address(usdc)));
        executor = new AllocationExecutor(address(consensus), address(vault));
        fee = new PerformanceFee(address(vault), address(consensus), FEE_BPS);

        vault.setAllocator(address(executor));
        vault.setFeeCollector(address(fee));
    }

    function _bond(address who, bytes32 specialty) internal {
        usdc.mint(who, BOND);
        vm.startPrank(who);
        usdc.approve(address(registry), BOND);
        registry.register(BOND, specialty);
        vm.stopPrank();
    }

    function _lpDeposit(uint256 amount) internal {
        usdc.mint(lp, amount);
        vm.startPrank(lp);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, lp);
        vm.stopPrank();
    }

    function _tokens() internal view returns (address[] memory t) {
        t = new address[](3);
        t[0] = mUSDY;
        t[1] = mIB01;
        t[2] = mAAPL;
    }

    function _proposal(uint256 epoch, uint16 a, uint16 b, uint16 c, bytes32 salt)
        internal
        view
        returns (IDaioAgent.Proposal memory p)
    {
        uint16[] memory w = new uint16[](3);
        w[0] = a; w[1] = b; w[2] = c;
        p.epoch = epoch;
        p.allocation = IDaioAgent.Allocation({tokens: _tokens(), weightsBps: w});
        p.rationaleHash = salt;
        p.signature = "";
    }

    function _commit(address who, IDaioAgent.Proposal memory p) internal {
        bytes32 h = round.hashProposal(p.epoch, who, p);
        vm.prank(who);
        round.commit(h);
    }

    function _reveal(address who, IDaioAgent.Proposal memory p) internal {
        vm.prank(who);
        round.reveal(p);
    }

    function _runEpoch1_AllRevealed() internal {
        _bond(alice, "macro");
        _bond(bob,   "credit");
        _bond(carol, "liquidity");

        round.startEpoch();
        fee.snapshotOpen(1);

        IDaioAgent.Proposal memory pa = _proposal(1, 5000, 3000, 2000, "a");
        IDaioAgent.Proposal memory pb = _proposal(1, 4500, 3500, 2000, "b");
        IDaioAgent.Proposal memory pc = _proposal(1, 3000, 2000, 5000, "c");
        _commit(alice, pa);
        _commit(bob,   pb);
        _commit(carol, pc);
        vm.warp(block.timestamp + COMMIT_WIN);
        _reveal(alice, pa);
        _reveal(bob,   pb);
        _reveal(carol, pc);
        vm.warp(block.timestamp + REVEAL_WIN);

        consensus.resolve(1);
        executor.execute(1);
    }

    function _navOpen(uint256 epoch) internal view returns (uint256) {
        (uint256 v,,,,,) = fee.metrics(epoch);
        return v;
    }

    function _totalFee(uint256 epoch) internal view returns (uint256) {
        (,,uint256 v,,,) = fee.metrics(epoch);
        return v;
    }

    function test_happyPath_lpDeposits_epochProfitable_agentsClaim() public {
        // 1) Bond agents and snapshot navOpen with empty vault (=0)
        _bond(alice, "macro");
        _bond(bob,   "credit");
        _bond(carol, "liquidity");

        round.startEpoch();
        fee.snapshotOpen(1);
        assertEq(_navOpen(1), 0);

        // 2) LP deposits AFTER snapshot — simulates "epoch gain" from the vault's POV
        _lpDeposit(LP_DEPOSIT);

        // 3) Run commit/reveal/resolve
        IDaioAgent.Proposal memory pa = _proposal(1, 5000, 3000, 2000, "a");
        IDaioAgent.Proposal memory pb = _proposal(1, 4500, 3500, 2000, "b");
        IDaioAgent.Proposal memory pc = _proposal(1, 3000, 2000, 5000, "c");
        _commit(alice, pa); _commit(bob, pb); _commit(carol, pc);
        vm.warp(block.timestamp + COMMIT_WIN);
        _reveal(alice, pa); _reveal(bob, pb); _reveal(carol, pc);
        vm.warp(block.timestamp + REVEAL_WIN);
        consensus.resolve(1);
        executor.execute(1);

        // 4) measureClose pulls 10% of "gain" (full LP deposit, since navOpen was 0)
        fee.measureClose(1);
        uint256 expectedTotalFee = (LP_DEPOSIT * FEE_BPS) / 10_000;
        assertEq(_totalFee(1), expectedTotalFee);
        // fee is now held by the PerformanceFee contract
        assertEq(usdc.balanceOf(address(fee)), expectedTotalFee);
        // vault lost that amount
        assertEq(vault.totalAssets(), LP_DEPOSIT - expectedTotalFee);

        // 5) Each agent claims pro-rata. All three bonded equal stake -> equal split.
        uint256 per = expectedTotalFee / 3;
        assertApproxEqAbs(fee.pendingFor(1, alice), per, 1);
        assertApproxEqAbs(fee.pendingFor(1, bob),   per, 1);
        assertApproxEqAbs(fee.pendingFor(1, carol), per, 1);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice); fee.claim(1);
        vm.prank(bob);   fee.claim(1);
        vm.prank(carol); fee.claim(1);
        assertApproxEqAbs(usdc.balanceOf(alice) - aliceBefore, per, 1);
        assertApproxEqAbs(usdc.balanceOf(bob),   per, 1);
        assertApproxEqAbs(usdc.balanceOf(carol), per, 1);
    }

    function test_measureClose_revertsBeforeConsensusResolved() public {
        _bond(alice, "macro");
        round.startEpoch();
        fee.snapshotOpen(1);
        IDaioAgent.Proposal memory pa = _proposal(1, 5000, 3000, 2000, "a");
        _commit(alice, pa);
        vm.warp(block.timestamp + COMMIT_WIN);
        _reveal(alice, pa);
        // do NOT resolve
        vm.expectRevert(PerformanceFee.EpochNotResolved.selector);
        fee.measureClose(1);
    }

    function test_measureClose_revertsWithoutSnapshot() public {
        _bond(alice, "macro");
        round.startEpoch();
        // skip snapshotOpen
        IDaioAgent.Proposal memory pa = _proposal(1, 5000, 3000, 2000, "a");
        _commit(alice, pa);
        vm.warp(block.timestamp + COMMIT_WIN);
        _reveal(alice, pa);
        vm.warp(block.timestamp + REVEAL_WIN);
        consensus.resolve(1);

        vm.expectRevert(PerformanceFee.NotOpened.selector);
        fee.measureClose(1);
    }

    function test_claim_revertsForNonWinner() public {
        _runEpoch1_AllRevealed();
        fee.snapshotOpen(2); // unrelated; just to exercise snapshot independence
        // mint some "gain" to the vault so totalFee > 0 for epoch 1 measure
        usdc.mint(address(vault), 100e6);
        fee.measureClose(1);

        address stranger = address(0xDEADBEEF);
        vm.prank(stranger);
        vm.expectRevert(PerformanceFee.NotAWinner.selector);
        fee.claim(1);
    }

    function test_claim_revertsIfAlreadyClaimed() public {
        _runEpoch1_AllRevealed();
        usdc.mint(address(vault), 100e6); // create gain
        fee.measureClose(1);

        vm.prank(alice); fee.claim(1);
        vm.prank(alice);
        vm.expectRevert(PerformanceFee.AlreadyClaimed.selector);
        fee.claim(1);
    }

    function test_underperformingEpoch_zeroFee_noClaim() public {
        _bond(alice, "macro");
        usdc.mint(address(vault), 500e6); // vault has assets before snapshot
        round.startEpoch();
        fee.snapshotOpen(1);
        assertEq(_navOpen(1), 500e6);

        IDaioAgent.Proposal memory pa = _proposal(1, 5000, 3000, 2000, "a");
        _commit(alice, pa);
        vm.warp(block.timestamp + COMMIT_WIN);
        _reveal(alice, pa);
        vm.warp(block.timestamp + REVEAL_WIN);
        consensus.resolve(1);
        executor.execute(1);

        // navClose unchanged -> no gain -> no fee
        fee.measureClose(1);
        assertEq(_totalFee(1), 0);
        assertEq(usdc.balanceOf(address(fee)), 0);

        vm.prank(alice);
        vm.expectRevert(PerformanceFee.NotAWinner.selector); // pendingFor returns 0 when totalFee == 0
        fee.claim(1);
    }
}
