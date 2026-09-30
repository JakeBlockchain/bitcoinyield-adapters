# Kraken Bitcoin Earn

Adapter for [Kraken Bitcoin Earn](https://www.kraken.com/earn) — Kraken's
custodial BTC yield product, implemented as a BoringVault on Ink L2
(Kraken's own chain, id 57073).

## Data sources

- **TVL**: `vault.totalSupply()` × `accountant.getRate()` — shares
  outstanding times BTC-per-share rate, both read on-chain.
  - BoringVault: `0x7Dee0120739b7ec048B469939EFB178ADbbB19B2`
  - Accountant: `0x4Bb6C416a00561ad6657110b76552c42d55Ff1d6`
- **APY** (`rateType: "apy"`): 30-day compounded growth of `getRate()` (via
  `readShareGrowth`), the site-wide APY standard. The rate is net of fees
  and compounds into the share price, so a losing window is published
  negative. Kraken's public Dune dashboard shows a 7D window instead.
  Requires an archive read at ~2,592,000 blocks back (Ink ≈ 1 block/sec).
- **BTC price**: framework's `prices.getBtc()` (CoinGecko, cached).

## Required environment

- `BITCOINYIELD_RPC_INK` — dedicated Ink RPC. Falls back to public
  endpoints (`rpc-gel.inkonchain.com`, drpc); without archive support the
  run fails rather than storing a guessed rate.

## Cost estimate

~7 RPC reads per hour (3 current-state reads, plus readShareGrowth's two
block headers and two rate reads) and one cached BTC price fetch. Free tier
on any provider covers this.
