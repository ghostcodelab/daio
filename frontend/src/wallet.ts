import { useCallback, useEffect, useRef, useState } from "react";
import { Contract, JsonRpcProvider, formatEther, formatUnits } from "ethers";

/* ------- chain config ------- */

export type ChainConfig = {
  chainId: number;
  chainIdHex: string;
  name: string;
  rpc: string;
  nativeSymbol: string;
  usdc: string;
  usdcDecimals: number;
  explorer: string;
};

export const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  arbSepolia: {
    chainId: 421614,
    chainIdHex: "0x66eee",
    name: "Arbitrum Sepolia",
    rpc:
      (import.meta as ImportMeta & { env?: Record<string, string> }).env
        ?.VITE_ARBITRUM_SEPOLIA_RPC_URL ||
      "https://sepolia-rollup.arbitrum.io/rpc",
    nativeSymbol: "ETH",
    usdc: "0x1490769168778a6332d2a206b318cc083022f3f3",
    usdcDecimals: 6,
    explorer: "https://sepolia.arbiscan.io",
  },
};

export const DEFAULT_CHAIN = SUPPORTED_CHAINS.arbSepolia;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
] as const;

const WC_PROJECT_ID =
  (import.meta as ImportMeta & { env?: Record<string, string> }).env
    ?.VITE_WALLETCONNECT_PROJECT_ID;

/* ------- ethereum provider typing ------- */

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
  disconnect?: () => Promise<void>;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

/* ------- public helpers ------- */

export function truncateAddr(addr: string | null): string {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

async function initWalletConnect(): Promise<Eip1193 | null> {
  if (!WC_PROJECT_ID) return null;
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const provider = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [DEFAULT_CHAIN.chainId],
    showQrModal: true,
    metadata: {
      name: "Daio",
      description: "A DAO with no humans",
      url: typeof window !== "undefined" ? window.location.origin : "",
      icons: [],
    },
  });
  await provider.connect();
  return provider as unknown as Eip1193;
}

/* ------- the hook ------- */

export type WalletState = {
  address: string | null;
  chainId: number | null;
  ethBalance: string;
  usdcBalance: string;
  connecting: boolean;
  error: string | null;
  isCorrectChain: boolean;
  hasWallet: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<void>;
  refresh: () => Promise<void>;
};

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [ethBalance, setEthBalance] = useState<string>("0");
  const [usdcBalance, setUsdcBalance] = useState<string>("0");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasInjected = typeof window !== "undefined" && !!window.ethereum;
  const isCorrectChain = chainId === DEFAULT_CHAIN.chainId;

  const providerRef = useRef<Eip1193 | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const attachProvider = useCallback(async (p: Eip1193) => {
    cleanupRef.current?.();
    providerRef.current = p;
    try {
      const accs = (await p.request({ method: "eth_accounts" })) as string[];
      if (accs.length > 0) setAddress(accs[0]);
      const cid = (await p.request({ method: "eth_chainId" })) as string;
      setChainId(typeof cid === "string" ? parseInt(cid, 16) : Number(cid));
    } catch {
      /* ignore */
    }

    const onAccs = (...args: unknown[]) => {
      const accs = args[0] as string[];
      setAddress(accs && accs.length > 0 ? accs[0] : null);
    };
    const onChain = (...args: unknown[]) => {
      const cid = args[0] as string;
      setChainId(typeof cid === "string" ? parseInt(cid, 16) : Number(cid));
    };
    p.on("accountsChanged", onAccs);
    p.on("chainChanged", onChain);
    cleanupRef.current = () => {
      p.removeListener("accountsChanged", onAccs);
      p.removeListener("chainChanged", onChain);
    };
  }, []);

  /* attach injected provider on mount if available */
  useEffect(() => {
    if (!hasInjected || !window.ethereum) return;
    void attachProvider(window.ethereum);
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [hasInjected, attachProvider]);

  /* read balances via public RPC to dodge MetaMask's stale-balance window */
  const refresh = useCallback(async () => {
    if (!address || !isCorrectChain) {
      setEthBalance("0");
      setUsdcBalance("0");
      return;
    }
    try {
      const provider = new JsonRpcProvider(DEFAULT_CHAIN.rpc);
      const ethWei = await provider.getBalance(address);
      setEthBalance(formatEther(ethWei));
      const usdc = new Contract(DEFAULT_CHAIN.usdc, ERC20_ABI as unknown as string[], provider);
      const bal = (await usdc.balanceOf(address)) as bigint;
      setUsdcBalance(formatUnits(bal, DEFAULT_CHAIN.usdcDecimals));
    } catch {
      /* ignore transient RPC errors */
    }
  }, [address, isCorrectChain]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      if (hasInjected && window.ethereum) {
        const accs = (await window.ethereum.request({
          method: "eth_requestAccounts",
        })) as string[];
        if (accs.length > 0) setAddress(accs[0]);
        const cid = (await window.ethereum.request({ method: "eth_chainId" })) as string;
        setChainId(parseInt(cid, 16));
        return;
      }
      if (WC_PROJECT_ID) {
        const wc = await initWalletConnect();
        if (wc) {
          await attachProvider(wc);
          return;
        }
      }
      window.open("https://metamask.io/download/", "_blank", "noopener,noreferrer");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to connect";
      setError(msg);
    } finally {
      setConnecting(false);
    }
  }, [hasInjected, attachProvider]);

  const disconnect = useCallback(() => {
    const p = providerRef.current;
    if (p && typeof p.disconnect === "function") {
      void p.disconnect();
    }
    cleanupRef.current?.();
    cleanupRef.current = null;
    providerRef.current = hasInjected && window.ethereum ? window.ethereum : null;
    setAddress(null);
    setEthBalance("0");
    setUsdcBalance("0");
    setError(null);
  }, [hasInjected]);

  const switchNetwork = useCallback(async () => {
    const p = providerRef.current;
    if (!p) return;
    try {
      await p.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: DEFAULT_CHAIN.chainIdHex }],
      });
    } catch (e: unknown) {
      // 4902: chain not yet added to wallet
      const code = (e as { code?: number })?.code;
      if (code === 4902) {
        try {
          await p.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: DEFAULT_CHAIN.chainIdHex,
                chainName: DEFAULT_CHAIN.name,
                rpcUrls: [DEFAULT_CHAIN.rpc],
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                blockExplorerUrls: [DEFAULT_CHAIN.explorer],
              },
            ],
          });
        } catch {
          /* user rejected add */
        }
      }
    }
  }, []);

  return {
    address,
    chainId,
    ethBalance,
    usdcBalance,
    connecting,
    error,
    isCorrectChain,
    hasWallet: hasInjected,
    connect,
    disconnect,
    switchNetwork,
    refresh,
  };
}
