import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  evaluateOutcome,
  loadMembers,
  appealWindow,
  APPEAL_COOLDOWN_DAYS,
  APPEAL_DEADLINE_DAYS,
  QUORUM_TURNOUT_BIPS,
  DENY_MAJORITY_BIPS,
} from "@/lib/governance";
import { GovernanceCaseClient, type CaseView } from "@/components/governance-case-client";

export const dynamic = "force-dynamic";

export default async function GovernanceCasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const c = await prisma.providerFlagCase.findUnique({
    where: { id },
    include: {
      provider: { select: { id: true, name: true, suspended: true, addresses: true } },
      initiations: {
        orderBy: { createdAt: "asc" },
        include: {
          revisions: { orderBy: { createdAt: "asc" } },
          entries: {
            orderBy: { createdAt: "asc" },
            include: { revisions: { orderBy: { createdAt: "asc" } } },
          },
        },
      },
      // Most recent activity first for the "Votes on record" display (order-independent for counts).
      votes: { orderBy: { updatedAt: "desc" } },
      voteRevisions: { orderBy: { createdAt: "asc" } },
      defense: {
        include: {
          revisions: { orderBy: { createdAt: "asc" } },
          entries: {
            orderBy: { createdAt: "asc" },
            include: { revisions: { orderBy: { createdAt: "asc" } } },
          },
        },
      },
    },
  });
  if (!c) notFound();

  // Evidence images for every point on this case, grouped by their owner id so each point can render
  // its own thumbnails. One query, grouped in memory.
  const imageRows = await prisma.providerFlagPointImage.findMany({
    where: { caseId: c.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      width: true,
      height: true,
      createdAt: true,
      removedAt: true,
      initiationId: true,
      groundsEntryId: true,
      defenseId: true,
      defenseEntryId: true,
    },
  });
  type PointImg = { id: string; width: number; height: number; at: string; removedAt: string | null };
  const imagesByOwner = new Map<string, PointImg[]>();
  for (const r of imageRows) {
    const owner = r.initiationId ?? r.groundsEntryId ?? r.defenseId ?? r.defenseEntryId;
    if (!owner) continue;
    const list = imagesByOwner.get(owner) ?? [];
    list.push({
      id: r.id,
      width: r.width,
      height: r.height,
      at: r.createdAt.toISOString(),
      removedAt: r.removedAt?.toISOString() ?? null,
    });
    imagesByOwner.set(owner, list);
  }
  const imagesFor = (ownerId: string): PointImg[] => imagesByOwner.get(ownerId) ?? [];

  let memberCount = c.memberCountAtOpen;
  try {
    memberCount = (await loadMembers()).memberCount;
  } catch {
    // keep snapshot
  }
  const votesCast = c.votes.length; // all present members, incl. abstentions (quorum)
  const denyVotes = c.votes.filter((v) => v.vote === "DENY").length;
  const keepVotes = c.votes.filter((v) => v.vote === "KEEP").length;
  const abstainVotes = c.votes.filter((v) => v.vote === "ABSTAIN").length;
  const decisiveVotes = denyVotes + keepVotes; // excludes abstentions (deny majority)
  const { turnoutFloor, denyNeeded } = evaluateOutcome(
    memberCount,
    votesCast,
    denyVotes,
    decisiveVotes
  );

  const detailAddress =
    c.provider.addresses[0]?.address ?? "";

  // Resolve each member's voter address to its provider name (a Management Group member is itself
  // a registered provider in our registry). Match via any of the entity's five addresses.
  const memberVoters = Array.from(
    new Set([
      ...c.initiations.map((i) => i.memberEntityVoter.toLowerCase()),
      ...c.votes.map((v) => v.memberEntityVoter.toLowerCase()),
    ])
  );
  const nameByMember = new Map<string, string>();
  if (memberVoters.length) {
    // The voter address is the entity identity; find the on-chain entity, then the provider that
    // lists any of its addresses.
    const entities = await prisma.providerOnchain.findMany({
      where: { voter: { in: memberVoters } },
      select: {
        voter: true,
        delegationAddress: true,
        submitAddress: true,
        submitSignaturesAddress: true,
        signingPolicyAddress: true,
      },
    });
    for (const e of entities) {
      const addrs = [
        e.voter,
        e.delegationAddress,
        e.submitAddress,
        e.submitSignaturesAddress,
        e.signingPolicyAddress,
      ]
        .filter((a): a is string => !!a)
        .map((a) => a.toLowerCase());
      const pa = await prisma.providerAddress.findFirst({
        where: { address: { in: addrs } },
        select: { provider: { select: { name: true } } },
      });
      if (pa?.provider.name) nameByMember.set(e.voter.toLowerCase(), pa.provider.name);
    }
  }
  const memberName = (voter: string) => nameByMember.get(voter.toLowerCase()) ?? null;

  // Appeal info for a DENIED case: when an appeal may open/closes, and whether the single permitted
  // appeal has already been used. Drives the "what happens next / how to appeal" panel.
  let appeal: CaseView["appeal"] = null;
  if (c.state === "DENIED" && c.decidedAt) {
    const win = appealWindow(c.decidedAt);
    const priorAppeal = await prisma.providerFlagCase.findFirst({
      where: {
        providerId: c.provider.id,
        isReVote: true,
        state: { in: ["DENIED", "CLEARED", "FAILED_QUORUM"] },
      },
      select: { id: true, state: true },
    });
    // An appeal currently in progress (opened, not yet decided). When present, the denied page links
    // straight to it so it never looks like nothing happened after a request.
    const liveAppeal = await prisma.providerFlagCase.findFirst({
      where: {
        providerId: c.provider.id,
        isReVote: true,
        state: { in: ["OPEN_DISCUSSION", "OPEN_VOTING"] },
      },
      select: { id: true },
    });
    appeal = {
      opensAt: win.opensAt.toISOString(),
      closesAt: win.closesAt.toISOString(),
      cooldownDays: APPEAL_COOLDOWN_DAYS,
      deadlineDays: APPEAL_DEADLINE_DAYS,
      usedCaseId: priorAppeal?.id ?? null,
      usedState: priorAppeal?.state ?? null,
      liveCaseId: liveAppeal?.id ?? null,
    };
  }

  // When viewing an APPEAL (re-vote), find the original denied review it appeals, so the appeal
  // page links back to it and the original review stays one click away.
  let appealOfCaseId: string | null = null;
  if (c.isReVote) {
    const original = await prisma.providerFlagCase.findFirst({
      where: { providerId: c.provider.id, isReVote: false, state: "DENIED" },
      orderBy: { decidedAt: "desc" },
      select: { id: true },
    });
    appealOfCaseId = original?.id ?? null;
  }

  const view: CaseView = {
    id: c.id,
    providerId: c.provider.id,
    providerName: c.provider.name,
    detailAddress,
    suspended: c.provider.suspended,
    state: c.state,
    isReVote: c.isReVote,
    appealOfCaseId,
    raisedAt: c.createdAt.toISOString(),
    openedAt: c.openedAt.toISOString(),
    discussionEndsAt: c.discussionEndsAt.toISOString(),
    votingEndsAt: c.votingEndsAt.toISOString(),
    decidedAt: c.decidedAt?.toISOString() ?? null,
    appeal,
    memberCount,
    turnoutFloor,
    denyNeeded,
    votesCast,
    denyVotes,
    keepVotes,
    abstainVotes,
    decisiveVotes,
    turnoutFloorBips: QUORUM_TURNOUT_BIPS,
    denyMajorityBips: DENY_MAJORITY_BIPS,
    initiations: c.initiations.map((i) => ({
      member: i.memberEntityVoter,
      memberName: memberName(i.memberEntityVoter),
      grounds: i.grounds,
      title: i.title,
      at: i.createdAt.toISOString(),
      editedAt: i.editedAt?.toISOString() ?? null,
      // The primary grounds point is owned by the initiation row itself (ownerType "initiation").
      initiationId: i.id,
      images: imagesFor(i.id),
      // Prior versions for the public history. Drops the latest revision, since it equals the
      // current `grounds` shown above; what remains is the trail of what changed.
      priorVersions: i.revisions
        .slice(0, Math.max(0, i.revisions.length - 1))
        .map((r) => ({ grounds: r.grounds, title: r.title, at: r.createdAt.toISOString() })),
      // Supplemental entries the same member added later (informational), each independently
      // editable with its own prior-version history.
      entries: i.entries.map((e) => ({
        id: e.id,
        grounds: e.grounds,
        title: e.title,
        at: e.createdAt.toISOString(),
        editedAt: e.editedAt?.toISOString() ?? null,
        images: imagesFor(e.id),
        replyToRef: e.replyToRef ?? null,
        priorVersions: e.revisions
          .slice(0, Math.max(0, e.revisions.length - 1))
          .map((r) => ({ grounds: r.grounds, title: r.title, at: r.createdAt.toISOString() })),
      })),
    })),
    votes: c.votes.map((v) => ({
      member: v.memberEntityVoter,
      memberName: memberName(v.memberEntityVoter),
      vote: v.vote,
      comment: v.comment,
      at: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
      // True when this member changed their vote at least once (current row was updated after it
      // was first created). The full per-member trail is in voteHistory below.
      changed: v.updatedAt.getTime() - v.createdAt.getTime() > 1000,
    })),
    // Full append-only audit of every cast/change across all members, newest first.
    voteHistory: c.voteRevisions
      .slice()
      .reverse()
      .map((r) => ({
        member: r.memberEntityVoter,
        memberName: memberName(r.memberEntityVoter),
        vote: r.vote,
        comment: r.comment,
        at: r.createdAt.toISOString(),
      })),
    defense: c.defense
      ? {
          id: c.defense.id,
          body: c.defense.body,
          title: c.defense.title,
          at: c.defense.createdAt.toISOString(),
          editedAt: c.defense.editedAt?.toISOString() ?? null,
          images: imagesFor(c.defense.id),
          priorVersions: c.defense.revisions
            .slice(0, Math.max(0, c.defense.revisions.length - 1))
            .map((r) => ({ body: r.body, title: r.title, at: r.createdAt.toISOString() })),
          entries: c.defense.entries.map((e) => ({
            id: e.id,
            body: e.body,
            title: e.title,
            at: e.createdAt.toISOString(),
            editedAt: e.editedAt?.toISOString() ?? null,
            images: imagesFor(e.id),
            replyToRef: e.replyToRef ?? null,
            priorVersions: e.revisions
              .slice(0, Math.max(0, e.revisions.length - 1))
              .map((r) => ({ body: r.body, title: r.title, at: r.createdAt.toISOString() })),
          })),
        }
      : null,
  };

  return (
    <div className="max-w-3xl">
      <GovernanceCaseClient view={view} />
    </div>
  );
}
