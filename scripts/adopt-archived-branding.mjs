// ONE-TIME: adopt branding for entities we carry nameless, from the archived provider list.
//
// WHY THIS EXISTS. Our chain sweep finds every registered, submitting entity, including ones no
// list has ever named. Those are stored source="onchain" with their own address as the name and no
// logo, and the feed never lists them, because "imported" means some list vouched for a name and
// "onchain" means nothing did (see api/admin/import-candidates).
//
// On 2026-11-05 Bifrost merged fourteen pull requests into TowoLabs/ftso-signal-providers and then
// ARCHIVED it. That merge published names, sites and logos for five entities we were carrying as
// hex, hours before the file froze for good. Their replacement catalog does not carry four of the
// five, so this is the only place that branding exists, and it will never be added to again.
//
// A list vouched for a name, so these stop being "onchain" and become ordinary unclaimed imports:
// they list once qualified, and the real owner can still claim them by signature at any time.
//
// Logos are MIRRORED, not hotlinked. Our feed is now the primary source for Flare's Systems
// Explorer and Portal, so a logo URL pointing into an archived repository is a broken image on
// their surfaces the day its owner deletes or privatises it. Same reasoning repoints the one
// existing entry (BlockNth) still hotlinking that repo.
//
// Two steps, because the raw URL has to resolve before the feed points at it:
//   node scripts/adopt-archived-branding.mjs                 # report only
//   node scripts/adopt-archived-branding.mjs --fetch         # 1: download logos into assets/
//   git add assets && git commit && git push                 #    then the raw URLs go live
//   node scripts/adopt-archived-branding.mjs --apply         # 2: write names/logos to the DB
import { PrismaClient } from "@prisma/client";
import { getAddress } from "viem";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { normalisePng } from "./lib/normalise-png.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ARCHIVE_URL =
  "https://raw.githubusercontent.com/TowoLabs/ftso-signal-providers/master/bifrost-wallet.providerlist.json";
const LOGO_REPO = process.env.LOGO_REPO ?? "BurstLabs/flareregistry";
const LOGO_BRANCH = process.env.LOGO_BRANCH ?? "main";
const logoRawURL = (address) =>
  `https://raw.githubusercontent.com/${LOGO_REPO}/${LOGO_BRANCH}/assets/${getAddress(address)}.png`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, "..", "assets");
const FETCH = process.argv.includes("--fetch");
const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

const isAddressName = (n) => /^0x[0-9a-f]{40}$/i.test(n.trim());
const norm = (s) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

async function fetchPng(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
    throw new Error("not a PNG");
  }
  if (buf.length > 1_000_000) throw new Error("too large (>1MB)");
  // Mirrored images used to be written verbatim, which is how a 512x512 and ten non-square logos
  // reached assets/. Normalise on the way in so it cannot happen again; see scripts/lib.
  const n = await normalisePng(buf);
  if ("error" in n) throw new Error(n.error);
  return n.buf;
}

async function main() {
  const res = await fetch(ARCHIVE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`archive: HTTP ${res.status}`);
  const archive = (await res.json()).providers ?? [];
  // Keyed by chain and address. The archive lists one role address per entry and it is not always
  // the one our listing row holds, so entries are matched through the entity's full role set below.
  const up = new Map();
  for (const p of archive) up.set(`${p.chainId}:${p.address.toLowerCase()}`, p);

  const nameless = (
    await prisma.provider.findMany({
      where: { source: "onchain" },
      include: { addresses: true },
    })
  ).filter((p) => isAddressName(p.name));

  const entities = await prisma.providerOnchain.findMany();
  const rolesFor = (addr) => {
    const e = entities.find((x) =>
      [x.voter, x.delegationAddress, x.submitAddress, x.submitSignaturesAddress, x.signingPolicyAddress]
        .filter(Boolean)
        .some((r) => r.toLowerCase() === addr)
    );
    return e
      ? [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress]
          .filter(Boolean)
          .map((r) => r.toLowerCase())
      : [addr];
  };

  // Every provider name already in use, so adopting one cannot silently fuse two operators.
  const taken = new Map(
    (await prisma.provider.findMany({ select: { id: true, name: true } })).map((p) => [
      norm(p.name),
      p.id,
    ])
  );

  const plan = [];
  for (const p of nameless) {
    for (const a of p.addresses) {
      let src = null;
      for (const r of rolesFor(a.address.toLowerCase())) {
        src = src || up.get(`${a.chainId}:${r}`);
      }
      if (!src || isAddressName(src.name)) continue;
      const clash = taken.get(norm(src.name));
      if (clash && clash !== p.id) {
        console.log(`  SKIP ${src.name}: that name is already taken by another listing`);
        continue;
      }
      plan.push({ provider: p, address: a, src });
      break; // one source entry per provider is enough
    }
  }

  // The one existing import still hotlinking the archived repo; same risk, same fix.
  const hotlinked = (
    await prisma.provider.findMany({
      where: { logoURI: { contains: "TowoLabs/ftso-signal-providers" } },
      include: { addresses: true },
    })
  ).filter((p) => p.addresses.length);

  console.log(
    `${nameless.length} nameless on-chain listings, ${plan.length} have branding in the archive; ` +
      `${hotlinked.length} existing listing(s) hotlink the archived repo`
  );
  for (const { provider, address, src } of plan) {
    console.log(`  chain ${address.chainId}  ${address.address} -> ${src.name}  (${src.url || "no site"})`);
  }

  if (FETCH) {
    if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });
    let got = 0;
    for (const { address, src } of plan) {
      if (!src.logoURI) continue;
      try {
        const buf = await fetchPng(src.logoURI);
        writeFileSync(join(ASSETS_DIR, `${getAddress(address.address)}.png`), buf);
        got++;
      } catch (e) {
        console.log(`  logo FAILED ${src.name}: ${e.message}`);
      }
    }
    for (const p of hotlinked) {
      try {
        const buf = await fetchPng(p.logoURI);
        writeFileSync(join(ASSETS_DIR, `${getAddress(p.addresses[0].address)}.png`), buf);
        got++;
      } catch (e) {
        console.log(`  logo FAILED ${p.name}: ${e.message}`);
      }
    }
    console.log(`fetched ${got} logo(s) into assets/. Commit and push, then re-run with --apply.`);
  }

  if (APPLY) {
    let n = 0;
    for (const { provider, address, src } of plan) {
      await prisma.provider.update({
        where: { id: provider.id },
        data: {
          // Trimmed: this text comes from a list we do not control and is republished verbatim.
          name: src.name.trim().slice(0, 80),
          description: (src.description ?? "").trim().slice(0, 600),
          url: (src.url ?? "").trim().slice(0, 200),
          logoURI: src.logoURI ? logoRawURL(address.address) : null,
          // A list vouched for a name, so this is no longer a chain-only entity.
          source: "imported",
        },
      });
      n++;
    }
    let r = 0;
    for (const p of hotlinked) {
      // Only repoint to a file we actually hold. Bitrue's asset in the archived repo is a JPEG
      // with a .png name, so the mirror refuses it; repointing anyway would swap a URL that works
      // for one that 404s.
      if (!existsSync(join(ASSETS_DIR, `${getAddress(p.addresses[0].address)}.png`))) {
        console.log(`  SKIP repoint ${p.name}: no mirrored asset`);
        continue;
      }
      await prisma.provider.update({
        where: { id: p.id },
        data: { logoURI: logoRawURL(p.addresses[0].address) },
      });
      r++;
    }
    console.log(`adopted ${n} listing(s), repointed ${r} hotlinked logo(s)`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
