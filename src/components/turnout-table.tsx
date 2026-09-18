"use client";

// WHO TURNS UP, for the whole group at once.
//
// One row per entity, one column per proposal, oldest on the left. Read across a row and you see a
// provider's history; read down a column and you see how a single proposal was attended. It is the
// same data the rosters on /proposals carry, transposed, and it is the page's own argument made
// checkable rather than asserted: this group does not disagree, it fails to turn up.
//
// Sorted by turnout, best first, because a table that opens sorted worst-first reads as an
// accusation before the reader has decided anything. Every column header sorts.

import { useMemo, useState } from "react";
import { useApp } from "./providers";
import type { Turnout, TurnoutCell, TurnoutRow } from "@/lib/mg-votes";

type SortKey = "name" | "eligible" | "voted" | "rate";

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

const CELL: Record<TurnoutCell, string> = {
  for: "bg-emerald-500/80",
  against: "bg-rose-500/80",
  missed: "bg-black/15 dark:bg-white/15",
  // Not eligible: present so the columns stay aligned, faint enough not to read as an absence.
  "n/a": "bg-black/[0.04] dark:bg-white/[0.04]",
};

function Strip({ row, proposals }: { row: TurnoutRow; proposals: Turnout["proposals"] }) {
  return (
    <span className="flex gap-[2px] whitespace-nowrap">
      {row.cells.map((c, i) => (
        <span
          key={i}
          title={`${proposals[i]?.voteEndAt.slice(0, 10)} ${proposals[i]?.name ?? ""}`}
          className={`h-3 w-[4px] shrink-0 rounded-[1px] ${CELL[c]}`}
        />
      ))}
    </span>
  );
}

export function TurnoutTable({ data }: { data: Turnout | null }) {
  const { t } = useApp();
  const [sort, setSort] = useState<SortKey>("eligible");
  const [desc, setDesc] = useState(true);
  const [query, setQuery] = useState("");

  const rate = (r: TurnoutRow) => (r.eligible ? r.voted / r.eligible : 0);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (data?.rows ?? []).filter(
      (r) => !q || (r.name ?? "").toLowerCase().includes(q) || r.addr.includes(q)
    );
    const dir = desc ? -1 : 1;
    return [...filtered].sort((a, b) => {
      if (sort === "name") return dir * (a.name ?? a.addr).localeCompare(b.name ?? b.addr);
      // Within an equal record length, the one who turned up more often goes first.
      if (sort === "eligible") return dir * (a.eligible - b.eligible || rate(a) - rate(b));
      if (sort === "voted") return dir * (a.voted - b.voted);
      // Ties on rate go to the one with more proposals behind it: 3 of 3 is not 44 of 44.
      return dir * (rate(a) - rate(b) || a.eligible - b.eligible);
    });
  }, [data, sort, desc, query]);

  const header = (key: SortKey, label: string, className = "") => (
    <th scope="col" className={`py-2 text-left font-medium ${className}`}>
      <button
        type="button"
        onClick={() => {
          if (sort === key) setDesc((d) => !d);
          else {
            setSort(key);
            setDesc(key !== "name");
          }
        }}
        className={`hover:text-beacon ${sort === key ? "text-fg" : ""}`}
        aria-sort={sort === key ? (desc ? "descending" : "ascending") : "none"}
      >
        {label}
        <span aria-hidden="true">{sort === key ? (desc ? " ▾" : " ▴") : ""}</span>
      </button>
    </th>
  );

  if (!data || !data.rows.length) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold">{t("turnout.h")}</h1>
        <p className="mt-3 text-sm text-flare">{t("prop.unreachable")}</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-semibold">{t("turnout.h")}</h1>
      <p className="mt-2 text-sm text-muted">{t("turnout.intro")}</p>
      {/* The denominator is the whole honesty of this table, so it is stated on the page rather
          than left for a reader to infer from two columns that disagree. */}
      <p className="mt-2 text-xs text-faint">{t("turnout.denominator")}</p>
      <p className="mb-6 mt-2 text-xs">
        <a href="/proposals" className="text-beacon hover:underline">
          {t("turnout.backToProposals")}
        </a>
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("turnout.filter")}
          aria-label={t("turnout.filter")}
          className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-themed bg-transparent px-3 text-xs text-fg placeholder:text-faint"
        />
        <p className="text-xs text-faint">
          {t("turnout.count", { rows: rows.length, proposals: data.proposals.length })}
        </p>
      </div>

      {/* The matrix is wider than a phone and must not squash: it scrolls on its own. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-xs">
          <thead className="border-b border-themed text-faint">
            <tr>
              {header("name", t("turnout.col.provider"))}
              {header("voted", t("turnout.col.voted"), "w-[1%] whitespace-nowrap pl-3")}
              {header("eligible", t("turnout.col.eligible"), "w-[1%] whitespace-nowrap pl-3")}
              {header("rate", t("turnout.col.rate"), "w-[1%] whitespace-nowrap pl-3")}
              {/* Sized for the matrix rather than for the words, so the cells never wrap. */}
              <th scope="col" className="w-[320px] py-2 pl-4 text-left font-medium">
                {t("turnout.col.record")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.addr} className="border-b border-themed">
                <td className="py-2 pr-3">
                  <span className="flex min-w-0 items-center gap-2">
                    {r.logoURI ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.logoURI} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" loading="lazy" />
                    ) : (
                      <span className="h-5 w-5 shrink-0 rounded-full bg-black/10 dark:bg-white/10" />
                    )}
                    {r.href ? (
                      <a href={`/provider/${r.href}`} className="truncate text-muted hover:text-beacon">
                        {r.name ?? shortAddr(r.addr)}
                      </a>
                    ) : (
                      <span className={`truncate text-muted ${r.name ? "" : "font-mono text-[11px]"}`}>
                        {r.name ?? shortAddr(r.addr)}
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-2 pl-3 tabular-nums text-muted">{r.voted}</td>
                <td className="py-2 pl-3 tabular-nums text-faint">{r.eligible}</td>
                <td className="py-2 pl-3 tabular-nums text-fg">
                  {r.eligible ? `${Math.round(rate(r) * 100)}%` : "-"}
                </td>
                <td className="py-2 pl-4">
                  <Strip row={r} proposals={data.proposals} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!rows.length && <p className="mt-3 text-sm text-muted">{t("turnout.none")}</p>}

      <p className="mt-4 text-[11px] text-faint">{t("turnout.legend")}</p>
    </div>
  );
}
