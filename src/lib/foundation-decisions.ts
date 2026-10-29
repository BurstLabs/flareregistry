// The Flare Foundation's OFF-CHAIN decisions on carried Management Group proposals.
//
// The vote's outcome is on chain and the proposals page labels it from the contract. Whether the
// Foundation then executes a carried chill is not, so it is recorded here, keyed by contract + id
// (ids restart per deployment), with the date it was made.
//
// 2026-10-28: the Foundation told FTSO providers (providers' Telegram group) that Flare Legal does not
// concur with the chill in #14, and asked providers still using the default provider to move away from
// it by 1 December 2026. #15 to #18 are recorded on the same footing (user-directed): the Foundation had
// said its #14 decision would set the precedent for the later proposals.
const MG = "0x1e91a59aac440d7eca5ebf58d85903cdb0021812";

export const FOUNDATION_DECLINED: Record<string, string> = {
  [`${MG}:14`]: "2026-10-28",
  [`${MG}:15`]: "2026-10-28",
  [`${MG}:16`]: "2026-10-28",
  [`${MG}:17`]: "2026-10-28",
  [`${MG}:18`]: "2026-10-28",
};

export function foundationDeclined(p: { contract: string; id: number }): string | null {
  return FOUNDATION_DECLINED[`${p.contract.toLowerCase()}:${p.id}`] ?? null;
}
