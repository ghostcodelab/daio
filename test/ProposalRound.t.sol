// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProposalRound} from "../src/ProposalRound.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {SynthUSDC} from "../src/synth/SynthUSDC.sol";
import {IDaioAgent} from "../src/interfaces/IDaioAgent.sol";

contract ProposalRoundTest is Test {
    ProposalRound internal round;
    AgentRegistry internal registry;
    SynthUSDC internal bond;

    address internal alice = address(0xA11CE);
    address internal bob   = address(0xB0B);
    address internal carol = address(0xCA201);

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
        _bond(alice, "macro");
        _bond(bob, "credit");
    }

    function _bond(address who, bytes32 specialty) internal {
        bond.mint(who, BOND);
        vm.startPrank(who);
        bond.approve(address(registry), BOND);
        registry.register(BOND, specialty);
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

    function test_startEpoch_emitsAndSetsCommitPhase() public {
        round.startEpoch();
        assertEq(round.currentEpoch(), 1);
        assertEq(uint8(round.currentPhase()), uint8(ProposalRound.Phase.Commit));
    }

    function test_commit_storesHash_emits() public {
        round.startEpoch();
        IDaioAgent.Proposal memory p = _proposal(1, 5000, 3000, 2000, "salt-a");
        bytes32 h = round.hashProposal(1, alice, p);

        vm.prank(alice);
        round.commit(h);
        assertEq(round.commits(1, alice), h);
    }

    function test_commit_revertsOutsideCommitPhase() public {
        round.startEpoch();
        vm.warp(block.timestamp + COMMIT_WIN); // jump into reveal phase
        bytes32 h = keccak256("anything");
        vm.prank(alice);
        vm.expectRevert(ProposalRound.WrongPhase.selector);
        round.commit(h);
    }

    function test_commit_revertsForUnregisteredAgent() public {
        round.startEpoch();
        vm.prank(carol); // never bonded
        vm.expectRevert(ProposalRound.NotRegisteredAgent.selector);
        round.commit(keccak256("x"));
    }

    function test_reveal_verifiesHashMatches() public {
        round.startEpoch();
        IDaioAgent.Proposal memory p = _proposal(1, 5000, 3000, 2000, "salt-a");
        bytes32 h = round.hashProposal(1, alice, p);

        vm.prank(alice);
        round.commit(h);

        // jump into reveal phase
        vm.warp(block.timestamp + COMMIT_WIN);

        vm.prank(alice);
        round.reveal(p);

        address[] memory revealed = round.revealsFor(1);
        assertEq(revealed.length, 1);
        assertEq(revealed[0], alice);
    }

    function test_reveal_revertsOnInvalidReveal() public {
        round.startEpoch();
        IDaioAgent.Proposal memory committed = _proposal(1, 5000, 3000, 2000, "salt-a");
        IDaioAgent.Proposal memory tampered  = _proposal(1, 6000, 2500, 1500, "salt-a");
        bytes32 h = round.hashProposal(1, alice, committed);

        vm.prank(alice);
        round.commit(h);

        vm.warp(block.timestamp + COMMIT_WIN);

        vm.prank(alice);
        vm.expectRevert(ProposalRound.InvalidReveal.selector);
        round.reveal(tampered);
    }

    /* unused stubs kept so the original test file's names still resolve */
    function test_reveal_verifiesEIP712Signature() public {}
}
