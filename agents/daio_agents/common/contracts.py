"""Bundle of Web3 Contract handles, addressed by short name."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from web3 import Web3

from . import abi


@dataclass
class Contracts:
    usdc: Any
    registry: Any
    round: Any
    consensus: Any
    executor: Any  # not strictly needed by agents yet, but useful for reads
    fee: Any
    vault: Any
    tokens: dict[str, str]  # symbol -> address (e.g. "mUSDY" -> "0x...")


# Minimal vault ABI (only what agents read).
_VAULT_ABI = [
    {
        "type": "function",
        "name": "totalAssets",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]

# AllocationExecutor — kept ABI tiny; we only read currentBasket for diagnostics.
_EXECUTOR_ABI = [
    {
        "type": "function",
        "name": "currentBasketEpoch",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "executed",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
]


def build_contracts(w3: Web3, addresses: dict[str, str]) -> Contracts:
    """Wire all the contract handles. Requires every address in `addresses`
    to be non-empty; raises if anything's missing."""
    required = ["usdc", "registry", "round", "consensus", "executor", "fee", "vault"]
    missing = [k for k in required if not addresses.get(k)]
    if missing:
        raise RuntimeError(
            f"missing contract addresses: {missing}. "
            "Set the *_ADDRESS env vars in .env to your deployed addresses."
        )

    def at(addr: str, abi_: list[dict]) -> Any:
        return w3.eth.contract(address=Web3.to_checksum_address(addr), abi=abi_)

    tokens = {
        sym: Web3.to_checksum_address(addresses[sym])
        for sym in ("mUSDY", "mIB01", "mAAPL")
        if addresses.get(sym)
    }

    return Contracts(
        usdc=at(addresses["usdc"], abi.MOCK_USDC_ABI),
        registry=at(addresses["registry"], abi.AGENT_REGISTRY_ABI),
        round=at(addresses["round"], abi.PROPOSAL_ROUND_ABI),
        consensus=at(addresses["consensus"], abi.CONSENSUS_ABI),
        executor=at(addresses["executor"], _EXECUTOR_ABI),
        fee=at(addresses["fee"], abi.PERFORMANCE_FEE_ABI),
        vault=at(addresses["vault"], _VAULT_ABI),
        tokens=tokens,
    )
