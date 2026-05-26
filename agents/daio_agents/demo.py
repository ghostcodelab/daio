"""Disagreement demo: run MacroAgent and CreditAgent in parallel against a
fake epoch, print both allocations side by side, and report whether they
would land in the same consensus cluster.

Requires LLM_API_KEY and LLM_MODEL in the .env at the repo root.
Routes through OpenRouter by default; override LLM_BASE_URL for other providers.

    uv run daio-demo
    uv run daio-demo --scenario agreement
    uv run daio-demo --scenario disagreement
"""
from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from .common.chain import load_env
from .common.types import Allocation
from .credit import strategy as credit_strategy
from .macro import strategy as macro_strategy

SCENARIOS = {
    "disagreement": {
        "label": "Dovish Fed pivot + surprise AAPL SEC inquiry",
        "macro": {
            "latest_fomc": "Powell signals rate cuts likely by Q3. Real yields fall 25bp on the week.",
            "latest_cpi": "Core CPI prints 0.2% MoM, below 0.3% consensus.",
            "yield_curve_2y10y": "+5bp (un-inverted last week)",
            "risk_appetite": "improving; VIX at 12",
        },
        "credit": {
            "issuer": "Apple Inc (mAAPL underlying)",
            "latest_filings": [
                {
                    "form": "8-K",
                    "date": "2026-05-22",
                    "summary": (
                        "Apple discloses SEC inquiry into revenue recognition "
                        "practices in Services segment. Company says it is "
                        "cooperating; no charges filed."
                    ),
                },
                {
                    "form": "10-Q",
                    "date": "2026-05-02",
                    "summary": "Services revenue grew 14% YoY but gross margin compressed 80bp.",
                },
            ],
            "credit_spreads": "AAPL 5y CDS widened 18bp on the 8-K filing",
        },
    },
    "agreement": {
        "label": "Hawkish Fed + AAPL profit warning",
        "macro": {
            "latest_fomc": "Powell rules out 2026 cuts. Dot plot now shows one hike risk.",
            "latest_cpi": "Core CPI prints 0.5% MoM, hot vs 0.3% consensus.",
            "yield_curve_2y10y": "-45bp (deeply inverted)",
            "risk_appetite": "risk-off; VIX at 24",
        },
        "credit": {
            "issuer": "Apple Inc (mAAPL underlying)",
            "latest_filings": [
                {
                    "form": "8-K",
                    "date": "2026-05-23",
                    "summary": (
                        "Apple pre-announces revenue miss for the quarter, citing "
                        "China demand weakness. Cuts FY guidance by 6%."
                    ),
                },
            ],
            "credit_spreads": "AAPL 5y CDS widened 12bp on the pre-announcement",
        },
    },
}


def _run_macro(inputs: dict) -> tuple[Allocation, str, float]:
    t0 = time.perf_counter()
    alloc, rationale = macro_strategy.propose(inputs)
    return alloc, rationale, time.perf_counter() - t0


def _run_credit(inputs: dict) -> tuple[Allocation, str, float]:
    t0 = time.perf_counter()
    alloc, rationale = credit_strategy.propose(inputs)
    return alloc, rationale, time.perf_counter() - t0


def _align(a: Allocation, b: Allocation) -> dict[str, tuple[int, int]]:
    """Pair weights by token symbol; tokens missing on either side count as 0."""
    keys = sorted(set(a.tokens) | set(b.tokens))
    a_map = dict(zip(a.tokens, a.weights_bps))
    b_map = dict(zip(b.tokens, b.weights_bps))
    return {k: (a_map.get(k, 0), b_map.get(k, 0)) for k in keys}


def _l1_divergence(a: Allocation, b: Allocation) -> int:
    aligned = _align(a, b)
    return sum(abs(av - bv) for av, bv in aligned.values())


def _bar(weight_bps: int, scale: int = 7000) -> str:
    width = 20
    filled = int(round(width * min(weight_bps, scale) / scale))
    return "#" * filled + "." * (width - filled)


def _print_block(name: str, alloc: Allocation, rationale: str, elapsed: float) -> None:
    print(f"\n{name}  (took {elapsed:.1f}s)")
    print("-" * 60)
    for tok, w in zip(alloc.tokens, alloc.weights_bps):
        pct = w / 100
        print(f"  {tok:6s}  {_bar(w)}  {pct:6.2f}%")
    print(f"\n  rationale: {rationale.strip()[:240]}")


def run(scenario_name: str) -> int:
    if scenario_name not in SCENARIOS:
        print(f"unknown scenario: {scenario_name!r}; pick one of: {list(SCENARIOS)}")
        return 2

    load_env()
    scenario = SCENARIOS[scenario_name]
    print(f"\nSCENARIO: {scenario['label']}")
    print("=" * 60)

    with ThreadPoolExecutor(max_workers=2) as pool:
        macro_future = pool.submit(_run_macro, scenario["macro"])
        credit_future = pool.submit(_run_credit, scenario["credit"])
        macro_alloc, macro_rationale, macro_t = macro_future.result()
        credit_alloc, credit_rationale, credit_t = credit_future.result()

    _print_block("MacroAgent", macro_alloc, macro_rationale, macro_t)
    _print_block("CreditAgent", credit_alloc, credit_rationale, credit_t)

    divergence = _l1_divergence(macro_alloc, credit_alloc)
    print("\nDIVERGENCE")
    print("-" * 60)
    aligned = _align(macro_alloc, credit_alloc)
    for tok, (m, c) in aligned.items():
        delta = c - m
        sign = "+" if delta > 0 else ""
        print(f"  {tok:6s}  macro {m/100:6.2f}%   credit {c/100:6.2f}%   delta {sign}{delta/100:6.2f}%")
    print(f"\n  L1 divergence: {divergence} bps")

    # Consensus tolerance in defaults is 500 bps (from foundry deploy script).
    tolerance = 500
    verdict = (
        "SAME CLUSTER (agents would converge)"
        if divergence <= tolerance
        else "SEPARATE CLUSTERS (consensus would have to resolve a real disagreement)"
    )
    print(f"  cluster tolerance: {tolerance} bps")
    print(f"  verdict: {verdict}\n")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario",
        default="disagreement",
        choices=list(SCENARIOS),
        help="which synth epoch to feed the agents",
    )
    args = parser.parse_args()
    sys.exit(run(args.scenario))


if __name__ == "__main__":
    main()
