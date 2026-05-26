// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice ERC-4626 vault for LP deposits of USDC. The vault holds USDC and
/// the active RWA basket as decided by the agent consensus each epoch.
contract DaioVault is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    error NotImplemented();
    error OnlyAllocator();
    error OnlyFeeCollector();
    error ZeroAddress();

    address public allocator;
    address public feeCollector;

    event AllocatorSet(address indexed allocator);
    event FeeCollectorSet(address indexed feeCollector);
    event FeeWithdrawn(address indexed to, uint256 amount);

    constructor(IERC20 asset_)
        ERC4626(asset_)
        ERC20("Daio Vault Share", "dvUSDC")
        Ownable(msg.sender)
    {}

    function setAllocator(address allocator_) external onlyOwner {
        allocator = allocator_;
        emit AllocatorSet(allocator_);
    }

    function setFeeCollector(address feeCollector_) external onlyOwner {
        if (feeCollector_ == address(0)) revert ZeroAddress();
        feeCollector = feeCollector_;
        emit FeeCollectorSet(feeCollector_);
    }

    /// @notice Total assets includes the USDC balance plus the marked-to-market
    /// value of the current RWA basket. MVP: returns USDC balance only.
    /// TODO: integrate price reads + RWA holdings.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice Pull assets to the executor for rebalancing. Only the allocator.
    function pullForRebalance(address token, uint256 amount, address to) external {
        if (msg.sender != allocator) revert OnlyAllocator();
        // TODO: safe transfer
        revert NotImplemented();
    }

    /// @notice PerformanceFee pulls the perf fee out of the vault here. Only the
    /// configured feeCollector. Reduces totalAssets, which is correct economic
    /// behavior: LPs implicitly pay the fee via reduced NAV per share.
    function withdrawFee(address to, uint256 amount) external {
        if (msg.sender != feeCollector) revert OnlyFeeCollector();
        if (to == address(0)) revert ZeroAddress();
        IERC20(asset()).safeTransfer(to, amount);
        emit FeeWithdrawn(to, amount);
    }
}
