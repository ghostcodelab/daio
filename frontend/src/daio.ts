/* Read-only on-chain reads against the live Arbitrum Sepolia deployment.
 *
 * Polls every 15s via a public RPC — no wallet required. The hook returns
 * `null` while loading (or if RPC is unreachable) so callers can keep
 * showing fallback content instead of going blank. */
import { useEffect, useState } from "react";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { DEFAULT_CHAIN } from "./wallet";

/* ------- deployed addresses (Arbitrum Sepolia) ------- */

export const DAIO = {
  usdc:      "0x1490769168778a6332d2a206b318cc083022f3f3",
  mUSDY:     "0xf2a302027de74a4ef9e6c78b1c5367c35fa8e0bd",
  mIB01:     "0x41d32afe4049c412b0ebe3fa35d8e665e4276700",
  mAAPL:     "0x3d2edabbd2bf90398d3ad022cb6fb05945b96134",
  registry:  "0xa078bc8cc0c7cec554f5891ba69f37e5a41326af",
  vault:     "0xe5805cd2ff4b6c0455fe5ec240081c84d27fc9f4",
  round:     "0x28bbfd6ac66674d9316eeb19cf98677f2cdc04e4",
  consensus: "0x6bd7fcb1df03c3d767b5385bfef3677e7037de82",
  executor:  "0x13c87e3805c3200ff45886d9a3603aeb48384022",
  fee:       "0x32ffa717cf58ed0063d12ca408f11d26e1feb65b",
  slashing:  "0x1b90222bd63ff7adb06c261d9cc198eab3607b91",
} as const;

export const KNOWN_AGENTS: { name: string; addr: string; specialty: string }[] = [
  { name: "MacroAgent",  addr: "0x2e09Ff1AEa117379dbDd8BF7Ac3DAB49CE377bbF", specialty: "macro"     },
  { name: "CreditAgent", addr: "0xd3bff89E700583e8dB995837f96475E18Ed1faE8", specialty: "credit"    },
];

/* token address -> symbol (lower-cased keys for safe lookup) */
const TOKEN_SYMBOL: Record<string, string> = {
  [DAIO.mUSDY.toLowerCase()]: "mUSDY",
  [DAIO.mIB01.toLowerCase()]: "mIB01",
  [DAIO.mAAPL.toLowerCase()]: "mAAPL",
};

export function symbolOf(token: string): string {
  return TOKEN_SYMBOL[token.toLowerCase()] ?? token.slice(0, 6) + "…";
}

/* ------- minimal ABIs ------- */

const VAULT_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];
const REGISTRY_ABI = [
  "function agents(address) view returns (bytes32 specialty, uint256 bond, uint256 reputation, uint256 strikes, bool active)",
];
const ROUND_ABI = [
  "function currentEpoch() view returns (uint256)",
  "function currentPhase() view returns (uint8)",
  "function epochs(uint256) view returns (uint64 commitOpen, uint64 commitClose, uint64 revealClose, uint8 phase)",
];
const EXECUTOR_ABI = [
  "function currentBasketEpoch() view returns (uint256)",
  "function currentBasket() view returns (tuple(address[] tokens, uint16[] weightsBps))",
];
const FEE_ABI = [
  "function metrics(uint256) view returns (uint256 navOpen, uint256 navClose, uint256 totalFee, uint256 winningStake, bool opened, bool measured)",
];

/* ------- public types ------- */

export type Phase = "Idle" | "Commit" | "Reveal" | "Closed";
const PHASE_NAMES: Phase[] = ["Idle", "Commit", "Reveal", "Closed"];

export type AgentLive = {
  name: string;
  specialty: string;
  addr: string;
  bond: number;          // USDC (decimal)
  reputation: number;
  strikes: number;
  active: boolean;
};

export type BasketLive = {
  epoch: number;
  weights: { token: string; symbol: string; weightBps: number }[];
};

export type NavPoint = { epoch: number; nav: number };

export type DaioLive = {
  /* vault */
  tvl: number;                  // USDC
  navPerShare: number;          // 1.0 if no shares minted
  totalSupplyShares: number;
  /* agents */
  agents: AgentLive[];
  totalBonded: number;          // USDC
  /* epoch */
  currentEpoch: number;
  phase: Phase;
  commitOpen: number;           // unix seconds
  commitClose: number;
  revealClose: number;
  /* allocation */
  basket: BasketLive | null;
  /* NAV history */
  navHistory: NavPoint[];       // measured epochs, oldest first, up to last 20
  /* meta */
  blockTs: number;
  lastUpdated: number;          // Date.now()
};

/* ------- the hook ------- */

const POLL_MS = 15_000;

export function useDaioLive(): DaioLive | null {
  const [state, setState] = useState<DaioLive | null>(null);

  useEffect(() => {
    const provider = new JsonRpcProvider(DEFAULT_CHAIN.rpc);
    const vault    = new Contract(DAIO.vault,    VAULT_ABI,    provider);
    const registry = new Contract(DAIO.registry, REGISTRY_ABI, provider);
    const round    = new Contract(DAIO.round,    ROUND_ABI,    provider);
    const executor = new Contract(DAIO.executor, EXECUTOR_ABI, provider);
    const fee      = new Contract(DAIO.fee,      FEE_ABI,      provider);

    let cancelled = false;

    const tick = async () => {
      try {
        const [
          tvlRaw,
          supplyRaw,
          curEpochRaw,
          phaseRaw,
          basketEpochRaw,
          block,
        ] = await Promise.all([
          vault.totalAssets() as Promise<bigint>,
          vault.totalSupply() as Promise<bigint>,
          round.currentEpoch() as Promise<bigint>,
          round.currentPhase() as Promise<bigint>,
          executor.currentBasketEpoch() as Promise<bigint>,
          provider.getBlock("latest"),
        ]);

        const curEpoch = Number(curEpochRaw);
        const phaseIdx = Number(phaseRaw);

        // Pull metrics for up to 8 most recent epochs (cap keeps RPC load
        // well under the public endpoint's rate limit). Per-epoch errors are
        // tolerated so a single bad call doesn't poison the whole poll.
        const HIST = 8;
        const histStart = curEpoch > 0 ? Math.max(1, curEpoch - HIST + 1) : 0;
        const histEpochs: number[] =
          curEpoch > 0
            ? Array.from({ length: curEpoch - histStart + 1 }, (_, i) => histStart + i)
            : [];

        const [epochInfo, agentRecords, basketRaw, histMetricsSettled] = await Promise.all([
          curEpoch > 0
            ? (round.epochs(curEpoch) as Promise<[bigint, bigint, bigint, bigint]>)
            : Promise.resolve([0n, 0n, 0n, 0n] as [bigint, bigint, bigint, bigint]),
          Promise.all(
            KNOWN_AGENTS.map((a) =>
              registry.agents(a.addr) as Promise<[string, bigint, bigint, bigint, boolean]>,
            ),
          ),
          basketEpochRaw > 0n
            ? (executor.currentBasket() as Promise<[string[], number[]]>)
            : Promise.resolve(null),
          Promise.allSettled(
            histEpochs.map((e) =>
              fee.metrics(e) as Promise<[bigint, bigint, bigint, bigint, boolean, boolean]>,
            ),
          ),
        ]);

        if (cancelled) return;

        const tvl = Number(formatUnits(tvlRaw, DEFAULT_CHAIN.usdcDecimals));
        const totalSupplyShares = Number(formatUnits(supplyRaw, DEFAULT_CHAIN.usdcDecimals));
        // Shares and assets share the same decimals here (OZ ERC-4626 with default
        // decimalsOffset=0). NAV/share is a unit-less ratio of raw amounts.
        const navPerShare = supplyRaw > 0n ? Number(tvlRaw) / Number(supplyRaw) : 1.0;

        const agents: AgentLive[] = KNOWN_AGENTS.map((meta, i) => {
          const [, bondRaw, repRaw, strikesRaw, active] = agentRecords[i];
          return {
            name: meta.name,
            specialty: meta.specialty,
            addr: meta.addr,
            bond: Number(formatUnits(bondRaw, DEFAULT_CHAIN.usdcDecimals)),
            reputation: Number(repRaw),
            strikes: Number(strikesRaw),
            active,
          };
        });
        const totalBonded = agents.filter((a) => a.active).reduce((s, a) => s + a.bond, 0);

        let basket: BasketLive | null = null;
        if (basketRaw && basketRaw[0].length > 0) {
          const tokens = basketRaw[0];
          const weights = basketRaw[1];
          basket = {
            epoch: Number(basketEpochRaw),
            weights: tokens.map((t, i) => ({
              token: t,
              symbol: symbolOf(t),
              weightBps: Number(weights[i]),
            })),
          };
        }

        // Per-share NAV at each measured epoch close.
        // NAV/share = navClose / currentTotalSupply. Approximate (assumes
        // share supply was stable across the epoch). Fine for the demo since
        // big share-supply jumps only happen on user deposit/withdraw.
        const navHistory: NavPoint[] = [];
        histMetricsSettled.forEach((res, i) => {
          if (res.status !== "fulfilled") return;
          const [, navCloseRaw, , , , measured] = res.value;
          if (measured && navCloseRaw > 0n && supplyRaw > 0n) {
            navHistory.push({
              epoch: histEpochs[i],
              nav: Number(navCloseRaw) / Number(supplyRaw),
            });
          }
        });

        setState({
          tvl,
          navPerShare,
          totalSupplyShares,
          agents,
          totalBonded,
          currentEpoch: curEpoch,
          phase: PHASE_NAMES[phaseIdx] ?? "Idle",
          commitOpen: Number(epochInfo[0]),
          commitClose: Number(epochInfo[1]),
          revealClose: Number(epochInfo[2]),
          basket,
          navHistory,
          blockTs: Number(block?.timestamp ?? 0),
          lastUpdated: Date.now(),
        });
      } catch (e) {
        // Transient RPC errors — keep the previous state, log to console only.
        // eslint-disable-next-line no-console
        console.warn("[daio] live read failed", e);
      }
    };

    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return state;
}

export function fmtRemaining(now: number, deadline: number): string {
  const s = Math.max(0, deadline - now);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}
