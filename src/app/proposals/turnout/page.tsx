import type { Metadata } from "next";
import { fetchTurnout } from "@/lib/mg-votes";
import { TurnoutTable } from "@/components/turnout-table";

// /proposals/turnout - who actually votes, for the whole group at once.
//
// Its own route rather than another section on /proposals, which is already two screens and is
// about the proposals themselves. This is about the members, and it is the natural companion to
// the removable panel: the contract removes a member for missing votes, and this is the record
// that removal rests on.
//
// Thin on purpose. Every string lives in the client component, as on /proposals, because that is
// where the translation hook lives.
//
// Dynamic for the same reason /proposals is: an open proposal's column changes as votes land.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Management Group turnout",
  description:
    "Every Management Group member's voting record across every proposal, measured against the proposals each was eligible for.",
};

export default async function TurnoutPage() {
  const data = await fetchTurnout().catch(() => null);
  return <TurnoutTable data={data} />;
}
