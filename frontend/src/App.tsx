import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { useGSAP } from "@gsap/react";
import { DEFAULT_CHAIN, truncateAddr, useWallet, type WalletState } from "./wallet";
import { useDaioLive, type DaioLive, type AgentLive } from "./daio";

gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, ScrambleTextPlugin);

// Public site URL. Swap to https://daio.fi (or wherever) when the site is
// deployed; localhost:8080 is the dev static server in this repo.
const SITE_URL = "http://localhost:8080";

type Phase = "Intent" | "Commit" | "Reveal" | "Consensus" | "Settle";

const PHASE_ORDER: Phase[] = ["Intent", "Commit", "Reveal", "Consensus", "Settle"];

type Agent = {
  name: string;
  specialty: string;
  addr: string;
  reputation: number;
  stake: number;
};

type FeedEntry = {
  id: number;
  time: string;
  who: string;
  what: string;
  tag: "commit" | "reveal" | "close";
};

type Allocation = { token: string; weightBps: number };

type AgentDetail = Agent & {
  specialtyLabel: string;
  blurb: string;
  epochStatus: "committed" | "pending" | "revealed";
  epochStatusDetail: string;
  lastReveal: { token: string; weight: number }[]; // weight in bps
};

const AGENT_DETAILS: AgentDetail[] = [
  {
    name: "MacroAgent", specialty: "macro", specialtyLabel: "Macro",
    addr: "0x2e09Ff1AEa117379dbDd8BF7Ac3DAB49CE377bbF", reputation: 847, stake: 2500,
    blurb: "Reads Fed minutes, CPI prints, yield-curve snapshots. Tilts to cash and short duration when real yields rise.",
    epochStatus: "committed",
    epochStatusDetail: "04:18 · hash 0x9c12…ad04",
    lastReveal: [
      { token: "mUSDY", weight: 5500 },
      { token: "mIB01", weight: 3000 },
      { token: "mAAPL", weight: 1500 },
    ],
  },
  {
    name: "CreditAgent", specialty: "credit", specialtyLabel: "Credit",
    addr: "0xd3bff89E700583e8dB995837f96475E18Ed1faE8", reputation: 723, stake: 2500,
    blurb: "Parses EDGAR filings (8-K, 10-Q) for issuers behind credit-side tokens. Tilts away from names showing deterioration.",
    epochStatus: "committed",
    epochStatusDetail: "03:51 · hash 0xf3a1…7e22",
    lastReveal: [
      { token: "mUSDY", weight: 4800 },
      { token: "mIB01", weight: 3400 },
      { token: "mAAPL", weight: 1800 },
    ],
  },
  {
    name: "ThirdAgent", specialty: "liq", specialtyLabel: "Liquidity",
    addr: "0xC852…f3ab", reputation: 412, stake: 1800,
    blurb: "Tracks on-chain liquidity, funding rates, and equity flow. Routinely the outlier on risk-on calls.",
    epochStatus: "pending",
    epochStatusDetail: "no commit received yet",
    lastReveal: [
      { token: "mUSDY", weight: 2800 },
      { token: "mIB01", weight: 2200 },
      { token: "mAAPL", weight: 5000 },
    ],
  },
];

const SEED_FEED: FeedEntry[] = [
  { id: 1, time: "04:18", who: "MacroAgent",  what: "committed proposal",                tag: "commit" },
  { id: 2, time: "03:51", who: "CreditAgent", what: "committed proposal",                tag: "commit" },
  { id: 3, time: "01:02", who: "ThirdAgent",  what: "committed proposal",                tag: "commit" },
  { id: 4, time: "00:00", who: "Epoch 41",    what: "closed · cluster Macro+Credit won", tag: "close"  },
  { id: 5, time: "-0:14", who: "ThirdAgent",  what: "revealed — outside cluster",        tag: "reveal" },
];

const INITIAL_ALLOC: Allocation[] = [
  { token: "mUSDY", weightBps: 4500 },
  { token: "mIB01", weightBps: 3000 },
  { token: "mAAPL", weightBps: 2500 },
];

// Plausible alternate allocations the agents might converge on after a rebalance.
const ALLOC_VARIANTS: Allocation[][] = [
  [
    { token: "mUSDY", weightBps: 4500 },
    { token: "mIB01", weightBps: 3000 },
    { token: "mAAPL", weightBps: 2500 },
  ],
  [
    { token: "mUSDY", weightBps: 5200 },
    { token: "mIB01", weightBps: 3200 },
    { token: "mAAPL", weightBps: 1600 },
  ],
  [
    { token: "mUSDY", weightBps: 3800 },
    { token: "mIB01", weightBps: 2800 },
    { token: "mAAPL", weightBps: 3400 },
  ],
  [
    { token: "mUSDY", weightBps: 4000 },
    { token: "mIB01", weightBps: 3500 },
    { token: "mAAPL", weightBps: 2500 },
  ],
];

const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const fmtPct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export function App() {
  const wallet = useWallet();
  const live = useDaioLive();
  const [phase, setPhase] = useState<Phase>("Commit");
  const [epoch, setEpoch] = useState(42);
  const [remaining, setRemaining] = useState(263); // 4:23 in seconds
  const [phaseLen] = useState(600);
  const [feed, setFeed] = useState<FeedEntry[]>(SEED_FEED);
  const [alloc, setAlloc] = useState<Allocation[]>(INITIAL_ALLOC);
  const [rebalanceTick, setRebalanceTick] = useState(0);

  // Simulate a rebalance every 22s — picks a different allocation variant
  // and bumps a tick the AllocationSection animates on.
  useEffect(() => {
    const id = window.setInterval(() => {
      setAlloc((prev) => {
        const variants = ALLOC_VARIANTS.filter(
          (v) => v.map((x) => x.weightBps).join(",") !== prev.map((x) => x.weightBps).join(","),
        );
        return variants[Math.floor(Math.random() * variants.length)];
      });
      setRebalanceTick((t) => t + 1);
      setFeed((prev) => {
        const entry: FeedEntry = {
          id: (prev[0]?.id ?? 0) + 1,
          time: "now",
          who: "Consensus",
          what: "resolved cluster · allocation rebalanced",
          tag: "close",
        };
        return [entry, ...prev].slice(0, 12);
      });
    }, 22000);
    return () => window.clearInterval(id);
  }, []);

  // Tick the epoch countdown forever for the demo.
  useEffect(() => {
    const id = window.setInterval(() => {
      setRemaining((r) => {
        if (r > 1) return r - 1;
        // phase rollover — advance through PHASE_ORDER, increment epoch on wrap.
        setPhase((p) => {
          const idx = PHASE_ORDER.indexOf(p);
          return PHASE_ORDER[(idx + 1) % PHASE_ORDER.length];
        });
        setEpoch((e) => (phase === PHASE_ORDER[PHASE_ORDER.length - 1] ? e + 1 : e));
        return phaseLen;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, phaseLen]);

  // Inject a synthetic feed entry every ~7 seconds for movement.
  useEffect(() => {
    const id = window.setInterval(() => {
      setFeed((prev) => {
        const next: FeedEntry = {
          id: (prev[0]?.id ?? 0) + 1,
          time: fmtTime(remaining),
          who: pick(["MacroAgent", "CreditAgent", "ThirdAgent"]),
          what: pick(["pulled price feed", "ran inference", "validated proposal", "queued reveal"]),
          tag: "commit",
        };
        return [next, ...prev].slice(0, 12);
      });
    }, 7000);
    return () => window.clearInterval(id);
  }, [remaining]);

  return (
    <div className="app">
      <ScrollProgress />
      <BackgroundGrid />
      <BackgroundGlow />
      <Topnav wallet={wallet} />
      <WrongNetworkBanner wallet={wallet} />
      <main className="wrap">
        <OpsQueue epoch={epoch} phase={phase} live={live} />
        {wallet.address && (
          <div id="position"><PositionSection wallet={wallet} live={live} /></div>
        )}
        <EpochStrip epoch={epoch} phase={phase} remaining={remaining} phaseLen={phaseLen} live={live} />
        <div id="vault"><StatsRow live={live} /></div>
        <div id="epoch"><EpochExplainer phase={phase} /></div>
        <div id="allocation"><AllocationSection alloc={alloc} rebalanceTick={rebalanceTick} live={live} /></div>
        <div id="agents"><TwoCol left={<AgentSection live={live} />} right={<FeedSection feed={feed} />} /></div>
        <AppFooter />
      </main>
    </div>
  );
}

/* ------- wrong-network banner ------- */

function WrongNetworkBanner({ wallet }: { wallet: WalletState }) {
  if (!wallet.address || wallet.isCorrectChain) return null;
  return (
    <div className="net-banner">
      <span>Wrong network. Daio runs on {DEFAULT_CHAIN.name}.</span>
      <button onClick={wallet.switchNetwork}>Switch</button>
    </div>
  );
}

/* ------- scroll progress bar ------- */

function ScrollProgress() {
  const fillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      const p = max > 0 ? h.scrollTop / max : 0;
      if (fillRef.current) {
        gsap.to(fillRef.current, { scaleX: p, duration: 0.15, ease: "none", overwrite: true });
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <div className="scroll-progress">
      <div ref={fillRef} className="fill" />
    </div>
  );
}

/* ------- background ------- */

function BackgroundGrid() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!ref.current) return;
      const x = (e.clientX / window.innerWidth - 0.5) * 18;
      const y = (e.clientY / window.innerHeight - 0.5) * 18;
      gsap.to(ref.current, { x, y, duration: 0.8, ease: "power3.out" });
    };
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, []);
  return <div ref={ref} className="bg-grid" aria-hidden />;
}

function BackgroundGlow() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!ref.current) return;
      gsap.to(ref.current, {
        left: e.clientX - 240,
        top: e.clientY - 240,
        duration: 1.2,
        ease: "power3.out",
      });
    };
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, []);
  return <div ref={ref} className="bg-glow" aria-hidden style={{ left: -480, top: -480 }} />;
}

/* ------- topnav ------- */

const NAV_LINKS = [
  { id: "vault",      label: "Vault"      },
  { id: "epoch",      label: "Epoch"      },
  { id: "allocation", label: "Allocation" },
  { id: "agents",     label: "Agents"     },
  { id: "position",   label: "Position"   },
];

function Topnav({ wallet }: { wallet: WalletState }) {
  const rootRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState<string>(NAV_LINKS[0].id);
  const [showMenu, setShowMenu] = useState(false);

  // POSITION nav only makes sense when there's a connected wallet to view the position of
  const navLinks = wallet.address ? NAV_LINKS : NAV_LINKS.filter((l) => l.id !== "position");

  useGSAP(
    () => {
      gsap.from(".top .row > *", {
        y: -16,
        opacity: 0,
        duration: 0.6,
        stagger: 0.08,
        ease: "power3.out",
      });

      // hex-decode the brand mark on mount
      gsap.to(".top .brand-text", {
        duration: 0.9,
        delay: 0.15,
        ease: "none",
        scrambleText: {
          text: "DAIO",
          chars: "0123456789ABCDEF",
          revealDelay: 0.2,
          speed: 0.6,
        },
      });

      // hex-decode nav labels, staggered
      gsap.utils.toArray<HTMLSpanElement>(".top .nav-label").forEach((el, i) => {
        const target = el.dataset.text || el.textContent || "";
        gsap.to(el, {
          duration: 0.7,
          delay: 0.35 + i * 0.06,
          ease: "none",
          scrambleText: {
            text: target,
            chars: "0123456789ABCDEF",
            revealDelay: 0.1,
            speed: 0.7,
          },
        });
      });
    },
    { scope: rootRef },
  );

  const onNavHover = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const span = e.currentTarget.querySelector(".nav-label") as HTMLElement | null;
    if (!span) return;
    const target = span.dataset.text || span.textContent || "";
    gsap.killTweensOf(span);
    gsap.to(span, {
      duration: 0.4,
      ease: "none",
      scrambleText: {
        text: target,
        chars: "0123456789ABCDEF",
        revealDelay: 0.05,
        speed: 0.9,
      },
    });
  };

  // scroll-spy
  useEffect(() => {
    const onScroll = () => {
      const offsets = NAV_LINKS.map((l) => {
        const el = document.getElementById(l.id);
        return { id: l.id, top: el ? el.getBoundingClientRect().top : Infinity };
      });
      const passed = offsets.filter((o) => o.top <= 120);
      const current = passed.length ? passed[passed.length - 1].id : NAV_LINKS[0].id;
      setActive(current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const jump = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top, behavior: "smooth" });
  };

  return (
    <nav ref={rootRef} className="top">
      <div className="row">
        <div className="brand-group">
          <a className="brand" href="#" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
            <span className="dot" /><span className="brand-text">DAIO</span>
          </a>
          <a className="back-link" href={SITE_URL}>← back to site</a>
        </div>
        <ul>
          {navLinks.map((l) => (
            <li key={l.id}>
              <a
                href={`#${l.id}`}
                className={active === l.id ? "active" : ""}
                onClick={jump(l.id)}
                onMouseEnter={onNavHover}
              >
                <span className="nav-label" data-text={l.label}>{l.label}</span>
              </a>
            </li>
          ))}
        </ul>
        {wallet.address ? (
          <div className="wallet-pill-group">
            <div
              className={`wallet-pill ${wallet.isCorrectChain ? "" : "warn"}`}
              onClick={() => setShowMenu((s) => !s)}
              title={wallet.isCorrectChain ? wallet.address : "Wrong network"}
            >
              <span className={`dot ${wallet.isCorrectChain ? "" : "warn"}`} />
              <ScrambleText text={truncateAddr(wallet.address)} />
            </div>
            {showMenu && (
              <div className="wallet-menu" onMouseLeave={() => setShowMenu(false)}>
                <div className="menu-row addr">
                  <span>{wallet.address}</span>
                </div>
                <div className="menu-row dim">
                  Chain: {wallet.isCorrectChain ? DEFAULT_CHAIN.name : `id ${wallet.chainId}`}
                </div>
                <div className="menu-row dim">
                  ETH: {fmtBalance(wallet.ethBalance, 4)} · USDC: {fmtBalance(wallet.usdcBalance, 2)}
                </div>
                <button className="menu-action" onClick={() => { wallet.disconnect(); setShowMenu(false); }}>
                  Disconnect
                </button>
              </div>
            )}
          </div>
        ) : (
          <div
            className={`wallet-pill connect ${wallet.connecting ? "busy" : ""}`}
            onClick={wallet.connect}
          >
            <ScrambleText text={wallet.connecting ? "Connecting…" : "Connect"} />
          </div>
        )}
      </div>
    </nav>
  );
}

function ScrambleText({
  text,
  chars = "0123456789ABCDEF",
  duration = 0.6,
}: {
  text: string;
  chars?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    gsap.killTweensOf(ref.current);
    gsap.to(ref.current, {
      duration,
      ease: "none",
      scrambleText: {
        text,
        chars,
        revealDelay: 0.08,
        speed: 0.7,
      },
    });
  }, [text, chars, duration]);
  return <span ref={ref}>{text}</span>;
}

function fmtBalance(s: string, decimals: number): string {
  const n = parseFloat(s);
  if (!isFinite(n)) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}


/* ------- ops queue (top main area) ------- */

type JobStatus = "done" | "active" | "pending" | "queued";

type Job = {
  id: string;
  epoch: number;
  stage: "Open" | "Intent" | "Commit" | "Reveal" | "Consensus" | "Settle";
  actor: string;
  title: string;
  status: JobStatus;
  time: string;
  detail?: string;
};

function buildJobs(epoch: number, phase: Phase): Job[] {
  const ord = PHASE_ORDER.indexOf(phase);
  const stageStatus = (idx: number): JobStatus =>
    idx < ord ? "done" : idx === ord ? "active" : "queued";

  // current-epoch jobs by phase
  const current: Job[] = [
    { id: "c-intent",    epoch, stage: "Intent",    actor: "system",      title: "Intent window",                status: stageStatus(0),
      time:   ord > 0 ? "closed" : ord === 0 ? "open" : "queued",
      detail: "LP deposits queued for the next epoch" },

    { id: "c-commit",    epoch, stage: "Commit",    actor: "system",      title: "Commit window",                status: stageStatus(1),
      time:   ord > 1 ? "closed" : ord === 1 ? "open · 4:23 to reveal" : "queued",
      detail: "phase 2 of 5 · agents may submit proposal hashes" },

    { id: "c-macro",     epoch, stage: "Commit",    actor: "MacroAgent",  title: "Proposal committed",           status: ord >= 1 ? "done" : "queued",
      time:   ord >= 1 ? "04:18" : "—",
      detail: "hash 0x9c12…ad04" },

    { id: "c-credit",    epoch, stage: "Commit",    actor: "CreditAgent", title: "Proposal committed",           status: ord >= 1 ? "done" : "queued",
      time:   ord >= 1 ? "03:51" : "—",
      detail: "hash 0xf3a1…7e22" },

    { id: "c-third",     epoch, stage: "Commit",    actor: "ThirdAgent",  title: ord <= 1 ? "Proposal awaiting" : "Proposal missed",
      status: ord === 1 ? "pending" : ord > 1 ? "done" : "queued",
      time:   "—",
      detail: ord === 1 ? "no commit received yet" : ord > 1 ? "committed at deadline · hash 0xa1b2…44ee" : "" },

    { id: "c-reveal",    epoch, stage: "Reveal",    actor: "system",      title: "Reveal window",                status: stageStatus(2),
      time:   ord > 2 ? "closed" : ord === 2 ? "open" : "queued",
      detail: "agents reveal committed proposals" },

    { id: "c-consensus", epoch, stage: "Consensus", actor: "consensus",   title: "Cluster resolution",           status: stageStatus(3),
      time:   ord > 3 ? "resolved" : ord === 3 ? "running" : "queued",
      detail: "L1 cluster · 500bps tolerance" },

    { id: "c-swap",      epoch, stage: "Settle",    actor: "Executor",    title: "Allocation swap",              status: stageStatus(4),
      time:   ord >= 4 ? "running" : "queued",
      detail: "vault rebalances to elected basket" },

    { id: "c-fees",      epoch, stage: "Settle",    actor: "x402",        title: "Performance fee distribution", status: stageStatus(4),
      time:   ord >= 4 ? "running" : "queued",
      detail: "fees routed to winning cluster" },

    { id: "c-slash",     epoch, stage: "Settle",    actor: "Slashing",    title: "Outlier slashing",             status: stageStatus(4),
      time:   ord >= 4 ? "running" : "queued",
      detail: "applied only if epoch profitable" },
  ];

  // previous-epoch jobs (E{epoch - 1}) — always settled
  const prev: Job[] = [
    { id: "p-fees",      epoch: epoch - 1, stage: "Settle",    actor: "x402",      title: "Performance fees distributed", status: "done", time: "16m ago",   detail: "12.4 USDC → MacroAgent + CreditAgent" },
    { id: "p-swap",      epoch: epoch - 1, stage: "Settle",    actor: "Executor",  title: "Allocation swap",              status: "done", time: "17m ago",   detail: "mUSDY 45 · mIB01 30 · mAAPL 25" },
    { id: "p-consensus", epoch: epoch - 1, stage: "Consensus", actor: "consensus", title: "Cluster resolved",             status: "done", time: "18m ago",   detail: "Macro + Credit cluster · 2 of 3 stake" },
    { id: "p-reveal",    epoch: epoch - 1, stage: "Reveal",    actor: "system",    title: "Reveal window closed",         status: "done", time: "19m ago",   detail: "3 reveals received · 1 outside cluster" },
    { id: "p-open",      epoch: epoch - 1, stage: "Open",      actor: "system",    title: "Epoch opened",                 status: "done", time: "1h 18m ago", detail: "1h cadence (demo)" },
  ];

  return [...current, ...prev];
}

const OPS_FILTERS: { id: "all" | JobStatus; label: string }[] = [
  { id: "all",     label: "All"     },
  { id: "active",  label: "Active"  },
  { id: "pending", label: "Pending" },
  { id: "queued",  label: "Queued"  },
  { id: "done",    label: "Done"    },
];

function OpsQueue({ epoch, phase, live }: { epoch: number; phase: Phase; live: DaioLive | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<"all" | JobStatus>("all");

  // Prefer live on-chain epoch + phase; fall back to the simulated ticker.
  const effectiveEpoch = live?.currentEpoch && live.currentEpoch > 0 ? live.currentEpoch : epoch;
  const effectivePhase = (live?.phase && live.phase !== "Idle" ? (live.phase as Phase) : phase);
  const jobs = useMemo(() => buildJobs(effectiveEpoch, effectivePhase), [effectiveEpoch, effectivePhase]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: jobs.length, done: 0, active: 0, pending: 0, queued: 0 };
    for (const j of jobs) c[j.status]++;
    return c;
  }, [jobs]);

  const visible = filter === "all" ? jobs : jobs.filter((j) => j.status === filter);

  useGSAP(
    () => {
      gsap.from(".ops-eyebrow", { y: -8, opacity: 0, duration: 0.5, ease: "power3.out" });
      gsap.from(".ops-title",   { y: 14, opacity: 0, duration: 0.6, ease: "power3.out", delay: 0.05 });
      gsap.from(".ops-strap",   { y: 10, opacity: 0, duration: 0.5, ease: "power3.out", delay: 0.18 });
      gsap.from(".ops-filters", { y: 8,  opacity: 0, duration: 0.5, ease: "power3.out", delay: 0.28 });
      gsap.from(".ops-row",     { y: 12, opacity: 0, duration: 0.45, stagger: 0.04, ease: "power3.out", delay: 0.38 });
    },
    { scope: ref },
  );

  return (
    <section ref={ref} className="ops">
      <div className="ops-eyebrow">
        <span className="live-dot" />
        <span>{live ? "Live · on-chain" : "Live"}</span>
        <span className="sep">·</span>
        <span>Epoch {effectiveEpoch} · {effectivePhase} phase</span>
        <span className="sep">·</span>
        <span>Arbitrum Sepolia</span>
      </div>
      <h1 className="ops-title">
        DAIO<span className="period">.</span>
      </h1>
      <p className="ops-strap">
        Every job <em>on-chain right now</em>, every job already settled. AI agents commit and reveal; consensus resolves; the executor rebalances; fees and slashes at epoch close.
      </p>

      <div className="ops-filters">
        {OPS_FILTERS.map((f) => (
          <button
            key={f.id}
            className={`ops-filter ${filter === f.id ? "on" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            <span className="lbl">{f.label}</span>
            <span className="cnt">{counts[f.id] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="ops-list">
        {visible.map((j) => <JobRow key={j.id} job={j} />)}
        {visible.length === 0 && (
          <div className="ops-empty">No jobs in this status.</div>
        )}
      </div>
    </section>
  );
}

function JobRow({ job }: { job: Job }) {
  return (
    <div className={`ops-row status-${job.status}`}>
      <div className="status"><StatusIcon status={job.status} /></div>
      <div className="meta">
        <span className="epoch">E{job.epoch}</span>
        <span className="stage">{job.stage}</span>
      </div>
      <div className="body">
        <div className="title">{job.title}</div>
        {job.detail && <div className="detail">{job.detail}</div>}
      </div>
      <div className="actor">{job.actor}</div>
      <div className="time">{job.time}</div>
    </div>
  );
}

function StatusIcon({ status }: { status: JobStatus }) {
  if (status === "done")    return <span className="job-icon done">✓</span>;
  if (status === "active")  return <span className="job-icon active"><span className="pulse" /></span>;
  if (status === "pending") return <span className="job-icon pending">○</span>;
  return <span className="job-icon queued">›</span>;
}


function EpochStrip({
  epoch,
  phase,
  remaining,
  phaseLen,
  live,
}: {
  epoch: number;
  phase: Phase;
  remaining: number;
  phaseLen: number;
  live: DaioLive | null;
}) {
  // Live override: if we have on-chain epoch state, use that for display.
  const displayEpoch = live?.currentEpoch && live.currentEpoch > 0 ? live.currentEpoch : epoch;
  const displayPhase = live?.phase && live.phase !== "Idle" ? (live.phase as Phase) : phase;
  const displayRemaining = (() => {
    if (!live || !live.blockTs) return remaining;
    const ts = live.blockTs;
    if (live.phase === "Commit") return Math.max(0, live.commitClose - ts);
    if (live.phase === "Reveal") return Math.max(0, live.revealClose - ts);
    return remaining;
  })();
  const displayPhaseLen = (() => {
    if (!live || !live.blockTs) return phaseLen;
    if (live.phase === "Commit") return Math.max(1, live.commitClose - live.commitOpen);
    if (live.phase === "Reveal") return Math.max(1, live.revealClose - live.commitClose);
    return phaseLen;
  })();

  // alias the originals to the resolved values so the rest of the body needs no edits
  epoch = displayEpoch;
  phase = displayPhase;
  remaining = displayRemaining;
  phaseLen = displayPhaseLen;

  const ref = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const epochRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      gsap.from(ref.current, { y: 24, opacity: 0, duration: 0.7, delay: 0.3, ease: "power3.out" });
    },
    { scope: ref },
  );

  // animate progress bar smoothly
  useEffect(() => {
    if (!barRef.current) return;
    const pct = 1 - remaining / phaseLen;
    gsap.to(barRef.current, { scaleX: pct, transformOrigin: "left center", duration: 0.6, ease: "power2.out" });
  }, [remaining, phaseLen]);

  // pulse the time when seconds tick
  useEffect(() => {
    if (!timeRef.current) return;
    gsap.fromTo(
      timeRef.current,
      { color: "#d0ff00" },
      { color: "#f0f0f0", duration: 1.0, ease: "power2.out" },
    );
  }, [remaining]);

  // flip number on epoch roll
  useEffect(() => {
    if (!epochRef.current) return;
    gsap.fromTo(
      epochRef.current,
      { y: -12, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.5, ease: "power3.out" },
    );
  }, [epoch]);

  return (
    <div ref={ref} className="epoch-strip">
      <div ref={epochRef} className="epoch-num">
        <span className="label">Epoch</span>
        #{epoch}
      </div>
      <div className="phase">
        <div className="name">
          <span className="pulse" />
          {phase} Phase
        </div>
        <div className="progress">
          <div ref={barRef} className="bar" style={{ transform: "scaleX(0)" }} />
        </div>
      </div>
      <div className="countdown">
        <div ref={timeRef} className="time">{fmtTime(remaining)}</div>
        <span className="label">Remaining</span>
      </div>
    </div>
  );
}

/* ------- stats ------- */

// Synth NAV series for the sparkline (20 epochs, gently up-trending with noise).
const NAV_SERIES = [
  1.0000, 1.0008, 1.0011, 1.0015, 1.0021, 1.0019, 1.0027, 1.0033, 1.0029, 1.0036,
  1.0044, 1.0048, 1.0055, 1.0053, 1.0062, 1.0068, 1.0074, 1.0079, 1.0088, 1.0342,
].map((v, i, a) => (i === a.length - 1 ? v : 1 + (v - 1) * 0.7 + i * 0.0008)); // scale tail

function StatsRow({ live }: { live: DaioLive | null }) {
  const ref = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      gsap.from(".stat", {
        y: 24,
        opacity: 0,
        duration: 0.6,
        stagger: 0.1,
        ease: "power3.out",
        scrollTrigger: { trigger: ref.current, start: "top 85%" },
      });
      gsap.to(".stat::after", { scaleX: 1, duration: 1.2, ease: "expo.out", delay: 0.4, stagger: 0.1 });
    },
    { scope: ref },
  );

  const tvl = live?.tvl ?? 1247892.41;
  const nav = live?.navPerShare ?? 1.0342;
  const bonded = live?.totalBonded ?? 6800;

  // Sparkline: use live NAV history when we have >= 2 measured epochs,
  // fall back to the synthetic NAV_SERIES otherwise. Axis labels reflect
  // whichever source is in play.
  const liveSeries = live?.navHistory ?? [];
  const usingLiveSpark = liveSeries.length >= 2;
  const sparkSeries = usingLiveSpark ? liveSeries.map((p) => p.nav) : NAV_SERIES;
  const sparkLabel = usingLiveSpark
    ? `NAV / share · last ${liveSeries.length} epochs · live`
    : "NAV / share · 20 epochs";
  const sparkAxis = usingLiveSpark
    ? { start: `e${liveSeries[0].epoch}`, end: `e${liveSeries[liveSeries.length - 1].epoch}` }
    : { start: "e22", end: "e42" };

  return (
    <section ref={ref} className="sec">
      <div className="label">
        <span className="num">§01</span> Vault
        {live && <span className="live-tag">on-chain</span>}
      </div>
      <div className="stats">
        <Stat k="Total value locked" target={tvl}    format="money"   delta={live ? "live · Arbitrum Sepolia" : "up 2.3% this week"} primary deltaNeutral={!!live} />
        <Stat k="NAV / share"        target={nav}    format="decimal" delta={live ? "live · per dvUSDC" : "up 0.04% last epoch"} deltaNeutral={!!live} />
        <Stat k="Total bonded"       target={bonded} format="money0"  delta="USDC at risk" deltaNeutral />
        <SparklineStat k={sparkLabel} series={sparkSeries} axisStart={sparkAxis.start} axisEnd={sparkAxis.end} />

      </div>
    </section>
  );
}

function SparklineStat({
  k,
  series,
  axisStart,
  axisEnd,
}: {
  k: string;
  series: number[];
  axisStart?: string;
  axisEnd?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const areaRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  const numRef = useRef<HTMLSpanElement>(null);

  // Build path data.
  const W = 220, H = 44, P = 4;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const xs = series.map((_, i) => P + (i * (W - P * 2)) / (series.length - 1));
  const ys = series.map((v) => P + (H - P * 2) * (1 - (v - min) / (max - min || 1)));
  const linePath = series.map((_, i) => (i === 0 ? `M ${xs[i]} ${ys[i]}` : `L ${xs[i]} ${ys[i]}`)).join(" ");
  const areaPath = `${linePath} L ${xs[xs.length - 1]} ${H} L ${xs[0]} ${H} Z`;
  const last = series[series.length - 1];

  useGSAP(
    () => {
      if (!lineRef.current || !areaRef.current || !dotRef.current || !numRef.current) return;
      const len = lineRef.current.getTotalLength();
      gsap.set(lineRef.current, { strokeDasharray: len, strokeDashoffset: len });
      gsap.set(areaRef.current, { opacity: 0 });
      gsap.set(dotRef.current, { opacity: 0 });

      const tl = gsap.timeline({
        scrollTrigger: { trigger: ref.current, start: "top 88%" },
      });
      tl.to(lineRef.current, { strokeDashoffset: 0, duration: 1.6, ease: "power2.out" });
      tl.to(areaRef.current, { opacity: 0.5, duration: 0.6, ease: "power2.out" }, "-=0.6");
      tl.to(dotRef.current, { opacity: 1, duration: 0.3, ease: "power2.out" }, "-=0.2");

      // count up the value
      const obj = { v: min };
      tl.to(
        obj,
        {
          v: last,
          duration: 1.4,
          ease: "power2.out",
          onUpdate: () => { if (numRef.current) numRef.current.textContent = `$${obj.v.toFixed(4)}`; },
        },
        0,
      );
    },
    { scope: ref, dependencies: [series.join(",")] },
  );

  return (
    <div ref={ref} className="stat spark">
      <div className="k">{k}</div>
      <div className="spark-row">
        <span ref={numRef} className="num">$0.0000</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height="44">
          <defs>
            <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#d0ff00" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#d0ff00" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path ref={areaRef} className="area" d={areaPath} />
          <path ref={lineRef} className="line" d={linePath} />
          <circle ref={dotRef} className="last-dot" cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={3} />
        </svg>
      </div>
      <div className="spark-axis">
        <span>{axisStart ?? "e22"}</span>
        <span>{axisEnd ?? "e42"}</span>
      </div>
    </div>
  );
}

function Stat({
  k,
  target,
  format,
  delta,
  deltaNeutral,
  primary,
}: {
  k: string;
  target: number;
  format: "money" | "money0" | "decimal" | "int";
  delta: string;
  deltaNeutral?: boolean;
  primary?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const numRef = useRef<HTMLDivElement>(null);
  // Track the most recent animated value so subsequent target updates
  // smoothly tween from prev → new (instead of resetting to 0 each tick).
  const lastValue = useRef(0);
  const initialDone = useRef(false);

  useGSAP(
    () => {
      if (!numRef.current) return;
      const obj = { v: lastValue.current };
      const opts: gsap.TweenVars = {
        v: target,
        duration: 1.2,
        ease: "power2.out",
        onUpdate: () => {
          if (!numRef.current) return;
          numRef.current.textContent = renderNum(obj.v, format);
        },
        onComplete: () => {
          lastValue.current = target;
        },
      };
      if (!initialDone.current) {
        // First reveal waits until the section scrolls into view.
        opts.scrollTrigger = { trigger: ref.current, start: "top 88%" };
        initialDone.current = true;
      }
      gsap.to(obj, opts);
    },
    { scope: ref, dependencies: [target] },
  );
  return (
    <div ref={ref} className={`stat ${primary ? "primary" : ""}`}>
      <div className="k">{k}</div>
      <div ref={numRef} className="v">{renderNum(0, format)}</div>
      <div className={`d ${deltaNeutral ? "" : "up"}`}>{delta}</div>
    </div>
  );
}

function renderNum(v: number, f: "money" | "money0" | "decimal" | "int"): string {
  if (f === "money") return fmtMoney(v);
  if (f === "money0") return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  if (f === "decimal") return `$${v.toFixed(4)}`;
  return Math.round(v).toLocaleString();
}

/* ------- allocation ------- */

function AllocationSection({
  alloc,
  rebalanceTick,
  live,
}: {
  alloc: Allocation[];
  rebalanceTick: number;
  live: DaioLive | null;
}) {
  const ref = useRef<HTMLElement>(null);
  const tagRef = useRef<HTMLSpanElement>(null);

  // Live override: replace the simulated alloc with the executor's current basket
  // when the on-chain epoch has had at least one execution.
  if (live?.basket && live.basket.weights.length > 0) {
    alloc = live.basket.weights.map((w) => ({ token: w.symbol, weightBps: w.weightBps }));
  }

  // Initial mount: stagger rows in, bars grow from 0.
  useGSAP(
    () => {
      gsap.from(".alloc-row", {
        x: -12,
        opacity: 0,
        duration: 0.5,
        stagger: 0.08,
        ease: "power3.out",
        scrollTrigger: { trigger: ref.current, start: "top 85%" },
      });
      gsap.utils.toArray<HTMLDivElement>(".alloc-row .bar").forEach((bar) => {
        const target = bar.getAttribute("data-w") || "0";
        gsap.fromTo(
          bar,
          { width: 0 },
          {
            width: `${target}%`,
            duration: 1.4,
            ease: "expo.out",
            scrollTrigger: { trigger: ref.current, start: "top 85%" },
          },
        );
      });
    },
    { scope: ref },
  );

  // On every rebalance, animate bars from current to new widths + flash.
  useEffect(() => {
    if (rebalanceTick === 0) return;
    const bars = ref.current?.querySelectorAll<HTMLDivElement>(".alloc-row .bar") ?? [];
    const wraps = ref.current?.querySelectorAll<HTMLDivElement>(".alloc-row .bar-wrap") ?? [];
    bars.forEach((bar) => {
      const target = bar.getAttribute("data-w") || "0";
      gsap.to(bar, { width: `${target}%`, duration: 1.0, ease: "power3.inOut" });
    });
    wraps.forEach((wrap) => {
      gsap.fromTo(
        wrap,
        { boxShadow: "0 0 0 1px rgba(208,255,0,0.0), 0 0 0 rgba(208,255,0,0)" },
        {
          boxShadow: "0 0 0 1px rgba(208,255,0,0.9), 0 0 18px rgba(208,255,0,0.6)",
          duration: 0.3,
          yoyo: true,
          repeat: 1,
          ease: "power2.out",
        },
      );
    });
    if (tagRef.current) {
      gsap.fromTo(
        tagRef.current,
        { opacity: 0, y: -6 },
        { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" },
      );
      gsap.to(tagRef.current, {
        opacity: 0,
        duration: 0.5,
        delay: 2.4,
        ease: "power2.in",
      });
    }
  }, [rebalanceTick]);

  return (
    <section ref={ref} className="sec">
      <div className="label">
        <span className="num">§03</span> Active allocation · epoch {live?.basket?.epoch ?? 42}
        <span ref={tagRef} className="rebalance-tag">REBALANCED</span>
      </div>
      <div className="alloc">
        {alloc.map((a, i) => (
          <div key={a.token} className="alloc-row">
            <div className="tok">{a.token}</div>
            <div className="bar-wrap">
              <div className={`bar ${i === alloc.length - 1 ? "dim" : ""}`} data-w={a.weightBps / 100} />
            </div>
            <div className="pct">{fmtPct(a.weightBps)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------- epoch explainer (pinned horizontal scroll) ------- */

const PHASES = [
  {
    num: "01",
    name: "Intent",
    desc: "LPs deposit USDC into DaioVault. ERC-4626 shares are minted pro-rata at the current NAV. Capital is queued for the next epoch's allocation.",
    flow: [
      { box: "LP",       hi: false },
      { box: "USDC",     hi: true  },
      { box: "DaioVault",hi: false },
      { box: "dvUSDC",   hi: true  },
    ],
  },
  {
    num: "02",
    name: "Commit",
    desc: "Each registered agent computes an allocation locally and submits a hash to ProposalRound. The actual weights stay sealed until the reveal window opens.",
    flow: [
      { box: "Agent",          hi: false },
      { box: "EIP-712 sign",   hi: false },
      { box: "keccak256",      hi: false },
      { box: "ProposalRound",  hi: true  },
    ],
  },
  {
    num: "03",
    name: "Reveal",
    desc: "Commit window closes. Agents reveal the proposal plus signature. Each reveal is verified against the prior commit. Late or mismatched reveals are dropped.",
    flow: [
      { box: "Agent",         hi: false },
      { box: "Proposal + sig",hi: true  },
      { box: "verify hash",   hi: false },
      { box: "accept",        hi: true  },
    ],
  },
  {
    num: "04",
    name: "Consensus",
    desc: "Revealed proposals are clustered by L1 distance under a 500bps tolerance. The cluster holding the highest aggregate stake wins. Its median allocation becomes the next active basket.",
    flow: [
      { box: "reveals[]",    hi: false },
      { box: "cluster",      hi: false },
      { box: "stake-weight", hi: true  },
      { box: "median",       hi: true  },
    ],
  },
  {
    num: "05",
    name: "Settle",
    desc: "AllocationExecutor swaps the vault to the elected basket. PerformanceFee distributes to winning agents via x402. Slashing penalises outliers in losing clusters if the epoch was profitable.",
    flow: [
      { box: "Executor swap", hi: false },
      { box: "x402 fee",      hi: true  },
      { box: "Slashing",      hi: true  },
      { box: "Epoch +1",      hi: false },
    ],
  },
];

function EpochExplainer({ phase }: { phase: Phase }) {
  const ref = useRef<HTMLElement>(null);
  const activeIdx = Math.max(0, PHASE_ORDER.indexOf(phase));
  const [selected, setSelected] = useState(activeIdx);

  // when the live phase advances, follow it (unless user has manually picked a different node)
  const lastActiveRef = useRef(activeIdx);
  useEffect(() => {
    if (lastActiveRef.current !== activeIdx) {
      setSelected(activeIdx);
      lastActiveRef.current = activeIdx;
    }
  }, [activeIdx]);

  useGSAP(
    () => {
      gsap.from(".epx-node", {
        y: 12,
        opacity: 0,
        duration: 0.5,
        stagger: 0.08,
        ease: "power3.out",
        scrollTrigger: { trigger: ref.current, start: "top 85%" },
      });
      gsap.fromTo(
        ".epx-rail-fill",
        { scaleX: 0 },
        {
          scaleX: 1,
          duration: 1.2,
          ease: "expo.out",
          transformOrigin: "left center",
          delay: 0.15,
          scrollTrigger: { trigger: ref.current, start: "top 85%" },
        },
      );
      gsap.from(".epx-panel", {
        y: 12,
        opacity: 0,
        duration: 0.6,
        ease: "power3.out",
        delay: 0.45,
        scrollTrigger: { trigger: ref.current, start: "top 85%" },
      });
    },
    { scope: ref },
  );

  // cross-fade panel when selection changes
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!panelRef.current) return;
    gsap.fromTo(
      panelRef.current,
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" },
    );
  }, [selected]);

  const phaseDetail = PHASES[selected];
  const stateOf = (i: number) =>
    i < activeIdx ? "done" : i === activeIdx ? "active" : "upcoming";
  const fillPct = (activeIdx / (PHASES.length - 1)) * 100;

  return (
    <section ref={ref} className="sec">
      <div className="label"><span className="num">§02</span> How an epoch works</div>

      <div className="epx-timeline">
        <div className="epx-rail">
          <div className="epx-rail-fill" style={{ width: `${fillPct}%` }} />
        </div>
        <div className="epx-nodes">
          {PHASES.map((p, i) => {
            const st = stateOf(i);
            return (
              <button
                key={p.num}
                className={`epx-node state-${st} ${selected === i ? "selected" : ""}`}
                onClick={() => setSelected(i)}
                onMouseEnter={() => setSelected(i)}
                aria-current={st === "active" ? "step" : undefined}
              >
                <span className="dot">
                  {st === "active" && <span className="pulse" />}
                </span>
                <span className="num">{p.num}</span>
                <span className="name">{p.name}</span>
                {st === "active" && <span className="current">Current</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div ref={panelRef} className="epx-panel">
        <div className="epx-panel-meta">
          <div className="num">{phaseDetail.num}</div>
          <div className="name">{phaseDetail.name}</div>
          <div className="state">{stateOf(selected)}</div>
        </div>
        <div className="epx-panel-body">
          <div className="desc">{phaseDetail.desc}</div>
          <div className="flow">
            {phaseDetail.flow.map((f, i) => (
              <span key={f.box} className="step">
                <span className={`box ${f.hi ? "hi" : ""}`}>{f.box}</span>
                {i < phaseDetail.flow.length - 1 && <span className="arrow">→</span>}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------- agents + feed ------- */

function TwoCol({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <section className="sec">
      <div className="row-2">{left}{right}</div>
    </section>
  );
}

function AgentSection({ live }: { live: DaioLive | null }) {
  const ref = useRef<HTMLDivElement>(null);

  // Live override: replace the hardcoded bond/reputation/active with on-chain
  // values for any AGENT_DETAILS entry whose address matches a live record.
  const liveByAddr: Record<string, AgentLive> = {};
  for (const a of live?.agents ?? []) liveByAddr[a.addr.toLowerCase()] = a;

  const agents: AgentDetail[] = AGENT_DETAILS.map((a) => {
    const onchain = liveByAddr[a.addr.toLowerCase()];
    if (!onchain) return a;
    return {
      ...a,
      reputation: onchain.reputation,
      stake: onchain.bond,
      epochStatus: onchain.active ? a.epochStatus : "pending",
      epochStatusDetail: onchain.active ? a.epochStatusDetail : "not registered",
    };
  });

  useGSAP(
    () => {
      gsap.from(".agent-card", {
        y: 18,
        opacity: 0,
        duration: 0.55,
        stagger: 0.1,
        ease: "power3.out",
        scrollTrigger: { trigger: ref.current, start: "top 85%" },
      });
      gsap.utils.toArray<HTMLDivElement>(".agent-card .mini-bar").forEach((bar) => {
        const target = bar.getAttribute("data-w") || "0";
        gsap.fromTo(bar, { width: 0 }, {
          width: `${target}%`,
          duration: 1.4,
          ease: "expo.out",
          scrollTrigger: { trigger: ref.current, start: "top 85%" },
        });
      });
    },
    { scope: ref },
  );
  return (
    <div ref={ref}>
      <div className="label" style={{ color: "var(--fg-dim)", fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", marginBottom: 24, display: "flex", alignItems: "baseline", gap: 14 }}>
        <span style={{ color: "var(--fg)", fontWeight: 500 }}>§05</span> Agent members
        {live && <span style={{ color: "var(--accent)", marginLeft: "auto" }}>on-chain</span>}
      </div>
      <div className="agent-grid">
        {agents.map((a) => <AgentCard key={a.addr} agent={a} />)}
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentDetail }) {
  const st = agent.epochStatus;
  return (
    <article className={`agent-card status-${st}`}>
      <div className="card-accent" />
      <header className="card-head">
        <div className="identity">
          <span className={`agent-status ${st}`}>
            {st === "pending" ? <span className="circle" /> : "✓"}
          </span>
          <h3 className="name">{agent.name}</h3>
        </div>
        <span className="specialty-pill">{agent.specialtyLabel}</span>
      </header>

      <div className="addr-row"><CopyAddr value={agent.addr} /></div>

      <p className="blurb">{agent.blurb}</p>

      <div className="card-block">
        <div className="block-head">
          <span>This epoch</span>
          <span className={`tag ${st}`}>{st}</span>
        </div>
        <div className="block-body">{agent.epochStatusDetail}</div>
      </div>

      <div className="card-block">
        <div className="block-head">
          <span>Last revealed</span>
          <span className="dim">epoch 41</span>
        </div>
        <div className="mini-bars">
          {agent.lastReveal.map((r, i) => (
            <div key={r.token} className="mini-row">
              <span className="tok">{r.token}</span>
              <div className="bar-wrap">
                <div className={`mini-bar ${i === agent.lastReveal.length - 1 ? "dim" : ""}`} data-w={r.weight / 100} />
              </div>
              <span className="pct">{(r.weight / 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>

      <footer className="card-foot">
        <div className="foot-stat">
          <span className="k">Reputation</span>
          <span className="v">{agent.reputation}</span>
        </div>
        <div className="foot-stat">
          <span className="k">Bonded</span>
          <span className="v">{agent.stake.toLocaleString()}<span className="unit"> USDC</span></span>
        </div>
      </footer>
    </article>
  );
}

function FeedSection({ feed }: { feed: FeedEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      gsap.from(".feed", {
        x: 16,
        opacity: 0,
        duration: 0.6,
        ease: "power3.out",
        scrollTrigger: { trigger: ref.current, start: "top 85%" },
      });
    },
    { scope: ref },
  );

  // slide in newest feed entry
  useEffect(() => {
    if (!listRef.current) return;
    const first = listRef.current.firstElementChild;
    if (!first) return;
    gsap.fromTo(
      first,
      { x: 24, opacity: 0 },
      { x: 0, opacity: 1, duration: 0.4, ease: "power3.out" },
    );
  }, [feed]);

  return (
    <div ref={ref}>
      <div className="label" style={{ color: "var(--fg-dim)", fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", marginBottom: 24, display: "flex", alignItems: "baseline", gap: 14 }}>
        <span style={{ color: "var(--fg)", fontWeight: 500 }}>§06</span> Live feed
      </div>
      <div className="feed">
        <div ref={listRef}>
          {feed.map((f) => (
            <div key={f.id} className="feed-row">
              <div className="time">{f.time}</div>
              <div className="who">{f.who}</div>
              <div className="what">{f.what}</div>
              <div className={`tag ${f.tag}`}>{f.tag}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------- position ------- */

function PositionSection({ wallet, live }: { wallet: WalletState; live: DaioLive | null }) {
  const ref = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      gsap.from(".pos", {
        y: 24,
        opacity: 0,
        duration: 0.7,
        ease: "power3.out",
        scrollTrigger: { trigger: ref.current, start: "top 85%" },
      });
    },
    { scope: ref },
  );

  const connected = !!wallet.address;
  const rightChain = wallet.isCorrectChain;

  /* live share balance — polled every 10s, also triggerable on demand */
  const [shares, setShares] = useState<string>("0");
  const refreshShares = useCallback(async () => {
    if (!connected || !rightChain || !wallet.address) { setShares("0"); return; }
    try {
      const { JsonRpcProvider, Contract, formatUnits } = await import("ethers");
      const provider = new JsonRpcProvider(DEFAULT_CHAIN.rpc);
      const vault = new Contract(
        DAIO_VAULT_FRONTEND,
        ["function balanceOf(address) view returns (uint256)"],
        provider,
      );
      const bal = (await vault.balanceOf(wallet.address)) as bigint;
      setShares(formatUnits(bal, DEFAULT_CHAIN.usdcDecimals));
    } catch { /* keep previous value */ }
  }, [connected, rightChain, wallet.address]);

  useEffect(() => {
    void refreshShares();
    const id = window.setInterval(refreshShares, 10_000);
    return () => window.clearInterval(id);
  }, [refreshShares]);

  const sharesNum = parseFloat(shares) || 0;
  const sharesUsdc = sharesNum * (live?.navPerShare ?? 1);

  /* action handlers */
  const [amount, setAmount] = useState("1000");
  const [busy, setBusy] = useState<null | "mint" | "deposit" | "withdraw">(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const doAction = async (kind: "mint" | "deposit" | "withdraw") => {
    if (!window.ethereum || !wallet.address) return;
    setActionError(null);
    setBusy(kind);
    try {
      const { JsonRpcProvider, Contract, Interface, parseUnits, toBeHex } = await import("ethers");
      // Reads via Alchemy (reliable). Writes via raw window.ethereum.request —
      // bypasses ethers' Contract write abstraction whose parallel populate
      // (gas / chainId / nonce) is the source of "could not coalesce error".
      const readProvider = new JsonRpcProvider(DEFAULT_CHAIN.rpc);
      const amt = parseUnits(amount, DEFAULT_CHAIN.usdcDecimals);
      const eth = window.ethereum!;

      // Pull current EIP-1559 fee floor so the tx isn't rejected for
      // maxFeePerGas < baseFee.
      const latestBlock = await readProvider.getBlock("latest");
      const baseFee = latestBlock?.baseFeePerGas ?? 1_000_000n; // fallback 0.001 gwei
      const tip = 1_000_000n; // 0.001 gwei priority
      const maxFeePerGas = baseFee * 3n + tip; // 3x base + tip; plenty of headroom

      const sendRaw = async (to: string, data: string): Promise<void> => {
        const hash = (await eth.request({
          method: "eth_sendTransaction",
          params: [{
            from: wallet.address,
            to,
            data,
            gas: toBeHex(400_000n),
            maxFeePerGas: toBeHex(maxFeePerGas),
            maxPriorityFeePerGas: toBeHex(tip),
          }],
        })) as string;
        // Poll Alchemy for the receipt — avoids MetaMask's
        // getTransactionReceipt which has been the source of coalesce wrappers.
        for (let i = 0; i < 60; i++) {
          const r = await readProvider.getTransactionReceipt(hash);
          if (r) {
            if (r.status === 0) throw new Error("tx reverted on-chain");
            return;
          }
          await new Promise((res) => setTimeout(res, 1500));
        }
        throw new Error("tx confirmation timed out (90s)");
      };

      // Interfaces just for calldata encoding — no provider/signer attached.
      const usdcIface = new Interface([
        "function mint(address,uint256)",
        "function approve(address,uint256) returns (bool)",
      ]);
      const vaultIface = new Interface([
        "function deposit(uint256,address) returns (uint256)",
        "function withdraw(uint256,address,address) returns (uint256)",
      ]);

      if (kind === "mint") {
        const data = usdcIface.encodeFunctionData("mint", [wallet.address, amt]);
        await sendRaw(DEFAULT_CHAIN.usdc, data);
      } else if (kind === "deposit") {
        const { formatUnits } = await import("ethers");
        // Read balance + allowance via Alchemy.
        const usdcRead = new Contract(
          DEFAULT_CHAIN.usdc,
          [
            "function balanceOf(address) view returns (uint256)",
            "function allowance(address,address) view returns (uint256)",
          ],
          readProvider,
        );
        const bal = (await usdcRead.balanceOf(wallet.address)) as bigint;
        if (bal < amt) {
          const balStr = formatUnits(bal, DEFAULT_CHAIN.usdcDecimals);
          throw new Error(
            `insufficient USDC. You have ${parseFloat(balStr).toLocaleString(
              "en-US",
              { style: "currency", currency: "USD" },
            )}. Click Faucet to mint more.`,
          );
        }
        const allowance = (await usdcRead.allowance(wallet.address, DAIO_VAULT_FRONTEND)) as bigint;
        if (allowance < amt) {
          const approveData = usdcIface.encodeFunctionData("approve", [DAIO_VAULT_FRONTEND, amt]);
          await sendRaw(DEFAULT_CHAIN.usdc, approveData);
        }
        const depositData = vaultIface.encodeFunctionData("deposit", [amt, wallet.address]);
        await sendRaw(DAIO_VAULT_FRONTEND, depositData);
      } else if (kind === "withdraw") {
        const { formatUnits } = await import("ethers");
        const vaultRead = new Contract(
          DAIO_VAULT_FRONTEND,
          ["function maxWithdraw(address) view returns (uint256)"],
          readProvider,
        );
        const max = (await vaultRead.maxWithdraw(wallet.address)) as bigint;
        if (amt > max) {
          const maxStr = formatUnits(max, DEFAULT_CHAIN.usdcDecimals);
          throw new Error(
            `withdraw exceeds your position. max: ${parseFloat(maxStr).toLocaleString(
              "en-US",
              { style: "currency", currency: "USD" },
            )}`,
          );
        }
        const withdrawData = vaultIface.encodeFunctionData("withdraw", [
          amt,
          wallet.address,
          wallet.address,
        ]);
        await sendRaw(DAIO_VAULT_FRONTEND, withdrawData);
      }
      // Both wallet balance and vault shares are now stale by ~1 block.
      // Refresh both immediately via Alchemy.
      await Promise.all([wallet.refresh(), refreshShares()]);
    } catch (e: unknown) {
      // eslint-disable-next-line no-console
      console.error("[daio] action failed", kind, e);
      const err = e as {
        code?: string | number;
        shortMessage?: string;
        reason?: string;
        info?: { error?: { message?: string; code?: number } };
        message?: string;
        errors?: Array<{ shortMessage?: string; message?: string; code?: string | number }>;
      };
      const head =
        err?.info?.error?.message ??
        err?.shortMessage ??
        err?.reason ??
        err?.message ??
        "failed";
      // Surface the inner errors array for coalesce errors so we can see
      // exactly which underlying RPC call failed.
      const innerDetail = (err.errors ?? [])
        .map((x) => x?.shortMessage ?? x?.message ?? String(x?.code ?? "?"))
        .filter(Boolean)
        .join("  |  ");
      const codeStr = err?.code !== undefined ? `[${err.code}] ` : "";
      const msg = innerDetail ? `${codeStr}${head}  ::  ${innerDetail}` : `${codeStr}${head}`;
      setActionError(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section ref={ref} className="sec">
      <div className="label"><span className="num">§04</span> Your position</div>
      <div className="pos">
        <div>
          <div className="k">Wallet USDC</div>
          <div className="v">
            {connected && rightChain ? fmtBalance(wallet.usdcBalance, 2) : "—"}{" "}
            <span style={{ color: "var(--fg-dim)", fontSize: 13 }}>USDC</span>
          </div>
          {connected && rightChain && (
            <div className="k" style={{ marginTop: 4 }}>
              {fmtBalance(wallet.ethBalance, 4)} {DEFAULT_CHAIN.nativeSymbol} for gas
            </div>
          )}
        </div>
        <div>
          <div className="k">Vault shares</div>
          <div className="v">
            {connected && rightChain ? fmtBalance(shares, 2) : "—"}{" "}
            <span style={{ color: "var(--fg-dim)", fontSize: 13 }}>dvUSDC</span>
          </div>
          {connected && rightChain && sharesNum > 0 && (
            <div className="k" style={{ marginTop: 4 }}>
              ≈ {sharesUsdc.toLocaleString("en-US", { style: "currency", currency: "USD" })} at current NAV
            </div>
          )}
        </div>
        <div className="actions">
          {!connected ? (
            <Btn primary onClick={wallet.connect}>
              {wallet.connecting ? "Connecting…" : "Connect wallet"}
            </Btn>
          ) : !rightChain ? (
            <Btn primary onClick={wallet.switchNetwork}>Switch to {DEFAULT_CHAIN.name}</Btn>
          ) : (
            <div className="pos-action-stack">
              <input
                className="pos-amount"
                type="number"
                min="0"
                step="100"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!!busy}
                placeholder="USDC"
              />
              <div className="pos-btn-row">
                <Btn ghost onClick={() => doAction("mint")}>
                  {busy === "mint" ? "Minting…" : "Faucet"}
                </Btn>
                <Btn primary onClick={() => doAction("deposit")}>
                  {busy === "deposit" ? "Depositing…" : "Deposit"}
                </Btn>
                <Btn ghost onClick={() => doAction("withdraw")}>
                  {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
                </Btn>
              </div>
            </div>
          )}
        </div>
      </div>
      {(wallet.error || actionError) && (
        <div className="pos-error">{actionError ?? wallet.error}</div>
      )}
    </section>
  );
}

// Mirrors the DaioVault address in daio.ts. Kept inline so PositionSection
// can read it without importing through useDaioLive's hook surface.
const DAIO_VAULT_FRONTEND = "0xe5805cd2ff4b6c0455fe5ec240081c84d27fc9f4";

/* ------- magnetic button with sweep ------- */

function Btn({
  children,
  primary,
  ghost,
  onClick,
}: {
  children: React.ReactNode;
  primary?: boolean;
  ghost?: boolean;
  onClick?: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const sweepRef = useRef<HTMLSpanElement>(null);

  const onMove = (e: React.MouseEvent) => {
    const el = btnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    gsap.to(el, { x: x * 0.25, y: y * 0.4, duration: 0.4, ease: "power3.out" });
  };

  const onEnter = () => {
    if (sweepRef.current) {
      gsap.fromTo(
        sweepRef.current,
        { xPercent: -110 },
        { xPercent: 110, duration: 0.7, ease: "power3.inOut" },
      );
    }
  };

  const onLeave = () => {
    if (btnRef.current) {
      gsap.to(btnRef.current, { x: 0, y: 0, duration: 0.6, ease: "elastic.out(1, 0.4)" });
    }
  };

  const cls = ["btn", primary && "primary", ghost && "ghost"].filter(Boolean).join(" ");
  return (
    <button
      ref={btnRef}
      className={cls}
      onClick={onClick}
      onMouseMove={onMove}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <span ref={sweepRef} className="sweep" />
      <span className="label">{children}</span>
    </button>
  );
}

/* ------- copyable address ------- */

function CopyAddr({ value }: { value: string }) {
  const chipRef = useRef<HTMLSpanElement>(null);
  const onClick = async () => {
    try { await navigator.clipboard.writeText(value); } catch { /* ignore */ }
    if (!chipRef.current) return;
    gsap.killTweensOf(chipRef.current);
    gsap.fromTo(
      chipRef.current,
      { opacity: 0, x: -6 },
      { opacity: 1, x: 0, duration: 0.25, ease: "power3.out" },
    );
    gsap.to(chipRef.current, { opacity: 0, duration: 0.4, delay: 1.2, ease: "power2.in" });
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      <span className="copy-addr" onClick={onClick} title="Copy address">{value}</span>
      <span ref={chipRef} className="copy-chip">Copied</span>
    </span>
  );
}

/* ------- footer ------- */

function AppFooter() {
  return (
    <footer className="app-footer">
      <div>Daio · Arbitrum Open House London 2026</div>
      <div><a href={SITE_URL}>← back to site</a></div>
    </footer>
  );
}

/* ------- helpers ------- */

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
