"""Epoch orchestrator: drives the contracts through one full lifecycle.

The agents (daio-macro / daio-credit) handle the commit + reveal phases.
This script handles the work that's not agent-driven — startEpoch (owner),
snapshotOpen / resolve / execute / measureClose (anyone) — plus the
waiting and per-phase status printing in between.

Modes:
  uv run daio-orchestrator full              # start a new epoch, wait, settle it
  uv run daio-orchestrator start-epoch       # just kick off the next epoch (+ snapshot)
  uv run daio-orchestrator settle <epoch>    # resolve + execute + measureClose for <epoch>
  uv run daio-orchestrator status            # print current epoch, phase, basket
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import structlog
from eth_account import Account
from web3 import Web3
from web3.exceptions import ContractLogicError

from .common import epoch as ep
from .common.abi import (
    PHASE_CLOSED,
    PHASE_COMMIT,
    PHASE_NAMES,
    PHASE_REVEAL,
    PROPOSAL_ROUND_ABI,
)
from .common.chain import ChainContext, _read_addresses, load_env
from .common.contracts import build_contracts

log = structlog.get_logger("daio.orch")


# ---------- context (deployer key) ----------

def build_deployer_context() -> ChainContext:
    """Same shape as common.chain.build_context but bound to DEPLOYER_PRIVATE_KEY
    instead of an agent key. The deployer is the only address that can call
    ProposalRound.startEpoch()."""
    load_env()
    rpc_url = os.environ.get("ARBITRUM_SEPOLIA_RPC_URL") or os.environ.get("ROBINHOOD_TESTNET_RPC_URL")
    if not rpc_url:
        raise RuntimeError("set ARBITRUM_SEPOLIA_RPC_URL or ROBINHOOD_TESTNET_RPC_URL in .env")
    pk = os.environ.get("DEPLOYER_PRIVATE_KEY")
    if not pk:
        raise RuntimeError("set DEPLOYER_PRIVATE_KEY in .env")

    w3 = Web3(Web3.HTTPProvider(rpc_url))
    account = Account.from_key(pk)
    contracts = build_contracts(w3, _read_addresses())
    log.info("orch.context.built", deployer=account.address, chain_id=w3.eth.chain_id)
    return ChainContext(w3=w3, account=account, contracts=contracts)


# ---------- deployer-only actions ----------

# `startEpoch()` and `snapshotOpen(uint256)` aren't on the agent-side minimal
# ABI; add them here as a thin extension so the orchestrator can call them.
_ORCH_ROUND_EXTRA = [
    {
        "type": "function",
        "name": "startEpoch",
        "stateMutability": "nonpayable",
        "inputs": [],
        "outputs": [],
    },
]

_ORCH_FEE_EXTRA = [
    {
        "type": "function",
        "name": "snapshotOpen",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "epoch", "type": "uint256"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "measureClose",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "epoch", "type": "uint256"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "metrics",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "uint256"}],
        "outputs": [
            {"name": "navOpen", "type": "uint256"},
            {"name": "navClose", "type": "uint256"},
            {"name": "totalFee", "type": "uint256"},
            {"name": "winningStake", "type": "uint256"},
            {"name": "opened", "type": "bool"},
            {"name": "measured", "type": "bool"},
        ],
    },
]

_ORCH_CONSENSUS_EXTRA = [
    {
        "type": "function",
        "name": "resolve",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "epoch", "type": "uint256"}],
        "outputs": [],
    },
]

_ORCH_EXECUTOR_EXTRA = [
    {
        "type": "function",
        "name": "execute",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "epoch", "type": "uint256"}],
        "outputs": [],
    },
]


def _attach_extras(ctx: ChainContext) -> None:
    """Re-bind each contract with the extra ABI fragments the orchestrator needs."""
    w3 = ctx.w3
    c = ctx.contracts
    c.round = w3.eth.contract(address=c.round.address, abi=PROPOSAL_ROUND_ABI + _ORCH_ROUND_EXTRA)
    c.fee = w3.eth.contract(address=c.fee.address, abi=c.fee.abi + _ORCH_FEE_EXTRA)
    c.consensus = w3.eth.contract(address=c.consensus.address, abi=c.consensus.abi + _ORCH_CONSENSUS_EXTRA)
    c.executor = w3.eth.contract(address=c.executor.address, abi=c.executor.abi + _ORCH_EXECUTOR_EXTRA)


# ---------- phase actions ----------

def start_epoch(ctx: ChainContext) -> int:
    log.info("orch.start_epoch")
    ep.send_tx(ctx, ctx.contracts.round.functions.startEpoch(), gas=200_000)
    epoch = ep.current_epoch(ctx)
    log.info("orch.epoch_started", epoch=epoch)
    return epoch


def snapshot_open(ctx: ChainContext, epoch: int) -> None:
    log.info("orch.snapshot_open", epoch=epoch)
    try:
        ep.send_tx(ctx, ctx.contracts.fee.functions.snapshotOpen(epoch), gas=120_000)
    except (RuntimeError, ContractLogicError) as e:
        # Already opened — fine.
        log.warning("orch.snapshot_open.skip", epoch=epoch, error=str(e))


def resolve(ctx: ChainContext, epoch: int) -> None:
    log.info("orch.resolve", epoch=epoch)
    ep.send_tx(ctx, ctx.contracts.consensus.functions.resolve(epoch), gas=2_000_000)


def execute(ctx: ChainContext, epoch: int) -> None:
    log.info("orch.execute", epoch=epoch)
    ep.send_tx(ctx, ctx.contracts.executor.functions.execute(epoch), gas=600_000)


def measure_close(ctx: ChainContext, epoch: int) -> None:
    log.info("orch.measure_close", epoch=epoch)
    ep.send_tx(ctx, ctx.contracts.fee.functions.measureClose(epoch), gas=600_000)


# ---------- composite flows ----------

def settle(ctx: ChainContext, epoch: int) -> None:
    """Anyone-callable settlement: resolve → execute → measureClose."""
    resolved = ctx.contracts.consensus.functions.resolved(epoch).call()
    if not resolved:
        resolve(ctx, epoch)
    else:
        log.info("orch.resolve.skip", epoch=epoch, reason="already resolved")

    executed = ctx.contracts.executor.functions.executed(epoch).call()
    if not executed:
        execute(ctx, epoch)
    else:
        log.info("orch.execute.skip", epoch=epoch, reason="already executed")

    metrics = ctx.contracts.fee.functions.metrics(epoch).call()
    if not metrics[5]:  # measured flag
        measure_close(ctx, epoch)
    else:
        log.info("orch.measure_close.skip", epoch=epoch, reason="already measured")

    # Print the final epoch summary.
    metrics = ctx.contracts.fee.functions.metrics(epoch).call()
    log.info(
        "orch.epoch.settled",
        epoch=epoch,
        navOpen=metrics[0],
        navClose=metrics[1],
        totalFee=metrics[2],
        winningStake=metrics[3],
    )


def full(ctx: ChainContext) -> None:
    """Start the next epoch, wait for it to fully close, settle it."""
    epoch = start_epoch(ctx)
    snapshot_open(ctx, epoch)

    # Read the per-epoch deadlines so the wait is exact, not guessed.
    commitOpen, commitClose, revealClose, _phase = ctx.contracts.round.functions.epochs(epoch).call()
    log.info(
        "orch.epoch.windows",
        epoch=epoch,
        commit_seconds=int(commitClose - commitOpen),
        reveal_seconds=int(revealClose - commitClose),
    )

    # Wait through commit phase. The agent processes (daio-macro / daio-credit)
    # should be running in other terminals and committing during this window.
    log.info("orch.waiting_for_reveal", until=int(commitClose))
    _wait_until(ctx, int(commitClose))

    # Wait through reveal phase. Agents reveal during this window.
    log.info("orch.waiting_for_close", until=int(revealClose))
    _wait_until(ctx, int(revealClose))

    # Tiny grace period for the chain to advance one block past revealClose.
    time.sleep(5)

    settle(ctx, epoch)


def _wait_until(ctx: ChainContext, ts: int, tick_s: float = 15.0) -> None:
    while True:
        block_ts = ctx.w3.eth.get_block("latest")["timestamp"]
        if block_ts >= ts:
            return
        remaining = ts - block_ts
        log.info("orch.wait", remaining_s=remaining)
        time.sleep(min(tick_s, max(1.0, remaining)))


# ---------- status ----------

def status(ctx: ChainContext) -> None:
    epoch = ep.current_epoch(ctx)
    phase = ep.current_phase(ctx)
    log.info("orch.status", current_epoch=epoch, phase=PHASE_NAMES.get(phase, phase))

    if epoch == 0:
        return
    commitOpen, commitClose, revealClose, _ = ctx.contracts.round.functions.epochs(epoch).call()
    block_ts = ctx.w3.eth.get_block("latest")["timestamp"]
    log.info(
        "orch.timing",
        epoch=epoch,
        block_ts=int(block_ts),
        commitOpen=int(commitOpen),
        commitClose=int(commitClose),
        revealClose=int(revealClose),
    )

    revealed = ctx.contracts.round.functions  # noqa: B018 — placeholder
    resolved = ctx.contracts.consensus.functions.resolved(epoch).call()
    executed_flag = ctx.contracts.executor.functions.executed(epoch).call()
    log.info("orch.epoch_state", epoch=epoch, resolved=resolved, executed=executed_flag)


# ---------- cli ----------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("full", help="start a new epoch, wait through windows, settle it")
    sub.add_parser("start-epoch", help="kick off the next epoch + snapshot navOpen")
    p_settle = sub.add_parser("settle", help="resolve + execute + measureClose for <epoch>")
    p_settle.add_argument("epoch", type=int)
    sub.add_parser("status", help="print the current epoch / phase / settlement state")

    args = parser.parse_args()

    ctx = build_deployer_context()
    _attach_extras(ctx)

    if args.cmd == "full":
        full(ctx)
    elif args.cmd == "start-epoch":
        e = start_epoch(ctx)
        snapshot_open(ctx, e)
    elif args.cmd == "settle":
        settle(ctx, args.epoch)
    elif args.cmd == "status":
        status(ctx)
    else:
        parser.print_help()
        sys.exit(2)


if __name__ == "__main__":
    main()
