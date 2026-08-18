// Ingest validator (P-chain node) stats from Flare/Songbird's platform.getCurrentValidators RPC and
// store them per node id, so the registry can show each provider's validators with their real staking
// fee, uptime and online status (joined to providers by nodeId, which is in ProviderOnchain.nodeIds).

import { prisma } from "./db";
import { createHash } from "node:crypto";

// fsp-rewards stores node IDs as 20-byte HEX (e.g. 0x5fce...), but the P-chain and the wider ecosystem
// use the CB58 "NodeID-..." form (base58check of the 20 bytes + 4-byte sha256 checksum). Convert so we
// display the canonical NodeID and can JOIN to ProviderValidator (which is keyed by NodeID-...).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Buffer): string {
  let n = BigInt("0x" + (bytes.toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    n = n / 58n;
    s = B58[r] + s;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}
export function hexToNodeId(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{40}$/.test(h)) return hex; // not a 20-byte hex node id; leave as-is
  const raw = Buffer.from(h, "hex");
  const checksum = createHash("sha256").update(raw).digest().subarray(-4);
  return "NodeID-" + base58(Buffer.concat([raw, checksum]));
}

/** Normalize any stored node id (hex or already NodeID-) to the canonical NodeID- form. */
export function toNodeId(id: string): string {
  return id.startsWith("NodeID-") ? id : hexToNodeId(id);
}

// P-chain RPC endpoints (the C-chain RPCs in chains.ts are /ext/C/rpc; validators live on /ext/bc/P).
const P_CHAIN_RPC: Record<string, string> = {
  flare: "https://flare-api.flare.network/ext/bc/P",
  songbird: "https://songbird-api.flare.network/ext/bc/P",
};

interface RawValidator {
  nodeID: string;
  delegationFee?: string; // percent string, e.g. "10.0000"
  uptime?: string; // percent string, e.g. "99.9824"
  connected?: boolean;
  /** SELF-BOND only. The P-chain reports delegated stake separately, in delegatorWeight. */
  weight?: string;
  /** Total stake delegated to this node by others. Absent on older node versions. */
  delegatorWeight?: string;
  startTime?: string; // unix seconds (string)
  endTime?: string;
  delegatorCount?: string | number;
}

async function fetchCurrentValidators(rpcUrl: string): Promise<RawValidator[]> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "platform.getCurrentValidators",
      params: {},
    }),
  });
  if (!res.ok) throw new Error(`getCurrentValidators ${rpcUrl}: ${res.status}`);
  const body = (await res.json()) as { result?: { validators?: RawValidator[] } };
  return body.result?.validators ?? [];
}

function toDate(secs: string | undefined): Date | null {
  const n = Number(secs);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

/** Refresh ProviderValidator rows for both networks from the P-chain. Returns counts per network. */
export async function ingestValidators(): Promise<{ flare: number; songbird: number }> {
  const counts = { flare: 0, songbird: 0 };
  for (const network of ["flare", "songbird"] as const) {
    const rpc = P_CHAIN_RPC[network];
    let validators: RawValidator[];
    try {
      validators = await fetchCurrentValidators(rpc);
    } catch {
      continue; // network hiccup: leave existing rows in place, try again next run
    }

    // The reward epoch this run's readings belong to. Taken from the entity table rather than a
    // clock, so the bucket agrees with the epoch every other component is windowed by. Null means we
    // have no epoch to file against yet and the per-epoch sample is skipped; the snapshot below still
    // updates, so nothing is lost from the display.
    const headRow = await prisma.providerOnchain.aggregate({
      where: { network },
      _max: { lastEpochSeen: true },
    });
    const epochId = headRow._max.lastEpochSeen ?? null;

    for (const v of validators) {
      if (!v.nodeID) continue;
      const fee = v.delegationFee != null ? Number(v.delegationFee) : null;
      const uptime = v.uptime != null ? Number(v.uptime) : null;
      const delegatorCount =
        v.delegatorCount != null ? Number(v.delegatorCount) : null;
      // The P-chain's `weight` is SELF-BOND, and `delegatorWeight` is everything delegated to the node.
      // Total stake is the sum, which is what this row's `weight` has always claimed to be and what the
      // public API documents. Storing `weight` verbatim understated Flare's validator set by ~9.6x
      // (1,898.5M FLR against a true 18,242.2M across 175 nodes). Both are decimal strings in the same
      // 1e9 unit, so BigInt addition is exact; a node that reports neither stays null rather than "0",
      // because zero stake and unknown stake are different claims.
      const selfBond = v.weight ?? null;
      const delegatedWeight = v.delegatorWeight ?? null;
      const total =
        selfBond != null || delegatedWeight != null
          ? (BigInt(selfBond ?? "0") + BigInt(delegatedWeight ?? "0")).toString()
          : null;
      const data = {
        network,
        nodeId: v.nodeID,
        feePercent: Number.isFinite(fee) ? fee : null,
        uptimePercent: Number.isFinite(uptime) ? uptime : null,
        connected: v.connected === true,
        weight: total,
        selfBond,
        delegatedWeight,
        delegatorCount: Number.isFinite(delegatorCount) ? delegatorCount : null,
        startTime: toDate(v.startTime),
        endTime: toDate(v.endTime),
      };
      await prisma.providerValidator.upsert({
        where: { network_nodeId: { network, nodeId: v.nodeID } },
        create: data,
        update: data,
      });

      // APPEND THIS READING TO THE EPOCH'S RECORD, so validator uptime accumulates into a windowed
      // series instead of remaining a snapshot that can only ever describe right now.
      //
      // uptimeMin keeps the LOWEST reading seen in the epoch: Flare's uptime figure is cumulative
      // over the staking period, so a validator that drops and recovers within one epoch would show
      // no trace by the end of it if we only kept the last value.
      if (epochId != null) {
        const u = Number.isFinite(uptime) ? (uptime as number) : null;
        const offline = v.connected === true ? 0 : 1;
        const existing = await prisma.validatorUptimeEpoch.findUnique({
          where: { network_epochId_nodeId: { network, epochId, nodeId: v.nodeID } },
        });
        if (!existing) {
          await prisma.validatorUptimeEpoch.create({
            data: {
              network,
              epochId,
              nodeId: v.nodeID,
              uptimePercent: u,
              uptimeMin: u,
              samples: 1,
              offlineSamples: offline,
            },
          });
        } else {
          await prisma.validatorUptimeEpoch.update({
            where: { id: existing.id },
            data: {
              uptimePercent: u ?? existing.uptimePercent,
              uptimeMin:
                u == null
                  ? existing.uptimeMin
                  : existing.uptimeMin == null
                    ? u
                    : Math.min(existing.uptimeMin, u),
              samples: existing.samples + 1,
              offlineSamples: existing.offlineSamples + offline,
            },
          });
        }
      }

      counts[network]++;
    }
  }
  return counts;
}

export interface ValidatorInfo {
  nodeId: string;
  feePercent: number | null;
  uptimePercent: number | null;
  connected: boolean;
  /** TOTAL stake: self-bond plus delegated, decimal string. */
  weight: string | null;
  /** The validator's own bond, the P-chain's `weight` field. */
  selfBond: string | null;
  /** Stake delegated to this node by others, the P-chain's `delegatorWeight` field. */
  delegatedWeight: string | null;
  delegatorCount: number | null;
}

function toValidatorInfo(r: {
  nodeId: string;
  feePercent: number | null;
  uptimePercent: number | null;
  connected: boolean;
  weight: string | null;
  selfBond: string | null;
  delegatedWeight: string | null;
  delegatorCount: number | null;
}): ValidatorInfo {
  return {
    nodeId: r.nodeId,
    feePercent: r.feePercent,
    uptimePercent: r.uptimePercent,
    connected: r.connected,
    // Rows written before the two legs were split have a null total but a backfilled selfBond. Fall
    // back to it rather than reporting null, so the field never regresses to "unknown" for a node we
    // already had a figure for.
    weight: r.weight ?? r.selfBond,
    selfBond: r.selfBond,
    delegatedWeight: r.delegatedWeight,
    delegatorCount: r.delegatorCount,
  };
}

/** Validator stats for a set of node ids on a network, keyed by nodeId. */
export async function validatorsForNodeIds(
  network: string,
  nodeIds: string[]
): Promise<Map<string, ValidatorInfo>> {
  if (!nodeIds.length) return new Map();
  const rows = await prisma.providerValidator.findMany({
    where: { network, nodeId: { in: nodeIds } },
  });
  return new Map(rows.map((r) => [r.nodeId, toValidatorInfo(r)]));
}

/**
 * All validator stats for both networks, keyed by "network:nodeId". One query, for callers (like the
 * feed builder) that need to join validators across every provider at once without an N+1.
 */
export async function allValidatorsByNetworkNode(): Promise<Map<string, ValidatorInfo>> {
  const rows = await prisma.providerValidator.findMany();
  return new Map(rows.map((r) => [`${r.network}:${r.nodeId}`, toValidatorInfo(r)]));
}
