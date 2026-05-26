"""CreditAgent epoch loop.

Modes:
  uv run daio-credit                  # single-pass: register if needed, commit + reveal once, exit
  uv run daio-credit --loop           # daemon: keep running across epochs
  uv run daio-credit --register-only  # just bond + register, then exit
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time

import structlog

from ..common import epoch as ep
from ..common.chain import ChainContext, build_context
from ..common.types import Allocation
from . import strategy

log = structlog.get_logger("daio.credit")


FALLBACK_INPUTS = {
    "issuer": "Apple Inc (mAAPL underlying)",
    "latest_filings": [
        {"form": "10-Q", "date": "2026-05-02", "summary": "Services 14% YoY; gross margin -80bp."},
    ],
    "credit_spreads": "AAPL 5y CDS unchanged",
}

FALLBACK_ALLOCATION = Allocation(
    tokens=["mUSDY", "mIB01", "mAAPL"],
    weights_bps=[4800, 3400, 1800],
)
FALLBACK_RATIONALE = "deterministic fallback: cash-leaning, mild duration; CreditAgent"


def _build_allocation() -> tuple[Allocation, str]:
    if not os.environ.get("LLM_API_KEY") or not os.environ.get("LLM_MODEL"):
        log.warning("strategy.fallback", reason="LLM_API_KEY/LLM_MODEL unset")
        return FALLBACK_ALLOCATION, FALLBACK_RATIONALE
    try:
        return strategy.propose(FALLBACK_INPUTS)
    except Exception as e:  # noqa: BLE001
        log.warning("strategy.fallback", reason=f"LLM call failed: {e}")
        return FALLBACK_ALLOCATION, FALLBACK_RATIONALE


def _rationale_hash(rationale: str, salt: bytes) -> bytes:
    return hashlib.sha256(rationale.encode("utf-8") + salt).digest()


def run_once(ctx: ChainContext) -> None:
    from ..common.abi import PHASE_COMMIT, PHASE_REVEAL

    ep.ensure_registered(ctx, specialty="credit")

    ep.wait_for_phase(ctx, PHASE_COMMIT)
    epoch = ep.current_epoch(ctx)
    log.info("credit.commit.start", epoch=epoch)

    allocation, rationale = _build_allocation()
    log.info("credit.allocation", weights=allocation.weights_bps, rationale=rationale[:160])

    salt = ep.random_salt()
    r_hash = _rationale_hash(rationale, salt)
    ep.commit_for_epoch(ctx, epoch, allocation, r_hash)

    ep.wait_for_phase(ctx, PHASE_REVEAL)
    ep.reveal_for_epoch(ctx, epoch, allocation, r_hash)
    log.info("credit.epoch.done", epoch=epoch)

    prev = epoch - 1
    if prev > 0:
        try:
            amount = ep.claim_if_winner(ctx, prev)
            if amount > 0:
                log.info("credit.fee.claimed", epoch=prev, amount=amount)
        except Exception as e:  # noqa: BLE001
            log.warning("credit.fee.claim_failed", epoch=prev, error=str(e))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--loop", action="store_true", help="keep running across epochs")
    parser.add_argument("--register-only", action="store_true", help="register and exit")
    parser.add_argument("--sleep", type=float, default=10.0, help="loop sleep (s)")
    args = parser.parse_args()

    ctx = build_context("CREDIT_AGENT_PRIVATE_KEY")
    log.info("credit.agent.started", address=ctx.account.address)

    if args.register_only:
        ep.ensure_registered(ctx, specialty="credit")
        return

    if not args.loop:
        run_once(ctx)
        return

    while True:
        try:
            run_once(ctx)
        except Exception as e:  # noqa: BLE001
            log.error("credit.loop.error", error=str(e))
        log.info("credit.loop.sleep", seconds=args.sleep)
        time.sleep(args.sleep)


if __name__ == "__main__":
    sys.exit(main())
