"use client";

import { useState, useEffect, useCallback } from "react";
import { useWalletSign } from "@/lib/useWalletSign";

// Operator-only admin dashboard. English-only (internal tool, not a user-facing page). Access is
// gated by ADMIN_ADDRESSES: sign in with an allowlisted wallet (reusing the SIWE flow) to unlock it.

type Tab = "stats" | "providers" | "qualification" | "governance" | "system";

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
  const connectAndSign = useWalletSign(adminT);

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

  async function connect() {
    setErr("");
    setBusy(true);
    try {
      const { message, signature } = await connectAndSign({ chainId: 14 });
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

  if (!admin) {
    return (
      <div className="mx-auto max-w-md p-6">
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="mt-2 text-sm text-muted">
          {address
            ? `Signed in as ${address.slice(0, 6)}…${address.slice(-4)}, which is not an admin address.`
            : "Connect an admin wallet to continue."}
        </p>
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
    { id: "qualification", label: "Qualification" },
    { id: "governance", label: "Governance" },
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
        {TABS.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === tb.id
                ? "border-beacon text-fg"
                : "border-transparent text-muted hover:text-beacon"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {tab === "stats" && <StatsTab />}
        {tab === "providers" && <ProvidersTab />}
        {tab === "qualification" && <QualificationTab />}
        {tab === "governance" && <GovernanceTab />}
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
const CHAIN_NAME: Record<number, string> = { 14: "Flare", 19: "Songbird", 16: "Coston", 114: "Coston2" };

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
        </div>
        <p className="mt-2 text-xs text-faint">
          These run the same library functions as the scheduled cron jobs.
        </p>
      </Card>
      {out && <pre className="surface overflow-auto rounded-lg border p-3 text-xs">{out}</pre>}
    </div>
  );
}
