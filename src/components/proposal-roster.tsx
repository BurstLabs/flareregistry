"use client";

import { useMemo, useRef, useState } from "react";
import { useApp } from "@/components/providers";
import { MgRemoveButton } from "@/components/mg-remove-button";
import { useMgVotes } from "@/lib/mg-voted";
import { entityKey, type HistoryCell } from "@/lib/member-history";

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

/**
 * Interned: `m` indexes the shared member list, `t` is unix seconds, `f` is "in favour".
 *
 * `f` is NULL where the vote is known but the side is not. The contract reports `hasVoted` and
 * nothing else: no getter on PollingManagementGroup returns which way a member voted, and the side
 * lives only in the VoteCast logs that the explorer sweep reads. So between casting a vote and the
 * sweep catching up, "voted" is a fact and "for" is not, and the row says the one it can stand up.
 */
export interface VoteRef {
  m: number;
  f: boolean | null;
  t: number | null;
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
  votes: allVotes, members, eligible, quorumNeeded, startMs, endMs, now,
}: {
  votes: VoteRef[]; members: MemberRef[]; eligible: number; quorumNeeded: number;
  startMs: number; endMs: number; now: number;
}) {
  const { t } = useApp();
  // TIMED VOTES ONLY. A vote known from the contract rather than from a log has no block behind it,
  // and this plot's whole axis is when. Placing an untimed vote anywhere on it would be inventing
  // the one value the chart exists to show; it is counted in the roster beside this and arrives
  // here with its real timestamp once the sweep catches up.
  const votes = allVotes.filter((v) => v.t != null);
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
    px: x((v.t as number) * 1000), py: y(i + 1), v, n: i + 1,
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
          hours: hoursInto(p.v.t as number, startMs).toFixed(1),
          date: utcStamp(p.v.t as number),
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
              stroke={
                p.v.f === null
                  ? "rgb(148 163 184)"
                  : p.v.f
                    ? "rgb(16 185 129)"
                    : "rgb(244 63 94)"
              }
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

/**
 * A STRIP OF TICKS THAT CAN TELL YOU WHAT EACH ONE IS.
 *
 * Shared by the two strips on this page, which want the same behaviour and label different things:
 * the card strip is one tick per member and names the provider, the row strip is one tick per
 * proposal and names the vote.
 *
 * NOT A TITLE ATTRIBUTE, which is what the row strip shipped with and what had to be replaced. A
 * native tooltip waits for the pointer to come to rest and will not re-arm when the pointer moves
 * straight from one adjacent element to the next. On a row of five-pixel targets two pixels apart
 * that means it appears if you approach slowly and stop, and otherwise never, which is exactly how
 * it behaved. This one appears on the first pointer event and follows the pointer along the strip.
 *
 * POSITIONED FROM THE ELEMENT, not from index arithmetic, because the card strip WRAPS onto several
 * lines at fifty members and computed offsets would put the label on the wrong row entirely.
 *
 * Clamped at both ends against the container, since these sit in a two-column grid and a label
 * centred on the last tick of the right-hand column would hang off the card.
 */
export function LabelledTicks({
  items,
  tick,
  wrap,
}: {
  items: { key: string; className: string; label: string }[];
  /** Tick geometry: [width, height, gap] in px. */
  tick: [number, number, number];
  wrap?: boolean;
}) {
  const [hv, setHv] = useState<{ i: number; x: number; y: number } | null>(null);
  const box = useRef<HTMLSpanElement | null>(null);
  const [w, h, gap] = tick;
  if (!items.length) return null;

  const width = box.current?.clientWidth ?? 0;
  // Which edge the label hangs from, so it never leaves the card.
  const anchor =
    hv === null ? "mid" : hv.x < 70 ? "start" : width && hv.x > width - 70 ? "end" : "mid";

  return (
    <span
      ref={box}
      className={`relative flex items-center ${wrap ? "flex-wrap" : "shrink-0"}`}
      style={{ gap }}
      onPointerLeave={() => setHv(null)}
    >
      {items.map((it, i) => (
        <span
          key={it.key}
          onPointerEnter={(e) => {
            const el = e.currentTarget;
            setHv({ i, x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop });
          }}
          // Touch: a tap arrives as pointerdown, and without this the strip is inert on a phone.
          onPointerDown={(e) => {
            const el = e.currentTarget;
            setHv({ i, x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop });
          }}
          style={{ width: w, height: h }}
          className={`rounded-[1px] transition-opacity ${
            hv !== null && hv.i !== i ? "opacity-40" : "opacity-100"
          } ${it.className}`}
        />
      ))}
      {hv !== null && (
        <span
          style={{
            top: hv.y,
            ...(anchor === "start" ? { left: 0 } : anchor === "end" ? { right: 0 } : { left: hv.x }),
          }}
          className={`pointer-events-none absolute z-30 max-w-[260px] -translate-y-full truncate whitespace-nowrap rounded border border-themed bg-elev px-2 py-1 text-[11px] font-normal text-fg shadow-lg ${
            anchor === "mid" ? "-translate-x-1/2" : ""
          }`}
        >
          {items[hv.i].label}
        </span>
      )}
    </span>
  );
}

/**
 * The label for one member's tick: who they are, what they did, and when.
 *
 * Exported because the card strip and the collapsed-row strip on /proposals both draw one tick per
 * member and both have to answer the same question on hover. Two copies would drift.
 */
export function memberTickLabel(
  t: (k: string, v?: Record<string, string | number>) => string,
  m: MemberRef | undefined,
  v: { f: boolean | null; t: number | null } | null | undefined,
  startMs: number,
  open: boolean
): string {
  const name = m?.name ?? (m ? shortAddr(m.addr) : t("prop.roster.unknownMember"));
  const verdict = !v
    ? open
      ? t("prop.roster.notYetVoted")
      : t("prop.roster.didNotVote")
    : v.f === null
      ? t("prop.roster.voted")
      : v.f
        ? t("prop.roster.for")
        : t("prop.roster.against");
  const when = v && v.t != null ? ` +${hoursInto(v.t, startMs).toFixed(1)}h` : "";
  return `${name} · ${verdict}${when}`;
}

/**
 * A member's recent record, beside their name. Oldest on the left, so somebody who stopped turning
 * up reads as colour fading out, and every row covers the SAME proposals so the strips can be read
 * down a column as well as across.
 *
 * Deliberately quiet: at full strength a dozen saturated ticks on every row out-shouted the names
 * they belong to, and the names are what the roster is for. Faded colour, a shorter tick, and the
 * un-hovered ones dimming when one is picked out.
 */
function HistoryStrip({ cells }: { cells: HistoryCell[] }) {
  const { t } = useApp();
  const items = cells.map((c) => {
    const name = c.name ?? t("prop.roster.unnamedProposal");
    const verdict = !c.eligible
      ? t("prop.roster.notEligible")
      : c.inFavour === null
        ? t("prop.roster.didNotVote")
        : c.inFavour
          ? t("prop.roster.for")
          : t("prop.roster.against");
    return {
      key: c.key,
      label: `${name} · ${verdict}${c.hoursIn != null ? ` +${c.hoursIn.toFixed(1)}h` : ""}`,
      className: !c.eligible
        ? "bg-black/[0.07] dark:bg-white/[0.07]"
        : c.inFavour === null
          ? "bg-black/15 dark:bg-white/[0.18]"
          : c.inFavour
            ? "bg-emerald-500/50"
            : "bg-rose-500/55",
    };
  });
  return <LabelledTicks items={items} tick={[4, 11, 2]} />;
}

/** One member, named where we can name them. */
function MemberRow({
  m, vote, startMs, removable, history,
}: {
  m: MemberRef | undefined; vote?: VoteRef; startMs: number;
  /** This member's recent record, already folded onto their entity. */
  history?: HistoryCell[];
  /**
   * The badge IS the button. Removal is permissionless, so the reader who has just found the name
   * that did not vote is exactly the person who can act on it, and sending them back up the page to
   * the panel to find the same name again was a step that bought nothing. The contract is still the
   * guard, and the two-step confirm still stands between a stray click and an eviction.
   */
  removable?: boolean;
}) {
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
  // THREE CELLS OF A SHARED GRID, not a flex line.
  //
  // The strip used to sit before a tail whose width was whatever that row's tail happened to
  // contain, so a row ending "Against" started its strip further left than one ending "For", and
  // "Removable" pushed it further still. Strips stacked in a column are read against each other,
  // and ragged ones cannot be read at all.
  //
  // A hand-tuned fixed width was the first fix and it was wrong: "Against" is "En contra" in
  // Spanish and "Dagegen" in German, the remove chip relabels itself as it arms, and any of those
  // overflowing the slot brings the misalignment straight back for whoever is reading in that
  // language. Grid columns size themselves to the widest cell IN THE WHOLE LIST, so every row
  // agrees by construction and no number has to be guessed.
  //
  // `contents` makes the li itself disappear as a box so its four children become the grid items.
  // All four are always rendered, empty where there is nothing, because a row short of a cell would
  // shift every cell after it.
  return (
    <li className="contents text-xs">
      {m.href ? (
        <a href={`/provider/${m.href}`} className="flex min-w-0 items-center gap-2 text-muted hover:text-beacon">
          {body}
        </a>
      ) : (
        <span className="flex min-w-0 items-center gap-2 text-muted">{body}</span>
      )}

      <span className="flex items-center justify-end">
        {history && history.length > 0 ? <HistoryStrip cells={history} /> : null}
      </span>

      {/* The time gets its OWN column, so the hours align with each other instead of being pushed
          around by the width of the chip beside them: "+1.4h" next to "For" and "+33.8h" next to
          "Against" otherwise start at four different places down one list. Right-aligned and
          tabular, so the decimal point lines up too. */}
      <span className="whitespace-nowrap text-right tabular-nums text-[11px] text-faint">
        {/* No timestamp when the vote came from the contract rather than from a log: hasVoted
            carries no block, and "+0.0h" would be a figure we invented. */}
        {vote?.t != null ? (
          <span title={utcStamp(vote.t)}>
            {t("prop.roster.at", { hours: hoursInto(vote.t, startMs).toFixed(1) })}
          </span>
        ) : null}
      </span>

      <span className="flex items-center justify-end">
        {removable && <MgRemoveButton identity={m.addr} variant="chip" />}
        {vote && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              vote.f === null
                ? "bg-black/10 text-muted dark:bg-white/10"
                : vote.f
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                  : "bg-rose-500/15 text-rose-600 dark:text-rose-300"
            }`}
          >
            {vote.f === null
              ? t("prop.roster.voted")
              : vote.f
                ? t("prop.roster.for")
                : t("prop.roster.against")}
          </span>
        )}
      </span>
    </li>
  );
}

export function ProposalRoster({
  part, members, removable, quorumNeeded, voteStartAt, voteEndAt, nowMs, open, partKey,
  viewerAddr, viewerVoted, history,
}: {
  part: ParticipationRef;
  /** `${contract}:${id}`, so a vote cast in this session can be matched to this proposal. */
  partKey: string;
  /** The connected member, lowercased, where the server resolved them and the wallet agrees. */
  viewerAddr?: string | null;
  /** The CONTRACT's own hasVoted for that member on this proposal. Read fresh on every load. */
  viewerVoted?: boolean;
  /** Recent record per entity key, shared by every roster on the page. */
  history?: Map<string, HistoryCell[]>;
  members: MemberRef[];
  /** Lowercased addresses the contract would remove today. */
  removable: Set<string>;
  quorumNeeded: number;
  voteStartAt: string;
  voteEndAt: string;
  /** The server's clock. Never Date.now() here: see the note on the payload field. */
  nowMs: number;
  /** Whether the window is still running, which decides "has not voted" vs "did not vote". */
  open: boolean;
}) {
  const { t } = useApp();
  const historyFor = (m: MemberRef | undefined) => {
    const k = entityKey(m);
    return k ? history?.get(k) : undefined;
  };
  // OPEN PROPOSALS START EXPANDED. That is the whole point of the feature: while the window is
  // running the names still missing are the actionable thing, and putting them behind a click
  // hides them from exactly the person who came to find them. Decided proposals start collapsed,
  // because sixteen cards of fifty names each is a wall nobody asked for.
  const [shown, setShown] = useState(open);

  const startMs = new Date(voteStartAt).getTime();
  const endMs = new Date(voteEndAt).getTime();

  // Votes this session cast and the explorer sweep has not picked up yet. Confirmed on chain
  // before they were written, so they are early rather than speculative.
  const mine = useMgVotes();

  const { voted, absent, ticks, allVotes } = useMemo(() => {
    const byMember = new Map<number, VoteRef>();
    for (const v of part.votes) byMember.set(v.m, v);
    // Eligibility is the snapshot, but a vote from outside it still counts and is still shown.
    const roster = part.eligible.length
      ? part.eligible
      : [...new Set(part.votes.map((v) => v.m))];
    const extra = part.votes.map((v) => v.m).filter((m) => !roster.includes(m));
    const all = [...roster, ...new Set(extra)];

    // MERGE THIS SESSION'S OWN VOTES, for this proposal only.
    //
    // Matched by address against the member list, and added ONLY where that member is on this
    // roster and the sweep has not already reported them. A vote from an address the roster does
    // not know is left alone rather than invented into the list: the eligible set is the
    // contract's own snapshot, and a name this page never had is not ours to add.
    const ownVotes: VoteRef[] = [];
    for (const v of mine.values()) {
      if (v.key !== partKey) continue;
      const m = members.findIndex((mm) => mm?.addr?.toLowerCase() === v.addr);
      if (m < 0 || !all.includes(m) || byMember.has(m)) continue;
      const ref: VoteRef = { m, f: v.inFavour, t: v.t };
      byMember.set(m, ref);
      ownVotes.push(ref);
    }

    // AND THE CONTRACT'S OWN ANSWER, which is the one that survives a reload.
    //
    // The store above only knows about votes cast through this page in this tab. It is empty after
    // a browser refresh, and it never sees a vote cast on Flare's portal or from another device.
    // Both of those left a member reading "Your vote is recorded", which comes from the contract,
    // directly above a roster that still had them absent, which comes from the explorer. Same
    // contradiction, different route to it.
    //
    // hasVoted is already read per open proposal for the signed-in member, straight off the RPC and
    // not through the sweep's cache, so this costs nothing new. The side is unavailable: no getter
    // returns it, so the row shows that they voted without claiming which way, and the sweep fills
    // that in within the minute.
    if (viewerVoted && viewerAddr) {
      const m = members.findIndex((mm) => mm?.addr?.toLowerCase() === viewerAddr);
      if (m >= 0 && all.includes(m) && !byMember.has(m)) {
        const ref: VoteRef = { m, f: null, t: null };
        byMember.set(m, ref);
        ownVotes.push(ref);
      }
    }

    // Appended rather than sorted in: this vote is the newest by construction, and the voted
    // column is in the order the votes arrived.
    const allVotes = ownVotes.length ? [...part.votes, ...ownVotes] : part.votes;
    return {
      allVotes,
      voted: allVotes.map((v) => ({ m: v.m, v })),
      absent: all.filter((m) => !byMember.has(m)),
      // Ticks follow the roster order so the strip is stable between renders, not the vote order.
      // The member index rides along: the strip names the provider, and a bare VoteRef cannot say
      // who did not vote, which is half of what the strip shows.
      ticks: all.map((m) => ({ m, v: byMember.get(m) ?? null })),
    };
  }, [part, mine, partKey, members, viewerAddr, viewerVoted]);

  const cast = allVotes.length;
  const eligible = ticks.length;
  if (!eligible) return null;

  return (
    <div className="mt-3 border-t border-themed pt-3">
      {/* THE STRIP. One tick per eligible member: filled where they voted, hollow where they have
          not. It reads as a progress bar from across the room and as a count on inspection, and it
          is the only part of this that every card carries.
          Each tick now names its member on hover. It was the one place on the page showing fifty
          providers while saying which none of them were, and the roster below it is two clicks and
          a scroll away from answering that. */}
      <LabelledTicks
        wrap
        tick={[6, 12, 3]}
        items={ticks.map(({ m, v }, i) => {
          return {
            key: `${m}-${i}`,
            label: memberTickLabel(t, members[m], v, startMs, open),
            className:
              v === null
                ? "bg-black/10 dark:bg-white/10"
                : v.f === null
                  ? "bg-muted/60"
                  : v.f
                    ? "bg-emerald-500/80"
                    : "bg-rose-500/80",
          };
        })}
      />

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
            votes={allVotes}
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
              {/* The grid the rows are cells of: name takes what is left; strip, time and chip
                  each size to the widest in their own column. See the note in MemberRow. */}
              <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-1.5">
                {voted.map(({ m, v }, i) => (
                  <MemberRow
                    key={`${m}-${i}`} m={members[m]} vote={v} startMs={startMs}
                    history={historyFor(members[m])}
                    removable={open && removable.has(members[m]?.addr ?? "")}
                  />
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
                <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-1.5">
                  {absent.map((m) => (
                    <MemberRow
                      key={m} m={members[m]} startMs={startMs}
                      history={historyFor(members[m])}
                      // OPEN PROPOSALS ONLY. Removability is a fact about the member TODAY, and a
                      // chip beside a name in a roster from 2024 would read as a fact about that
                      // vote. On a live one the two are the same moment.
                      removable={open && removable.has(members[m]?.addr ?? "")}
                    />
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
