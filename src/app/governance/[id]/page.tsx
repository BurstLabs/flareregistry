import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import {
  evaluateOutcome,
  loadMembers,
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
      votes: { orderBy: { createdAt: "asc" } },
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

  let memberCount = c.memberCountAtOpen;
  try {
    memberCount = (await loadMembers()).memberCount;
  } catch {
    // keep snapshot
  }
  const votesCast = c.votes.length;
  const denyVotes = c.votes.filter((v) => v.vote === "DENY").length;
  const { turnoutFloor, denyNeeded } = evaluateOutcome(memberCount, votesCast, denyVotes);

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

  const view: CaseView = {
    id: c.id,
    providerId: c.provider.id,
    providerName: c.provider.name,
    detailAddress,
    suspended: c.provider.suspended,
    state: c.state,
    isReVote: c.isReVote,
    openedAt: c.openedAt.toISOString(),
    discussionEndsAt: c.discussionEndsAt.toISOString(),
    votingEndsAt: c.votingEndsAt.toISOString(),
    decidedAt: c.decidedAt?.toISOString() ?? null,
    memberCount,
    turnoutFloor,
    denyNeeded,
    votesCast,
    denyVotes,
    keepVotes: votesCast - denyVotes,
    turnoutFloorBips: QUORUM_TURNOUT_BIPS,
    denyMajorityBips: DENY_MAJORITY_BIPS,
    initiations: c.initiations.map((i) => ({
      member: i.memberEntityVoter,
      memberName: memberName(i.memberEntityVoter),
      grounds: i.grounds,
      at: i.createdAt.toISOString(),
      editedAt: i.editedAt?.toISOString() ?? null,
      // Prior versions for the public history. Drops the latest revision, since it equals the
      // current `grounds` shown above; what remains is the trail of what changed.
      priorVersions: i.revisions
        .slice(0, Math.max(0, i.revisions.length - 1))
        .map((r) => ({ grounds: r.grounds, at: r.createdAt.toISOString() })),
      // Supplemental entries the same member added later (informational), each independently
      // editable with its own prior-version history.
      entries: i.entries.map((e) => ({
        id: e.id,
        grounds: e.grounds,
        at: e.createdAt.toISOString(),
        editedAt: e.editedAt?.toISOString() ?? null,
        priorVersions: e.revisions
          .slice(0, Math.max(0, e.revisions.length - 1))
          .map((r) => ({ grounds: r.grounds, at: r.createdAt.toISOString() })),
      })),
    })),
    votes: c.votes.map((v) => ({
      member: v.memberEntityVoter,
      memberName: memberName(v.memberEntityVoter),
      vote: v.vote,
      comment: v.comment,
      at: v.createdAt.toISOString(),
    })),
    defense: c.defense
      ? {
          body: c.defense.body,
          at: c.defense.createdAt.toISOString(),
          editedAt: c.defense.editedAt?.toISOString() ?? null,
          priorVersions: c.defense.revisions
            .slice(0, Math.max(0, c.defense.revisions.length - 1))
            .map((r) => ({ body: r.body, at: r.createdAt.toISOString() })),
          entries: c.defense.entries.map((e) => ({
            id: e.id,
            body: e.body,
            at: e.createdAt.toISOString(),
            editedAt: e.editedAt?.toISOString() ?? null,
            priorVersions: e.revisions
              .slice(0, Math.max(0, e.revisions.length - 1))
              .map((r) => ({ body: r.body, at: r.createdAt.toISOString() })),
          })),
        }
      : null,
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-4 text-sm">
        <Link href="/governance" className="text-muted hover:text-beacon">
          &larr; About the governance process
        </Link>
      </div>
      <GovernanceCaseClient view={view} />
    </div>
  );
}
