# Consuming the Flare Registry provider list

Everything below is about reading the published list. To list a provider, or correct an entry,
see [flareregistry.com/submit](https://flareregistry.com/submit): entries are owner-managed, so
nobody can change a listing on a provider's behalf, including us.

## Where it is

| | |
| --- | --- |
| Live | `https://flareregistry.com/api/feed/providerlist.json` |
| Static | `https://raw.githubusercontent.com/BurstLabs/flareregistry/main/providerlist.json` |
| Schema | `https://flareregistry.com/providerlist.schema.json` |

Both carry the same document. The live endpoint sends `Cache-Control: public, max-age=60`; the
static file is rewritten whenever a listing changes. Polling either more than a few times an hour
tells you nothing new: on-chain figures advance once per reward epoch, which is 3.5 days.

Also published: `/api/v1/providers` (the same data in a versioned envelope),
`/api/feed/validators.json`, `/api/feed/yield.json`, and `/api/feed/coston2/providerlist.json`
for the test network. `/api/feed/archived.json` was removed on 5 November 2026; departed providers
are in the main list now, which is the point of the next section.

## Use `listed` for pickers, and show the rest everywhere else

```js
const pick = providers.filter((p) => p.listed);
```

`listed` is true for a provider that meets every automatable criterion and has served out its
review window. That is the set to put in a delegation picker or a comparison table.

Everywhere else, show the entry whether or not it is listed. A user looking at a confirmation
screen, a transaction history or a search result wants to see who they are dealing with, and
filtering those views leaves them with a bare hex address.

**The list deliberately contains providers you should not offer.** Providers who stopped
submitting keep their entry rather than vanishing, because the chain still carries their
registration: an explorer will still have a row for them and still need a name. Removing them from
the feed does not make them disappear from your screen, it only makes them nameless.

## `status` says why

`listed` tells you whether to offer a provider. `status` tells you why not.

| `status` | Meaning |
| --- | --- |
| `listed` | Meets every criterion and is past its review window. |
| `held` | Qualified, but inside the 30-day new-provider or new-claim window. |
| `unqualified` | Does not currently meet the criteria. |
| `departed` | Not qualified and silent for 26 reward epochs (about 3 months) or more. |
| `suspended` | A governance case closed against it. |
| `unnamed` | Registered on-chain, but no list or owner has ever published an identity. |
| `dormant` | Holds a registration that has never taken part: no signing policy, no submissions. |

`listed === (status === "listed")` holds for every entry, by construction. Both reverse on their
own: a departed provider that starts submitting again is listed again with no action by anyone.

If you only ever read one of the two, read `listed`.

## Verify the logo bytes

`logoURI` points at our CDN. `logoHash` is the SHA-256 of the bytes at that URL, lowercase hex,
no `0x` prefix:

```js
const bytes = new Uint8Array(await (await fetch(p.logoURI)).arrayBuffer());
const digest = await crypto.subtle.digest("SHA-256", bytes);
const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
if (hex !== p.flareregistry.logoHash) throw new Error(`logo mismatch for ${p.name}`);
```

A URL on its own cannot be checked. A CDN, a proxy or a stale mirror can serve a different picture
and nothing in the response says so. The hash is there so you never have to take the image on
trust. It is `null` on the few entries whose image we do not host.

Logos are PNG, square, 128 to 256 px, 24 KB or less. Transparency is common but not guaranteed:
some marks are opaque, so do not assume you can composite them onto any background.

## Validate against the schema

```bash
curl -sO https://flareregistry.com/providerlist.schema.json
curl -s https://flareregistry.com/api/feed/providerlist.json -o providerlist.json
npx -p ajv-cli@5 -p ajv-formats@3 ajv validate --spec=draft7 -c ajv-formats \
  -s providerlist.schema.json -d providerlist.json
```

(`-c ajv-formats` is needed because ajv ignores `format` keywords unless you ask for them, and
the schema uses `date-time` and `uri`.)

The schema is draft-07 and lives at a stable URL, and the feed names it in `$schema`. It is
checked against the generator on every build of this site, so it cannot quietly fall behind the
document it describes. If your validation fails, that is a bug on our side and we would like to
hear about it.

## The seven base fields are byte-compatible with the older format

```
chainId   name   description   url   address   logoURI   listed
```

Those are exactly the fields of the FTSO provider list that wallets consumed before, with the same
names and the same meanings, so code written against that format reads this one unchanged.
Everything we add lives under one namespaced key, `flareregistry`, which a consumer that does not
know about it will ignore.

`description` is per network. A provider operating on both Flare and Songbird may publish
different text for each, so read it from the entry rather than caching it per provider.

## Reconciling against another list

If you read more than one provider list, two fields settle a disagreement without you having to
decide in advance which source wins:

- **`attestedAt`** is when that address last proved control by signing a challenge with an
  on-chain role key. It is the strongest claim in the entry, because the subject of the record
  made it, not us.
- **`updatedAt`** is when the entry's published name, description, url or logo last changed.

Both are `null` where an entry still carries another list's text, so a copy never outranks the
original. An entry with a recent `attestedAt` is one its operator stood behind recently.

## Terms

The data is **CC BY 4.0**: copy, redistribute, adapt and build on it, commercially or not, with
credit to Flare Registry (https://flareregistry.com). See
[LICENSE-DATA](https://github.com/BurstLabs/flareregistry/blob/main/LICENSE-DATA).

**Logos are not covered by that grant and are not ours to license.** Each one is the trademark or
brand mark of the provider it identifies, uploaded by that provider so it can be shown beside
their entry. Showing a logo next to the provider it identifies is what it is there for; using it
for anything else is between you and them. See
[assets/NOTICE.md](https://github.com/BurstLabs/flareregistry/blob/main/assets/NOTICE.md).

## Questions

Open an issue on [BurstLabs/flareregistry](https://github.com/BurstLabs/flareregistry), or use the
contact form at [flareregistry.com/contact](https://flareregistry.com/contact). If you are building
on this list we would like to know, so we can tell you before anything in it changes.
