#!/usr/bin/env bash
# Drives one full epoch with a visible $50k fake-gain inject between snapshot
# and measureClose, so the recording captures real fee distribution to both
# agents. Assumes the short-window deploy (script/DeployShort.s.sol) is live
# and .env points at those addresses.
#
# Pre-reqs (run once after redeploying):
#   1. Update .env *_ADDRESS lines with the new DeployShort output
#   2. Update frontend/src/daio.ts DAIO addresses
#   3. cd agents && uv run daio-macro --register-only && uv run daio-credit --register-only
#   4. mint + approve + deposit at least 1M USDC into the new vault
#      (the script will skip the deposit step if TVL is already > 0)
#
# Usage:  ./record-demo.sh
set -euo pipefail

cd "$(dirname "$0")"
set -a; source .env; set +a

RPC="$ARBITRUM_SEPOLIA_RPC_URL"
DEPLOYER_KEY="$DEPLOYER_PRIVATE_KEY"
GAIN_AMOUNT=50000000000   # 50,000 USDC at 6 decimals

if [[ -z "${USDC_ADDRESS:-}" || -z "${DAIO_VAULT_ADDRESS:-}" || -z "${PROPOSAL_ROUND_ADDRESS:-}" ]]; then
  echo "Missing addresses in .env. Run DeployShort first." >&2
  exit 1
fi

say() { printf "\n\033[1;33m> %s\033[0m\n" "$*"; }
info() { printf "\033[2m  %s\033[0m\n" "$*"; }

# --- 1. Ensure vault has TVL (deposit 1M USDC if empty) ---
TVL_RAW=$(cast call "$DAIO_VAULT_ADDRESS" "totalAssets()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
if [[ "$TVL_RAW" == "0" ]]; then
  say "Seeding vault with 1,000,000 USDC"
  DEPOSIT_AMOUNT=1000000000000
  cast send "$USDC_ADDRESS" "mint(address,uint256)" \
    $(cast wallet address --private-key "$DEPLOYER_KEY") $DEPOSIT_AMOUNT \
    --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null
  cast send "$USDC_ADDRESS" "approve(address,uint256)" \
    "$DAIO_VAULT_ADDRESS" $DEPOSIT_AMOUNT \
    --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null
  cast send "$DAIO_VAULT_ADDRESS" "deposit(uint256,address)" \
    $DEPOSIT_AMOUNT $(cast wallet address --private-key "$DEPLOYER_KEY") \
    --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null
  info "deposited"
else
  info "vault already has ${TVL_RAW%[^0-9]*} raw USDC, skipping deposit"
fi

# --- 2. Start epoch + snapshot via orchestrator ---
say "startEpoch + snapshotOpen"
(cd agents && uv run daio-orchestrator start-epoch) 2>&1 | grep -E "(epoch_started|snapshot_open|tx.mined)" || true

EPOCH=$(cast call "$PROPOSAL_ROUND_ADDRESS" "currentEpoch()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
info "now on epoch $EPOCH"

# --- 3. Launch the two agents in parallel (they exit after reveal) ---
say "Launching MacroAgent and CreditAgent"
mkdir -p /tmp/daio-demo
(cd agents && uv run daio-macro)  > /tmp/daio-demo/macro.log  2>&1 &
MACRO_PID=$!
(cd agents && uv run daio-credit) > /tmp/daio-demo/credit.log 2>&1 &
CREDIT_PID=$!
info "macro pid=$MACRO_PID  credit pid=$CREDIT_PID"
info "log streams:"
info "  tail -F /tmp/daio-demo/macro.log"
info "  tail -F /tmp/daio-demo/credit.log"

# --- 4. Wait through the commit window, then inject the gain just before measureClose ---
# Short-window deploy: 60s commit + 60s reveal = 120s total.
# Inject the gain at ~T+100s so it lands before measureClose at T+125s.
say "Sleeping 100s while agents commit + reveal"
for i in $(seq 100 -10 10); do
  printf "  T-%ds  " "$i"
  date +%H:%M:%S
  sleep 10
done

say "Injecting \$50,000 USDC into vault (simulated epoch gain)"
cast send "$USDC_ADDRESS" "mint(address,uint256)" \
  "$DAIO_VAULT_ADDRESS" $GAIN_AMOUNT \
  --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" 2>&1 | grep -E "(status|transactionHash)" | head -2
info "new TVL should be 1,050,000 USDC; epoch gain = 50,000"

# --- 5. Wait for reveal window to close, then settle ---
say "Sleeping 30s for reveal window to close"
sleep 30

say "Settling epoch $EPOCH (resolve + execute + measureClose)"
(cd agents && uv run daio-orchestrator settle "$EPOCH") 2>&1 | grep -E "(resolve|execute|measure_close|epoch.settled|tx.mined)" || true

# --- 6. Both agents claim their fee share ---
say "Agents claim performance fees"
PENDING_MACRO=$(cast call "$PERFORMANCE_FEE_ADDRESS" "pendingFor(uint256,address)(uint256)" \
  "$EPOCH" "$(cast wallet address --private-key "$MACRO_AGENT_PRIVATE_KEY")" --rpc-url "$RPC" | awk '{print $1}')
PENDING_CREDIT=$(cast call "$PERFORMANCE_FEE_ADDRESS" "pendingFor(uint256,address)(uint256)" \
  "$EPOCH" "$(cast wallet address --private-key "$CREDIT_AGENT_PRIVATE_KEY")" --rpc-url "$RPC" | awk '{print $1}')
info "pending - macro: $PENDING_MACRO  credit: $PENDING_CREDIT  (raw USDC, 6 decimals)"

if [[ "$PENDING_MACRO" != "0" ]]; then
  cast send "$PERFORMANCE_FEE_ADDRESS" "claim(uint256)" "$EPOCH" \
    --rpc-url "$RPC" --private-key "$MACRO_AGENT_PRIVATE_KEY" 2>&1 | grep -E "(status|transactionHash)" | head -2
fi
if [[ "$PENDING_CREDIT" != "0" ]]; then
  cast send "$PERFORMANCE_FEE_ADDRESS" "claim(uint256)" "$EPOCH" \
    --rpc-url "$RPC" --private-key "$CREDIT_AGENT_PRIVATE_KEY" 2>&1 | grep -E "(status|transactionHash)" | head -2
fi

# --- 7. Final summary ---
say "Final state"
TVL=$(cast call "$DAIO_VAULT_ADDRESS" "totalAssets()(uint256)" --rpc-url "$RPC")
M_BAL=$(cast call "$USDC_ADDRESS" "balanceOf(address)(uint256)" "$(cast wallet address --private-key "$MACRO_AGENT_PRIVATE_KEY")" --rpc-url "$RPC")
C_BAL=$(cast call "$USDC_ADDRESS" "balanceOf(address)(uint256)" "$(cast wallet address --private-key "$CREDIT_AGENT_PRIVATE_KEY")" --rpc-url "$RPC")
info "vault TVL:        $TVL"
info "MacroAgent USDC:  $M_BAL"
info "CreditAgent USDC: $C_BAL"

wait "$MACRO_PID" 2>/dev/null || true
wait "$CREDIT_PID" 2>/dev/null || true

echo
say "Done. Frontend should show new TVL, new basket (epoch $EPOCH), both agents with non-zero USDC."
