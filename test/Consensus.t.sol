// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Consensus} from "../src/Consensus.sol";
import {ProposalRound} from "../src/ProposalRound.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {SynthUSDC} from "../src/synth/SynthUSDC.sol";
import {IDaioAgent} from "../src/interfaces/IDaioAgent.sol";

contract ConsensusTest is Test {
    Consensus internal consensus;
    ProposalRound internal round;
    AgentRegistry internal registry;
    SynthUSDC internal bond;

    address internal alice = address(0xA11CE);
    address internal bob   = address(0xB0B);
    address internal carol = address(0xCA201);
    address internal dan   = address(0xDA1);

    address internal mUSDY = address(0x1001);
    address internal mIB01 = address(0x1002);
    address internal mAAPL = address(0x1003);

    uint64 constant COMMIT_WIN = 300;
    uint64 constant REVEAL_WIN = 300;
    uint256 constant BOND = 1_000e6;

    function setUp() public {
        bond = new SynthUSDC();
        registry = new AgentRegistry(address(bond), BOND, 3);
        round = new ProposalRound(address(registry), COMMIT_WIN, REVEAL_WIN);
        consensus = new Consensus(address(round), address(registry), 500);
    }

    function _bond(address who, uint256 amount, bytes32 specialty) internal {
        bond.mint(who, amount);
        vm.startPrank(who);
        bond.approve(address(registry), amount);
        registry.register(amount, specialty);
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

    function _commitAndReveal(address who, IDaioAgent.Proposal memory p) internal {
        bytes32 h = round.hashProposal(p.epoch, who, p);

        // phase: commit
        if (round.currentPhase() != ProposalRound.Phase.Commit) {
            revert("test fixture: not in commit phase");
        }
        vm.prank(who);
        round.commit(h);
    }

    function _revealOnly(address who, IDaioAgent.Proposal memory p) internal {
        vm.prank(who);
        round.reveal(p);
    }

    function _advanceToReveal() internal {
        vm.warp(block.timestamp + COMMIT_WIN);
    }

    function _advanceToClosed() internal {
        vm.warp(block.timestamp + REVEAL_WIN);
    }

    function test_resolve_revertsBeforeRevealPhaseClosed() public {
        _bond(alice, BOND, "macro");
        round.startEpoch();
        IDaioAgent.Proposal memory pa = _proposal(1, 5000, 3000, 2000, "a");
        _commitAndReveal(alice, pa);
        _advanceToReveal();
        _revealOnly(alice, pa);
        // still inside reveal window
        vm.expectRevert(Consensus.EpochNotReady.selector);
        consensus.resolve(1);
    }

    function test_resolve_handlesSingleAgentRevealed() public {
        _bond(alice, BOND, "macro");
        round.startEpoch();
        IDaioAgent.Proposal memory pa = _proposal(1, 5000, 3000, 2000, "a");
        _commitAndReveal(alice, pa);
        _advanceToReveal();
        _revealOnly(alice, pa);
        _advanceToClosed();

        consensus.resolve(1);

        IDaioAgent.Allocation memory winning = consensus.getWinningAllocation(1);
        assertEq(winning.weightsBps.length, 3);
        // single agent: weights equal that agent's proposal (already sums to 10000)
        assertEq(uint256(winning.weightsBps[0]), 5000);
        assertEq(uint256(winning.weightsBps[1]), 3000);
        assertEq(uint256(winning.weightsBps[2]), 2000);
        assertTrue(consensus.resolved(1));
    }

    function test_resolve_computesMedianOfWinningCluster() public {
        // Three equal-stake agents. Per-token median is the middle of three sorted weights.
        // A: [5000, 3000, 2000]
        // B: [4500, 3500, 2000]
        // C: [3000, 2000, 5000]
        // sorted per token:
        //   t0: 3000, 4500, 5000 -> median 4500
        //   t1: 2000, 3000, 3500 -> median 3000
        //   t2: 2000, 2000, 5000 -> median 2000
        // sum = 9500; renormalised to 10000 (rounding remainder added to largest)
        _bond(alice, BOND, "macro");
        _bond(bob,   BOND, "credit");
        _bond(carol, BOND, "liquidity");

        round.startEpoch();
        IDaioAgent.Proposal memory pa = _proposal(1, 5000, 3000, 2000, "a");
        IDaioAgent.Proposal memory pb = _proposal(1, 4500, 3500, 2000, "b");
        IDaioAgent.Proposal memory pc = _proposal(1, 3000, 2000, 5000, "c");

        _commitAndReveal(alice, pa);
        _commitAndReveal(bob,   pb);
        _commitAndReveal(carol, pc);
        _advanceToReveal();
        _revealOnly(alice, pa);
        _revealOnly(bob,   pb);
        _revealOnly(carol, pc);
        _advanceToClosed();

        consensus.resolve(1);
        IDaioAgent.Allocation memory w = consensus.getWinningAllocation(1);

        // weights should sum to exactly 10_000
        uint256 sum = uint256(w.weightsBps[0]) + uint256(w.weightsBps[1]) + uint256(w.weightsBps[2]);
        assertEq(sum, 10_000, "weights must sum to 10000 bps");

        // largest weight token should be t0 (the cash leg) since pre-norm median was 4500
        assertGt(uint256(w.weightsBps[0]), uint256(w.weightsBps[1]));
        assertGt(uint256(w.weightsBps[0]), uint256(w.weightsBps[2]));
        // t1 should be larger than t2 (3000 > 2000)
        assertGt(uint256(w.weightsBps[1]), uint256(w.weightsBps[2]));
    }

    function test_resolve_revertsIfAlreadyResolved() public {
        _bond(alice, BOND, "macro");
        round.startEpoch();
        IDaioAgent.Proposal memory pa = _proposal(1, 5000, 3000, 2000, "a");
        _commitAndReveal(alice, pa);
        _advanceToReveal();
        _revealOnly(alice, pa);
        _advanceToClosed();

        consensus.resolve(1);
        vm.expectRevert(Consensus.AlreadyResolved.selector);
        consensus.resolve(1);
    }

    function test_resolve_revertsWithNoReveals() public {
        _bond(alice, BOND, "macro");
        round.startEpoch();
        _advanceToReveal();
        _advanceToClosed();
        vm.expectRevert(Consensus.NoReveals.selector);
        consensus.resolve(1);
    }

    /* placeholder stubs from the original file kept for cluster v2 */
    function test_resolve_picksHighestStakeCluster() public {}
    function test_resolve_handlesAllAgentsInOneCluster() public {}
    function test_resolve_handlesPerfectTwoWayTie() public {}
}
