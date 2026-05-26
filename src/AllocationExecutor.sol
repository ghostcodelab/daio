// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDaioAgent} from "./interfaces/IDaioAgent.sol";
import {Consensus} from "./Consensus.sol";
import {DaioVault} from "./DaioVault.sol";

/// @notice Records the consensus-elected basket on-chain and (in v2) swaps
/// vault holdings to match it.
///
/// MVP (this file): "synth swap" — record the elected basket and emit
/// `Rebalanced`. The vault's USDC balance is untouched; off-chain accounting
/// + the frontend treat the recorded basket as the active allocation.
/// v2: for each token, compute delta vs current vault holdings and swap via
/// routes[token]. The legacy `Route`/`routes`/`setRoute`/`Executed` surface
/// is kept for that.
contract AllocationExecutor is Ownable {
    error EpochNotResolved();
    error AlreadyExecuted();
    error InvalidWeightSum();
    error LengthMismatch();
    error EmptyAllocation();

    uint16 public constant TOTAL_WEIGHT_BPS = 10_000;

    struct Route {
        address router;
        bytes pathData;
    }

    Consensus public immutable consensus;
    DaioVault public immutable vault;

    // v2 swap infrastructure — set per token by the owner once real DEX routes exist.
    mapping(address => Route) public routes;

    // v1 state: per-epoch basket snapshots + pointer to the most recent.
    mapping(uint256 => IDaioAgent.Allocation) internal _basket;
    mapping(uint256 => bool) public executed;
    uint256 public currentBasketEpoch;

    event RouteSet(address indexed token, address router);
    event Executed(uint256 indexed epoch, address indexed token, int256 deltaAmount); // v2
    event Rebalanced(uint256 indexed epoch, address[] tokens, uint16[] weightsBps);   // v1

    constructor(address consensus_, address vault_) Ownable(msg.sender) {
        consensus = Consensus(consensus_);
        vault = DaioVault(vault_);
    }

    function setRoute(address token, address router, bytes calldata pathData) external onlyOwner {
        routes[token] = Route(router, pathData);
        emit RouteSet(token, router);
    }

    /// @notice Record the consensus-elected basket for `epoch`. Idempotent per epoch.
    /// Anyone can poke this once consensus has resolved — there's nothing privileged
    /// about recording the result.
    function execute(uint256 epoch) external {
        if (!consensus.resolved(epoch)) revert EpochNotResolved();
        if (executed[epoch]) revert AlreadyExecuted();

        IDaioAgent.Allocation memory a = consensus.getWinningAllocation(epoch);
        uint256 n = a.tokens.length;
        if (n == 0) revert EmptyAllocation();
        if (a.weightsBps.length != n) revert LengthMismatch();

        uint256 sum;
        for (uint256 i = 0; i < n; i++) sum += a.weightsBps[i];
        if (sum != TOTAL_WEIGHT_BPS) revert InvalidWeightSum();

        _basket[epoch] = a;
        executed[epoch] = true;
        if (epoch > currentBasketEpoch) currentBasketEpoch = epoch;

        // v2: for (i = 0..n) compute target = totalAssets * weight / 10000;
        //     swap (target - currentBalance[token]) via routes[token]; emit Executed per leg.
        // v1: emit the basket as a single event. Frontend reads via `currentBasket()`.
        emit Rebalanced(epoch, a.tokens, a.weightsBps);
    }

    function getBasket(uint256 epoch) external view returns (IDaioAgent.Allocation memory) {
        return _basket[epoch];
    }

    function currentBasket() external view returns (IDaioAgent.Allocation memory) {
        return _basket[currentBasketEpoch];
    }

    function basketWeightOf(uint256 epoch, address token) external view returns (uint16) {
        IDaioAgent.Allocation memory a = _basket[epoch];
        uint256 n = a.tokens.length;
        for (uint256 i = 0; i < n; i++) {
            if (a.tokens[i] == token) return a.weightsBps[i];
        }
        return 0;
    }
}
