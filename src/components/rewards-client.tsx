"use client";

import { useApp } from "./providers";
import { RewardSignPanel, type PendingRewardView } from "./reward-sign-panel";
import { RewardWatchForm } from "./reward-watch-form";

export function RewardsClient({ pending }: { pending: PendingRewardView | null }) {
  const { t } = useApp();
  return (
    <div>
      <section className="hero-accent -mx-4 mb-8 rounded-2xl px-4 py-8 sm:-mx-6 sm:px-6">
        <h1 className="mb-3 text-3xl font-bold tracking-tight">{t("rewards.title")}</h1>
        <p className="max-w-2xl leading-relaxed text-muted">{t("rewards.intro")}</p>
      </section>

      {pending ? (
        <RewardSignPanel pending={pending} />
      ) : (
        // NOTHING PENDING IS THE NORMAL STATE and reads as a healthy one, not as an empty page.
        // An epoch is only signable for the hours between Flare publishing the distribution and
        // the signing threshold being reached, so most visits land here.
        <section className="surface rounded-xl border p-5">
          <p className="text-sm text-muted">{t("rewards.nothing")}</p>
        </section>
      )}

      {/* The page only helps providers who think to visit it, which is the same problem signing
          has in the first place. */}
      <RewardWatchForm />

      <section className="mt-8 text-xs leading-relaxed text-faint">
        <h2 className="mb-1.5 text-sm font-semibold text-fg">{t("rewards.howTitle")}</h2>
        <p className="max-w-3xl">{t("rewards.how")}</p>
      </section>
    </div>
  );
}
