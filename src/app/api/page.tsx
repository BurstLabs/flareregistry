"use client";

import { useApp } from "@/components/providers";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://flareregistry.com";
const ASSETS_FEED =
  "https://raw.githubusercontent.com/BurstLabs/flareregistry/main/providerlist.json";

function Endpoint({
  method,
  path,
  children,
}: {
  method: string;
  path: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6 rounded-lg border border-themed p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-elev px-2 py-0.5 text-xs font-medium text-emerald-400">
          {method}
        </span>
        <code className="text-sm text-beacon">{path}</code>
      </div>
      <div className="text-sm text-muted">{children}</div>
    </div>
  );
}

export default function ApiDocs() {
  const { t } = useApp();
  return (
    <div className="max-w-3xl">
      <h1 className="mb-2 text-3xl font-bold">{t("api.title")}</h1>
      <p className="mb-8 text-muted">
        {t("api.intro")} <code className="text-beacon">flareregistry</code>{" "}
        {t("api.introAfter")}
      </p>

      <h2 className="mb-3 text-xl font-semibold">{t("api.endpointsHeading")}</h2>

      <Endpoint method="GET" path="/api/feed/providerlist.json">
        {t("api.ep.feed")}{" "}
        <code>{`{ name, timestamp, version, providers[] }`}</code>. {t("api.ep.feedAfter")}{" "}
        <a className="text-beacon underline break-all" href={ASSETS_FEED}>
          {ASSETS_FEED}
        </a>
        .
      </Endpoint>

      <Endpoint method="GET" path="/api/v1/providers">
        {t("api.ep.providers")}{" "}
        <code>{`{ apiVersion, generatedAt, count, providers[] }`}</code>.{" "}
        {t("api.ep.providersAfter")}
      </Endpoint>

      <Endpoint method="GET" path="/api/provider/:address">
        {t("api.ep.provider")}
      </Endpoint>

      <h2 className="mb-3 mt-8 text-xl font-semibold">{t("api.schemaHeading")}</h2>
      <p className="mb-3 text-sm text-muted">
        {t("api.baseFields")} <code>chainId</code>, <code>name</code>,{" "}
        <code>description</code>, <code>url</code>, <code>address</code> (EIP-55),{" "}
        <code>logoURI</code>, <code>listed</code>.
      </p>
      <p className="mb-2 text-sm text-muted">
        {t("api.optionalObj")} <code className="text-beacon">flareregistry</code>{" "}
        {t("api.optionalObjAfter")}
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-themed bg-elev p-4 text-xs font-medium">
        {`"flareregistry": {
  "verified": true,                 // owner proved control of this address by signature
  "registered": true,               // matched to a registered FTSO entity on-chain
  "managementGroup": true,          // member of Flare's on-chain FTSO Management Group
  "qualified": true,                // meets all automatable qualification criteria
  "network": "flare",               // "flare" | "songbird"
  "feePercent": 20,                 // delegation fee, percent
  "votePower": "124071601...",      // wNat weight, wei-scale string
  "votePowerCapped": "124071601...",
  "feedCount": 63,                  // feeds covered this epoch
  "lastEpoch": 408,                 // reward epoch the metrics are from
  "delegatorRewardLastEpoch": "...",// wei-scale string
  "feeRewardLastEpoch": "...",      // wei-scale string
  "entity": {                       // the 5 registered on-chain addresses (null if unmatched)
    "identity": "0x...",            // voter / identity address
    "submit": "0x...",
    "submitSignatures": "0x...",
    "signingPolicy": "0x...",
    "delegation": "0x..."
  },
  "selfDeclared": {                 // provider-attested, NOT verified on-chain
    "privateNode": true,            // submits from a private node (or null)
    "algorithm": "in-house"         // "in-house" | "open-source" | null
  },
  "qualification": {                // liveness / disqualification risk
    "qualifiedSince": "2026-06-...",// when the current Qualified latch began (ISO)
    "lastSubmittedEpoch": 408,      // last epoch the entity submitted
    "epochsSinceSubmit": 0,         // 0 = submitted this epoch
    "epochsUntilRevoke": 17,        // missed epochs left before losing Qualified
    "revokeAfterEpochs": 17         // the revocation threshold
  }
}`}
      </pre>
      <p className="mt-3 text-sm text-muted">
        {t("api.weiNote")} (<code>flare-foundation/fsp-rewards</code>) {t("api.weiNoteMid")}{" "}
        (<code>lastEpoch</code>){t("api.weiNoteAfter")} 10<sup>18</sup>.
      </p>

      <h2 className="mb-3 mt-8 text-xl font-semibold">{t("api.logoHeading")}</h2>
      <p className="mb-3 text-sm text-muted">{t("api.logoHosted")}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-themed bg-elev p-4 text-xs font-medium">
        {`https://raw.githubusercontent.com/BurstLabs/flareregistry/main/assets/<checksumAddress>.png

# example
https://raw.githubusercontent.com/BurstLabs/flareregistry/main/assets/0x69141E890F3a79cd2CFf552c0B71508bE23712dC.png`}
      </pre>
      <p className="mt-3 text-sm text-muted">
        {t("api.logoDeterministic")} <code>logoURI</code> {t("api.logoDeterministicAfter")}
      </p>
      <p className="mt-2 text-sm text-muted">{t("api.logoReqs")}</p>

      <p className="mt-8 text-sm text-muted">
        {t("api.baseUrlLabel")} <code className="text-beacon">{PUBLIC_BASE_URL}</code>
      </p>
    </div>
  );
}
