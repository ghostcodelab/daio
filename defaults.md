# Daio: locked defaults

## 1. Specialty taxonomy for MVP

**Two reference agents: MacroAgent and CreditAgent.**

- **MacroAgent**: inputs are Fed minutes, CPI prints, yield-curve snapshots. Output: tilt between cash, T-bill, and risk assets.
- **CreditAgent**: inputs are EDGAR filings (8-K, 10-Q) for issuers behind the credit-side tokens. Output: tilt between IG corp paper and away.

Why two and not three: a 1-hour epoch demo needs to show legitimate disagreement and consensus resolution. Two agents with strong, distinct priors maximize the chance the demo shows a real conflict, not just three agents converging trivially. Third specialty (Sentiment, Regulatory, or Liquidity) is documented as v2.

## 2. Mock RWA target list

Three mock tokens deployed by us, each mirroring a real public RWA product so the demo is concrete and the narrative is defensible.

| Token | Mirrors | Public underlying | Why included |
|---|---|---|---|
| `mUSDY` | Ondo USDY | tokenized US T-bills + bank deposits | Macro side, cash-equivalent baseline |
| `mIB01` | Backed bIB01 | iShares 0-1y treasury bond ETF | Macro side, slight duration |
| `mAAPL` | Apple Inc common stock | NASDAQ:AAPL | Equity / credit side, well-known, dividend-paying |

All three are demo ERC-20s in `src/synth/SynthRWA.sol`. README clearly labels them as demonstration-only mirrors with no affiliation to the underlying issuers.

Why these three: cover the natural risk-asset spectrum (cash to short duration to equity) in three tokens, so both agents have non-trivial allocation decisions to make. AAPL also enables a future dividend-distribution demo if scope allows.

## 3. Reputation read strategy

**Stub ACHIVX and Andromeda reads in MVP. Document the integration. Do not block the build on real composition.**

`AgentRegistry.sol` exposes a `reputationOf(address agent) returns (uint256)` view. MVP implementation: returns local reputation score (computed from past consensus participation in this protocol). Production implementation: composes ACHIVX / Andromeda / ClawLens reads behind the same interface.

Why stub: real composition needs published ABIs and live testnet deployments of those reputation primitives. ERC-8004 itself is the higher-priority integration this week. Reputation composition is a clean v2 swap behind the existing interface.

## Other defaults set without separate question

- **Solidity 0.8.24**, OpenZeppelin v5 contracts.
- **Foundry** (not Hardhat) for the contract toolchain. Faster, audit-skill-plugin friendly, fewer moving parts.
- **Python 3.12** for agents. `uv` for env management. `openai` (via OpenRouter, provider-neutral), `web3`, `eth-account`, `pydantic` core deps.
- **Vite + React + TypeScript + ethers v6** for the frontend. No SSR overhead.
- **Arbitrum Sepolia** deployed (all 11 contracts verified). Robinhood Chain testnet deployment pending the Jun 2 workshop.
- **USDC** as the only LP deposit currency in MVP (no ETH path).
- **Epoch length**: 1 hour for demo, configurable. Production envelope is weekly.
- **Snapshot mechanism**: block-number snapshot at proposal-window close. MEV considerations documented as future work.
- **Admin**: MVP uses the deployer EOA as owner of every `Ownable` contract. Production target is a 2-of-3 multisig; rotate ownership via `transferOwnership` before public launch.
