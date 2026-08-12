// Ingest Flare's governance CHILLS from historical event logs.
//
// WHY LOGS AND NOT THE LIVE CONTRACT. Flare does not upgrade these contracts, it deploys a
// replacement and repoints FlareContractRegistry, and the successor starts with empty storage. The
// retired VoterRegistry 0x2580… still answers chilledUntilRewardEpochId with 358 for the entities
// chilled on 2025-12-18; the current 0xA480… answers 0 for every one of them. Reading the live view
// would report "never chilled" about entities that were chilled, which is worse than not reporting.
//
// WHY FOUR SOURCES. Two eras, two generations each, and the event signature changed between the two
// VoterRegistry generations (uint256 -> uint32), so they have DIFFERENT topic0 values. Scanning for
// one silently misses the other. That is exactly how this was missed before: a scan against today's
// registry-resolved addresses and today's event signature returns zero, and zero looks like an
// answer.
//
// Every topic0 below was computed with `cast keccak` on the canonical signature, never guessed.
//
// The explorer log API is used rather than eth_getLogs because the public RPC caps the block range
// per request and the ranges here span tens of millions of blocks.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const EXPLORER = "https://flare-explorer.flare.network/api";
const RPC = process.env.FLARE_RPC ?? "https://flare-api.flare.network/ext/C/rpc";

const SOURCES = [
  {
    label: "VoterWhitelister gen-2 (v1 era)",
    address: "0x072A199670fAD8883c7A92D108dFA56828EfCE87",
    // VoterChilled(address,uint256), neither parameter indexed: both live in data.
    topic0: "0x0c2fcef22ab22997ed46cd27f7f0aa308600145401a7a141065d61c5d87341d2",
    fromBlock: 7_130_336,
    decode: (log) => ({
      beneficiary: "0x" + log.data.slice(2).slice(24, 64),
      untilEpoch: parseInt(log.data.slice(2).slice(64, 128), 16),
    }),
  },
  {
    label: "VoterRegistry gen-1 (FSP era)",
    address: "0x2580101692366e2f331e891180d9ffdF861Fce83",
    // BeneficiaryChilled(bytes20,uint256), beneficiary INDEXED. bytes20 is LEFT-aligned in the
    // topic, unlike address which is right-aligned, so the value is the FIRST 20 bytes.
    topic0: "0x0a5e087b026d8f1c57e75d9d0cb0394c2ad3535e7a15d97d553be80476274cd0",
    fromBlock: 29_549_006,
    decode: (log) => ({
      beneficiary: "0x" + log.topics[1].slice(2).slice(0, 40),
      untilEpoch: parseInt(log.data, 16),
    }),
  },
  {
    label: "VoterRegistry gen-2 (current)",
    address: "0xA480457953Af3583E54DCd630b219353B8FC9Af7",
    // Same event, uint32 instead of uint256, so a DIFFERENT topic0. No occurrences yet, but it is
    // where any future chill will land and leaving it out would re-create the original blind spot.
    topic0: "0x23a1b7932916d24f6177b7f7282bb925e3733697d5699c07e0372cd149696345",
    fromBlock: 65_000_000,
    decode: (log) => ({
      beneficiary: "0x" + log.topics[1].slice(2).slice(0, 40),
      untilEpoch: parseInt(log.data, 16),
    }),
  },
];

async function fetchLogs(src) {
  const url =
    `${EXPLORER}?module=logs&action=getLogs&fromBlock=${src.fromBlock}` +
    `&toBlock=99999999&address=${src.address}&topic0=${src.topic0}`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  // status "0" with "No logs found" is a legitimate empty result, not a failure.
  if (!Array.isArray(body.result)) {
    if (String(body.message ?? "").toLowerCase().includes("no logs")) return [];
    throw new Error(`unexpected body: ${JSON.stringify(body).slice(0, 160)}`);
  }
  return body.result;
}

/** Block timestamp, so a chill can be shown with a date rather than only an epoch number. */
async function blockTime(blockNumber) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["0x" + blockNumber.toString(16), false],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json();
  const ts = j?.result?.timestamp;
  return ts ? new Date(parseInt(ts, 16) * 1000) : new Date(0);
}

(async () => {
  let total = 0;
  let written = 0;
  for (const src of SOURCES) {
    let logs;
    try {
      logs = await fetchLogs(src);
    } catch (e) {
      // REFUSE TO WRITE rather than record a partial history. A source that failed must not be
      // mistaken later for a source that had nothing, which is the whole failure this file exists
      // to prevent.
      console.error(`chills: ${src.label} FAILED (${e.message ?? e}); leaving existing rows alone`);
      continue;
    }
    console.log(`chills: ${src.label} -> ${logs.length} event(s)`);
    total += logs.length;
    for (const log of logs) {
      const { beneficiary, untilEpoch } = src.decode(log);
      const blockNumber = parseInt(log.blockNumber, 16);
      const appliedAt = await blockTime(blockNumber);
      const data = {
        network: "flare",
        beneficiary: beneficiary.toLowerCase(),
        untilEpoch,
        contract: src.address.toLowerCase(),
        blockNumber,
        txHash: log.transactionHash,
        appliedAt,
      };
      await prisma.providerChill.upsert({
        where: {
          network_beneficiary_txHash: {
            network: "flare",
            beneficiary: data.beneficiary,
            txHash: data.txHash,
          },
        },
        create: data,
        update: data,
      });
      written++;
    }
  }
  const held = await prisma.providerChill.count();
  console.log(`chills: ${total} found across sources, ${written} written, ${held} held in total`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("ingest-chills failed:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
