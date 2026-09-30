# Lombard Finance

Adapter for core LBTC, distinct from Lombard Bitcoin Earn. Its headline rate matches the provider-reported **30-day net APY** on [Lombard's transparency dashboard](https://www.lombard.finance/transparency/lbtc/).

## Data sources

- **APY:** `GET https://api.lombard.finance/v2/transparency/reports/latest`, field `report.apy`. The API returns a decimal string; multiply by 100 for the framework's percentage-valued `rate`, with `rateType: "apy"`. For example, the September 28, 2026 report returned `"0.003624889635897219"`, or **0.3624889635897219% APY**. This is a dated observation, not a constant or target.
- **TVL:** Ethereum LBTC `0x8236a87084f8B84306f72007F36F2618A5634494`, `totalSupply()` multiplied by `getRate()` (BTC per LBTC, 18 decimals). This remains **Ethereum-circulating LBTC backing only**, not protocol-wide backing. Token decimals and exchange-rate decimals are distinct.
- **Diagnostics:** 7-day and 30-day archive `getRate()` growth remain in `apy7d`, `apy30d`, `linearApr7d`, and `linearApr30d`, including negative values. Actual windows are recorded in `onchainWindowDays7d` and `onchainWindowDays30d`. Missing archive baselines produce null diagnostics and no longer prevent a valid reported APY from being returned.
- **BTC price:** the framework's shared price feed.

The headline carries `rateBasis: "provider-reported-net"`, `rateWindow: "30d"`, and the endpoint in `rateSource`. Metadata preserves the source decimal, report ID, `as_of`, `created_at`, and retrieval time. Missing/malformed APY, invalid/future timestamps, or reports older than 72 hours fail loudly; no target, legacy estimated-APY, or on-chain-growth fallback is used. The 72-hour limit is an adapter freshness policy allowing delayed daily publication.

A genuine reported zero sets `allowZeroRate`. Negative reported APYs are returned unchanged, **not floored**, and the pipeline stores them (APY rows may go down to -100%).

## Interpretation

The provider's APY and independently calculated exchange-rate growth are different measures. On September 28, the published APY was positive while trailing exchange-rate growth was negative. Their methodology remains unreconciled; the provider quote must not be described as independently verified on-chain holder return. The 2.5% deployment target remains informational metadata only. Net fees are not deducted again.

The legacy `/api/v1/analytics/estimated-apy` endpoint is not the dashboard source. APY history is available at `/v2/transparency/series/apy?start_time=<RFC3339>&end_time=<RFC3339>`. Report `lbtc_ratio` is inverse-direction LBTC per BTC, scaled by 1e18; it is not used for the headline rate.

## Required environment and cost

`BITCOINYIELD_RPC_ETHEREUM` selects an Ethereum RPC; an archive-capable endpoint is needed only for diagnostic history. Each run makes one transparency HTTP request, a current multicall (supply, decimals, rate), two share-growth probes (current/historical block and rate reads), and a shared cached BTC-price lookup. There are no API credentials or database writes in the adapter.
