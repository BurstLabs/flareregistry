"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useWalletSign } from "@/lib/useWalletSign";
import {
  LATTICE_MIN_TRIALS,
  LATTICE_LIFT_EXCLUDE,
  PATTERN_MIN_ROUNDS,
  PATTERN_STRONG,
  PATTERN_KNOWN_CUSTOM,
} from "@/lib/detection";

// Operator-only admin dashboard. English-only (internal tool, not a user-facing page). Access is
// gated by ADMIN_ADDRESSES: sign in with an allowlisted wallet (reusing the SIWE flow) to unlock it.

type Tab =
  | "stats"
  | "providers"
  | "imports"
  | "qualification"
  | "governance"
  | "reports"
  | "consumers"
  | "detection"
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
    { id: "reports", label: "Logo reports" },
    { id: "consumers", label: "Consumers" },
    { id: "detection", label: "Detection" },
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
        {tab === "reports" && <ReportsTab />}
        {tab === "consumers" && <ConsumersTab />}
        {tab === "detection" && <ExampleProviderTab />}
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
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted">
          Traffic (last 30 days) — {data.traffic.totalHits} views, {data.traffic.totalUniques} unique
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
                  title={p.archivedAt ? `Archived ${new Date(p.archivedAt).toISOString().slice(0, 10)} — click to restore` : "Archive (remove from live feed, keep record)"}
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
            : `Scanned ${s.fetched} entries · ${s.staged} new staged · ${s.refreshed} refreshed · ${s.absorbed} absorbed.`
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

function PendingLogosPanel() {
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
      if (r.ok) load();
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
function ReportsTab() {
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
    if (r.ok) load();
  }
  return (
    <div>
      <PendingLogosPanel />
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
    </div>
  );
}

// ---------- Detection (example-provider similarity) ----------
// Flare-only. Ranks registered providers by how closely their on-chain long-tail submissions track our
// own reference instances of the example Feed Value Provider, vs the field. A SUSPICION SCORE, not
// proof - the example provider is non-deterministic, so high similarity means "behaves like the example
// provider," never certainty. Never auto-acts; evidence for human judgment only.
function ExampleProviderTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [maxRounds, setMaxRounds] = useState(0);
  // Verified-custom controls, still shown as the scale anchor even though the false-positive rate they
  // used to police belonged to the removed probability column.
  const [fp, setFp] = useState<{ rate: number | null; count: number; names: string[] }>({
    rate: null,
    count: 0,
    names: [],
  });
  const [loading, setLoading] = useState(true);
  const [calibrated, setCalibrated] = useState(true);
  const [ruledOutCount, setRuledOutCount] = useState(0);
  // Sort state. Default = tick-grid lift, descending. It used to default to the fingerprint-derived
  // probability, which meant a discredited metric ordered the entire screen.
  const [sortKey, setSortKey] = useState<string>("latticeLift");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Report threshold is now a tick-grid LIFT (e.g. 1.6x), not a probability percent.
  const [reportThreshold, setReportThreshold] = useState("1.6");
  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/admin/example-provider");
    const b = await r.json();
    setRows(b.report ?? []);
    setMaxRounds(b.maxRounds ?? 0);
    setFp({ rate: b.falsePositiveRate ?? null, count: b.knownCustomCount ?? 0, names: b.falsePositiveNames ?? [] });
    setCalibrated(b.calibrated !== false);
    setRuledOutCount(b.ruledOutCount ?? 0);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Confidence is low until the accumulators mature (~500 rounds, ~12h). Flag the warm-up state.
  const warming = maxRounds < 200;

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  // Compact whole-token weight: 187.8M / 21.4K / 640.
  const compact = (n: number) =>
    n >= 1e9
      ? `${(n / 1e9).toFixed(1)}B`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(1)}M`
        : n >= 1e3
          ? `${(n / 1e3).toFixed(1)}K`
          : `${Math.round(n)}`;

  // Click a header to sort by it; clicking the active one flips direction.
  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }
  const sorted = [...rows].sort((a, b) => {
    let av = a[sortKey];
    let bv = b[sortKey];
    if (sortKey === "name") {
      av = (a.name ?? "").toLowerCase();
      bv = (b.name ?? "").toLowerCase();
    } else if (sortKey === "variant") {
      av = a.variant ?? "";
      bv = b.variant ?? "";
    } else if (sortKey === "latticeLift") {
      av = a.lattice?.lift ?? null;
      bv = b.lattice?.lift ?? null;
    } else if (sortKey === "patternR") {
      av = a.pattern?.r ?? null;
      bv = b.pattern?.r ?? null;
    }
    if (av == null) av = -Infinity;
    if (bv == null) bv = -Infinity;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === "desc" ? -cmp : cmp;
  });

  // Sortable header cell: tooltip + click-to-sort + active-direction arrow.
  const SortTh = ({
    label,
    col,
    tip,
    align = "right",
  }: {
    label: string;
    col: string;
    tip: string;
    align?: "left" | "right" | "center";
  }) => (
    <th
      className={`cursor-pointer select-none pb-2 font-normal hover:text-beacon ${
        align === "left" ? "text-left" : align === "center" ? "text-center" : "text-right"
      }`}
      title={tip}
      onClick={() => toggleSort(col)}
    >
      {label}
      <span className="ml-0.5 inline-block w-2 text-beacon">
        {sortKey === col ? (sortDir === "desc" ? "▾" : "▴") : ""}
      </span>
    </th>
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-fg">
          Example-provider similarity <span className="text-faint">(Flare)</span>
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted" title="Minimum TICK-GRID LIFT for a provider to be included in the downloaded report. 1.0x = behaves like the field; genuine example-provider instances measure 1.44x-2.33x, so ~1.6x is a reasonable cut.">
            Report threshold
            <input
              type="number"
              min={0}
              max={10}
              step={0.1}
              value={reportThreshold}
              onChange={(e) => setReportThreshold(e.target.value)}
              className="w-16 rounded-md border border-themed bg-elev px-1.5 py-1 text-xs tabular-nums"
            />
            <span className="text-faint">x lift</span>
          </label>
          <a
            href={`/api/admin/example-provider/report?minLift=${Math.min(10, Math.max(0, Number(reportThreshold) || 0)).toFixed(2)}`}
            className="rounded-md border border-beacon px-2.5 py-1 text-xs font-medium text-beacon hover:bg-beacon/10"
            title="Download a CSV report of probable example-provider users, with total network weight they hold and full detection data."
          >
            Download report
          </a>
          <button
            onClick={load}
            className="rounded-md border border-themed px-2.5 py-1 text-xs text-muted hover:text-beacon"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-beacon/40 bg-beacon/5 p-3 text-xs leading-relaxed text-muted">
        A <strong className="text-fg">suspicion score</strong>, not proof. Use as evidence for human
        judgment; it never drives listing changes automatically.
        {warming && (
          <div className="mt-2 rounded bg-amber-500/15 px-2 py-1 text-amber-500">
            Warming up: only {maxRounds} rounds observed so far. Scores stabilise over ~12h of data.
            Treat current values as provisional.
          </div>
        )}
        {fp.count > 0 && !calibrated && (
          <div className="mt-2 text-[11px] text-faint">
            Fingerprint calibration is currently unavailable (no cross-config reference anchor). This no
            longer affects the screen, since the Tick grid column does not use the reference at all.
          </div>
        )}
        <div className="mt-2 text-[11px] text-faint">
          Reference scale for the Tick grid column: the field sits at{" "}
          <span className="text-fg">1.00x</span> by construction, our own example-provider instances
          measure <span className="text-fg">1.44x-2.33x</span> depending on exchange config, and our
          verified-custom control measures <span className="text-emerald-500">0.52x</span>. Providers are
          excluded only when the upper bound of their lift stays below 1.30x.
        </div>
        <div className="mt-2 text-[11px] text-faint">
          The old P(example) and Fingerprint columns were removed: both scored providers by similarity to
          our own replica, which sits far outside the provider cloud, and 6 of their top 20 were providers
          this screen formally excludes. The values are still in the CSV for the record.
        </div>
        {ruledOutCount > 0 && (
          <div className="mt-2 text-[11px] text-faint">
            Tick-grid screen: <span className="text-emerald-500">{ruledOutCount}</span> of {rows.length}{" "}
            providers excluded (their values do not echo raw exchange prints). The remaining{" "}
            {rows.length - ruledOutCount} are <em>not</em> thereby implicated: any median-of-prints
            implementation reads above the field, including our verified-custom control.
          </div>
        )}
      </div>

      <Card>
        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">No similarity data yet. The scorer runs every 5 minutes.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-faint">
                <th className="pb-2 pr-2 text-right font-normal">#</th>
                <SortTh
                  label="Provider"
                  col="name"
                  align="left"
                  tip="The registered provider (identified by its on-chain submit address). '(unlisted)' = submits on-chain but has no listing in our registry."
                />
                {/*
                  P(example) and Fingerprint were REMOVED. Both were reference-anchored: they scored a
                  provider by how closely it matched our own replica. A multi-agent audit showed that
                  family cannot produce positive detections at any calibration, because the replica sits
                  6.3x outside the provider cloud. Two independent mechanical signals then contradicted
                  the ranking outright, and 6 of its top 20 were providers the tick-grid screen formally
                  EXCLUDES - it rendered a red 99% beside a green "ruled out" on the same row. Its anchor
                  was also drifting (0.890 -> 0.571 within hours), which saturated the logistic and is
                  why it printed 100%. The underlying values are still computed and still exported in the
                  CSV for the record; they are simply no longer shown or sorted on.
                */}
                <SortTh
                  label="Tick grid"
                  col="latticeLift"
                  tip="TICK-GRID lift: how much more often this provider's value lands on a coarse exchange tick grid than THE FIELD did on the same feeds in the same rounds. The example provider returns an observed trade PRINT verbatim, so its values inherit the venue's tick grid; averaging or mid-pricing smooths that away. The baseline is the per-round leave-one-out field rate, so 1.0x means 'behaves like the field'. It is NOT an arithmetic 1/T null: most lattices are powers of ten, so raw divisibility mostly measures 'rounded to fewer decimals', which any implementation can do and which varies by round. Measured: field 1.0x, example-provider level ~1.8-2.1x, verified-custom Burst FTSO 0.54x, verified-custom 1FTSO 1.47x. ONE-SIDED: low is strong evidence AGAINST, high is NOT proof FOR - 1FTSO is verified custom and still reads above the field, because any median-of-prints implementation echoes a print."
                />
                <SortTh
                  label="Pattern"
                  col="patternR"
                  tip="PER-CELL HIT-PATTERN match: does this provider over-hit the SAME (feed, tick) cells our reference example provider does? Aggregate lift cannot rank the non-excluded providers, because it is confounded by config size (our own configs span 1.44x-2.33x) and because any median-of-prints implementation reads high. But which cells get over-hit is set by the VENUE LIST, so this is far more specific than the level. Measured: our instances match each other at 0.624; verified-custom 1FTSO (a median-of-prints custom) reaches 0.396; verified-custom Burst FTSO reads -0.432. RED = above 0.50, close to the reference's own self-similarity. AMBER = above 0.396, i.e. more example-provider-like than a provider we KNOW is custom. Still not proof."
                />
                <SortTh
                  label="Variant"
                  col="variant"
                  align="center"
                  tip="Which exchange-subset variant of the example provider it best matches: full = all ~18 exchanges (default), top5 / top10 = only the most popular exchanges. Hints at how they edited feeds.json."
                />
                <SortTh
                  label="Weight"
                  col="weight"
                  tip="On-chain vote power (wNat weight) of this provider's entity, in whole tokens. Context for how much influence a suspected example-provider user actually has."
                />
                <SortTh
                  label="Accuracy dev"
                  col="accuracy"
                  tip="Mean deviation of this provider's submissions from the field consensus median, in spread units. LOWER = more accurate / closer to consensus. Independent of the example-provider question."
                />
                <SortTh
                  label="Conf."
                  col="confidence"
                  tip="Confidence in this provider's score, scaling with how many rounds we've observed it (full after ~500 rounds / ~12h). Low confidence = treat the probability as provisional."
                />
                <SortTh
                  label="Rounds"
                  col="rounds"
                  tip="Number of voting rounds this provider has been scored over. More rounds = more stable score."
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.voter} className="border-t border-themed/40">
                  <td className="py-1.5 pr-2 text-right tabular-nums text-faint">{i + 1}</td>
                  <td className="py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.name ?? "(unlisted)"}</span>
                      {/* Combined class from level + shape. See detectionClass(). */}
                      {r.klass === "candidate" && (
                        <span
                          className="rounded bg-flare/15 px-1 text-[10px] text-flare"
                          title="Echoes raw exchange prints AND over-hits the same cells as our reference example provider, i.e. consistent with the same venue list. The strongest class we can assign. Still not proof."
                        >
                          candidate
                        </span>
                      )}
                      {r.klass === "other-median" && (
                        <span
                          className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-500"
                          title="Echoes raw exchange prints, but on a DIFFERENT set of cells than our reference, i.e. a median-of-prints implementation over a different venue list. Our verified-custom control 1FTSO sits here: identical to our reference on lift (1.50x) but far away on pattern (0.42 vs 0.84)."
                        >
                          other median
                        </span>
                      )}
                      {r.knownCustom && (
                        <span
                          className="rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-400"
                          title="Verified NOT running the example provider. Used as a trusted negative in calibration."
                        >
                          verified custom
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-faint">{r.voter.slice(0, 18)}…</span>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.lattice?.lift != null ? (
                      // ONE-SIDED screen, so ONLY the exclusion end is coloured. A red/amber ramp on the
                      // high end would encode exactly the inference this screen cannot support, and it
                      // painted verified-custom 1FTSO in the table's accusation colour.
                      <span
                        className={r.lattice.ruledOut ? "text-emerald-500" : "text-muted"}
                        title={
                          `${r.lattice.hits} hits over ${r.lattice.trials} trials; ` +
                          `upper bound ${r.lattice.liftUpper?.toFixed(2) ?? "?"}x. 1.0x = behaves like the field. ` +
                          (r.lattice.ruledOut
                            ? `RULED OUT: even the upper bound stays under ${LATTICE_LIFT_EXCLUDE}x, below the ~1.8-2.1x the example provider produces.`
                            : r.lattice.trials < LATTICE_MIN_TRIALS
                              ? `Still accumulating; needs ${LATTICE_MIN_TRIALS}+ trials before it may rule anyone out.`
                              : "Not excluded. This is NOT evidence of guilt: any median-of-prints implementation reads high, including verified-custom 1FTSO.")
                        }
                      >
                        {r.lattice.lift.toFixed(2)}x
                        {r.lattice.ruledOut && <span className="ml-1 text-[10px]">ruled out</span>}
                        <span className="ml-1 text-[10px] text-faint">n={r.lattice.trials}</span>
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.pattern?.r != null ? (
                      <span
                        className={
                          r.pattern.band === "strong"
                            ? "font-semibold text-flare"
                            : r.pattern.band === "elevated"
                              ? "text-amber-500"
                              : "text-muted"
                        }
                        title={
                          `Matches config ${r.pattern.bestConfig ?? "?"} at r=${r.pattern.bestR?.toFixed(3) ?? "?"}, over ${r.pattern.rounds} rounds. ` +
                          (!r.pattern.mature
                            ? `NOT YET MATURE: a correlation between noisy profiles is attenuated toward zero, so this value is biased LOW and no band or class is applied until ${PATTERN_MIN_ROUNDS} rounds.`
                            : r.lattice?.ruledOut
                            ? "Excluded by the tick-grid screen, so no suspicion band is applied regardless of this value."
                            : r.pattern.band === "strong"
                              ? `At or above ${PATTERN_STRONG}: over-hits the same cells as our reference, whose own instances sit at 0.80-0.87.`
                              : r.pattern.band === "elevated"
                                ? `At or above ${PATTERN_KNOWN_CUSTOM}, i.e. beyond what a provider we KNOW is custom (1FTSO) reaches. Elevated, not conclusive.`
                                : "At or below the verified-custom control. No elevation.")
                        }
                      >
                        {r.pattern.r.toFixed(3)}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="py-1.5 text-center">
                    {r.variant ? (
                      <span className="rounded bg-elev px-1.5 py-0.5 text-[10px] text-muted">
                        {r.variant}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-muted">
                    {r.weight != null ? compact(r.weight) : <span className="text-faint">—</span>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-muted">
                    {r.accuracy.toFixed(3)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-faint">{pct(r.confidence)}</td>
                  <td className="py-1.5 text-right tabular-nums text-faint">{r.rounds}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

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
