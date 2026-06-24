# Flare Registry

A self-service registry for FTSO signal providers on Flare and Songbird. Live at
[flareregistry.com](https://flareregistry.com). Built by [Burst Labs](https://www.burstlabs.io).

A provider connects the wallet for their on-chain address, signs a challenge to prove they
control it, and manages their own listing. The result is published as a `providerlist.json`
feed that is compatible with the standard provider-list schema, so any wallet that reads that
list can read Flare Registry unchanged.

Only addresses registered on-chain as FTSO signal providers (on Flare or Songbird) can list, so
the registry only ever contains real providers. The whole codebase, including the qualification
rules that decide listing, is open source here for anyone to audit and reproduce.

See [flareregistry.com/why](https://flareregistry.com/why) for more.

## Highlights

- **Self-service listing.** Sign in with your wallet and edit your listing instantly; it appears
  in the feed right away.
- **Cryptographic ownership.** A listing is editable only by the wallet that signed for its
  address.
- **Live on-chain metrics.** Fee, vote power, feed coverage, and per-epoch rewards, sourced from
  Flare's published reward data (`flare-foundation/fsp-rewards`).
- **Transparent, automatic qualification.** A Qualified status is computed automatically from
  on-chain data, with every criterion shown as a pass/fail.
- **Registered providers only.** Listing requires an on-chain registered FTSO address, so the
  registry cannot be polluted with arbitrary addresses.
- **Open source and auditable.** The listing logic is code anyone can read. Open, documented API
  plus a stable feed URL. See [/api](https://flareregistry.com/api).

## Qualification

Each provider is evaluated against an automatable set of trust and availability criteria,
sourced from Flare's published reward data:

- **Address on website** (required for new providers; waived for established ones by on-chain tenure)
- **Submitting prices** (active in the latest reward epoch)
- **Sufficient vote power** (enough weight to participate in the signing policy)
- **>=95% uptime over 30 days** (present in at least 95% of the last ~9 reward epochs)
- **One provider per network** (a single registered entity per network)

A provider is **Qualified** when all automatable checks pass. Qualification **latches**: once
earned, a provider stays qualified, and the only way to lose it is to stop submitting prices for
60 days (~17 epochs), after which it must re-qualify from scratch. The feed exposes how close a
provider is to revocation (`qualification.epochsUntilRevoke`).

Items that cannot be verified on-chain (private node, in-house/open-source algorithm) are
provider-attested and shown labeled as self-declared. Independence / no-collusion is not
auto-judged; Qualified is a performance and identity signal, not a sybil guarantee.

## How ownership verification works

1. The provider enters the on-chain address they want to claim.
2. The server issues a one-time challenge (a SIWE message containing a nonce).
3. The provider signs it with the wallet for that address.
4. The server recovers the signer and confirms it equals the claimed address before saving.

Sign in with your **identity address** (any of the five registered addresses is accepted, but
the identity address gives the strongest on-chain match). On Flare and Songbird the address must
be a registered on-chain FTSO entity; the testnets (Coston, Coston2) are exempt since they have
no reward data to check against. The feed exposes all five of an entity's registered addresses
under `flarebeacon.entity` (identity, submit, submit-signatures, signing-policy, delegation).

## Supported chains

| Network  | chainId |
|----------|---------|
| Flare    | 14      |
| Songbird | 19      |
| Coston   | 16      |
| Coston2  | 114     |

## Endpoints

- `GET  /api/feed/providerlist.json` — the wallet-compatible feed. Also published as a static
  file at `raw.githubusercontent.com/BurstLabs/flareregistry/main/providerlist.json`.
- `GET  /api/v1/providers` — the same data in a versioned envelope.
- `GET  /api/provider/:address` — a single provider profile.
- `POST /api/auth/nonce`, `POST /api/auth/verify` — sign-in.
- `POST /api/provider`, `POST /api/provider/logo` — manage a listing (authenticated).

Full schema and the `flarebeacon` metrics object: [/api](https://flareregistry.com/api).

## Logo assets

Logos are committed for the provider on upload and served from GitHub's raw CDN, keyed by the
EIP-55 checksummed address: `assets/<checksumAddress>.png`. Requirements (enforced on upload):
square PNG, 128-256 px per side, transparent or filled background, <= 24 KB.

## Stack

Next.js 16 (App Router) · TypeScript · Postgres (Prisma) · SIWE wallet auth (viem) · Tailwind
(dark/light) · 6-language i18n (EN/ES/ZH/JA/KO/DE).

## Getting started

```bash
npm install
cp .env.example .env        # set DATABASE_URL, SESSION_SECRET, GITHUB_ASSETS_TOKEN
npm run db:push             # create tables
npm run dev
```

## Deploy

Production deploy is a single script on the server: `./deploy.sh` (git reset, prisma generate,
migrate deploy, build, pm2 restart, health check). On-chain metrics are ingested from
`flare-foundation/fsp-rewards` on a 6-hour cron.

## License

MIT. See [LICENSE](LICENSE).

## Built by

[Burst Labs](https://www.burstlabs.io).
