"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "./providers";
import { useWalletSign } from "@/lib/useWalletSign";
import { apiErrorMessage } from "@/lib/i18n";

// Inline "Manage this listing" on the provider page: connect the wallet and sign in (opening a
// session), then route to /submit?manage=1, which detects the session and jumps straight to the
// edit form - skipping the otherwise near-empty connect screen.
//
// claimed=false means this is an unclaimed legacy seed (no verified owner yet). Then the affordance
// reads "Claim this listing" and the wallet must match one of THIS listing's registered addresses
// (claimAddresses). Without that check, signing in with a wallet that owns a DIFFERENT provider would
// open a session and /submit?manage=1 would jump to that wallet's own listing, not the one being
// claimed (the manage flow resolves the listing by the signed-in address).
export function ManageListingButton({
  ownerAddresses,
  claimAddresses = [],
  claimed = true,
}: {
  // Verified owner addresses (gate for managing an already-claimed listing).
  ownerAddresses: string[];
  // All of this listing's registered addresses (gate for claiming an unclaimed seed).
  claimAddresses?: string[];
  claimed?: boolean;
}) {
  const { t } = useApp();
  const router = useRouter();
  const connectAndSign = useWalletSign(t);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function connectAndManage() {
    setErr("");
    setBusy(true);
    try {
      // The connected wallet must belong to THIS listing; otherwise signing in would open a session
      // and the manage flow would jump to whatever listing that wallet owns, not this one. For an
      // already-claimed listing the wallet must be a verified owner; for an unclaimed seed it must be
      // one of the listing's registered addresses (the legitimate claimant signs with one of those).
      // The challenge is on Flare (14). The allow-list guard runs before signing.
      const { message, signature } = await connectAndSign({
        chainId: 14,
        allowAddresses: claimed ? ownerAddresses : claimAddresses,
        allowAddressesErrorKey: claimed ? "detail.manageWrongWallet" : "detail.claimWrongWallet",
      });

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        throw new Error(apiErrorMessage(t, body, "submit.err.verifyFailed"));
      }
      router.push("/submit?manage=1");
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("submit.err.verifyFailed"));
      setBusy(false);
    }
  }

  // An unclaimed seed gets a more prominent "Claim this listing" prompt with a short explainer, so a
  // provider arriving at their imported entry knows they can take it over by signing.
  if (!claimed) {
    return (
      <div className="mt-3 rounded border border-beacon/40 bg-beacon/10 px-3 py-2">
        <button
          type="button"
          onClick={connectAndManage}
          disabled={busy}
          className="text-sm font-medium text-beacon underline-offset-2 hover:underline disabled:opacity-50"
        >
          {busy ? t("detail.manageConnecting") : t("detail.claimListing")} &rarr;
        </button>
        <p className="mt-1 text-xs text-muted">{t("detail.claimListingHint")}</p>
        {err && <p className="mt-1 text-xs text-flare">{err}</p>}
      </div>
    );
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={connectAndManage}
        disabled={busy}
        className="text-sm text-muted underline-offset-2 hover:text-beacon hover:underline disabled:opacity-50"
      >
        {busy ? t("detail.manageConnecting") : t("detail.manageListing")} &rarr;
      </button>
      {err && <p className="mt-1 text-xs text-flare">{err}</p>}
    </div>
  );
}
