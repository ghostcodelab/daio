"""MacroAgent epoch loop.

Modes:
  uv run daio-macro                  # single-pass: register if needed, commit + reveal once, exit
  uv run daio-macro --loop           # daemon: keep running across epochs
  uv run daio-macro --register-only  # just bond + register, then exit
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

log = structlog.get_logger("daio.macro")


# Fallback inputs used when the LLM is not configured. Keeps the demo
# runnable without OpenRouter credentials.
FALLBACK_INPUTS = {
    "latest_fomc": "Powell hints at modest cuts later this year. Real yields steady.",
    "latest_cpi": "Core CPI prints 0.3% MoM, in line with consensus.",
    "yield_curve_2y10y": "+10bp",
    "risk_appetite": "neutral; VIX at 14",
}

# Deterministic fallback if both LLM and macro inputs unavailable.
FALLBACK_ALLOCATION = Allocation(
    tokens=["mUSDY", "mIB01", "mAAPL"],
    weights_bps=[5500, 3000, 1500],
)
FALLBACK_RATIONALE = "deterministic fallback: cash-heavy default for MacroAgent"


def _build_allocation() -> tuple[Allocation, str]:
    """Try the LLM; if it's not configured, use the deterministic fallback."""
    if not os.environ.get("LLM_API_KEY") or not os.environ.get("LLM_MODEL"):
        log.warning("strategy.fallback", reason="LLM_API_KEY/LLM_MODEL unset")
        return FALLBACK_ALLOCATION, FALLBACK_RATIONALE
    try:
        return strategy.propose(FALLBACK_INPUTS)
    except Exception as e:  # noqa: BLE001 — LLM failures are demo-non-blocking
        log.warning("strategy.fallback", reason=f"LLM call failed: {e}")
        return FALLBACK_ALLOCATION, FALLBACK_RATIONALE


def _rationale_hash(rationale: str, salt: bytes) -> bytes:
    """bytes32 = keccak-ish digest binding the rationale text to a random salt
    so two agents with identical text+salt-less still produce distinct hashes."""
    return hashlib.sha256(rationale.encode("utf-8") + salt).digest()


def run_once(ctx: ChainContext) -> None:
    from ..common.abi import PHASE_COMMIT, PHASE_REVEAL

    ep.ensure_registered(ctx, specialty="macro")

    ep.wait_for_phase(ctx, PHASE_COMMIT)
    epoch = ep.current_epoch(ctx)
    log.info("macro.commit.start", epoch=epoch)

    allocation, rationale = _build_allocation()
    log.info("macro.allocation", weights=allocation.weights_bps, rationale=rationale[:160])

    salt = ep.random_salt()
    r_hash = _rationale_hash(rationale, salt)
    ep.commit_for_epoch(ctx, epoch, allocation, r_hash)

    ep.wait_for_phase(ctx, PHASE_REVEAL)
    ep.reveal_for_epoch(ctx, epoch, allocation, r_hash)
    log.info("macro.epoch.done", epoch=epoch)

    # Best-effort claim of the previous epoch's fee.
    prev = epoch - 1
    if prev > 0:
        try:
            amount = ep.claim_if_winner(ctx, prev)
            if amount > 0:
                log.info("macro.fee.claimed", epoch=prev, amount=amount)
        except Exception as e:  # noqa: BLE001
            log.warning("macro.fee.claim_failed", epoch=prev, error=str(e))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--loop", action="store_true", help="keep running across epochs")
    parser.add_argument("--register-only", action="store_true", help="register and exit")
    parser.add_argument("--sleep", type=float, default=10.0, help="loop sleep (s)")
    args = parser.parse_args()

    ctx = build_context("MACRO_AGENT_PRIVATE_KEY")
    log.info("macro.agent.started", address=ctx.account.address)

    if args.register_only:
        ep.ensure_registered(ctx, specialty="macro")
        return

    if not args.loop:
        run_once(ctx)
        return

    while True:
        try:
            run_once(ctx)
        except Exception as e:  # noqa: BLE001
            log.error("macro.loop.error", error=str(e))
        log.info("macro.loop.sleep", seconds=args.sleep)
        time.sleep(args.sleep)


if __name__ == "__main__":
    sys.exit(main())
