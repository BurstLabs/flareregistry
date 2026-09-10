"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/providers";

// WHO voted, and WHEN, for one proposal.
//
// A proposal runs 48 hours and dies without quorum, so the number a member needs is not the tally,
// which Flare's portal already shows, but the names still missing from it. As this is written the
// two live proposals stand at 28 in favour and 0 against with a bar of 33: unanimous, and five
// short. Nothing anywhere published which five.
//
// Collapsed, every card carries a strip of one tick per eligible member, which reads as a progress
// bar at a glance and as a roster on inspection. Expanded, it draws the 48-hour window with the
// turnout curve against the quorum line, then names both groups.

export interface MemberRef {
  addr: string;
  name: string | null;
  logoURI: string | null;
  href: string | null;
}

/** Interned: `m` indexes the shared member list, `t` is unix seconds, `f` is "in favour". */
export interface VoteRef {
  m: number;
  f: boolean;
  t: number;
}

export interface ParticipationRef {
  eligible: number[];
  votes: VoteRef[];
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

/** Hours into the voting window, which is how a member reads "when" for a 48-hour vote. */
function hoursInto(at: number, startMs: number): number {
  return Math.max(0, (at * 1000 - startMs) / 3_600_000);
}

function utcStamp(at: number): string {
  return new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * The 48-hour window, the turnout curve and the bar it has to clear.
 *
 * Inline SVG rather than a chart library: it is one monotone step curve and two straight lines, it
 * has to be legible in both themes, and the page already refuses to load anything it does not need.
 * The y axis is the WHOLE eligible group, not the number who voted, so the curve shows turnout as
 * the share it actually is and the quorum line sits where the bar actually is. Scaling to the votes
 * cast would draw every proposal as a curve reaching the top of the box, including the ones that
 * failed.
 */
function Timeline({
  votes, members, eligible, quorumNeeded, startMs, endMs, now,
}: {
  votes: VoteRef[]; members: MemberRef[]; eligible: number; quorumNeeded: number;
  startMs: number; endMs: number; now: number;
}) {
  const { t } = useApp();
  const W = 600, H = 240;
  const L = 6, R = W - 6, TOP = 18, BASE = H - 26;
  /** Marker radius. Every vote is a provider logo at this size, so it has to stay recognisable. */
  const LOGO_R = 7;
  const span = Math.max(1, endMs - startMs);
  // THE TOP OF THE BOX. The whole eligible group was the honest scale while each vote was a 3px
  // dot, but a vote is now a 14px logo, and 49 members across the plot left the ones who voted in
  // the same hour piled on top of each other. Scaling to the BAR, or to turnout once it passes the
  // bar, roughly halves that crowding without the failure the group scale was protecting against:
  // a proposal that fell short still draws a curve that stops visibly below the quorum line,
  // because the line is what the axis is pinned to. Headroom so the last logo is never clipped.
  const maxY = Math.max(1, Math.max(quorumNeeded, votes.length) * 1.15);

  const x = (ms: number) => L + ((Math.min(Math.max(ms, startMs), endMs) - startMs) / span) * (R - L);
  const y = (n: number) => BASE - (n / maxY) * (BASE - TOP);

  // Monotone step: turnout only ever rises, so each vote is a vertical then a horizontal.
  const pts: { px: number; py: number; v: VoteRef; n: number }[] = votes.map((v, i) => ({
    px: x(v.t * 1000), py: y(i + 1), v, n: i + 1,
  }));
  let d = `M ${L} ${y(0)}`;
  for (const p of pts) d += ` L ${p.px} ${y(p.n - 1)} L ${p.px} ${p.py}`;
  // Carry the line to the right edge: to now while it is running, to the close once it has ended.
  const endX = x(Math.min(now, endMs));
  d += ` L ${endX} ${y(votes.length)}`;
  const area = `${d} L ${endX} ${BASE} L ${L} ${BASE} Z`;

  const met = votes.length >= quorumNeeded;
  const stroke = met ? "rgb(16 185 129)" : "rgb(245 158 11)";
  const qy = y(quorumNeeded);
  const running = now < endMs;
  const uid = `${startMs}-${quorumNeeded}`;

  // A tick every 12 hours, which for a 48-hour window is four gridlines and no crowding.
  const ticks: number[] = [];
  for (let h = 12; h * 3_600_000 < span; h += 12) ticks.push(h);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={t("prop.roster.chartAlt", { cast: votes.length, needed: quorumNeeded })}
      className="mt-3 block h-auto w-full"
    >
      <defs>
        {/* objectBoundingBox units, so this ONE path clips every logo to a circle inscribed in
            whatever box it is applied to. No per-marker clipPath and no id collisions between
            cards. */}
        <clipPath id="logo-clip" clipPathUnits="objectBoundingBox">
          <circle cx="0.5" cy="0.5" r="0.5" />
        </clipPath>
        <linearGradient id={`g-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {ticks.map((h) => {
        const tx = x(startMs + h * 3_600_000);
        return (
          <g key={h}>
            <line x1={tx} y1={TOP - 6} x2={tx} y2={BASE} stroke="currentColor" strokeOpacity="0.10" strokeWidth="1" />
            <text x={tx} y={BASE + 14} textAnchor="middle" fontSize="9" fill="currentColor" fillOpacity="0.45">
              {t("prop.roster.hourTick", { hours: h })}
            </text>
          </g>
        );
      })}

      <line x1={L} y1={BASE} x2={R} y2={BASE} stroke="currentColor" strokeOpacity="0.18" strokeWidth="1" />

      {/* The bar. Dashed so it never reads as data, and labelled with the number it stands for. */}
      <line x1={L} y1={qy} x2={R} y2={qy} stroke={stroke} strokeOpacity="0.55" strokeWidth="1" strokeDasharray="4 4" />
      {/* Labelled on the LEFT. Turnout only rises, so the right-hand end of the chart is where the
          curve and its fill are highest, and a label anchored there sat on top of them on every
          proposal that cleared the bar. The top left is empty on all of them. */}
      <text x={L + 2} y={qy - 5} textAnchor="start" fontSize="9" fill={stroke} fillOpacity="0.9">
        {t("prop.roster.quorumLine", { needed: quorumNeeded })}
      </text>

      <path d={area} fill={`url(#g-${uid})`} />
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinejoin="round" />

      {/* EACH VOTE IS THE PROVIDER WHO CAST IT. Drawn in time order, so where several members vote
          within minutes of each other the later logos overlap the earlier ones the way a stack of
          avatars does, which reads as the cluster it is. A member we have no logo for keeps a plain
          dot rather than a placeholder box. */}
      {pts.map((p, i) => {
        const m = members[p.v.m];
        const label = t("prop.roster.dot", {
          name: m?.name ?? shortAddr(m?.addr ?? ""),
          hours: hoursInto(p.v.t, startMs).toFixed(1),
          date: utcStamp(p.v.t),
        });
        if (!m?.logoURI) {
          return (
            <circle key={i} cx={p.px} cy={p.py} r="3" fill={stroke}>
              <title>{label}</title>
            </circle>
          );
        }
        return (
          // Hover scales the marker up in place. Where several members voted minutes apart their
          // logos genuinely do overlap, and SVG paints later siblings on top with no way to
          // reorder on hover, so growing the one under the cursor is what makes a pile explorable.
          <g key={i} className="origin-center transition-transform duration-100 hover:scale-[1.7]"
             style={{ transformBox: "fill-box", transformOrigin: "center" }}>
            {/* The ring is what separates one logo from the one it overlaps, and it carries the
                for/against colour that the bare logo cannot. */}
            <circle cx={p.px} cy={p.py} r={LOGO_R + 0.9} fill="rgb(var(--bg-elev))" />
            <image
              href={m.logoURI}
              x={p.px - LOGO_R} y={p.py - LOGO_R}
              width={LOGO_R * 2} height={LOGO_R * 2}
              preserveAspectRatio="xMidYMid slice"
              clipPath="url(#logo-clip)"
            />
            <circle
              cx={p.px} cy={p.py} r={LOGO_R}
              fill="none" strokeWidth="1.2"
              stroke={p.v.f ? "rgb(16 185 129)" : "rgb(244 63 94)"}
              strokeOpacity="0.9"
            />
            <title>{label}</title>
          </g>
        );
      })}

      {/* Where the clock has got to, on a vote that is still running. */}
      {running && now > startMs && (
        <g>
          <line x1={x(now)} y1={TOP - 6} x2={x(now)} y2={BASE} stroke="currentColor" strokeOpacity="0.45" strokeWidth="1" strokeDasharray="2 3" />
          <text x={x(now)} y={TOP - 8} textAnchor="middle" fontSize="9" fill="currentColor" fillOpacity="0.6">
            {t("prop.roster.now")}
          </text>
        </g>
      )}

      <text x={L} y={BASE + 14} fontSize="9" fill="currentColor" fillOpacity="0.45">
        {t("prop.roster.opened")}
      </text>
      <text x={R} y={BASE + 14} textAnchor="end" fontSize="9" fill="currentColor" fillOpacity="0.45">
        {t("prop.roster.closes")}
      </text>
    </svg>
  );
}

/** One member, named where we can name them. */
function MemberRow({ m, vote, startMs }: { m: MemberRef | undefined; vote?: VoteRef; startMs: number }) {
  const { t } = useApp();
  if (!m) return null;
  const body = (
    <>
      {m.logoURI ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.logoURI} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" loading="lazy" />
      ) : (
        <span className="h-5 w-5 shrink-0 rounded-full bg-black/10 dark:bg-white/10" />
      )}
      <span className={`truncate ${m.name ? "" : "font-mono text-[11px]"}`}>
        {m.name ?? shortAddr(m.addr)}
      </span>
    </>
  );
  return (
    <li className="flex items-center gap-2 text-xs">
      {m.href ? (
        <a href={`/provider/${m.href}`} className="flex min-w-0 flex-1 items-center gap-2 text-muted hover:text-beacon">
          {body}
        </a>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-muted">{body}</span>
      )}
      {vote && (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="tabular-nums text-[11px] text-faint" title={utcStamp(vote.t)}>
            {t("prop.roster.at", { hours: hoursInto(vote.t, startMs).toFixed(1) })}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              vote.f
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                : "bg-rose-500/15 text-rose-600 dark:text-rose-300"
            }`}
          >
            {vote.f ? t("prop.roster.for") : t("prop.roster.against")}
          </span>
        </span>
      )}
    </li>
  );
}

export function ProposalRoster({
  part, members, quorumNeeded, voteStartAt, voteEndAt, nowMs, open,
}: {
  part: ParticipationRef;
  members: MemberRef[];
  quorumNeeded: number;
  voteStartAt: string;
  voteEndAt: string;
  /** The server's clock. Never Date.now() here: see the note on the payload field. */
  nowMs: number;
  /** Whether the window is still running, which decides "has not voted" vs "did not vote". */
  open: boolean;
}) {
  const { t } = useApp();
  // OPEN PROPOSALS START EXPANDED. That is the whole point of the feature: while the window is
  // running the names still missing are the actionable thing, and putting them behind a click
  // hides them from exactly the person who came to find them. Decided proposals start collapsed,
  // because sixteen cards of fifty names each is a wall nobody asked for.
  const [shown, setShown] = useState(open);

  const startMs = new Date(voteStartAt).getTime();
  const endMs = new Date(voteEndAt).getTime();

  const { voted, absent, ticks } = useMemo(() => {
    const byMember = new Map<number, VoteRef>();
    for (const v of part.votes) byMember.set(v.m, v);
    // Eligibility is the snapshot, but a vote from outside it still counts and is still shown.
    const roster = part.eligible.length
      ? part.eligible
      : [...new Set(part.votes.map((v) => v.m))];
    const extra = part.votes.map((v) => v.m).filter((m) => !roster.includes(m));
    const all = [...roster, ...new Set(extra)];
    return {
      voted: part.votes.map((v) => ({ m: v.m, v })),
      absent: all.filter((m) => !byMember.has(m)),
      // Ticks follow the roster order so the strip is stable between renders, not the vote order.
      ticks: all.map((m) => byMember.get(m) ?? null),
    };
  }, [part]);

  const cast = part.votes.length;
  const eligible = ticks.length;
  if (!eligible) return null;

  return (
    <div className="mt-3 border-t border-themed pt-3">
      {/* THE STRIP. One tick per eligible member: filled where they voted, hollow where they have
          not. It reads as a progress bar from across the room and as a count on inspection, and it
          is the only part of this that every card carries. */}
      <div className="flex flex-wrap gap-[3px]" aria-hidden="true">
        {ticks.map((v, i) => (
          <span
            key={i}
            className={`h-3 w-[6px] rounded-[1px] ${
              v === null
                ? "bg-black/10 dark:bg-white/10"
                : v.f
                  ? "bg-emerald-500/80"
                  : "bg-rose-500/80"
            }`}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-expanded={shown}
        className="mt-2 flex min-h-[32px] items-center gap-1.5 text-[11px] text-muted hover:text-beacon"
      >
        <span>
          {/* While the window is open the operative number is the one still MISSING, because that
              is the only one a member can do anything about. Afterwards it is the turnout. */}
          {open
            ? t("prop.roster.summaryOpen", { cast, absent: absent.length })
            : t("prop.roster.summary", { cast, eligible })}
        </span>
        <span aria-hidden="true">{shown ? "▴" : "▾"}</span>
      </button>

      {shown && (
        <div className="mt-1">
          <Timeline
            votes={part.votes}
            members={members}
            eligible={eligible}
            quorumNeeded={quorumNeeded}
            startMs={startMs}
            endMs={endMs}
            now={nowMs}
          />

          <div className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
                {t("prop.roster.votedH", { n: voted.length })}
              </p>
              <ul className="space-y-1.5">
                {voted.map(({ m, v }, i) => (
                  <MemberRow key={`${m}-${i}`} m={members[m]} vote={v} startMs={startMs} />
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
                {open
                  ? t("prop.roster.pendingH", { n: absent.length })
                  : t("prop.roster.absentH", { n: absent.length })}
              </p>
              {absent.length ? (
                <ul className="space-y-1.5">
                  {absent.map((m) => (
                    <MemberRow key={m} m={members[m]} startMs={startMs} />
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">{t("prop.roster.everyone")}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
