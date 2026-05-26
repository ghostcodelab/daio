"""Web3 client and contract handles."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import structlog
from dotenv import load_dotenv
from eth_account import Account
from eth_account.signers.local import LocalAccount
from web3 import Web3

from .contracts import Contracts, build_contracts

log = structlog.get_logger()


@dataclass
class ChainContext:
    w3: Web3
    account: LocalAccount
    contracts: Contracts


def load_env() -> None:
    env_path = Path(__file__).resolve().parents[3] / ".env"
    load_dotenv(env_path)


def _read_addresses() -> dict[str, str]:
    """Pull every deployed-address env var. Keys are short names used by
    Contracts; values are 0x-prefixed addresses."""
    return {
        "usdc":      os.environ.get("USDC_ADDRESS", ""),
        "registry":  os.environ.get("AGENT_REGISTRY_ADDRESS", ""),
        "round":     os.environ.get("PROPOSAL_ROUND_ADDRESS", ""),
        "consensus": os.environ.get("CONSENSUS_ADDRESS", ""),
        "executor":  os.environ.get("ALLOCATION_EXECUTOR_ADDRESS", ""),
        "fee":       os.environ.get("PERFORMANCE_FEE_ADDRESS", ""),
        "vault":     os.environ.get("DAIO_VAULT_ADDRESS", ""),
        "mUSDY":     os.environ.get("MUSDY_ADDRESS", ""),
        "mIB01":     os.environ.get("MIB01_ADDRESS", ""),
        "mAAPL":     os.environ.get("MAAPL_ADDRESS", ""),
    }


def build_context(agent_key_env: str) -> ChainContext:
    load_env()
    rpc_url = os.environ.get("ARBITRUM_SEPOLIA_RPC_URL") or os.environ.get("ROBINHOOD_TESTNET_RPC_URL")
    if not rpc_url:
        raise RuntimeError("set ARBITRUM_SEPOLIA_RPC_URL or ROBINHOOD_TESTNET_RPC_URL in .env")

    pk = os.environ.get(agent_key_env)
    if not pk:
        raise RuntimeError(f"set {agent_key_env} in .env")

    w3 = Web3(Web3.HTTPProvider(rpc_url))
    account = Account.from_key(pk)
    contracts = build_contracts(w3, _read_addresses())

    log.info(
        "chain.context.built",
        address=account.address,
        chain_id=w3.eth.chain_id,
    )
    return ChainContext(w3=w3, account=account, contracts=contracts)
