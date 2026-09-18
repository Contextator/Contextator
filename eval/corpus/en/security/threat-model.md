# Threat model

What Halyard defends against, what it does not, and which of the things it does not defend against are
deliberate.

## Trust boundaries

Three, and they are not equally strong.

**The publisher** holds an API key and is trusted with what that key's scopes allow. A key with
`events:write` can publish any event type to any subscriber; there is no per-type authorization. If you
need one publisher to be unable to trigger another team's endpoint, run two Halyard deployments.

**The receiver** is not trusted at all. It is a URL that Halyard makes requests to, and everything it
returns is treated as data: status codes are interpreted, bodies are truncated at 4 KiB and stored, and
nothing in a response can change Halyard's configuration.

**The operator** has the database. Anyone with the database has every payload that has not been swept and
every endpoint's custom headers, including any bearer token you put in one. Encrypt the volume; Halyard
does not encrypt payloads at rest and does not pretend to.

## Server-side request forgery

The one that matters, because Halyard's whole purpose is making HTTP requests to addresses that users
supply.

- An endpoint URL must be https unless the host is loopback.
- The resolved address must not be link-local (`169.254.0.0/16`, `fe80::/10`), loopback, or in a
  metadata-service range. This is checked at creation and **again immediately before each delivery**,
  against the address the connection will actually use, because a name that resolved to a public address
  yesterday can resolve to `169.254.169.254` today. The delivery-time failure is `HLY-2007`.
- Redirects are not followed. A `3xx` from a receiver is a failure, not a hop.

Private RFC 1918 ranges are **allowed** by default, because delivering to a service on your own network
is a normal deployment. Set `HALYARD_BLOCK_PRIVATE_RANGES=true` where user-supplied endpoints are
untrusted — a multi-tenant product, most obviously — and accept that internal endpoints then need their
own deployment.

## Signature verification is the receiver's job

Halyard signs; it cannot make anyone check. `X-Halyard-Signature` and `X-Halyard-Signature-Timestamp`
together let a receiver establish that a request came from this Halyard and is not a replay of a captured
one. A receiver that does not verify is accepting webhooks from anybody who learns its URL, and no
setting here changes that.

The timestamp is signed with the body, which is what makes replay detection possible. Reject requests
whose timestamp is further than `HALYARD_SIGNATURE_TOLERANCE` — five minutes — from your own clock, and
compare signatures in constant time.

## Keys

Static keys in `HALYARD_ADMIN_API_KEYS` have full access, cannot be scoped, cannot be revoked without a
restart and appear in whatever manages your environment. They exist for bootstrap and CI. Everything
else should be a key minted with `halyardctl keys mint`, which is scoped, revocable in one request, and
stored only as a hash with a short prefix kept so two keys can be told apart in a list.

## What is not defended

- **No rate limiting on the publish API.** A publisher with a valid key can fill the queue. The key is
  the boundary; put a proxy in front if you need more than that.
- **No payload encryption at rest**, as above.
- **No audit log of reads.** Who listed deliveries and looked at a payload is not recorded. Writes are
  logged with the key id; reads are not.
- **No protection against a malicious operator.** Nothing here is trying to.
