# Deploying Daio on Robinhood Chain testnet

Scaffold for the parallel deployment after the Jun 2 Robinhood Chain workshop. Fill in the unknowns as the workshop publishes them.

## Workshop info to capture (Jun 2)

| Item | Value |
|---|---|
| Chain ID | `<TODO from workshop>` |
| RPC URL (HTTPS) | `<TODO>` |
| Block explorer URL | `<TODO>` |
| Explorer API URL (for `--verify`) | `<TODO>` |
| Testnet ETH faucet | `<TODO>` |
| Canonical USDC address (if published) | `<TODO>` (otherwise we keep deploying SynthUSDC) |
| Native swap venue / DEX (for v2 Executor) | `<TODO>` |

## After the workshop, edit two files

### 1. `.env` — add the RPC and (when ready) explorer API key

```
ROBINHOOD_TESTNET_RPC_URL=<from workshop>
# ROBINHOOD_EXPLORER_API_KEY=<once verifier is online>
```

### 2. `foundry.toml` — uncomment + fill in the `[etherscan]` Robinhood entry

```toml
[etherscan]
arbitrum_sepolia   = { key = "${ETHERSCAN_API_KEY}", chain = 421614, url = "https://api.etherscan.io/v2/api" }
robinhood_testnet  = { key = "${ROBINHOOD_EXPLORER_API_KEY}", chain = <id>, url = "<api-url>" }
```

(`[rpc_endpoints].robinhood_testnet` is already wired up — it reads `${ROBINHOOD_TESTNET_RPC_URL}` from your `.env`.)

## Deploy commands

```bash
cd daio
set -a; source .env; set +a

# 1. Fund the deployer
#    Use the workshop's faucet, ideally with the same 0xa364... address you used
#    on Sepolia so the two deployments stay symmetric.
cast balance $(cast wallet address --private-key $DEPLOYER_PRIVATE_KEY) \
  --rpc-url $ROBINHOOD_TESTNET_RPC_URL

# 2. Dry run (no broadcast)
forge script script/DeployRobinhood.s.sol --rpc-url robinhood_testnet

# 3. Real deploy
forge script script/DeployRobinhood.s.sol --rpc-url robinhood_testnet --broadcast

# 4. Verify (only once foundry.toml [etherscan].robinhood_testnet is set)
forge script script/DeployRobinhood.s.sol --rpc-url robinhood_testnet --broadcast --verify
```

Save the printed 11 addresses.

## Wire the frontend

Two paths. Pick one.

### Path A: replace the Sepolia deployment as primary (simplest)

Edit `frontend/src/daio.ts`:

```ts
export const DAIO = {
  usdc:      "<robinhood USDC>",
  mUSDY:     "<robinhood mUSDY>",
  // ... etc
} as const;
```

And `frontend/src/wallet.ts`:

```ts
export const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  robinhood: {
    chainId: <id>,
    chainIdHex: "<0x... hex>",
    name: "Robinhood Chain testnet",
    rpc: <Robinhood RPC>,
    nativeSymbol: "ETH",
    usdc: "<Robinhood SynthUSDC>",
    usdcDecimals: 6,
    explorer: "<Robinhood explorer base URL>",
  },
};
export const DEFAULT_CHAIN = SUPPORTED_CHAINS.robinhood;
```

Restart the dev server. The dApp now reads the Robinhood deployment.

### Path B: support both chains, runtime selector

Bigger change. Keep both deployments' addresses in `daio.ts` keyed by `chainId`, add a tiny chain selector dropdown in the top nav that pipes the selected chain id into `useDaioLive`, and update `useWallet` to switch chains via `wallet_switchEthereumChain`.

Worth ~half a day. Big upside if you want the dApp to demo both chains in the same recording.

## Register the agents

```bash
# in .env
MACRO_AGENT_PRIVATE_KEY=...
CREDIT_AGENT_PRIVATE_KEY=...

# fund each from the Robinhood faucet, then:
cd agents
uv run daio-macro  --register-only
uv run daio-credit --register-only
```

The agents are chain-agnostic — they read the addresses from `.env` (which now point at the Robinhood deployment) and sign for whichever RPC the env vars target.

## Verify end-to-end

```bash
# from daio/
./record-demo.sh        # uses .env addresses, so this runs against
                        # whichever deployment .env currently points at
```

Expected output: same as on Sepolia. One full epoch settled, both agents claim, vault TVL ticks correctly.

## Update the README

Change the network line near the top from:

```markdown
- **Network**: Arbitrum Sepolia · chain id `421614`
```

to:

```markdown
- **Networks**: Arbitrum Sepolia (`421614`) and Robinhood Chain testnet (`<id>`). Contracts deployed identically on both; the protocol is chain-agnostic.
```

And add a second contracts-table section with the Robinhood addresses, mirroring the Sepolia table.

## What this gets you for the buildathon

- **Reserved Robinhood Chain prize slot eligibility** (the headline reason)
- A "chain-agnostic by design" claim that's actually backed by parallel deployments, not just talk
- A second set of verifiable contract links for judges to audit
