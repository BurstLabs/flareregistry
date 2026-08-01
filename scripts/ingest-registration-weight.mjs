// FIP.16 REGISTRATION WEIGHT, read straight off the chain.
//
// Why this exists. The Weight column shows DELEGATION WEIGHT, because that is the number Flare's own
// systems explorer shows and therefore the one a provider recognises as theirs. But delegation weight is
// not what the protocol runs on. It ignores staking entirely, and it is linear where the protocol is
// concave, so it overstates the largest providers and understates anyone whose weight comes from stake.
// Any claim of the form "these providers hold X% of the network" has to be made in the units the network
// actually uses, which is the FIP.16 registration weight:
//
//   S       = stakingFactor * SUM(mirrored P-chain vote power over the entity's nodeIds)
//             + min(wNatCap, WNat vote power of the DELEGATION address)
//   wNatCap = WNat.totalVotePowerAt(vpBlock) * wNatCapPPM / 1e6          (2.5% of the whole network)
//   weight  = isqrt(S) * isqrt(isqrt(S))                                 (integer floor of S^0.75)
//
// We do NOT implement that formula. FlareSystemsCalculator already computed it at registration time and
// VoterRegistry stored the answer, so we read the stored value. That distinction matters more than it
// looks: a reimplementation is our opinion of the protocol's arithmetic and can drift from it silently
// (wrong cap basis, cap applied to the identity address instead of the delegation address, rounding at
// the wrong step, a governance change to stakingFactor or wNatCapPPM). Reading the getter cannot drift,
// and it gives every provider a one-line way to check us:
//
//   cast call 0xA480457953Af3583E54DCd630b219353B8FC9Af7 \
//     "getVoterRegistrationWeight(address,uint256)(uint256)" <identity> <epoch> --rpc-url <flare rpc>
//
// The unit is wei^0.75. It is not FLR and not comparable to a delegation figure; only ratios between
// providers mean anything, which is all we use it for.
//
// Addresses are resolved through FlareContractRegistry rather than hardcoded, so this keeps working
// across contract upgrades and works unchanged on Songbird.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Same address on every Flare-family chain, by design.
const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

const NETWORKS = {
  flare: [
    process.env.FLARE_RPC_URL ?? "http://127.0.0.1:19650/ext/bc/C/rpc",
    "https://flare-api.flare.network/ext/C/rpc",
  ],
  songbird: [
    process.env.SONGBIRD_RPC_URL ?? "https://songbird-api.flare.network/ext/C/rpc",
  ],
};

// getContractAddressByName(string)
const SEL_BY_NAME = "0x82760fca";
// getVoterRegistrationWeight(address,uint256) -> uint256
const SEL_REG_WEIGHT = "0x33994081";
// getWeightsSums(uint256) -> (uint128 weightsSum, uint16 ..., uint16 ...)
const SEL_WEIGHTS_SUMS = "0x9508858e";
// getCurrentRewardEpochId() -> uint32
const SEL_CURRENT_EPOCH = "0x70562697";

const pad = (hexOrNum) => {
  const h = typeof hexOrNum === "bigint" || typeof hexOrNum === "number"
    ? BigInt(hexOrNum).toString(16)
    : String(hexOrNum).replace(/^0x/, "");
  return h.padStart(64, "0");
};

function encodeString(s) {
  const bytes = Buffer.from(s, "utf8");
  const len = pad(bytes.length);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 32) {
    chunks.push(bytes.subarray(i, i + 32).toString("hex").padEnd(64, "0"));
  }
  if (chunks.length === 0) chunks.push("0".repeat(64));
  return pad(32) + len + chunks.join("");
}

let rpcId = 0;

// Try each endpoint in turn. A REVERT is a real answer, not an endpoint failure, so it is returned as
// {revert} immediately rather than sending us to the fallback: a voter who is simply not registered must
// not cause the whole run to retry against a public RPC.
async function ethCall(urls, to, data) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: ++rpcId, method: "eth_call",
          params: [{ to, data }, "latest"],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const j = await res.json();
      if (j.error) {
        const msg = String(j.error.message ?? "");
        if (/revert/i.test(msg)) return { revert: msg };
        lastErr = new Error(msg);
        continue;
      }
      if (typeof j.result === "string" && j.result.length > 2) return { ok: j.result };
      lastErr = new Error("empty result");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all endpoints failed");
}

async function resolveContract(urls, name) {
  const r = await ethCall(urls, CONTRACT_REGISTRY, SEL_BY_NAME + encodeString(name));
  if (r.revert) throw new Error(`registry reverted for ${name}: ${r.revert}`);
  const addr = "0x" + r.ok.slice(-40);
  if (/^0x0{40}$/.test(addr)) throw new Error(`${name} not present in the contract registry`);
  return addr;
}

// Find the newest epoch that VoterRegistry has actually SEALED. The current epoch id can be one ahead of
// the last epoch with a registered voter set, and reading an unregistered epoch would blank every weight,
// so walk back until getWeightsSums returns a non-zero total.
async function resolveEpoch(urls, voterRegistry) {
  let start = null;
  try {
    const sm = await resolveContract(urls, "FlareSystemsManager");
    const r = await ethCall(urls, sm, SEL_CURRENT_EPOCH);
    if (r.ok) start = Number(BigInt(r.ok));
  } catch { /* fall through to the env/default probe below */ }
  if (start == null) {
    const env = Number(process.env.REGISTRATION_EPOCH);
    if (!Number.isFinite(env)) throw new Error("could not determine the current reward epoch");
    start = env;
  }
  for (let e = start; e > start - 8 && e >= 0; e--) {
    const r = await ethCall(urls, voterRegistry, SEL_WEIGHTS_SUMS + pad(e));
    if (r.ok) {
      const sum = BigInt("0x" + r.ok.slice(2, 66));
      if (sum > 0n) return { epoch: e, weightsSum: sum };
    }
  }
  throw new Error(`no sealed epoch found at or below ${start}`);
}

async function ingest(network) {
  const urls = NETWORKS[network];
  if (!urls) return;

  let voterRegistry, epoch, weightsSum;
  try {
    voterRegistry = await resolveContract(urls, "VoterRegistry");
    ({ epoch, weightsSum } = await resolveEpoch(urls, voterRegistry));
  } catch (e) {
    console.error(`${network}: setup failed - ${e.message}`);
    return;
  }

  const rows = await prisma.providerOnchain.findMany({
    where: { network },
    select: { voter: true },
  });
  if (rows.length === 0) {
    console.log(`${network}: no providers on record; nothing to do`);
    return;
  }

  let written = 0;
  let unregistered = 0;
  let failed = 0;
  let seen = 0n;
  for (const { voter } of rows) {
    const addr = String(voter ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
    let r;
    try {
      r = await ethCall(urls, voterRegistry, SEL_REG_WEIGHT + pad(addr) + pad(epoch));
    } catch (e) {
      failed++;
      console.error(`${network}: ${addr} - ${e.message}`);
      continue;
    }
    // A voter registered under a different identity, or not registered this epoch, is a legitimate
    // outcome and is stored as null rather than zero: zero would read as "no influence", which is a
    // different and wrong claim.
    if (r.revert) {
      unregistered++;
      await prisma.providerOnchain.updateMany({
        where: { network, voter },
        data: { registrationWeight: null, registrationEpoch: epoch },
      });
      continue;
    }
    const w = BigInt(r.ok);
    seen += w;
    await prisma.providerOnchain.updateMany({
      where: { network, voter },
      data: { registrationWeight: w.toString(), registrationEpoch: epoch },
    });
    written++;
  }

  // Our coverage against the protocol's own total. Anything well under 100% means we are missing voters
  // and every share we quote is inflated, so it is worth printing every run.
  const pct = weightsSum > 0n ? Number((seen * 10000n) / weightsSum) / 100 : 0;
  console.log(
    `${network}: epoch ${epoch}, ${written} registration weights written, ` +
      `${unregistered} not registered, ${failed} failed; ` +
      `covered ${pct.toFixed(2)}% of the protocol weightsSum`
  );
}

async function main() {
  for (const network of Object.keys(NETWORKS)) await ingest(network);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
