// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AllocationExecutor} from "../src/AllocationExecutor.sol";
import {Consensus} from "../src/Consensus.sol";
import {ProposalRound} from "../src/ProposalRound.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {DaioVault} from "../src/DaioVault.sol";
import {SynthUSDC} from "../src/synth/SynthUSDC.sol";
import {IDaioAgent} from "../src/interfaces/IDaioAgent.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AllocationExecutorTest is Test {
    AllocationExecutor internal executor;
    Consensus internal consensus;
    ProposalRound internal round;
    AgentRegistry internal registry;
    DaioVault internal vault;
    SynthUSDC internal usdc;

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
        usdc = new SynthUSDC();
        registry = new AgentRegistry(address(usdc), BOND, 3);
        round = new ProposalRound(address(registry), COMMIT_WIN, REVEAL_WIN);
        consensus = new Consensus(address(round), address(registry), 500);
        vault = new DaioVault(IERC20(address(usdc)));
        executor = new AllocationExecutor(address(consensus), address(vault));
        vault.setAllocator(address(executor));
    }

    function _bond(address who, bytes32 specialty) internal {
        usdc.mint(who, BOND);
        vm.startPrank(who);
        usdc.approve(address(registry), BOND);
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

    function _commit(address who, IDaioAgent.Proposal memory p) internal {
        bytes32 h = round.hashProposal(p.epoch, who, p);
        vm.prank(who);
        round.commit(h);
    }

    function _reveal(address who, IDaioAgent.Proposal memory p) internal {
        vm.prank(who);
        round.reveal(p);
    }

    function _runEpoch() internal {
        _bond(alice, "macro");
        _bond(bob,   "credit");
        _bond(carol, "liquidity");

        round.startEpoch();
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
    }

    function test_execute_recordsBasket_emitsRebalanced() public {
        _runEpoch();

        IDaioAgent.Allocation memory winning = consensus.getWinningAllocation(1);

        vm.expectEmit(true, false, false, true);
        emit AllocationExecutor.Rebalanced(1, winning.tokens, winning.weightsBps);

        executor.execute(1);

        assertTrue(executor.executed(1));
        assertEq(executor.currentBasketEpoch(), 1);

        IDaioAgent.Allocation memory snap = executor.getBasket(1);
        assertEq(snap.tokens.length, 3);
        assertEq(snap.weightsBps.length, 3);

        uint256 sum;
        for (uint256 i = 0; i < 3; i++) sum += snap.weightsBps[i];
        assertEq(sum, 10_000);

        // currentBasket() returns the same snapshot
        IDaioAgent.Allocation memory cur = executor.currentBasket();
        assertEq(cur.tokens[0], snap.tokens[0]);
        assertEq(cur.weightsBps[0], snap.weightsBps[0]);
    }

    function test_execute_revertsBeforeConsensusResolved() public {
        _bond(alice, "macro");
        round.startEpoch();
        IDaioAgent.Proposal memory pa = _proposal(1, 5000, 3000, 2000, "a");
        _commit(alice, pa);
        vm.warp(block.timestamp + COMMIT_WIN);
        _reveal(alice, pa);
        // do NOT call consensus.resolve

        vm.expectRevert(AllocationExecutor.EpochNotResolved.selector);
        executor.execute(1);
    }

    function test_execute_revertsIfAlreadyExecuted() public {
        _runEpoch();
        executor.execute(1);
        vm.expectRevert(AllocationExecutor.AlreadyExecuted.selector);
        executor.execute(1);
    }

    function test_basketWeightOf_returnsPerTokenWeight() public {
        _runEpoch();
        executor.execute(1);
        uint16 wUsdy = executor.basketWeightOf(1, mUSDY);
        uint16 wIb01 = executor.basketWeightOf(1, mIB01);
        uint16 wAapl = executor.basketWeightOf(1, mAAPL);
        assertEq(uint256(wUsdy) + uint256(wIb01) + uint256(wAapl), 10_000);
        // unknown token returns 0
        assertEq(uint256(executor.basketWeightOf(1, address(0xDEAD))), 0);
    }
}
