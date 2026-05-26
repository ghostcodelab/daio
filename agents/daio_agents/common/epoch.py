"""High-level epoch interactions: register, commit, reveal, claim.

All on-chain mutations go through `send_tx`, which builds, signs, sends,
and waits for receipt — with a single retry on the common transient errors
(nonce drift, underpriced replacement).
"""
from __future__ import annotations

import os
import time
from secrets import token_bytes
from typing import Any

import structlog
from web3 import Web3
from web3.exceptions import ContractLogicError, TransactionNotFound

from .abi import PHASE_COMMIT, PHASE_NAMES, PHASE_REVEAL
from .chain import ChainContext
from .types import Allocation

log = structlog.get_logger("daio.epoch")


# ---------- tx plumbing ----------

def send_tx(ctx: ChainContext, fn, *, gas: int = 600_000, value: int = 0) -> dict:
    """Build, sign, send, wait. `fn` is a Web3 ContractFunction
    (e.g. contract.functions.commit(hash))."""
    nonce = ctx.w3.eth.get_transaction_count(ctx.account.address, "pending")
    tx = fn.build_transaction({
        "from": ctx.account.address,
        "chainId": ctx.w3.eth.chain_id,
        "nonce": nonce,
        "gas": gas,
        "value": value,
    })
    signed = ctx.account.sign_transaction(tx)
    raw = getattr(signed, "rawTransaction", None) or signed.raw_transaction
    tx_hash = ctx.w3.eth.send_raw_transaction(raw)
    log.info("tx.sent", hash=tx_hash.hex(), nonce=nonce)
    receipt = ctx.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if receipt["status"] != 1:
        raise RuntimeError(f"tx reverted: {tx_hash.hex()}")
    log.info("tx.mined", hash=tx_hash.hex(), block=receipt["blockNumber"], gas=receipt["gasUsed"])
    return dict(receipt)


# ---------- registration ----------

def is_registered(ctx: ChainContext) -> bool:
    return bool(ctx.contracts.registry.functions.isActive(ctx.account.address).call())


def ensure_registered(ctx: ChainContext, specialty: str) -> None:
    """No-op if already active. Otherwise: mint synth USDC (testnet only),
    approve registry, register."""
    if is_registered(ctx):
        log.info("registry.already_active", address=ctx.account.address)
        return

    min_bond = ctx.contracts.registry.functions.minBond().call()
    usdc = ctx.contracts.usdc
    bal = usdc.functions.balanceOf(ctx.account.address).call()
    log.info("registry.preparing", min_bond=min_bond, usdc_balance=bal)

    if bal < min_bond:
        # SynthUSDC has open mint on testnet. Mint just enough.
        log.info("registry.minting_usdc", amount=min_bond - bal)
        send_tx(ctx, usdc.functions.mint(ctx.account.address, min_bond - bal), gas=120_000)

    allowance = usdc.functions.allowance(
        ctx.account.address, ctx.contracts.registry.address
    ).call()
    if allowance < min_bond:
        log.info("registry.approving_usdc", amount=min_bond)
        send_tx(ctx, usdc.functions.approve(ctx.contracts.registry.address, min_bond), gas=100_000)

    specialty_bytes = specialty.encode("utf-8").ljust(32, b"\x00")[:32]
    log.info("registry.registering", bond=min_bond, specialty=specialty)
    send_tx(
        ctx,
        ctx.contracts.registry.functions.register(min_bond, specialty_bytes),
        gas=300_000,
    )
    log.info("registry.registered", address=ctx.account.address)


# ---------- epoch / phase helpers ----------

def current_epoch(ctx: ChainContext) -> int:
    return int(ctx.contracts.round.functions.currentEpoch().call())


def current_phase(ctx: ChainContext) -> int:
    return int(ctx.contracts.round.functions.currentPhase().call())


def wait_for_phase(ctx: ChainContext, target_phase: int, poll_s: float = 5.0, timeout_s: float = 1800.0) -> None:
    """Block until currentPhase() == target_phase or timeout."""
    start = time.time()
    while True:
        ph = current_phase(ctx)
        if ph == target_phase:
            return
        if time.time() - start > timeout_s:
            raise TimeoutError(
                f"timed out waiting for {PHASE_NAMES.get(target_phase, target_phase)}; "
                f"current is {PHASE_NAMES.get(ph, ph)}"
            )
        log.info(
            "phase.waiting",
            current=PHASE_NAMES.get(ph, ph),
            target=PHASE_NAMES.get(target_phase, target_phase),
            poll_s=poll_s,
        )
        time.sleep(poll_s)


# ---------- proposal build / commit / reveal ----------

def _resolve_tokens(ctx: ChainContext, symbols: list[str]) -> list[str]:
    """Map ["mUSDY", "mIB01", "mAAPL"] to checksummed addresses."""
    out: list[str] = []
    for sym in symbols:
        addr = ctx.contracts.tokens.get(sym)
        if not addr:
            raise RuntimeError(
                f"no address for token symbol {sym!r}; set MUSDY_ADDRESS / MIB01_ADDRESS / MAAPL_ADDRESS in .env"
            )
        out.append(addr)
    return out


def build_proposal_tuple(
    ctx: ChainContext,
    epoch: int,
    allocation: Allocation,
    rationale_hash: bytes,
    signature: bytes = b"",
) -> tuple:
    """Pack a Proposal into the tuple shape the ABI expects."""
    return (
        epoch,
        (_resolve_tokens(ctx, allocation.tokens), list(allocation.weights_bps)),
        rationale_hash,
        signature,
    )


def commit_for_epoch(
    ctx: ChainContext,
    epoch: int,
    allocation: Allocation,
    rationale_hash: bytes,
) -> bytes:
    """Compute the on-chain commit hash via the contract's own pure function
    (foolproof — no Python/Solidity encoding skew), then send `commit(hash)`."""
    proposal = build_proposal_tuple(ctx, epoch, allocation, rationale_hash)
    h = ctx.contracts.round.functions.hashProposal(epoch, ctx.account.address, proposal).call()
    log.info("commit.hash_computed", epoch=epoch, hash=h.hex())
    send_tx(ctx, ctx.contracts.round.functions.commit(h), gas=200_000)
    return h


def reveal_for_epoch(
    ctx: ChainContext,
    epoch: int,
    allocation: Allocation,
    rationale_hash: bytes,
) -> None:
    proposal = build_proposal_tuple(ctx, epoch, allocation, rationale_hash)
    send_tx(ctx, ctx.contracts.round.functions.reveal(proposal), gas=400_000)
    log.info("reveal.sent", epoch=epoch)


def random_salt() -> bytes:
    """32-byte salt to bind into the commit hash so identical allocations
    produce distinct commit hashes (prevents rainbow-table reveal-prediction)."""
    return token_bytes(32)


# ---------- claim ----------

def claim_if_winner(ctx: ChainContext, epoch: int) -> int:
    """Attempt to claim the agent's perf-fee share for `epoch`. Returns the
    USDC amount transferred (0 if nothing was due)."""
    pending = ctx.contracts.fee.functions.pendingFor(epoch, ctx.account.address).call()
    if pending == 0:
        log.info("claim.skip", epoch=epoch, reason="nothing pending")
        return 0
    log.info("claim.sending", epoch=epoch, pending=pending)
    try:
        send_tx(ctx, ctx.contracts.fee.functions.claim(epoch), gas=200_000)
    except (ContractLogicError, RuntimeError) as e:
        log.warning("claim.failed", epoch=epoch, error=str(e))
        return 0
    return pending
