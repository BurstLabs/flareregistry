// Re-read ONE entity's Management Group state straight from the chain, right now.
//
// Why this exists. The provider page renders from our database, refreshed by cron: membership hourly,
// removal standing every six hours. That is fine for a page nobody just acted on. It is wrong the
// moment we put buttons on it, because a provider who joins or removes someone watches the transaction
// confirm and then sees the page still insisting on the state they just changed. That happened on the
// first real use of the remove button: the removal landed on-chain, and the listing went on showing the
// member and the button for the best part of an hour.
//
// So both buttons call this on success. It reads only what is CHEAP to read for a single voter, which
// is precisely the state the buttons change:
//   isMember, memberAddedAtRewardEpoch, memberRemovedAtTs, and a simulation of addMember/removeMember.
// The expensive parts (the 20-epoch reward walk-back, the proposal participation window) are left to
// the cron and deliberately NOT touched here, because writing a half-computed value would be worse than
// leaving yesterday's correct one.
//
// Safety: everything written is read back from the chain, so a caller cannot inject a value, only cause
// work. Unknown voters are rejected and each voter is rate limited, which bounds that work.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const RPCS = [
  process.env.FLARE_RPC_URL ?? "http://127.0.0.1:19650/ext/bc/C/rpc",
  "https://flare-api.flare.network/ext/C/rpc",
];

// Verified against the deployed ABIs; see scripts/ingest-mg-eligibility.mjs for the same set.
const SEL_BY_NAME = "0x82760fca";
const SEL_ADD_MEMBER = "0x029d010d";
const SEL_REMOVE_MEMBER = "0x0b1ca49a";
const SEL_IS_MEMBER = "0xa230c524";
const SEL_MEMBER_ADDED_AT = "0x9d2dc81c";
const SEL_MEMBER_REMOVED_AT = "0x3f66935c";
const SEL_REMOVE_FOR_DAYS = "0x59c077c0";
const SEL_CURRENT_EPOCH = "0x70562697";

const pad = (v: number | bigint) => BigInt(v).toString(16).padStart(64, "0");
const padAddr = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

function encodeString(s: string) {
  const bytes = Buffer.from(s, "utf8");
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32) {
    chunks.push(bytes.subarray(i, i + 32).toString("hex").padEnd(64, "0"));
  }
  if (!chunks.length) chunks.push("0".repeat(64));
  return pad(32) + pad(bytes.length) + chunks.join("");
}

let rpcId = 0;
async function ethCall(to: string, data: string, from?: string) {
  let lastErr: unknown = null;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: ++rpcId, method: "eth_call",
          params: [from ? { from, to, data } : { to, data }, "latest"],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const j = await res.json();
      if (j.error) {
        const msg = String(j.error.message ?? "");
        // A revert is the answer we want from the simulations, not a transport failure.
        if (/revert/i.test(msg)) {
          return { revert: msg.replace(/^execution reverted:?\s*/i, "").trim() };
        }
        lastErr = new Error(msg);
        continue;
      }
      // "0x" is success for a void function; see the ingest script for the bug this once caused.
      if (typeof j.result === "string") return { ok: j.result as string };
      lastErr = new Error("no result");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all endpoints failed");
}

const asNum = (r: { ok?: string }) => (r.ok && r.ok.length > 2 ? Number(BigInt(r.ok)) : null);

async function resolve(name: string) {
  const r = await ethCall(CONTRACT_REGISTRY, SEL_BY_NAME + encodeString(name));
  if (!("ok" in r) || !r.ok) throw new Error(`${name} unresolved`);
  return "0x" + r.ok.slice(-40);
}

// One refresh per voter per 10s. The endpoint is idempotent and chain-truthed, so this bounds load
// rather than protecting correctness.
const lastRun = new Map<string, number>();

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const voter = typeof body?.voter === "string" ? body.voter.toLowerCase() : null;
  if (!voter || !/^0x[0-9a-f]{40}$/.test(voter)) {
    return NextResponse.json({ error: "bad voter" }, { status: 400 });
  }

  const row = await prisma.providerOnchain.findFirst({
    where: { network: "flare", voter },
    select: { id: true },
  });
  if (!row) return NextResponse.json({ error: "unknown voter" }, { status: 404 });

  const now = Date.now();
  const prev = lastRun.get(voter) ?? 0;
  if (now - prev < 10_000) return NextResponse.json({ ok: true, throttled: true });
  lastRun.set(voter, now);

  try {
    const [pmg, fsm] = await Promise.all([
      resolve("PollingManagementGroup"),
      resolve("FlareSystemsManager"),
    ]);

    const currentEpoch = asNum(await ethCall(fsm, SEL_CURRENT_EPOCH));
    const isMember = (asNum(await ethCall(pmg, SEL_IS_MEMBER + padAddr(voter))) ?? 0) !== 0;
    const removedAtTs = asNum(await ethCall(pmg, SEL_MEMBER_REMOVED_AT + padAddr(voter))) ?? 0;
    const removeForDays = asNum(await ethCall(pmg, SEL_REMOVE_FOR_DAYS)) ?? 7;
    const memberSince = isMember
      ? asNum(await ethCall(pmg, SEL_MEMBER_ADDED_AT + padAddr(voter)))
      : null;

    const addSim = await ethCall(pmg, SEL_ADD_MEMBER, voter);
    const canJoin = !("revert" in addSim);
    const removeSim = isMember
      ? await ethCall(pmg, SEL_REMOVE_MEMBER + padAddr(voter), voter)
      : null;

    const removedUntilTs = removedAtTs > 0 ? removedAtTs + removeForDays * 86400 : 0;
    const inRemovalWindow = removedUntilTs > now / 1000;

    await prisma.providerOnchain.update({
      where: { id: row.id },
      data: {
        managementGroup: isMember,
        mgMemberSinceEpoch: memberSince,
        mgEligible: isMember ? null : canJoin,
        mgVerdict: "revert" in addSim ? addSim.revert : "SUCCESS",
        mgRemovable: isMember && removeSim ? !("revert" in removeSim) : null,
        mgRemoveVerdict: removeSim ? ("revert" in removeSim ? removeSim.revert : "REMOVABLE") : null,
        // A just-removed entity is in the rejoin window; say so rather than leave the stale reason,
        // which would read as "does not meet the conditions" for a week.
        ...(isMember
          ? {}
          : inRemovalWindow
            ? {
                mgBlockReason: "recently-removed",
                mgBlockedUntil: new Date(removedUntilTs * 1000),
                mgEpochsRemaining: null,
              }
            : {}),
        ...(isMember ? { mgBlockReason: null, mgBlockedUntil: null } : {}),
        mgCheckedEpoch: currentEpoch,
        mgCheckedAt: new Date(),
      },
    });

    return NextResponse.json({ ok: true, isMember, canJoin });
  } catch (e) {
    console.error("mg/refresh failed:", e);
    return NextResponse.json({ error: "refresh failed" }, { status: 500 });
  }
}
