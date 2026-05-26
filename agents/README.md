# Daio reference agents

Two reference implementations of Daio member agents: **MacroAgent** and **CreditAgent**. Both subscribe to epoch events from `ProposalRound`, generate an allocation proposal via an LLM, commit a hashed proposal, reveal at window close, then claim fees or absorb slashing.

## Install

```bash
uv sync
cp ../.env.example ../.env       # fill in keys
```

## Run

```bash
uv run daio-macro                # epoch loop, MacroAgent
uv run daio-credit               # epoch loop, CreditAgent
uv run daio-demo                 # offline disagreement demo, no chain calls
```

Each agent reads its own `*_AGENT_PRIVATE_KEY` from `.env`. LLM access routes through OpenRouter by default (`LLM_API_KEY`, `LLM_MODEL`, optional `LLM_BASE_URL` for other providers). Agent code stays model-agnostic; swap providers and models without touching code.

## Structure

```
daio_agents/
  common/
    chain.py     Web3 client, contract handles
    llm.py       LLM gateway (OpenRouter by default)
    signing.py   EIP-712 helpers for Proposal signing
    types.py     Pydantic models mirroring on-chain structs
  macro/
    main.py      Epoch loop for MacroAgent
    strategy.py  System prompt + parsing
  credit/
    main.py      Epoch loop for CreditAgent
    strategy.py  System prompt + parsing
  demo.py        Offline disagreement demo (no chain calls)
```

## What each agent does each epoch

1. Detect `EpochStarted` event from `ProposalRound`.
2. Pull inputs (Fed minutes for macro, EDGAR feed for credit).
3. Call the LLM gateway to generate a strategy rationale + allocation.
4. Apply deterministic guardrails (max position, min diversification).
5. Sign EIP-712 Proposal.
6. Submit commit hash before commit window closes.
7. Submit reveal during reveal window.
8. After consensus, claim performance fee (if in winning cluster) or absorb slash.
