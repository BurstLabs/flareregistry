import Link from "next/link";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// PUBLIC oracle-independence dashboard.
//
// Aggregate only, by design. This renders the DIRECT measurement (how often pairs of providers submit
// byte-identical values) and never the example-provider classification, which is inference carrying
// zero confirmed positives. No provider is named and no per-provider rate is shown, which is what
// honours the commitment published on /detection.
//
// Deliberately NOT linked from the site navigation: this is the preview of a product intended to live
// on its own domain, and adding it to the nav would be a launch rather than a preview.

const THRESHOLD = 0.6;

function pct(x: number | null | undefined, dp = 1) {
  return x == null ? "n/a" : `${(x * 100).toFixed(dp)}%`;
}

async function getData() {
  const network = "flare";
  const snaps = await prisma.correlationSnapshot.findMany({
    where: { network },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  if (!snaps.length) return null;
  const latest = snaps[0].createdAt.getTime();
  const current = snaps.filter((s) => latest - s.createdAt.getTime() < 120_000);

  const onchain = await prisma.providerOnchain.findMany({
    where: { network, NOT: { registrationWeight: null } },
    select: { voter: true, submitAddress: true, registrationWeight: true },
  });
  const weightBy = new Map<string, number>();
  let totalWeight = 0;
  for (const e of onchain) {
    const w = Number(e.registrationWeight);
    totalWeight += w;
    for (const a of [e.submitAddress, e.voter]) if (a) weightBy.set(a.toLowerCase(), w);
  }
  let correlatedWeight = 0;
  for (const s of current) {
    if (s.peersAbove > 0) correlatedWeight += weightBy.get(s.voter.toLowerCase()) ?? 0;
  }

  const rates = current.map((s) => s.maxRate).sort((a, b) => a - b);
  const q = (p: number) => rates[Math.min(rates.length - 1, Math.floor(p * rates.length))];
  const bands: [number, number][] = [
    [0, 0.2], [0.2, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1.01],
  ];

  return {
    measuredAt: snaps[0].createdAt,
    fromRound: current[0].fromRound,
    toRound: current[0].toRound,
    providers: current.length,
    correlated: current.filter((s) => s.peersAbove > 0).length,
    correlatedWeightPct: totalWeight > 0 ? correlatedWeight / totalWeight : null,
    median: q(0.5),
    max: rates[rates.length - 1],
    distribution: bands.map(([lo, hi]) => ({
      lo, hi, n: current.filter((s) => s.maxRate >= lo && s.maxRate < hi).length,
    })),
  };
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="surface rounded-xl border p-4">
      <div className="text-xs uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-fg">{value}</div>
      {hint ? <div className="mt-1 text-xs leading-relaxed text-muted">{hint}</div> : null}
    </div>
  );
}

export default async function IndependencePage() {
  const d = await getData();

  if (!d) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold">Oracle independence</h1>
        <p className="mt-3 text-sm text-muted">No measurement has been recorded yet.</p>
      </div>
    );
  }

  const peak = Math.max(...d.distribution.map((b) => b.n), 1);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="text-xs uppercase tracking-wide text-flare">Preview</div>
      <h1 className="mt-1 text-3xl font-bold">Oracle independence</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        An oracle&apos;s resilience rests on independent observation. This measures how much of that
        independence is real, by counting how often pairs of Flare FTSO providers submit{" "}
        <strong className="text-fg">byte-identical values</strong>. Identical to the last digit, not
        close.
      </p>

      <div className="surface mt-6 rounded-xl border p-5">
        <div className="text-xs uppercase tracking-wide text-faint">
          Voting power submitting values identical to another provider
        </div>
        <div className="mt-2 text-5xl font-bold tabular-nums text-flare">
          {pct(d.correlatedWeightPct)}
        </div>
        <div className="mt-2 text-sm leading-relaxed text-muted">
          {d.correlated} of {d.providers} providers agree to the last digit with at least one peer on
          more than {Math.round(THRESHOLD * 100)}% of priced values. Weighted by FIP.16 registration
          weight, the unit the protocol actually votes in.
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="Median provider"
          value={pct(d.median)}
          hint="Typical provider's agreement with its closest peer."
        />
        <Stat
          label="Highest pair"
          value={pct(d.max)}
          hint="The most correlated provider in the set."
        />
        <Stat
          label="Providers measured"
          value={String(d.providers)}
          hint={`Rounds ${d.fromRound.toLocaleString()} to ${d.toRound.toLocaleString()}.`}
        />
      </div>

      <h2 className="mt-10 text-xl font-semibold">Distribution</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Each provider&apos;s agreement with its single closest peer. A healthy oracle would cluster on
        the left. This one is bimodal: a large independent group, and a block that agrees almost
        perfectly.
      </p>
      <div className="surface mt-4 space-y-2 rounded-xl border p-4">
        {d.distribution.map((b) => (
          <div key={b.lo} className="flex items-center gap-3">
            <div className="w-20 shrink-0 text-right text-xs tabular-nums text-muted">
              {Math.round(b.lo * 100)}
              {"–"}
              {Math.round(Math.min(b.hi, 1) * 100)}%
            </div>
            <div className="h-5 flex-1 overflow-hidden rounded bg-elev">
              <div
                className={`h-full rounded ${b.lo >= THRESHOLD ? "bg-flare" : "bg-beacon/40"}`}
                style={{ width: `${Math.max(2, (b.n / peak) * 100)}%` }}
              />
            </div>
            <div className="w-8 shrink-0 text-right text-xs tabular-nums text-fg">{b.n}</div>
          </div>
        ))}
      </div>

      <h2 className="mt-10 text-xl font-semibold">What this is, and what it is not</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted">
        <p>
          This is a <strong className="text-fg">direct measurement</strong>. It reads reveals off the
          chain and counts cells where two providers&apos; encoded values match exactly. There is no
          model, no calibration, no reference implementation and no threshold inside the measurement
          itself. Anyone with an RPC endpoint can reproduce it.
        </p>
        <p>
          It does <strong className="text-fg">not</strong>{" "}establish why any two providers agree, and it
          alleges nothing about anyone&apos;s conduct. Independent operators running the same published
          software produce the same signature as any other cause of correlation. No provider is named
          here, and no per-provider figure is published.
        </p>
        <p>
          Correlation is not a quality problem. Providers in the correlated group perform at or slightly
          above the network average. The concern is that when observers move together, one upstream
          fault reaches many participants at once and arrives looking like consensus rather than like a
          fault.
        </p>
      </div>

      <div className="surface mt-6 rounded-xl border p-4 text-sm leading-relaxed text-muted">
        Full method, including the formulae and the contract addresses needed to reproduce it, is at{" "}
        <Link href="/detection" className="text-beacon hover:underline">
          /detection
        </Link>
        . The aggregate data behind this page is served from{" "}
        <Link href="/api/independence" className="text-beacon hover:underline">
          /api/independence
        </Link>
        .
      </div>

      <p className="mt-6 text-xs text-faint">
        Measured {d.measuredAt.toISOString().slice(0, 16).replace("T", " ")} UTC over rounds{" "}
        {d.fromRound.toLocaleString()} to {d.toRound.toLocaleString()}. Updated every six hours.
      </p>
    </div>
  );
}
