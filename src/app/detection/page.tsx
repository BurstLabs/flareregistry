"use client";

import Link from "next/link";

// Public METHODOLOGY page for the example-provider detection work.
//
// Scope is deliberate and narrow: this page explains HOW the measurement works and what it cannot
// establish. It publishes NO per-provider results, no scores and no names. The analysis identifies
// configuration and output arithmetic rather than source code, we hold zero confirmed positives, and a
// public list would therefore be an accusation the evidence does not support.
//
// English only, by decision: the body is dense statistical language where a mistranslation of
// "leave-one-out field rate" or "basis points" would be worse than no translation at all. The nav and
// footer entries are literal strings for the same reason.

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-10 scroll-mt-20">
      <h2 className="mb-3 text-xl font-semibold">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted">{children}</div>
    </section>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="surface mt-4 rounded-xl border p-4 text-sm leading-relaxed text-muted">
      {children}
    </div>
  );
}

// Wide content must scroll inside its own box, never widen the page on a phone.
function Scroller({ children }: { children: React.ReactNode }) {
  return <div className="-mx-1 overflow-x-auto px-1">{children}</div>;
}

function Formula({ children }: { children: string }) {
  return (
    <Scroller>
      <pre className="surface my-3 w-max min-w-full rounded-lg border p-3 text-xs leading-relaxed text-fg">
        <code>{children}</code>
      </pre>
    </Scroller>
  );
}

export default function DetectionMethodPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold">How the detection works</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Flare publishes a reference price-feed implementation,{" "}
        <code className="rounded bg-elev px-1 py-0.5 text-xs">ftso-v2-example-value-provider</code>,
        documented as a testing and demonstration tool rather than production software. We measured how
        much of the provider set appears to share a common implementation. Providers have asked how that
        measurement works, so this page sets it out in full.
      </p>

      <Note>
        <strong className="text-fg">This page publishes no results.</strong> No scores, no rankings and
        no provider names appear here or anywhere public. Our signals identify a{" "}
        <em>configuration and a style of arithmetic</em>, not which source code a provider runs, and we
        hold zero confirmed positives. Section 8 explains how to check your own setup in a minute
        without any tooling from us.
      </Note>

      <Section id="claims" title="1. What this does not establish">
        <p>Placed first on purpose, because it bounds everything below.</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-fg">Zero verified positives.</strong> No provider has confirmed to us
            that they run this software. Every figure we hold rests on inference.
          </li>
          <li>
            <strong className="text-fg">
              The signals detect arithmetic and configuration, not source code.
            </strong>{" "}
            A provider who writes their own median-of-prints implementation over a similar venue list is,
            on our measurements, indistinguishable from one running the reference code.
          </li>
        </ul>
      </Section>

      <Section id="mechanism" title="2. The mechanism">
        <p>
          The reference implementation computes each price with a time-decayed weighted median whose final
          step returns <strong className="text-fg">an observed trade price verbatim</strong>. It does not
          average. The relevant line is the return in <code>weightedMedian()</code> inside{" "}
          <code>src/data-feeds/ccxt-provider-service.ts</code>.
        </p>
        <p>
          That matters because exchange trade prices sit on that venue&apos;s tick grid. On chain, a value
          is encoded as an integer:
        </p>
        <Formula>{`encoded = round(price × 10^decimals) + 2^31`}</Formula>
        <p>
          So if a value came from a venue whose tick is <code>t</code>, the encoded integer is a multiple
          of <code>T = t × 10^decimals</code>. Where <code>T ≥ 2</code>, that divisibility is a real,
          checkable constraint. A value produced by averaging carries no such structure.
        </p>
      </Section>

      <Section id="signal1" title="3. Signal one: tick-grid lift">
        <p>
          Shown as the <strong className="text-fg">Tick grid</strong>{" "}column. For each (feed, tick) pair
          we ask how often a provider&apos;s encoded value is divisible by <code>T</code>.
        </p>
        <p>
          The baseline is the <strong className="text-fg">per-round leave-one-out field rate</strong>:
          the rate at which every <em>other</em> provider hit that same cell in that same round.
        </p>
        <Formula>{`for each (feed, T) cell in a round:
    k = providers hitting the cell,  m = providers with a usable value
    q_i = (k - hit_i) / (m - 1)          leave-one-out rate for provider i

lift = Σ hit_i / Σ q_i                  1.0 = behaves like the field`}</Formula>
        <p>
          Conditioning on the round removes the price-level effects common to every provider that round,
          and the field lands at 1.00 by construction. Values below <code>2^31</code> (the unpriced-feed
          sentinel) are excluded: zero is divisible by everything and would manufacture evidence.
        </p>
        <p>
          Exclusion is decided on an upper confidence bound on the lift rather than a z-score, so it
          converges as data accumulates instead of drifting. The variance carries a deliberate inflation
          factor for residual dependence between nested lattices, which can only make the screen slower
          to exclude someone.
        </p>
        <Note>
          <strong className="text-fg">This signal is one-sided.</strong> A low lift is strong evidence
          against running the reference implementation. A high lift is <em>not</em> proof for it, because
          any median-of-prints implementation echoes a print. It is an exclusion filter.
        </Note>
      </Section>

      <Section id="signal2" title="4. Signal two: per-cell hit pattern">
        <p>
          Shown as the <strong className="text-fg">Pattern</strong> column. Lift alone cannot rank the
          providers it does not exclude. It is confounded twice: our own
          reference configurations span a wide range of lift purely by exchange-list size, and any
          median-of-prints implementation reads high.
        </p>
        <p>
          <em>Which</em>{" "}cells a provider over-hits is a sharper question, because that is set by the
          venue list rather than the aggregation method. We correlate each provider&apos;s per-cell excess
          profile against our reference instances, then normalise by those instances&apos; own
          cross-configuration agreement:
        </p>
        <Formula>{`score = corr(provider profile, reference profile)
        ÷ mean corr between our own differently-configured instances`}</Formula>
        <p>
          The normaliser matters. A raw correlation is attenuated toward zero while profiles are noisy,
          so it climbs with sample size and no fixed threshold survives. Dividing by a quantity that
          attenuates in lockstep fixes that, and gives the scale a meaning: <strong className="text-fg">1.0
          means matching our reference as well as our own differently-configured instances match each
          other.</strong>
        </p>
      </Section>

      <Section id="signal3" title="5. Signal three: USDC configuration signature">
        <p>
          Shown as the <strong className="text-fg">USDC cfg</strong> column. This is the most defensible
          of the three and the only one needing no reference instance at all.
        </p>
        <p>
          The shipped <code>feeds.json</code> prices <code>USDC/USD</code> from five{" "}
          <code>USDC/USDT</code> order books, then multiplies by the provider&apos;s{" "}
          <strong className="text-fg">own</strong> <code>USDT/USD</code> median. Four of those five books
          tick at 1e-4, so whenever the median print comes from one of them:
        </p>
        <Formula>{`(USDC/USD ÷ USDT/USD) × 10^4   lands on an integer`}</Formula>
        <p>
          The fifth book ticks finer, at 1e-5, and prints taken from it do not land on that grid. So even
          an unmodified deployment does not score 1.0 here; it scores well above the field but short of
          it, by roughly the share of rounds the finer book wins the median. That is why the measure is
          read as a rate rather than as a yes or no.
        </p>
        <p>
          It uses only a provider&apos;s own two submitted values. Nothing is calibrated and there is no
          threshold to tune: the hit rate is identical at two different tolerances, and substituting a
          placebo constant for 1e-4 collapses the effect. Recomputing a provider against the{" "}
          <em>field median</em> USDT instead of its own also collapses it, exactly as the mechanism
          predicts.
        </p>
        <Note>
          It identifies a <strong className="text-fg">configuration, not an implementation</strong>. A
          custom implementation that kept the shipped <code>feeds.json</code> would read as
          example-config, and a deployment of the reference code whose USDC venues are geo-blocked or
          down would read as non-example-config. We have measured a real instance of the latter. A
          correlation gate is applied to catch that case and report it as unclear rather than as custom.
        </Note>
      </Section>

      <Section id="external" title="6. Cross-reference against an independent detector">
        <p>
          We are not the only party measuring this.{" "}
          <a
            href="https://cerberusonchain.xyz/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-beacon hover:underline"
          >
            cerberusonchain.xyz
          </a>{" "}
          publishes its own example-provider assessment, and we cache it daily to compare against our
          own. It drives the <strong className="text-fg">Ext</strong> column. Their verdicts are their
          work, not ours, and we neither republish them nor treat them as an input to our
          classification.
        </p>
        <p>
          What makes the comparison worth anything is that the two methods{" "}
          <strong className="text-fg">share no signals</strong>. They work from cadence and
          submitted-value fingerprints measured against their own reference deployment. We work from tick
          grids, per-cell hit patterns and a configuration signature. Two unrelated methods agreeing is
          evidence in a way that two of our own signals agreeing is not, and given we hold zero confirmed
          positives, an independent detector is the closest thing to external ground truth available.
        </p>
      </Section>

      <Section id="weight" title="7. How weight is calculated">
        <p>
          The <strong className="text-fg">Weight</strong> column shows a provider&apos;s{" "}
          <strong className="text-fg">share of total network voting power</strong>, as a percentage. It
          is computed from <strong className="text-fg">registration weight</strong>, which is the unit
          the protocol actually votes in.
          The delegation figure in tokens appears underneath it in smaller type, because that is the
          number Flare&apos;s own systems explorer shows and the one a provider recognises as theirs, but
          it is not what decides influence.
        </p>
        <p>
          Registration weight is what does. It caps the delegation leg, adds staking on top, and raises
          the total to the power 0.75:
        </p>
        <Formula>{`S       = stakingFactor x SUM(mirrored P-chain stake over the entity's nodeIds)
          + min(wNatCap, wNat vote power of the DELEGATION address)
wNatCap = WNat.totalVotePowerAt(vpBlock) x wNatCapPPM / 1e6
weight  = isqrt(S) x isqrt(isqrt(S))                       an integer floor of S^0.75`}</Formula>
        <p>
          Read live from the chain at the time of writing, <code>stakingFactor</code> is 5 and{" "}
          <code>wNatCapPPM</code>{" "}is 25000, so the cap is 2.5 percent of total network wNat. Three
          details are easy to get wrong and all three change the answer: the cap is a share of the whole
          network&apos;s vote power rather than of any individual, it applies to the{" "}
          <strong className="text-fg">delegation address</strong> rather than the identity address, and
          the exponent applies once to the combined sum rather than to each leg. Every step is integer
          arithmetic in wei with floors.
        </p>
        <p>
          A note on naming, because we got this wrong ourselves at first. This is often called the FIP.16
          weight, but FIP.16 introduced only the <strong className="text-fg">5x staking factor</strong>.
          The 2.5 percent cap and the 0.75 exponent are older than FIP.16 and appear in the FTSOv2
          whitepaper rather than the proposal. The authority for all three is the deployed contract, so
          that is what we cite and what we read.
        </p>
        <p>
          Songbird is not the same calculation. There,{" "}
          <code>FlareSystemsCalculator.pChainStakeMirror</code> is the zero address, so the staking leg
          never runs and registration weight is simply capped wNat raised to the power 0.75, even though{" "}
          <code>stakingFactor</code> still reads 5. Any Songbird figure that includes a stake term is
          wrong.
        </p>
        <p>
          We do not implement that formula.{" "}
          <code>FlareSystemsCalculator.calculateRegistrationWeight</code> already evaluated it at
          registration and <code>VoterRegistry</code>{" "}stored the answer, so we read the stored value.
          A reimplementation would be our opinion of the protocol&apos;s arithmetic, and it would drift
          silently the moment governance changed <code>stakingFactor</code> or <code>wNatCapPPM</code>.
          Reading the getter cannot drift, and it means you can check your own row yourself:
        </p>
        <Formula>{`cast call 0xA480457953Af3583E54DCd630b219353B8FC9Af7 \\
  "getVoterRegistrationWeight(address,uint256)(uint256)" <identity address> <reward epoch> \\
  --rpc-url https://flare-api.flare.network/ext/C/rpc

# the protocol's own total for the same epoch
cast call 0xA480457953Af3583E54DCd630b219353B8FC9Af7 \\
  "getWeightsSums(uint256)(uint128,uint16,uint16)" <reward epoch> --rpc-url ...`}</Formula>
        <p>
          The raw value is never displayed, only the share. Its unit is wei to the power 0.75, so it is
          not a token amount and does not convert to one; an absolute figure tells you nothing and would
          invite exactly the misreading the unit deserves. Ratios are the only meaningful form, and a
          share of the total is a ratio.
        </p>
        <p>
          We did not take the formula on trust either. Recomputing it from raw primitives{" "}
          (<code>getNodeIdsOfAt</code>, <code>batchVotePowerOfAt</code>,{" "}
          <code>getDelegationAddressOfAt</code>, <code>votePowerOfAt</code>,{" "}
          <code>totalVotePowerAt</code>) reproduces the stored weight for{" "}
          <strong className="text-fg">98 of 98 voters on Flare and 64 of 64 on Songbird</strong>, and the
          totals match <code>getWeightsSums</code> exactly, to the wei. Rival readings do not: using
          uncapped wNat matches 96, a staking factor of 1 matches 3, applying the exponent to each leg
          separately matches 3, capping the sum rather than the wNat term matches 65, and using the
          identity address in place of the delegation address matches none.
        </p>
        <Note>
          The denominator is every registered voter on the network, not only the providers we scored, so
          a provider&apos;s share does not move because our measurement coverage changed. Summed across
          every voter we read, our figures cover 99.97 percent of the protocol&apos;s own{" "}
          <code>weightsSum</code>{" "}for the epoch, so the percentages are within rounding of true
          network shares. Any statement we make about how much of the network a group of providers
          represents is computed the same way.
        </Note>
      </Section>

      <Section id="selfcheck" title="8. How to check your own setup">
        <p>You can answer this in a minute, and you hold information we never will.</p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Does your value provider return a price taken directly from a single observed trade, or does
            it combine several observations arithmetically?
          </li>
          <li>
            Is your <code>USDC/USD</code> derived from <code>USDC/USDT</code> books multiplied by your own{" "}
            <code>USDT/USD</code>?
          </li>
          <li>How much does your venue list differ from the shipped defaults?</li>
          <li>
            If you forked the reference implementation, how far has it diverged and when did you last
            rebase?
          </li>
        </ol>
        <p>
          If you believe our method would misclassify you, please{" "}
          <Link href="/contact" className="text-beacon hover:underline">
            tell us
          </Link>
          . We will correct the record.
        </p>
      </Section>

      <Section id="verify" title="9. Reproducing this independently">
        <p>Everything upstream of our code is public. Reveals are decoded from:</p>
        <Scroller>
          <ul className="w-max min-w-full list-disc space-y-1 pl-5 text-xs">
            <li>
              Submission contract <code>0x2cA6571Daa15ce734Bbd0Bf27D5C9D16787fc33f</code>
            </li>
            <li>
              Selector <code>0x9d00c9fd</code>, FTSO protocol id <code>100</code>
            </li>
            <li>
              Payload: <code>random(32)</code> then 4-byte values in canonical feed order
            </li>
            <li>
              Voting round: <code>floor((unixtime - 1658429955) / 90)</code>; round R reveals during R+1
            </li>
          </ul>
        </Scroller>
        <p>
          Canonical feed order and per-feed decimals come from Flare&apos;s published{" "}
          <code>reward-epoch-info.json</code>. Exchange tick sizes come from ccxt market metadata. We are
          happy to share further detail with the Management Group, with Flare, or with any provider who
          asks.
        </p>
      </Section>

      <Section id="use" title="10. How this is used">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-fg">It never affects a listing.</strong>{" "}
            The tooling is barred from driving listing decisions, and Flare Registry has not altered any provider&apos;s listing on
            the basis of this analysis.
          </li>
          <li>
            <strong className="text-fg">Results are not published.</strong> No list is published here.
          </li>
          <li>
            <strong className="text-fg">The concern is correlation, not quality.</strong>{" "}
            An oracle&apos;s resilience rests on independent observation. Homogeneity means one upstream fault reaches
            many participants at once and arrives looking like consensus. That is the risk worth
            discussing, and it is not a claim that anyone is producing bad prices.
          </li>
        </ul>
      </Section>

    </div>
  );
}
