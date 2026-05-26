// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {SynthUSDC} from "../src/synth/SynthUSDC.sol";

contract AgentRegistryTest is Test {
    AgentRegistry internal registry;
    SynthUSDC internal bond;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        bond = new SynthUSDC();
        registry = new AgentRegistry(address(bond), 1000e6, 3);
    }

    function test_register_pullsBond_andRecords() public {}

    function test_register_revertsBelowMinBond() public {}

    function test_register_revertsIfAlreadyRegistered() public {}

    function test_slash_onlySlasher() public {}

    function test_slash_decrementsBond_andEjectsAtMaxStrikes() public {}

    function test_reputationOf_returnsLocalScore() public {}

    function test_setSlasher_onlyOwner() public {}
}
