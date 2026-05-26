// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DaioVault} from "../src/DaioVault.sol";
import {SynthUSDC} from "../src/synth/SynthUSDC.sol";

contract DaioVaultTest is Test {
    DaioVault internal vault;
    SynthUSDC internal usdc;

    address internal lp = makeAddr("lp");
    address internal allocator = makeAddr("allocator");

    function setUp() public {
        usdc = new SynthUSDC();
        vault = new DaioVault(usdc);
        vault.setAllocator(allocator);
    }

    function test_deposit_mintsSharesProRata() public {}

    function test_withdraw_burnsShares_returnsUSDC() public {}

    function test_totalAssets_includesRWABasket() public {}

    function test_pullForRebalance_onlyAllocator() public {}

    function test_setAllocator_onlyOwner() public {}
}
