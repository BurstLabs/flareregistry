"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useWalletSign } from "@/lib/useWalletSign";

// Operator-only admin dashboard. English-only (internal tool, not a user-facing page). Access is
// gated by ADMIN_ADDRESSES: sign in with an allowlisted wallet (reusing the SIWE flow) to unlock it.

type Tab =
  | "stats"
  | "providers"
  | "qualification"
  | "governance"
  | "reports"
  | "consumers"
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
    { id: "qualification", label: "Qualification" },
    { id: "governance", label: "Governance" },
    { id: "reports", label: "Logo reports" },
    { id: "consumers", label: "Consumers" },
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
        {tab === "reports" && <ReportsTab />}
        {tab === "consumers" && <ConsumersTab />}
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
