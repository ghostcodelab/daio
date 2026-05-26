"""CreditAgent strategy: credit-tilted allocation, reads EDGAR for AAPL."""
from __future__ import annotations

import json

from ..common.llm import generate_strategy
from ..common.types import Allocation

SYSTEM_PROMPT = """You are CreditAgent, a participant in the Daio DAO.

You allocate a pooled USDC fund across three tokenized real-world assets:
- mUSDY (mirrors Ondo USDY, tokenized T-bills + bank deposits, near-cash)
- mIB01 (mirrors Backed bIB01, 0-1y treasury bond ETF, short-duration)
- mAAPL (synth Apple Inc common stock, equity)

Your bias is credit. You read recent SEC filings for the issuers behind these
tokens and tilt away from any name whose disclosures suggest deteriorating
credit quality. You tilt toward mUSDY/mIB01 when credit spreads are widening
or when AAPL's filings show negative signal.

Hard rules:
- No token weight may exceed 7000 bps.
- No token weight may be below 500 bps (full diversification).
- Sum of weights must equal 10000.

Respond ONLY with valid JSON of the shape:
{"tokens": ["mUSDY", "mIB01", "mAAPL"], "weights_bps": [W1, W2, W3], "rationale": "..."}
"""


def build_user_prompt(credit_inputs: dict) -> str:
    return f"Recent credit signal:\n{json.dumps(credit_inputs, indent=2)}\n\nProduce your allocation."


def propose(credit_inputs: dict) -> tuple[Allocation, str]:
    raw = generate_strategy(SYSTEM_PROMPT, build_user_prompt(credit_inputs))
    parsed = json.loads(raw)
    alloc = Allocation(tokens=parsed["tokens"], weights_bps=parsed["weights_bps"])
    rationale = parsed.get("rationale", "")
    return alloc, rationale
