"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useWalletSign } from "@/lib/useWalletSign";
import {
  LATTICE_MIN_TRIALS,
  LATTICE_LIFT_EXCLUDE,
  PATTERN_MIN_ROUNDS,
  PATTERN_STRONG,
  PATTERN_CANDIDATE,
} from "@/lib/detection";

// Operator-only admin dashboard. English-only (internal tool, not a user-facing page). Access is
// gated by ADMIN_ADDRESSES: sign in with an allowlisted wallet (reusing the SIWE flow) to unlock it.

type Tab =
  | "stats"
  | "providers"
  | "imports"
  | "qualification"
  | "governance"
  | "conduct"
  | "reports"
  | "consumers"
  | "detection"
  | "telegram"
  | "system";

// Minimal English-only translator so the shared wallet-sign hook (which throws localised keys) shows
// readable copy in this internal tool without pulling in the full i18n context.
const ADMIN_STRINGS: Record<string, string> = {
  "submit.err.noAccount": "No account.",
  "submit.err.noChallenge": "Could not get a challenge.",
  "submit.err.wrongAccount": "Wrong account.",
};
const adminT = (key: string) => ADMIN_STRINGS[key] ?? key;

export default function AdminPage() {
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("stats");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Counts of items awaiting admin action, shown as (n) badges on the relevant tabs.
  const [counts, setCounts] = useState<Partial<Record<Tab, number>>>({});
  const connectAndSign = useWalletSign(adminT);
  // The live connected wallet. The admin session (a cookie) and the connected wallet are independent,
  // so we must reconcile them: access is granted only when the session is an admin AND the wallet
  // currently connected is that same admin address. Otherwise a stale admin session would keep the
  // dashboard open even after the user switches MetaMask to a different (non-admin) account.
  const { address: walletAddress, isConnected } = useAccount();

  const checkSession = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/session");
      const b = await r.json();
      setAdmin(!!b.admin);
      setAddress(b.address ?? null);
    } catch {
      setAdmin(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // Effective access: admin session AND the connected wallet matches the session's admin address.
  // If no wallet is connected, or it differs, the dashboard is withheld even though the session is
  // valid - the operator must connect the admin wallet (and can re-sign via the gate below).
  const walletMatchesSession =
    isConnected &&
    !!walletAddress &&
    !!address &&
    walletAddress.toLowerCase() === address.toLowerCase();
  const hasAccess = admin === true && walletMatchesSession;

  // Pull the pending-action counts for the tab badges once access is granted. Maps the API's keys to
  // the tabs that surface a review queue; other tabs get no badge.
  const loadCounts = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/pending-counts");
      if (!r.ok) return;
      const b = await r.json();
      setCounts({
        imports: b.imports ?? 0,
        governance: b.governance ?? 0,
        // Conduct has its own badge. It used to have none while its cases were counted under
        // Governance, so the one tab that could show a sealed case was the one with no indicator
        // that anything was waiting in it.
        conduct: b.conduct ?? 0,
        reports: b.reports ?? 0,
        consumers: b.consumers ?? 0,
      });
    } catch {
      /* best-effort; badges just don't show */
    }
  }, []);
  useEffect(() => {
    if (hasAccess) loadCounts();
  }, [hasAccess, loadCounts]);

  async function connect() {
    setErr("");
    setBusy(true);
    try {
      const { message, signature } = await connectAndSign({ chainId: 14, action: "session" });
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      if (!verifyRes.ok) throw new Error("Verification failed.");
      await checkSession();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  if (admin === null) {
    return <div className="mx-auto max-w-5xl p-6 text-sm text-muted">Loading…</div>;
  }

  if (!hasAccess) {
    // Explain WHY access is withheld: not an admin session at all, an admin session but a different
    // (or no) wallet connected, or simply not signed in. The connected wallet must match the admin.
    const reason = !admin
      ? address
        ? `Signed in as ${address.slice(0, 6)}…${address.slice(-4)}, which is not an admin address.`
        : "Connect an admin wallet to continue."
      : !isConnected
        ? "Your admin session is valid, but no wallet is connected. Connect the admin wallet to continue."
        : !walletMatchesSession
          ? `The connected wallet (${walletAddress?.slice(0, 6)}…${walletAddress?.slice(-4)}) is not the admin. Switch to the admin wallet and sign in.`
          : "Connect an admin wallet to continue.";
    return (
      <div className="mx-auto max-w-md p-6">
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="mt-2 text-sm text-muted">{reason}</p>
        <button
          onClick={connect}
          disabled={busy}
          className="mt-4 rounded-lg bg-beacon px-4 py-2 font-medium text-neutral-950 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Signing…" : "Connect admin wallet"}
        </button>
        {err && <p className="mt-3 text-sm text-flare">{err}</p>}
      </div>
    );
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: "stats", label: "Statistics" },
    { id: "providers", label: "Providers" },
    { id: "imports", label: "Imports" },
    { id: "qualification", label: "Qualification" },
    { id: "governance", label: "Governance" },
    { id: "conduct", label: "Conduct" },
    { id: "reports", label: "Logo reports" },
    { id: "consumers", label: "Consumers" },
    { id: "telegram", label: "Telegram" },
    { id: "system", label: "System" },
  ];

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">Admin</h1>
        <span className="text-xs text-faint">
          {address?.slice(0, 6)}…{address?.slice(-4)}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-1 border-b border-themed">
        {TABS.map((tb) => {
          const n = counts[tb.id] ?? 0;
          return (
          <button
            key={tb.id}
            onClick={() => {
              setTab(tb.id);
              // Refresh badges on navigation so a queue you just cleared updates without a page reload.
              loadCounts();
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === tb.id
                ? "border-beacon text-fg"
                : "border-transparent text-muted hover:text-beacon"
            }`}
          >
            {tb.label}
            {n > 0 && (
              <span className="ml-1.5 rounded-full bg-beacon/20 px-1.5 py-0.5 text-[11px] font-semibold text-beacon">
                {n}
              </span>
            )}
          </button>
          );
        })}
      </div>
      <div className="mt-6">
        {tab === "stats" && <StatsTab />}
        {tab === "providers" && <ProvidersTab />}
        {tab === "imports" && <ImportsTab />}
        {tab === "qualification" && <QualificationTab />}
        {tab === "governance" && <GovernanceTab />}
        {tab === "conduct" && <ConductTab />}
        {tab === "reports" && <ReportsTab onChanged={loadCounts} />}
        {tab === "consumers" && <ConsumersTab />}
        {tab === "telegram" && <TelegramTab />}
        {tab === "system" && <SystemTab />}
      </div>
    </div>
  );
}

// ---------- shared ----------
function Card({ children }: { children: React.ReactNode }) {
  return <div className="surface rounded-xl border p-4">{children}</div>;
}
function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="surface rounded-lg border p-3">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-faint">{label}</div>
    </div>
  );
}
const CHAIN_NAME: Record<number, string> = { 14: "Flare", 19: "Songbird" };

// ---------- Statistics ----------
function StatsTab() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/admin/stats")
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : setData(d)))
      .catch(() => setErr("Failed to load stats."));
  }, []);
  if (err) return <p className="text-sm text-flare">{err}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;
  const c = data.counts;
  const maxHits = Math.max(1, ...data.traffic.trafficByDay.map((d: any) => d.hits));
  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted">Registry</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Providers" value={c.providers} />
          <Stat label="Claimed (submitted)" value={c.submitted} />
          <Stat label="Imported (unclaimed)" value={c.imported} />
          <Stat label="Verified addresses" value={c.verifiedAddrs} />
          <Stat label="Qualified" value={c.qualified} />
          <Stat label="Management Group" value={c.managementGroup} />
          <Stat label="MG eligible, not joined" value={c.mgEligibleNow ?? "-"} />
          <Stat label="Suspended" value={c.suspended} />
          <Stat label="Open cases" value={c.openCases} />
          <Stat label="Total cases" value={c.totalCases} />
          <Stat label="Total addresses" value={c.addresses} />
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
          {c.byChain.map((b: any) => (
            <span key={b.chainId} className="rounded bg-elev px-2 py-1">
              {CHAIN_NAME[b.chainId] ?? `chain ${b.chainId}`}: {b.count} verified
            </span>
          ))}
          {/* Freshness, not just the number. MG eligibility is a cache refreshed by a single cron, and
              a cron that quietly dies looks identical to "nothing changed" on a dashboard that only
              shows counts. Amber once the reading is more than a day old. */}
          {data.mgEligibility?.checkedAt && (
            <span
              className={`rounded px-2 py-1 ${
                Date.now() - new Date(data.mgEligibility.checkedAt).getTime() > 86_400_000
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  : "bg-elev"
              }`}
            >
              MG eligibility checked at epoch {data.mgEligibility.checkedEpoch},{" "}
              {new Date(data.mgEligibility.checkedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted">
          Traffic (last 30 days): {data.traffic.totalHits} views, {data.traffic.totalUniques} unique
        </h2>
        <Card>
          {data.traffic.trafficByDay.length === 0 ? (
            <p className="text-sm text-faint">No traffic recorded yet.</p>
          ) : (
            <div className="flex h-32 items-end gap-1">
              {data.traffic.trafficByDay.map((d: any) => (
                <div key={d.day} className="flex flex-1 flex-col items-center" title={`${d.day}: ${d.hits} views, ${d.uniques} unique`}>
                  <div
                    className="w-full rounded-t bg-beacon/70"
                    style={{ height: `${Math.round((d.hits / maxHits) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
          )}
          {data.traffic.topPaths.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-xs font-medium text-muted">Top pages</div>
              <ul className="space-y-0.5 text-xs text-muted">
                {data.traffic.topPaths.map((p: any) => (
                  <li key={p.path} className="flex justify-between">
                    <span className="font-mono">{p.path}</span>
                    <span>{p.hits}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted">Growth (by month)</h2>
        <Card>
          <table className="w-full text-sm">
            <thead className="text-xs text-faint">
              <tr>
                <th className="text-left font-normal">Month</th>
                <th className="text-right font-normal">New listings</th>
                <th className="text-right font-normal">Imported seeds</th>
                <th className="text-right font-normal">Flags</th>
                <th className="text-right font-normal">Appeals</th>
              </tr>
            </thead>
            <tbody>
              {data.growthByMonth.map((g: any) => (
                <tr key={g.month} className="border-t border-themed/60">
                  <td className="py-1">{g.month}</td>
                  <td className="py-1 text-right">{g.providers}</td>
                  <td className="py-1 text-right">{g.imported}</td>
                  <td className="py-1 text-right">{g.flags}</td>
                  <td className="py-1 text-right">{g.appeals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

// ---------- Providers ----------
function ProvidersTab() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/providers?q=${encodeURIComponent(q)}`);
    const b = await r.json();
    setRows(b.providers ?? []);
  }, [q]);
  useEffect(() => {
    load();
  }, [load]);

  async function patch(id: string, data: any) {
    setMsg("");
    const r = await fetch("/api/admin/providers", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...data }),
    });
    const b = await r.json();
    setMsg(r.ok ? "Saved." : b.error ?? "Failed.");
    if (r.ok) load();
  }
  async function del(id: string, name: string) {
    if (!confirm(`Delete provider "${name}" and all its data? This cannot be undone.`)) return;
    const r = await fetch("/api/admin/providers", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setMsg(r.ok ? "Deleted." : "Failed.");
    if (r.ok) load();
  }
  async function patchAddr(id: string, data: any) {
    const r = await fetch("/api/admin/address", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...data }),
    });
    setMsg(r.ok ? "Saved." : "Failed.");
    if (r.ok) load();
  }
  async function delAddr(id: string) {
    if (!confirm("Remove this address from the listing?")) return;
    const r = await fetch("/api/admin/address", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const b = await r.json();
    setMsg(r.ok ? "Removed." : b.error ?? "Failed.");
    if (r.ok) load();
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or address"
          className="w-full max-w-sm rounded border border-themed bg-elev px-3 py-1.5 text-sm"
        />
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
      <div className="space-y-3">
        {rows.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">{p.name}</div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <select
                  value={p.source}
                  onChange={(e) => patch(p.id, { source: e.target.value })}
                  className="rounded border border-themed bg-elev px-2 py-1"
                >
                  <option value="submitted">submitted</option>
                  <option value="imported">imported</option>
                </select>
                <button
                  onClick={() => patch(p.id, { suspended: !p.suspended })}
                  className={`rounded px-2 py-1 ${p.suspended ? "bg-flare/20 text-flare" : "bg-elev text-muted"}`}
                >
                  {p.suspended ? "suspended" : "active"}
                </button>
                <button
                  onClick={() => patch(p.id, { archived: !p.archivedAt })}
                  className={`rounded px-2 py-1 ${p.archivedAt ? "bg-amber-500/20 text-amber-400" : "bg-elev text-muted"}`}
                  title={p.archivedAt ? `Archived ${new Date(p.archivedAt).toISOString().slice(0, 10)}, click to restore` : "Archive (remove from live feed, keep record)"}
                >
                  {p.archivedAt ? "archived" : "archive"}
                </button>
                <button onClick={() => del(p.id, p.name)} className="rounded bg-flare/15 px-2 py-1 text-flare">
                  delete
                </button>
              </div>
            </div>
            <div className="mt-1 truncate text-xs text-muted">{p.url}</div>
            <ul className="mt-2 space-y-1 text-xs">
              {p.addresses.map((a: any) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-themed/50 pt-1">
                  <span className="font-mono">
                    [{CHAIN_NAME[a.chainId] ?? a.chainId}] {a.address}
                  </span>
                  <span className="flex items-center gap-2">
                    <button
                      onClick={() => patchAddr(a.id, { verified: !a.verified })}
                      className={`rounded px-2 py-0.5 ${a.verified ? "bg-emerald-500/15 text-emerald-400" : "bg-elev text-faint"}`}
                    >
                      {a.verified ? "verified" : "unverified"}
                    </button>
                    <button onClick={() => delAddr(a.id)} className="rounded bg-flare/10 px-2 py-0.5 text-flare">
                      remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
        {rows.length === 0 && <p className="text-sm text-muted">No providers.</p>}
      </div>
    </div>
  );
}

// ---------- Qualification ----------
function QualificationTab() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/qualification?q=${encodeURIComponent(q)}`);
    const b = await r.json();
    setRows(b.rows ?? []);
  }, [q]);
  useEffect(() => {
    load();
  }, [load]);
  async function toggle(row: any) {
    setMsg("");
    const r = await fetch("/api/admin/qualification", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ network: row.network, voter: row.voter, qualified: !row.qualified }),
    });
    setMsg(r.ok ? "Saved." : "Failed.");
    if (r.ok) load();
  }
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search voter address"
          className="w-full max-w-sm rounded border border-themed bg-elev px-3 py-1.5 text-sm"
        />
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
      <Card>
        <ul className="space-y-1 text-xs">
          {rows.map((row) => (
            <li key={`${row.network}:${row.voter}`} className="flex flex-wrap items-center justify-between gap-2 border-t border-themed/50 pt-1">
              <span className="font-mono">
                [{row.network}] {row.voter}
              </span>
              <button
                onClick={() => toggle(row)}
                className={`rounded px-2 py-0.5 ${row.qualified ? "bg-emerald-500/15 text-emerald-400" : "bg-elev text-faint"}`}
              >
                {row.qualified ? "qualified" : "not qualified"}
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="text-muted">No qualification records.</li>}
        </ul>
      </Card>
    </div>
  );
}

// ---------- Governance ----------

/**
 * Conduct cases, including SEALED ones. Full read and write.
 *
 * The operator has to run this process: serve notice on a subject, see a case progressing, correct
 * it when it is wrong, and answer for what the system did. None of that works against a case they
 * cannot see. Sealed means sealed against the PUBLIC, not against the venue.
 *
 * EVERY FIELD IS EDITABLE HERE, including state, publication, evidence, votes, the defence, and the
 * case itself. The two consequential controls are `publishedAt`, which is the single gate that turns
 * a sealed case into a public finding, and `state`, because a published SUBSTANTIATED case is what
 * deducts points from that provider's reputation score. Changing either takes effect immediately and
 * republishes the feed.
 *
 * Mutations are recorded in the case audit with the acting admin address and the previous values.
 * Those rows are keyed by a plain caseId string rather than a foreign key, so they outlive the case:
 * a deleted case still leaves the record that it existed and was deleted.
 */
/** One input style, so every control on the conduct tab lines up instead of each picking its own. */
const inputCls =
  "w-full rounded border border-themed bg-elev px-2 py-1 text-sm text-fg placeholder:text-faint focus:border-beacon focus:outline-none";

/** A small status pill. Tone carries meaning: red is a decided finding, amber needs attention. */
function Chip({ tone, children }: { tone: "green" | "amber" | "red" | "grey"; children: React.ReactNode }) {
  const cls =
    tone === "green"
      ? "bg-emerald-500/15 text-emerald-500 dark:text-emerald-300"
      : tone === "amber"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-300"
        : tone === "red"
          ? "bg-red-500/15 text-red-400"
          : "bg-black/10 text-muted dark:bg-white/10";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

/** A titled block. The panel was one undivided run of fields; these give it somewhere to breathe. */
function Section2({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-themed/60 pt-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</p>
      {children}
    </div>
  );
}

/** Label above input, with an optional hint. Several fields here do something non-obvious and a
 *  bare label like "Published" does not say that it makes an accusation public. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-faint">{label}</span>
      {children}
      {hint ? <span className="mt-0.5 block text-[10px] text-faint">{hint}</span> : null}
    </label>
  );
}

/**
 * One audit entry, rendered readably.
 *
 * `detail` is JSON written by the API, and dumping it raw put unwrapped before/after blobs across
 * the panel. The common shape is {before, after}, so that is summarised as changed fields and the
 * raw text is kept behind a toggle rather than thrown away: the record is the point of this list,
 * and a summary that cannot be checked against the original is not much of a record.
 */
function AuditRow({
  entry,
  onRestore,
  busy,
}: {
  entry: {
    id?: string;
    action: string;
    actor: string;
    detail?: string | null;
    at: string;
    restorable?: boolean;
  };
  onRestore?: (auditId: string) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  let summary: string | null = null;
  if (entry.detail) {
    try {
      const d = JSON.parse(entry.detail);
      if (d && typeof d === "object" && d.after && typeof d.after === "object") {
        const keys = Object.keys(d.after);
        summary = keys.length ? `changed ${keys.join(", ")}` : null;
      } else if (d && typeof d === "object") {
        const keys = Object.keys(d).filter((k) => d[k] != null);
        summary = keys.length ? keys.join(", ") : null;
      }
    } catch {
      summary = null;
    }
  }
  return (
    <li className="text-[11px] text-muted">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-faint">
          {new Date(entry.at).toISOString().slice(0, 16).replace("T", " ")}
        </span>
        <span className="font-medium text-fg">{entry.action}</span>
        <span className="font-mono text-faint" title={entry.actor}>
          {entry.actor === "system" ? "system" : `${entry.actor.slice(0, 10)}\u2026`}
        </span>
        {summary && <span className="text-muted">{summary}</span>}
        {entry.detail && (
          <button onClick={() => setOpen((o) => !o)} className="text-beacon hover:underline">
            {open ? "hide" : "raw"}
          </button>
        )}
        {/* Only on rows that actually carry a snapshot. A deletion recorded before snapshots were
            widened has the same action name and cannot be undone, and offering a button that would
            fail is worse than offering none. */}
        {entry.restorable && entry.id && onRestore && (
          <button
            onClick={() => onRestore(entry.id!)}
            disabled={busy}
            className="rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-300"
          >
            restore
          </button>
        )}
      </div>
      {open && entry.detail && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-elev/60 p-2 text-[10px] text-faint">
          {entry.detail}
        </pre>
      )}
    </li>
  );
}

function ConductTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [trail, setTrail] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/conduct");
    const b = await r.json().catch(() => ({}));
    setRows(b.cases ?? []);
    setTrail(b.deletedTrail ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function send(body: any, ok = "Saved.") {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/conduct", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const b = await r.json().catch(() => ({}));
      setMsg(r.ok ? ok : `Failed: ${b.error ?? r.status}`);
      if (r.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  async function restore(auditId: string) {
    if (!confirm("Restore what this deletion removed? Ids and timestamps are put back as they were.")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/conduct", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // `id` is required by the route's dispatcher; the case id on the audit row is the right one
        // even when the case itself was what got deleted.
        body: JSON.stringify({ op: "restore", id: openId ?? "", auditId }),
      });
      const b = await r.json().catch(() => ({}));
      setMsg(r.ok ? `Restored ${b.restored}.` : `Failed: ${b.error ?? r.status}`);
      if (r.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  async function delCase(id: string, provider: string) {
    if (
      !confirm(
        `Delete the conduct case against "${provider}"?\n\nThe case, its points, evidence, votes and defence are removed. An audit row survives recording that this case existed and was deleted.`
      )
    )
      return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/conduct", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const b = await r.json().catch(() => ({}));
      setMsg(r.ok ? "Case deleted." : `Failed: ${b.error ?? r.status}`);
      if (r.ok) {
        setOpenId(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  const STATES = [
    "PENDING",
    "NOTICE",
    "OPEN_DISCUSSION",
    "OPEN_VOTING",
    "SUBSTANTIATED",
    "NOT_SUBSTANTIATED",
    "FAILED_QUORUM",
  ];
  const SERVICE = [
    "SERVED_DEFENDED",
    "SERVED_NO_DEFENCE",
    "NOTICE_UNDELIVERED",
    "UNCLAIMED_NOT_SERVED",
  ];

  return (
    <div>
      {msg && <div className="mb-2 text-xs text-muted">{msg}</div>}
      <Card>
        <p className="mb-2 text-xs text-muted">
          Sealed cases are visible here and nowhere else. Everything on this tab is editable:
          publishing a SUBSTANTIATED case makes it public on the provider&apos;s page and deducts
          points from their reputation score. Changes are recorded in the case audit.
        </p>
        <table className="w-full text-sm">
          <thead className="text-xs text-faint">
            <tr>
              <th className="text-left font-normal">Provider</th>
              <th className="text-left font-normal">State</th>
              <th className="text-left font-normal">Public</th>
              <th className="text-left font-normal">Subject</th>
              <th className="text-right font-normal">Sigs</th>
              <th className="text-right font-normal">Votes</th>
              <th className="text-left font-normal">Next deadline</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const next =
                c.state === "NOTICE"
                  ? c.noticeEndsAt
                  : c.state === "OPEN_DISCUSSION"
                    ? c.discussionEndsAt
                    : c.state === "OPEN_VOTING"
                      ? c.votingEndsAt
                      : null;
              return (
                <tr key={c.id} className="border-t border-themed/60 align-top">
                  <td className="py-1">{c.provider}</td>
                  <td className="py-1 text-muted">{c.state}</td>
                  <td className="py-1">
                    {c.published ? (
                      <span className="text-emerald-500">published</span>
                    ) : (
                      <span className="text-faint">sealed</span>
                    )}
                  </td>
                  <td className="py-1 text-muted">
                    {c.claimed ? "claimed" : <span className="text-amber-500">unclaimed</span>}
                    {c.hasDefence ? " · replied" : ""}
                  </td>
                  <td className="py-1 text-right">{c.signatures}</td>
                  <td className="py-1 text-right">
                    {c.votes.total > 0
                      ? `${c.votes.deny}D/${c.votes.keep}K/${c.votes.abstain}A`
                      : "—"}
                  </td>
                  <td className="py-1 text-xs text-muted">
                    {next ? new Date(next).toISOString().slice(0, 10) : "—"}
                  </td>
                  <td className="py-1 text-right">
                    <button
                      onClick={() => setOpenId(openId === c.id ? null : c.id)}
                      className="rounded bg-elev px-2 py-0.5 text-xs text-muted"
                    >
                      {openId === c.id ? "hide" : "edit"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="py-2 text-muted">
                  No conduct cases.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {rows
        .filter((c) => c.id === openId)
        .map((c) => (
          <Card key={c.id}>
            {/* HEADER: identity and state first, destructive action last and set apart. */}
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-themed/60 pb-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-fg">{c.provider}</span>
                  <Chip tone={c.state === "SUBSTANTIATED" ? "red" : c.state === "PENDING" ? "grey" : "amber"}>
                    {c.state}
                  </Chip>
                  <Chip tone={c.published ? "green" : "grey"}>{c.published ? "published" : "sealed"}</Chip>
                  <Chip tone={c.claimed ? "grey" : "amber"}>{c.claimed ? "claimed" : "unclaimed"}</Chip>
                  <Chip tone={c.signatures >= 4 ? "green" : "grey"}>{c.signatures} of 4 signatures</Chip>
                </div>
                <p className="mt-1 font-mono text-[11px] text-faint">
                  {c.network} · {c.id}
                </p>
              </div>
              <button
                onClick={() => delCase(c.id, c.provider)}
                disabled={busy}
                className="shrink-0 rounded border border-red-500/40 px-2.5 py-1 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              >
                Delete case
              </button>
            </div>

            {/* CASE FIELDS, grouped by what they answer rather than by column order in the table.
                Publication is separated and labelled with its effect, because it is the one control
                here that makes a sealed accusation public and moves a provider's score. */}
            <Section2 title="Status">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="State">
                  <select
                    defaultValue={c.state}
                    onChange={(e) => send({ op: "case", id: c.id, state: e.target.value })}
                    className={inputCls}
                  >
                    {STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Service status" hint="What the published finding says about notice">
                  <select
                    defaultValue={c.serviceStatus ?? ""}
                    onChange={(e) => send({ op: "case", id: c.id, serviceStatus: e.target.value || null })}
                    className={inputCls}
                  >
                    <option value="">(not recorded)</option>
                    {SERVICE.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Published" hint="Makes it public and deducts score">
                  <input
                    type="date"
                    defaultValue={c.publishedAt ? String(c.publishedAt).slice(0, 10) : ""}
                    onBlur={(e) => send({ op: "case", id: c.id, publishedAt: e.target.value || null })}
                    className={inputCls}
                  />
                </Field>
              </div>
            </Section2>

            <Section2 title="Timeline">
              <div className="grid gap-3 sm:grid-cols-3">
                {(
                  [
                    ["openedAt", "Opened"],
                    ["noticeEndsAt", "Notice ends"],
                    ["discussionEndsAt", "Discussion ends"],
                    ["votingEndsAt", "Voting ends"],
                    ["decidedAt", "Decided"],
                    ["lateReplyAt", "Late reply"],
                  ] as const
                ).map(([k, label]) => (
                  <Field key={k} label={label}>
                    <input
                      type="date"
                      defaultValue={c[k] ? String(c[k]).slice(0, 10) : ""}
                      onBlur={(e) => send({ op: "case", id: c.id, [k]: e.target.value || null })}
                      className={inputCls}
                    />
                  </Field>
                ))}
              </div>
            </Section2>

            <Section2 title="Outcome">
              <div className="grid gap-3 sm:grid-cols-4">
                {(
                  [
                    ["decidedEpoch", "Decided epoch", "epoch the score ages from"],
                    ["memberCountAtOpen", "Members at open", ""],
                    ["outcomeTurnout", "Turnout", ""],
                    ["outcomeDeny", "Deny count", ""],
                  ] as const
                ).map(([k, label, hint]) => (
                  <Field key={k} label={label} hint={hint}>
                    <input
                      type="number"
                      placeholder="not set"
                      defaultValue={c[k] ?? ""}
                      onBlur={(e) => send({ op: "case", id: c.id, [k]: e.target.value || null })}
                      className={inputCls}
                    />
                  </Field>
                ))}
              </div>
            </Section2>

            {/* POINTS. Each is one member's accusation plus its evidence, so each gets its own box
                rather than running together in a single column. */}
            <Section2 title={`Points and evidence (${c.points.length})`}>
              <div className="space-y-3">
                {c.points.map((p: any) => (
                  <div key={p.id} className="rounded-lg border border-themed/60 bg-elev/30 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-faint" title={p.member}>
                        {p.member}
                        {p.withdrawn && <span className="ml-2 text-amber-500">withdrawn</span>}
                      </span>
                      <div className="flex gap-1">
                        <button
                          onClick={() =>
                            send({ op: "initiation", id: c.id, initiationId: p.id, withdrawn: !p.withdrawn })
                          }
                          disabled={busy}
                          className="rounded border border-themed px-2 py-0.5 text-[11px] text-muted hover:text-beacon disabled:opacity-50"
                        >
                          {p.withdrawn ? "Restore" : "Withdraw"}
                        </button>
                        <button
                          onClick={() =>
                            confirm("Delete this point and its evidence?") &&
                            send({ op: "deleteInitiation", id: c.id, initiationId: p.id }, "Point deleted.")
                          }
                          disabled={busy}
                          className="rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <input
                      defaultValue={p.title ?? ""}
                      placeholder="Subject (optional)"
                      onBlur={(e) =>
                        e.target.value !== (p.title ?? "") &&
                        send({ op: "initiation", id: c.id, initiationId: p.id, title: e.target.value })
                      }
                      className={`${inputCls} mt-2 font-medium`}
                    />
                    <textarea
                      defaultValue={p.grounds}
                      rows={3}
                      placeholder="Grounds"
                      onBlur={(e) =>
                        e.target.value !== p.grounds &&
                        send({ op: "initiation", id: c.id, initiationId: p.id, grounds: e.target.value })
                      }
                      className={`${inputCls} mt-2 resize-y`}
                    />
                    <p className="mt-3 text-[11px] uppercase tracking-wide text-faint">Evidence</p>
                    <div className="mt-1 space-y-1">
                      {p.evidence.map((e: any) => (
                        <div key={e.id} className="grid grid-cols-12 items-center gap-1">
                          <input
                            defaultValue={e.kind}
                            onBlur={(ev) =>
                              ev.target.value !== e.kind &&
                              send({ op: "evidence", id: c.id, evidenceId: e.id, kind: ev.target.value })
                            }
                            className={`${inputCls} col-span-2 font-mono`}
                          />
                          <input
                            defaultValue={e.chain ?? ""}
                            placeholder="chain"
                            onBlur={(ev) =>
                              ev.target.value !== (e.chain ?? "") &&
                              send({ op: "evidence", id: c.id, evidenceId: e.id, chain: ev.target.value || null })
                            }
                            className={`${inputCls} col-span-2`}
                          />
                          <input
                            defaultValue={e.ref}
                            title={e.ref}
                            onBlur={(ev) =>
                              ev.target.value !== e.ref &&
                              send({ op: "evidence", id: c.id, evidenceId: e.id, ref: ev.target.value })
                            }
                            className={`${inputCls} col-span-4 font-mono`}
                          />
                          <input
                            defaultValue={e.claim}
                            placeholder="what it shows"
                            onBlur={(ev) =>
                              ev.target.value !== e.claim &&
                              send({ op: "evidence", id: c.id, evidenceId: e.id, claim: ev.target.value })
                            }
                            className={`${inputCls} col-span-3`}
                          />
                          <button
                            onClick={() => send({ op: "deleteEvidence", id: c.id, evidenceId: e.id }, "Evidence deleted.")}
                            disabled={busy}
                            className="col-span-1 rounded border border-red-500/40 py-1 text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() =>
                        send(
                          { op: "addEvidence", id: c.id, initiationId: p.id, kind: "TX", chain: c.network, ref: "", claim: "" },
                          "Evidence row added."
                        )
                      }
                      disabled={busy}
                      className="mt-2 rounded border border-themed px-2 py-0.5 text-[11px] text-muted hover:text-beacon disabled:opacity-50"
                    >
                      + Evidence
                    </button>
                  </div>
                ))}
                <AddPoint caseId={c.id} onDone={send} busy={busy} />
              </div>
            </Section2>

            <Section2 title={`Votes (${c.votes.rows.length})`}>
              <div className="space-y-1">
                {c.votes.rows.map((v: any) => (
                  <div key={v.id} className="flex items-center gap-1">
                    <input
                      defaultValue={v.memberEntityVoter}
                      onBlur={(ev) =>
                        ev.target.value !== v.memberEntityVoter &&
                        send({ op: "vote", id: c.id, voteId: v.id, member: ev.target.value })
                      }
                      className={`${inputCls} flex-1 font-mono`}
                    />
                    <select
                      defaultValue={v.vote}
                      onChange={(ev) => send({ op: "vote", id: c.id, voteId: v.id, vote: ev.target.value })}
                      className={`${inputCls} w-28`}
                    >
                      {["DENY", "KEEP", "ABSTAIN"].map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => send({ op: "deleteVote", id: c.id, voteId: v.id }, "Vote deleted.")}
                      disabled={busy}
                      className="rounded border border-red-500/40 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      x
                    </button>
                  </div>
                ))}
                {c.votes.rows.length === 0 && <p className="text-xs text-faint">No votes cast.</p>}
                <AddVote caseId={c.id} onDone={send} busy={busy} />
              </div>
            </Section2>

            <Section2 title={c.defence ? "Provider response" : "Provider response (none on record)"}>
              <textarea
                defaultValue={c.defence?.body ?? ""}
                rows={3}
                placeholder="No response has been submitted. Text entered here is recorded as the provider's."
                onBlur={(e) =>
                  e.target.value !== (c.defence?.body ?? "") &&
                  send({ op: "defence", id: c.id, title: c.defence?.title ?? null, body: e.target.value })
                }
                className={`${inputCls} resize-y`}
              />
              {c.defence && (
                <button
                  onClick={() =>
                    confirm("Delete the provider's response?") &&
                    send({ op: "deleteDefence", id: c.id }, "Defence deleted.")
                  }
                  disabled={busy}
                  className="mt-2 rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                >
                  Delete response
                </button>
              )}
            </Section2>

            {c.audit.length > 0 && (
              <Section2 title={`Audit (${c.audit.length})`}>
                <ul className="max-h-72 space-y-1 overflow-y-auto">
                  {c.audit.map((a: any, i: number) => (
                    <AuditRow key={i} entry={a} onRestore={restore} busy={busy} />
                  ))}
                </ul>
              </Section2>
            )}
          </Card>
        ))}

      {trail.length > 0 && (
        <Card>
          <p className="text-xs text-faint">
            Audit rows for cases that no longer exist. These survive deletion because the trail is
            keyed by case id rather than by a foreign key.
          </p>
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {trail.map((a: any, i: number) => (
              <li key={i}>
                <span className="mr-2 font-mono text-[10px] text-faint">{a.caseId}</span>
                <AuditRow entry={a} onRestore={restore} busy={busy} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Add a point (initiation) to a case, attributed to a member address, entered by the operator. */
function AddPoint({
  caseId,
  onDone,
  busy,
}: {
  caseId: string;
  onDone: (body: any, ok?: string) => Promise<void>;
  busy: boolean;
}) {
  const [member, setMember] = useState("");
  const [grounds, setGrounds] = useState("");
  return (
    <div className="mt-3 flex gap-1 border-t border-themed/60 pt-2">
      <input
        value={member}
        onChange={(e) => setMember(e.target.value)}
        placeholder="Member voter address"
        className={`${inputCls} w-64 font-mono`}
      />
      <input
        value={grounds}
        onChange={(e) => setGrounds(e.target.value)}
        placeholder="Grounds"
        className={`${inputCls} flex-1`}
      />
      <button
        onClick={async () => {
          if (!member || !grounds) return;
          await onDone({ op: "addInitiation", id: caseId, member, grounds }, "Point added.");
          setMember("");
          setGrounds("");
        }}
        disabled={busy}
        className="shrink-0 rounded border border-themed px-2 py-1 text-xs text-muted hover:text-beacon disabled:opacity-50"
      >
        + Point
      </button>
    </div>
  );
}

/** Record a vote on a case on a member's behalf. */
function AddVote({
  caseId,
  onDone,
  busy,
}: {
  caseId: string;
  onDone: (body: any, ok?: string) => Promise<void>;
  busy: boolean;
}) {
  const [member, setMember] = useState("");
  const [vote, setVote] = useState("DENY");
  return (
    <div className="mt-1 flex gap-1">
      <input
        value={member}
        onChange={(e) => setMember(e.target.value)}
        placeholder="Member voter address"
        className={`${inputCls} flex-1 font-mono`}
      />
      <select
        value={vote}
        onChange={(e) => setVote(e.target.value)}
        className={`${inputCls} w-28`}
      >
        {["DENY", "KEEP", "ABSTAIN"].map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
      <button
        onClick={async () => {
          if (!member) return;
          await onDone({ op: "addVote", id: caseId, member, vote }, "Vote added.");
          setMember("");
        }}
        disabled={busy}
        className="shrink-0 rounded border border-themed px-2 py-1 text-xs text-muted hover:text-beacon disabled:opacity-50"
      >
        + Vote
      </button>
    </div>
  );
}

function GovernanceTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/admin/governance");
    const b = await r.json();
    setRows(b.cases ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function del(id: string, provider: string) {
    if (!confirm(`Delete governance case for "${provider}"? This removes its votes and comments.`)) return;
    const r = await fetch("/api/admin/governance", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setMsg(r.ok ? "Deleted." : "Failed.");
    if (r.ok) load();
  }
  return (
    <div>
      {msg && <div className="mb-2 text-xs text-muted">{msg}</div>}
      <Card>
        <table className="w-full text-sm">
          <thead className="text-xs text-faint">
            <tr>
              <th className="text-left font-normal">Provider</th>
              <th className="text-left font-normal">Type</th>
              <th className="text-left font-normal">State</th>
              <th className="text-right font-normal">Flags</th>
              <th className="text-right font-normal">Votes</th>
              <th className="text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-themed/60">
                <td className="py-1">
                  <a href={`/governance/${c.id}`} className="text-beacon hover:underline">
                    {c.provider}
                  </a>
                </td>
                <td className="py-1 text-muted">{c.isReVote ? "appeal" : "flag"}</td>
                <td className="py-1 text-muted">{c.state}</td>
                <td className="py-1 text-right">{c.flags}</td>
                <td className="py-1 text-right">{c.votes}</td>
                <td className="py-1 text-right">
                  <button onClick={() => del(c.id, c.provider)} className="rounded bg-flare/15 px-2 py-0.5 text-xs text-flare">
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-2 text-muted">
                  No governance cases.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------- Pending logos (in the review window) ----------
// New uploads are held for a review window before auto-going-live. This panel lets the operator
// eyeball each pending image and either approve it now (promote to live immediately) or reject it
// (discard the upload). Without this, the only signal was a notification email with no matching action.
// ---------- Consumers ("Powered by" showcase moderation) ----------
// ---------- Imports (TowoLabs legacy list) ----------
// The TowoLabs ftso-signal-providers list is the legacy PR-based provider list wallets historically
// consumed. A daily scan (plus "Scan now" here) diffs it against our registry and stages entries we
// don't have as pending candidates. Approving one creates an UNCLAIMED source="imported" provider: it
// appears in the feed only once it qualifies on-chain or the real owner claims it by signature.
// Dismissing keeps a tombstone so it is not re-surfaced. It is not an assertion of ownership.
function ImportsTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/admin/import-candidates");
    const b = await r.json();
    setRows(b.candidates ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function scan() {
    setBusy("scan");
    setMsg("Scanning TowoLabs list…");
    try {
      const r = await fetch("/api/admin/import-candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "scan" }),
      });
      const b = await r.json();
      if (r.ok) {
        const s = b.result ?? {};
        setMsg(
          s.error
            ? `Scan error: ${s.error}`
            : `Upstream list: ${s.fetched} entries · ${s.staged} staged · ${s.refreshed} refreshed · ${s.absorbed} absorbed. ` +
              `Chain sweep: ${s.chainScanned ?? 0} entities · ${s.chainNewToUs ?? 0} not covered · ` +
              `${s.chainStaged ?? 0} staged · ${s.chainSkippedStale ?? 0} skipped as inactive.`
        );
        load();
      } else {
        setMsg(b.error ?? "Scan failed.");
      }
    } finally {
      setBusy("");
    }
  }

  async function act(id: string, action: "approve" | "dismiss", name: string) {
    const label = action === "approve" ? "import this provider (unclaimed)" : "dismiss this entry";
    if (!confirm(`Are you sure you want to ${label} for "${name}"?`)) return;
    setBusy(id + action);
    setMsg("");
    try {
      const r = await fetch("/api/admin/import-candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const b = await r.json();
      setMsg(r.ok ? (b.absorbed ? "Already in registry - absorbed." : "Done.") : b.error ?? "Failed.");
      if (r.ok) load();
    } finally {
      setBusy("");
    }
  }

  const pending = rows.filter((c) => c.status === "pending");
  const actioned = rows.filter((c) => c.status !== "pending");
  const STATUS_STYLE: Record<string, string> = {
    approved: "bg-emerald-500/15 text-emerald-400",
    dismissed: "bg-neutral-500/15 text-neutral-400",
    absorbed: "bg-sky-500/15 text-sky-400",
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
        <span className="font-semibold text-fg">
          TowoLabs additions not yet in our registry ({pending.length} pending)
        </span>
        <div className="flex items-center gap-3">
          <span>{msg}</span>
          <button
            onClick={scan}
            disabled={busy === "scan"}
            className="rounded-md border border-beacon px-2.5 py-1 font-medium text-beacon hover:bg-beacon/10 disabled:opacity-50"
          >
            {busy === "scan" ? "Scanning…" : "Scan now"}
          </button>
        </div>
      </div>
      <Card>
        {pending.length === 0 ? (
          <p className="text-sm text-muted">
            No new additions to review. Run a scan to check the TowoLabs list.
          </p>
        ) : (
          <ul className="space-y-4">
            {pending.map((c) => (
              <li
                key={c.id}
                className="border-t border-themed/50 pt-4 first:border-0 first:pt-0"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-500">
                        {CHAIN_NAME[c.chainId] ?? c.chainId}
                      </span>
                      <span className="text-sm font-medium">{c.name}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">{c.description}</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-faint">
                      {c.address}
                    </p>
                    {c.url && (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer nofollow"
                        className="text-xs text-beacon hover:underline"
                      >
                        {c.url}
                      </a>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => act(c.id, "approve", c.name)}
                      disabled={busy === c.id + "approve"}
                      className="rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-50"
                    >
                      Import
                    </button>
                    <button
                      onClick={() => act(c.id, "dismiss", c.name)}
                      disabled={busy === c.id + "dismiss"}
                      className="rounded-md border border-themed px-2.5 py-1 text-xs text-muted hover:text-fg disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {actioned.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-xs font-semibold text-muted">History</p>
          <Card>
            <ul className="space-y-1 text-xs">
              {actioned.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    <span className="text-faint">{CHAIN_NAME[c.chainId] ?? c.chainId} · </span>
                    {c.name}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      STATUS_STYLE[c.status] ?? "bg-neutral-500/15 text-neutral-400"
                    }`}
                  >
                    {c.status}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

function ConsumersTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/admin/consumers");
    const b = await r.json();
    setRows(b.queue ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function act(id: string, action: "approve" | "reject", name: string, kind: string) {
    const label =
      action === "approve"
        ? kind === "edit"
          ? "apply these changes"
          : "approve and publish this listing"
        : kind === "edit"
          ? "discard this edit"
          : "reject this listing";
    if (!confirm(`Are you sure you want to ${label} for "${name}"?`)) return;
    setBusy(id + action);
    setMsg("");
    try {
      const r = await fetch("/api/admin/consumers", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const b = await r.json();
      setMsg(r.ok ? "Done." : b.error ?? "Failed.");
      if (r.ok) load();
    } finally {
      setBusy("");
    }
  }
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        <span className="font-semibold text-fg">Powered-by submissions awaiting review</span>
        <span>{msg}</span>
      </div>
      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">Nothing to review.</p>
        ) : (
          <ul className="space-y-4">
            {rows.map((q) => {
              const p = q.proposed ?? {};
              const cur = q.current;
              const name = p.name ?? cur?.name ?? "(unnamed)";
              return (
                <li
                  key={q.id}
                  className="border-t border-themed/50 pt-4 first:border-0 first:pt-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                          q.kind === "edit"
                            ? "bg-amber-500/15 text-amber-500"
                            : "bg-emerald-500/15 text-emerald-400"
                        }`}
                      >
                        {q.kind}
                      </span>
                      <span className="text-sm font-medium">{name}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <button
                        onClick={() => act(q.id, "approve", name, q.kind)}
                        disabled={!!busy}
                        className="rounded bg-emerald-500/15 px-2.5 py-1 text-emerald-400 disabled:opacity-50"
                      >
                        {busy === q.id + "approve" ? "…" : q.kind === "edit" ? "apply" : "approve"}
                      </button>
                      <button
                        onClick={() => act(q.id, "reject", name, q.kind)}
                        disabled={!!busy}
                        className="rounded bg-flare/15 px-2.5 py-1 text-flare disabled:opacity-50"
                      >
                        {busy === q.id + "reject" ? "…" : "reject"}
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                    {q.kind === "edit" && cur && (
                      <ConsumerFields title="Current (live)" v={cur} muted />
                    )}
                    <ConsumerFields
                      title={q.kind === "edit" ? "Proposed" : "Submitted"}
                      v={p}
                      email={q.contactEmail}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ConsumerFields({
  title,
  v,
  email,
  muted,
}: {
  title: string;
  v: any;
  email?: string | null;
  muted?: boolean;
}) {
  return (
    <div className={`rounded border border-themed/50 p-2 ${muted ? "opacity-70" : ""}`}>
      <div className="mb-1 text-[10px] font-semibold uppercase text-faint">{title}</div>
      <dl className="space-y-0.5">
        <Row k="Category" val={v.category} />
        <Row
          k="URL"
          val={
            v.url ? (
              <a href={v.url} target="_blank" rel="noreferrer" className="text-beacon hover:underline">
                {v.url}
              </a>
            ) : (
              "—"
            )
          }
        />
        <Row k="Blurb" val={v.blurb} />
        {v.logoURL && (
          <Row
            k="Logo"
            val={
              <a href={v.logoURL} target="_blank" rel="noreferrer" className="text-beacon hover:underline">
                image
              </a>
            }
          />
        )}
        {email && <Row k="Contact" val={email} />}
      </dl>
    </div>
  );
}

function Row({ k, val }: { k: string; val: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-faint">{k}</dt>
      <dd className="min-w-0 break-words text-fg">{val ?? "—"}</dd>
    </div>
  );
}

// ---------- Logo decision history ----------
//
// Every approve, reject and timer-promotion, newest first. The pending panel above shows only what is
// still undecided, so without this the moment a logo was published it vanished from the admin surface
// entirely and there was no way to answer "who approved that image, and when".
//
// AUTO_PROMOTED is the majority and that is expected: a logo nobody reviews goes live when the review
// window elapses. Listing those beside the manual decisions is what stops the history from implying
// every unreviewed logo was actually looked at.
function LogoDecisionHistory() {
  const [rows, setRows] = useState<any[]>([]);
  const [counts, setCounts] = useState<{ approved: number; rejected: number; autoPromoted: number } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    fetch("/api/admin/logo-decisions")
      .then((r) => r.json())
      .then((b) => {
        setRows(b.decisions ?? []);
        setCounts(b.counts ?? null);
      })
      .catch(() => setRows([]));
  }, [open]);

  const tone = (a: string) =>
    a === "APPROVED"
      ? "text-emerald-500"
      : a === "REJECTED"
        ? "text-red-400"
        : "text-muted";

  return (
    <div className="mt-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs font-semibold text-fg hover:text-beacon"
      >
        Logo decision history {open ? "\u25be" : "\u25b8"}
        {counts && (
          <span className="ml-2 font-normal text-faint">
            {counts.approved} approved · {counts.rejected} rejected · {counts.autoPromoted} auto
          </span>
        )}
      </button>
      {open && (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-xs text-faint">
              <tr>
                <th className="text-left font-normal">When</th>
                <th className="text-left font-normal">Provider</th>
                <th className="text-left font-normal">Decision</th>
                <th className="text-left font-normal">By</th>
                <th className="text-left font-normal">Uploaded by</th>
                <th className="text-right font-normal">Image</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-t border-themed/60 align-top">
                  <td className="py-1 text-xs text-faint whitespace-nowrap">
                    {new Date(d.at).toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="py-1">
                    <a href={`/provider/${d.providerId}`} className="text-beacon hover:underline">
                      {d.provider}
                    </a>
                  </td>
                  <td className={`py-1 text-xs ${tone(d.action)}`}>
                    {d.action === "AUTO_PROMOTED" ? "auto (window elapsed)" : d.action.toLowerCase()}
                  </td>
                  <td className="py-1 font-mono text-xs text-muted">
                    {d.actor === "system" ? "system" : `${String(d.actor).slice(0, 10)}\u2026`}
                  </td>
                  <td className="py-1 font-mono text-xs text-faint">
                    {d.uploadedBy ? `${String(d.uploadedBy).slice(0, 10)}\u2026` : "\u2014"}
                  </td>
                  <td className="py-1 text-right text-xs">
                    {d.logoURI ? (
                      <a href={d.logoURI} target="_blank" rel="noreferrer" className="text-beacon hover:underline">
                        view
                      </a>
                    ) : (
                      <span className="text-faint">{"\u2014"}</span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-2 text-muted">
                    No logo decisions recorded yet. Decisions are recorded from this release onward.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function PendingLogosPanel({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/admin/pending-logos");
    const b = await r.json();
    setRows(b.pending ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function act(id: string, action: "approve" | "reject", name: string) {
    const label = action === "approve" ? "publish this logo now" : "discard this pending logo";
    if (!confirm(`Are you sure you want to ${label} for "${name}"?`)) return;
    setBusy(id + action);
    setMsg("");
    try {
      const r = await fetch("/api/admin/pending-logos", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const b = await r.json();
      setMsg(r.ok ? (action === "approve" ? "Published." : "Discarded.") : b.error ?? "Failed.");
      if (r.ok) {
        load();
        // The panel refreshed its own list before; the tab badge is owned by the parent and did not,
        // which is why the count stayed at 2 after an approve left one item.
        onChanged();
      }
    } finally {
      setBusy("");
    }
  }
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        <span className="font-semibold text-fg">Pending logos (in review window)</span>
        <span>{msg}</span>
      </div>
      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No logos awaiting review.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-themed/50 pt-3 first:border-0 first:pt-0">
                <div className="flex items-center gap-3">
                  {p.previewURL ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.previewURL} alt="" width={40} height={40} className="rounded bg-elev" />
                  ) : (
                    <div className="h-10 w-10 rounded bg-elev" />
                  )}
                  <div className="text-sm">
                    <a href={`/provider/${p.id}`} className="font-medium text-beacon hover:underline">
                      {p.name}
                    </a>
                    <div className="text-xs text-faint">
                      Auto-goes-live {p.goLiveAt ? new Date(p.goLiveAt).toLocaleDateString() : "—"}
                      {p.previewURL && (
                        <>
                          {" · "}
                          <a href={p.previewURL} target="_blank" rel="noreferrer" className="hover:underline">
                            preview
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <button
                    onClick={() => act(p.id, "approve", p.name)}
                    disabled={!!busy}
                    className="rounded bg-emerald-500/15 px-2.5 py-1 text-emerald-400 disabled:opacity-50"
                  >
                    {busy === p.id + "approve" ? "…" : "approve now"}
                  </button>
                  <button
                    onClick={() => act(p.id, "reject", p.name)}
                    disabled={!!busy}
                    className="rounded bg-flare/15 px-2.5 py-1 text-flare disabled:opacity-50"
                  >
                    {busy === p.id + "reject" ? "…" : "reject"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------- Logo reports ----------
// `onChanged` re-pulls the parent's tab badges. Without it the badge only refreshed on tab
// NAVIGATION, so clearing a queue from inside the tab you were already on left the count stale: an
// admin who approved the last pending logo still saw a badge telling them work was waiting.
function ReportsTab({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/logo-reports?status=${showAll ? "all" : "OPEN"}`);
    const b = await r.json();
    setRows(b.reports ?? []);
  }, [showAll]);
  useEffect(() => {
    load();
  }, [load]);
  async function act(id: string, action: "removeLogo" | "dismiss", provider: string) {
    const label = action === "removeLogo" ? "remove this logo" : "dismiss this report";
    if (!confirm(`Are you sure you want to ${label} for "${provider}"?`)) return;
    const r = await fetch("/api/admin/logo-reports", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    setMsg(r.ok ? "Done." : "Failed.");
    if (r.ok) {
      load();
      onChanged();
    }
  }
  return (
    <div>
      <PendingLogosPanel onChanged={onChanged} />
      <div className="mb-2 mt-6 flex items-center justify-between text-xs text-muted">
        <span>{msg}</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show resolved (history)
        </label>
      </div>
      <Card>
        <table className="w-full text-sm">
          <thead className="text-xs text-faint">
            <tr>
              <th className="text-left font-normal">Provider</th>
              <th className="text-left font-normal">Reporter</th>
              <th className="text-left font-normal">Reason</th>
              <th className="text-left font-normal">When</th>
              <th className="text-left font-normal">Status</th>
              <th className="text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-themed/60 align-top">
                <td className="py-1">
                  <a href={`/provider/${r.provider?.id ?? ""}`} className="text-beacon hover:underline">
                    {r.provider?.name ?? "(removed)"}
                  </a>
                </td>
                <td className="py-1 font-mono text-xs text-muted">{r.reporterAddress?.slice(0, 10)}…</td>
                <td className="py-1 text-muted break-words" style={{ maxWidth: 280 }}>{r.reason}</td>
                <td className="py-1 text-faint">{new Date(r.createdAt).toLocaleDateString()}</td>
                <td className="py-1 text-muted">{r.status}</td>
                <td className="py-1 text-right whitespace-nowrap">
                  {r.status === "OPEN" ? (
                    <>
                      <button
                        onClick={() => act(r.id, "removeLogo", r.provider?.name ?? "")}
                        className="mr-1 rounded bg-flare/15 px-2 py-0.5 text-xs text-flare"
                      >
                        remove logo
                      </button>
                      <button
                        onClick={() => act(r.id, "dismiss", r.provider?.name ?? "")}
                        className="rounded bg-elev px-2 py-0.5 text-xs text-muted"
                      >
                        dismiss
                      </button>
                    </>
                  ) : (
                    <span className="text-faint text-xs">
                      {r.resolvedBy ? `by ${r.resolvedBy.slice(0, 8)}…` : ""}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-2 text-muted">
                  No {showAll ? "" : "open "}logo reports.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <LogoDecisionHistory />
    </div>
  );
}

// Detection moved to oracleindependence.com: its own repo, database and pipeline. This tab and the
// /detection, /independence and /api/detection surfaces were removed on 2026-08-02; the routes are
// 308-redirected in next.config.mjs because a governance proposal cites them.

// ---------- System ----------
function SystemTab() {
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState("");
  async function run(action: string, confirm = false) {
    setBusy(action);
    setOut("");
    try {
      const r = await fetch("/api/admin/system", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, confirm }),
      });
      const b = await r.json();
      setOut(JSON.stringify(b, null, 2));
    } catch (e) {
      setOut(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy("");
    }
  }
  const Btn = ({ action, label, confirm }: { action: string; label: string; confirm?: boolean }) => (
    <button
      onClick={() => run(action, confirm)}
      disabled={!!busy}
      className="rounded-lg border border-themed px-3 py-2 text-sm font-medium text-muted hover:text-beacon disabled:opacity-50"
    >
      {busy === action ? "Running…" : label}
    </button>
  );
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap gap-2">
          <Btn action="republish" label="Republish feed" />
          <Btn action="evaluate" label="Re-evaluate qualification" />
          <Btn action="syncManagement" label="Sync Management Group" />
          <Btn action="purge" label="Purge stale (dry run)" />
          <Btn action="purge" label="Purge stale (confirm)" confirm />
          <Btn action="promoteLogos" label="Promote due logos" />
          <Btn action="ingestValidators" label="Ingest validators" />
        </div>
        <p className="mt-2 text-xs text-faint">
          These run the same library functions as the scheduled cron jobs.
        </p>
      </Card>
      {out && <pre className="surface overflow-auto rounded-lg border p-3 text-xs">{out}</pre>}
    </div>
  );
}

// Telegram access: config health, membership, and the removal clock.
//
// Config health leads because every failure mode of this feature is a configuration one. A missing
// webhook secret means the endpoint fails closed and NOBODY can join; a missing chat_join_request in
// allowed_updates means the bot never hears about joins at all. Neither is visible from the member
// list, and both look identical to "the feature is broken".
function TelegramTab() {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch("/api/admin/telegram");
      if (!r.ok) throw new Error("load failed");
      setData(await r.json());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function act(action: string, id: string, label: string) {
    if (!confirm(`${label}?`)) return;
    setBusy(id + action);
    setErr("");
    try {
      const r = await fetch("/api/admin/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error ?? "failed");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <div className="text-sm text-muted">{err || "Loading…"}</div>;
  const c = data.config;
  const wh = data.webhook;
  const Pill = ({ ok, label }: { ok: boolean; label: string }) => (
    <span
      className={`rounded px-2 py-1 text-xs ${
        ok ? "bg-emerald-500/15 text-emerald-500" : "bg-flare/15 text-flare"
      }`}
    >
      {ok ? "\u2713" : "\u2715"} {label}
    </span>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted">Configuration</h2>
        <div className="flex flex-wrap gap-2">
          <Pill ok={c.botToken} label="bot token" />
          <Pill ok={c.chatId} label="chat id" />
          <Pill ok={c.webhookSecret} label="webhook secret" />
          <span className="rounded bg-elev px-2 py-1 text-xs text-muted">
            grace {c.graceEpochs} epochs · removes after {c.revokeAfterDays}d ineligible
          </span>
        </div>
        {!c.webhookSecret && (
          <p className="mt-2 text-xs text-flare">
            TELEGRAM_WEBHOOK_SECRET is unset, so the webhook rejects every delivery and nobody can
            join. It fails closed on purpose.
          </p>
        )}
        {wh && (
          <div className="mt-2 space-y-1 text-xs text-faint">
            <div>webhook url: {wh.url || <span className="text-flare">not registered</span>}</div>
            {wh.allowedUpdates && (
              <div>
                allowed updates: {String(wh.allowedUpdates)}
                {!String(wh.allowedUpdates).includes("chat_join_request") && (
                  <span className="text-flare">
                    {" "}
                    (chat_join_request missing: the bot will never see joins)
                  </span>
                )}
              </div>
            )}
            {wh.pendingUpdateCount ? <div>pending updates: {wh.pendingUpdateCount}</div> : null}
            {wh.lastErrorMessage && (
              <div className="text-flare">last error: {wh.lastErrorMessage}</div>
            )}
            {wh.error && <div className="text-flare">getWebhookInfo: {wh.error}</div>}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted">
          Members: {data.counts.joined} joined · {data.counts.issued} link issued ·{" "}
          {data.counts.removed} removed
          {data.counts.onClock > 0 && (
            <span className="text-amber-500"> · {data.counts.onClock} on the removal clock</span>
          )}
        </h2>
        {err && <p className="mb-2 text-sm text-flare">{err}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-faint">
              <tr>
                <th className="py-1 pr-3">Provider</th>
                <th className="py-1 pr-3">Telegram</th>
                <th className="py-1 pr-3">State</th>
                <th className="py-1 pr-3">Eligible now</th>
                <th className="py-1 pr-3">Removal</th>
                <th className="py-1 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.id} className="border-t border-themed/40">
                  <td className="py-1.5 pr-3">
                    {r.name ?? <span className="font-mono text-xs">{r.voter.slice(0, 10)}…</span>}
                    <div className="font-mono text-[10px] text-faint">{r.voter}</div>
                  </td>
                  <td className="py-1.5 pr-3">
                    {r.telegramUsername ? `@${r.telegramUsername}` : r.telegramUserId || "-"}
                  </td>
                  <td className="py-1.5 pr-3">{r.state}</td>
                  <td className="py-1.5 pr-3">
                    <span className={r.eligibleNow ? "text-emerald-500" : "text-flare"}>
                      {r.eligibleNow ? r.eligibleReason : `no (${r.eligibleReason})`}
                    </span>
                    {r.epochsSinceSeen != null && r.epochsSinceSeen > 0 && (
                      <span className="text-faint"> · {r.epochsSinceSeen}ep since seen</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {r.removesInDays != null ? (
                      <span className="text-amber-500">in {r.removesInDays}d</span>
                    ) : (
                      <span className="text-faint">-</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {r.hasLink && (
                      <button
                        onClick={() => act("revokeLink", r.id, "Revoke this invite link")}
                        disabled={busy === r.id + "revokeLink"}
                        className="mr-2 text-xs text-muted underline disabled:opacity-50"
                      >
                        revoke link
                      </button>
                    )}
                    {r.telegramUserId && r.state === "joined" && (
                      <button
                        onClick={() => act("removeMember", r.id, `Remove ${r.name ?? r.voter} from the group`)}
                        disabled={busy === r.id + "removeMember"}
                        className="text-xs text-flare underline disabled:opacity-50"
                      >
                        remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!data.rows.length && (
                <tr>
                  <td colSpan={6} className="py-3 text-sm text-faint">
                    Nobody has requested access yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
