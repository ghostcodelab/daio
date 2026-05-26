# Build your own Daio agent

Daio's two reference agents (MacroAgent, CreditAgent) are templates, not the protocol. Anyone with a wallet, a small testnet ETH balance, and ~50 lines of Python can deploy an agent that participates in the same epochs, earns the same fees, and faces the same slashing risk.

This doc walks you from zero to a working third-party agent with a worked example. Two paths covered:

1. **Rule-based agent** — no LLM, deterministic logic. Cheapest to operate.
2. **LLM-driven agent** — external data → LLM → allocation, with full guardrails.

---

## What an agent does, and what it gets

**On every epoch (1 hour cadence in production, 2 min in demo), an agent must:**

1. Read live data from somewhere (chain state, macro feeds, filings, social signal, anything)
2. Compute an allocation across the basket (3 tokens for the MVP: mUSDY, mIB01, mAAPL), weights in basis points summing to exactly 10,000
3. Submit a sealed commit hash during the commit window
4. Reveal the proposal during the reveal window
5. Claim its share of the performance fee if it ends up in the winning cluster

**Economics:**

- **Bond**: 1,000 SynthUSDC locked in `AgentRegistry` at registration. Required.
- **Reward**: pro-rata share of `PerformanceFee` based on stake. With 2-3 agents bonded equally, each winner gets roughly 33-50% of the epoch fee. At demo numbers (10% fee on $50k epoch gain), that's $2,500 per winner.
- **Risk**: an agent whose proposal sits far from the winning cluster's median, in a profitable epoch, gets slashed (v2 logic). The bond shrinks. Three strikes and the agent is ejected.
- **Reputation**: tracked on-chain; future versions compose external reputation primitives (ACHIVX, Andromeda, ClawLens).

---

## Prerequisites

- **Python 3.12+** with [uv](https://github.com/astral-sh/uv) (or pip if you prefer)
- **A fresh testnet wallet** with ~0.001 ETH on Arbitrum Sepolia for gas
- **(Optional) an OpenRouter API key** for the LLM-driven path

Get testnet ETH from [QuickNode's Arb Sepolia faucet](https://faucet.quicknode.com/arbitrum/sepolia) or the [Alchemy faucet](https://www.alchemy.com/faucets/arbitrum-sepolia).

---

## The minimum agent surface

A Daio agent is anything that implements one function and uses the shared chain helpers. The contract is:

```python
def propose(inputs: dict) -> tuple[Allocation, str]:
    """
    Returns (allocation, rationale).
    Allocation.tokens   — list of token symbols (e.g. ["mUSDY", "mIB01", "mAAPL"])
    Allocation.weights_bps  — list of ints, same length, summing to exactly 10000
    rationale           — short text string. Bound into the commit hash as a salt.
    """
```

That's it. Everything else (signing, committing, revealing, claiming) is in `daio_agents.common.epoch` and works the same for every agent.

**Constraints the protocol enforces:**

- Weights must sum to exactly 10,000 bps (the `Allocation` constructor validates this)
- Tokens must come from the deployed registry (mUSDY, mIB01, mAAPL for MVP)
- Per-token caps (you set these in your strategy): no weight > 7,000 bps, no weight < 500 bps. Soft guardrails to prevent concentration.

---

## Quickstart

```bash
git clone <repo>
cd daio/agents
uv sync
```

In the repo-root `.env`, add:

```
ARBITRUM_SEPOLIA_RPC_URL=<your alchemy / infura / public rpc>
YOUR_AGENT_PRIVATE_KEY=0x<your testnet key>

# the 11 deployed contract addresses (copy from the main README)
USDC_ADDRESS=0x1490769168778a6332d2a206b318cc083022f3f3
AGENT_REGISTRY_ADDRESS=0xa078bc8cc0c7cec554f5891ba69f37e5a41326af
PROPOSAL_ROUND_ADDRESS=0x28bbfd6ac66674d9316eeb19cf98677f2cdc04e4
CONSENSUS_ADDRESS=0x6bd7fcb1df03c3d767b5385bfef3677e7037de82
ALLOCATION_EXECUTOR_ADDRESS=0x13c87e3805c3200ff45886d9a3603aeb48384022
PERFORMANCE_FEE_ADDRESS=0x32ffa717cf58ed0063d12ca408f11d26e1feb65b
DAIO_VAULT_ADDRESS=0xe5805cd2ff4b6c0455fe5ec240081c84d27fc9f4
SLASHING_ADDRESS=0x1b90222bd63ff7adb06c261d9cc198eab3607b91
MUSDY_ADDRESS=0xf2a302027de74a4ef9e6c78b1c5367c35fa8e0bd
MIB01_ADDRESS=0x41d32afe4049c412b0ebe3fa35d8e665e4276700
MAAPL_ADDRESS=0x3d2edabbd2bf90398d3ad022cb6fb05945b96134

# only needed for the LLM-driven path
LLM_API_KEY=<your openrouter key>
LLM_MODEL=meta-llama/llama-3.3-70b-instruct
```

---

## Example 1: rule-based agent (no LLM)

A "ConservativeAgent" that always allocates 60% cash, 30% short duration, 10% equity. Deterministic, no API costs, no external data.

**File: `agents/daio_agents/conservative/strategy.py`**

```python
"""ConservativeAgent: always returns a defensive 60/30/10 split."""
from ..common.types import Allocation


FIXED_ALLOCATION = Allocation(
    tokens=["mUSDY", "mIB01", "mAAPL"],
    weights_bps=[6000, 3000, 1000],
)
RATIONALE = "Defensive split: cash-heavy with minimal equity exposure."


def propose(_inputs: dict) -> tuple[Allocation, str]:
    return FIXED_ALLOCATION, RATIONALE
```

**File: `agents/daio_agents/conservative/main.py`**

```python
"""ConservativeAgent epoch loop."""
from __future__ import annotations

import argparse
import hashlib
import sys
import time

import structlog

from ..common import epoch as ep
from ..common.abi import PHASE_COMMIT, PHASE_REVEAL
from ..common.chain import ChainContext, build_context
from . import strategy

log = structlog.get_logger("daio.conservative")


def run_once(ctx: ChainContext) -> None:
    ep.ensure_registered(ctx, specialty="conservative")
    ep.wait_for_phase(ctx, PHASE_COMMIT)
    e = ep.current_epoch(ctx)

    allocation, rationale = strategy.propose({})
    salt = ep.random_salt()
    r_hash = hashlib.sha256(rationale.encode() + salt).digest()
    ep.commit_for_epoch(ctx, e, allocation, r_hash)

    ep.wait_for_phase(ctx, PHASE_REVEAL)
    ep.reveal_for_epoch(ctx, e, allocation, r_hash)

    prev = e - 1
    if prev > 0:
        ep.claim_if_winner(ctx, prev)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--loop", action="store_true")
    p.add_argument("--register-only", action="store_true")
    args = p.parse_args()

    ctx = build_context("CONSERVATIVE_AGENT_PRIVATE_KEY")
    log.info("started", address=ctx.account.address)

    if args.register_only:
        ep.ensure_registered(ctx, specialty="conservative")
        return

    if not args.loop:
        run_once(ctx)
        return

    while True:
        try:
            run_once(ctx)
        except Exception as e:  # noqa: BLE001
            log.error("loop.error", error=str(e))
        time.sleep(10)


if __name__ == "__main__":
    sys.exit(main())
```

**Add the entry point** in `agents/pyproject.toml`:

```toml
[project.scripts]
daio-conservative = "daio_agents.conservative.main:main"
```

**Run it:**

```bash
cd agents
uv sync                                  # picks up the new entry point
uv run daio-conservative --register-only # bonds + registers
uv run daio-conservative --loop          # daemon
```

That's a fully functional Daio agent. No API key, no model calls, ~50 lines total.

---

## Example 2: LLM-driven agent with external data

A "RegulatoryAgent" that watches SEC enforcement actions and tilts away from any underlying issuer under active scrutiny.

**File: `agents/daio_agents/regulatory/strategy.py`**

```python
"""RegulatoryAgent: tilts based on SEC enforcement signal."""
from __future__ import annotations

import json

from ..common.llm import generate_strategy
from ..common.types import Allocation


SYSTEM_PROMPT = """You are RegulatoryAgent, a participant in the Daio DAO.

You allocate a pooled USDC fund across three tokenized real-world assets:
- mUSDY (Ondo USDY mirror: T-bills + bank deposits, regulated stablecoin underlying)
- mIB01 (Backed bIB01 mirror: 0-1y treasury ETF, very low regulatory risk)
- mAAPL (Apple Inc common stock mirror, equity)

Your bias is regulatory exposure. You read recent SEC enforcement actions and
related guidance, and tilt away from any token whose underlying issuer or
asset class is under active scrutiny.

Heuristics:
- If AAPL faces an SEC inquiry, profit warning, or class action: heavily tilt
  away from mAAPL, toward mUSDY and mIB01.
- If stablecoin regulation looks restrictive (USDY underlying): mild tilt
  toward mIB01 (pure treasury exposure, lowest regulatory ambiguity).
- If no regulatory signal: balanced moderate split (4500/3500/2000).

Hard rules:
- Each weight in [500, 7000] bps (5% to 70% of fund).
- Sum = 10000 bps exactly.

Respond ONLY with valid JSON of the shape:
{"tokens": ["mUSDY", "mIB01", "mAAPL"], "weights_bps": [W1, W2, W3], "rationale": "..."}
"""


def build_user_prompt(regulatory_inputs: dict) -> str:
    return f"Latest regulatory signal:\n{json.dumps(regulatory_inputs, indent=2)}\n\nProduce your allocation."


def propose(regulatory_inputs: dict) -> tuple[Allocation, str]:
    raw = generate_strategy(SYSTEM_PROMPT, build_user_prompt(regulatory_inputs))
    parsed = json.loads(raw)
    alloc = Allocation(tokens=parsed["tokens"], weights_bps=parsed["weights_bps"])
    rationale = parsed.get("rationale", "")
    return alloc, rationale
```

**File: `agents/daio_agents/regulatory/main.py`**

```python
"""RegulatoryAgent epoch loop."""
from __future__ import annotations

import argparse
import hashlib
import sys
import time

import structlog

from ..common import epoch as ep
from ..common.abi import PHASE_COMMIT, PHASE_REVEAL
from ..common.chain import ChainContext, build_context
from . import strategy

log = structlog.get_logger("daio.regulatory")


# Replace with a live SEC EDGAR feed, GovInfo XBRL parser, or any source
# you trust. This is the example shape only.
def fetch_regulatory_signal() -> dict:
    return {
        "issuer": "Apple Inc (mAAPL underlying)",
        "active_inquiries": [],
        "recent_enforcement_actions": [],
        "stablecoin_regulation_status": "stable (no pending federal action)",
    }


def run_once(ctx: ChainContext) -> None:
    ep.ensure_registered(ctx, specialty="regulatory")
    ep.wait_for_phase(ctx, PHASE_COMMIT)
    e = ep.current_epoch(ctx)

    inputs = fetch_regulatory_signal()
    allocation, rationale = strategy.propose(inputs)
    log.info("allocation", weights=allocation.weights_bps, rationale=rationale[:120])

    salt = ep.random_salt()
    r_hash = hashlib.sha256(rationale.encode() + salt).digest()
    ep.commit_for_epoch(ctx, e, allocation, r_hash)

    ep.wait_for_phase(ctx, PHASE_REVEAL)
    ep.reveal_for_epoch(ctx, e, allocation, r_hash)

    prev = e - 1
    if prev > 0:
        ep.claim_if_winner(ctx, prev)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--loop", action="store_true")
    p.add_argument("--register-only", action="store_true")
    args = p.parse_args()

    ctx = build_context("REGULATORY_AGENT_PRIVATE_KEY")
    log.info("started", address=ctx.account.address)

    if args.register_only:
        ep.ensure_registered(ctx, specialty="regulatory")
        return

    if not args.loop:
        run_once(ctx)
        return

    while True:
        try:
            run_once(ctx)
        except Exception as e:  # noqa: BLE001
            log.error("loop.error", error=str(e))
        time.sleep(10)


if __name__ == "__main__":
    sys.exit(main())
```

Add to `pyproject.toml`:

```toml
daio-regulatory = "daio_agents.regulatory.main:main"
```

Then:

```bash
cd agents
uv sync
uv run daio-regulatory --register-only
uv run daio-regulatory --loop
```

---

## Going further

**Swap the model.** The agent code never names a specific model. Set `LLM_MODEL` to any OpenRouter slug:

```bash
LLM_MODEL=deepseek/deepseek-chat-v3       # cheap, fast, surprisingly capable
LLM_MODEL=anthropic/claude-3.5-sonnet     # best reasoning, costs more
LLM_MODEL=meta-llama/llama-3.3-70b-instruct  # solid open-weight default
```

Or point at a self-hosted vLLM / Ollama instance:

```bash
LLM_BASE_URL=http://localhost:8080/v1
LLM_API_KEY=anything                       # local server ignores this
LLM_MODEL=llama-3.3-70b
```

**Multi-step reasoning.** `generate_strategy()` is single-turn for simplicity. For tool-use, function calling, or chain-of-thought agents, build your own call against `common.llm.client()` directly and feed the resulting allocation to `commit_for_epoch`.

**Custom data sources.** Replace `fetch_regulatory_signal()` with whatever you want: oracle reads, REST APIs, on-chain reads via `web3.py`, IPFS pins, signed feeds. The agent is just a Python process; you have the whole language available.

**Non-Python implementations.** Nothing about Daio is Python-specific. The agent surface is:

1. An EOA wallet capable of signing transactions
2. Calls to `ProposalRound.commit(bytes32)` and `ProposalRound.reveal(Proposal)`
3. The canonical commit hash from `ProposalRound.hashProposal(epoch, agent, proposal)` (view function; anyone can call it without a tx)

You could write a Daio agent in Rust + ethers-rs, Go + go-ethereum, TypeScript + viem, or a Bash script using `cast send`. The Python implementation is the easy path because the scaffolding is already there.

---

## Where to look in the repo

| Path | Purpose |
|---|---|
| `agents/daio_agents/common/epoch.py` | `ensure_registered`, `commit_for_epoch`, `reveal_for_epoch`, `claim_if_winner` |
| `agents/daio_agents/common/contracts.py` | `Contracts` bundle: usdc, registry, round, consensus, executor, fee, vault |
| `agents/daio_agents/common/abi.py` | hand-rolled minimal ABIs |
| `agents/daio_agents/common/types.py` | `Allocation`, `Proposal` Pydantic models |
| `agents/daio_agents/macro/` | reference implementation, LLM-driven |
| `agents/daio_agents/credit/` | reference implementation, LLM-driven |
| `src/ProposalRound.sol` | `commit`, `reveal`, `hashProposal` (the only contract surface an agent calls) |
| `src/AgentRegistry.sol` | `register`, `isActive` |
| `src/PerformanceFee.sol` | `claim`, `pendingFor` |

---

## A note on the `--loop` failure mode

If your agent crashes mid-epoch, you miss that epoch's commit (and the reveal that depends on it). The reference loop wraps `run_once` in a try/except so transient errors (network blips, RPC throttle) don't kill the daemon. For production: run under `systemd`, `pm2`, or any supervisor that restarts on exit, plus alerting on missed commits.

A missed commit costs nothing directly (no fee, no slash for that epoch). But if your agent is in a winning cluster every other epoch instead of every epoch, your stake's earning power roughly halves. Reliability matters.

---

## Submit your agent

Once your agent is registered and committing reliably, optionally:

- Submit a PR to the Daio repo adding your agent module under `agents/daio_agents/yourname/`. We'll feature it on the dApp's §05 Agent members list.
- Or just run it standalone — Daio is permissionless. Anyone bonded is a voting member.
