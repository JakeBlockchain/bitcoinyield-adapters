# Syntetika hBTC

Syntetika's "BTC Hilbert Basis+" vault on Base (hBTC, backed by cbBTC).
Managed by Hilbert / Tulipa Capital; delta-neutral basis strategy plus a
Merkl reward campaign.

## Data sources

- **Vault** — `https://api.backup.syntetika.io/vault/<id>` for TVL (BTC and
  USD), share price, exchange rate, and `rewards_apy` (Merkl fallback).
  Despite the "backup" label this is the hostname Syntetika's own app is
  served from; the apex `api.syntetika.io` returns 404 for these routes
  (checked 2026-09-16).
- **Merkl** — `https://api.merkl.xyz/v4/opportunities?chainId=8453&identifier=<vault>`
  for the live incentive campaign rate. Read from Merkl directly (not from
  Syntetika's `/merkl/apr` proxy) so the incentive figure is independent of
  Syntetika's self-reporting — their proxy just mirrors `rewards_apy`.
- **Base RPC** — `convertToAssets(1e8)` on the vault now and ~1,296,000
  blocks (~30 days) back, via `readShareGrowth`. Set
  `BITCOINYIELD_RPC_BASE` to an archive endpoint in production.

## APY decomposition

Syntetika's `current_apr` (the app's "30D AVERAGE APR" tile) is the
realized 30-day share-price APR plus the provider-reported reward rate
(`rewards_apy`, which mirrors the Merkl campaign). Verified 2026-09-16:
`current_apr - rewards_apy` = 0.922%, and the on-chain `convertToAssets`
growth over the prior 30–31 days annualizes to 0.93–0.96%. The app's
headline "CURRENT NET APY" is `net_apy`, a since-inception compounded
figure (plus rewards), so it will read higher than the stored rate while the
vault is young. The adapter reports a 30-day APY (`rateType: "apy"`, the
site-wide standard) instead of reusing `current_apr`:

1. computes the strategy APY from on-chain `convertToAssets` growth over
   the last ~30 days, compounded; a losing window is published negative,
2. adds the **live** Merkl campaign rate, so an ended campaign contributes
   zero instead of a stale provider figure.

`current_apr` is kept in `metadata.providerCurrentApr` for comparison. No
archive read, no rate: the run fails rather than guessing.

If Merkl is unreachable or returns an unexpected shape, the adapter logs a
warning and falls back to `rewards_apy`; `metadata.rateSource` records which
path produced the stored figure. An empty Merkl campaign list is treated as
a real zero.
