# Stacking DAO stBTC

Liquid sBTC staking on Stacks. stBTC is an 8-decimal share token backed by sBTC held in a reserve and deployed through protocol bonds. This adapter covers **stBTC only**, not stSTX, stSTXbtc, native STX staking, or protocol-wide TVL.

## On-chain accounting

Mainnet deployer: `SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG`.

- **TVL:** `stbtc-reserve.get-total-sbtc`, in satoshis. The deployed function adds reserve sBTC balance to staked principal. This is the gross sBTC figure displayed as **stBTC TVL** by the Stacking DAO analytics page. Do not use the app's protocol-wide USD TVL or stBTC token supply as BTC TVL.
- **Withdrawal liabilities:** `stbtc-reserve.get-sbtc-for-withdrawals`. Gross TVL includes these; metadata separately reports active backing after subtracting reserved withdrawals.
- **Shares:** `stbtc-token.get-total-supply` and `data-stbtc-v1.get-pending-shares`. Active share supply excludes pending withdrawal shares.
- **Current exchange rate:** `data-stbtc-v1.get-sbtc-per-stbtc`, scaled by `1e8`. It is reconciled with active backing / active shares within 1 ppm to allow minor latest-state read drift.

The adapter's primary metrics are contract reads. It does not use the Stacking DAO APY endpoint.

## Trailing 30-day APY

The `rate` field carries a **trailing compounded APY**, explicitly labelled with `rateType: "apy"`. The value is derived from the on-chain exchange-rate change:

```text
APY = 100 × ((current_sBTC_per_stBTC / historical_sBTC_per_stBTC)
             ^ (365 days / elapsed seconds) − 1)
```

The historical rate is reconstructed at the Stacks block nearest 30 days before the latest block:

1. Hiro's Stacks block API identifies the two block timestamps and the exact cutoff height.
2. Hiro's historical reserve balance (`balances?until_block=`) supplies idle sBTC at the cutoff.
3. Hiro's deployed contract print-event streams supply post-cutoff deltas for deposits, withdrawals, pending shares, staked principal, and withdrawal reserves.
4. Those deltas are applied backward from the current on-chain reads. The reconstructed historical active backing / active share supply must reconcile before APY is calculated.

Metadata records the current and historical block heights/times, both exchange rates, the actual window length, event counts, and the reconstruction method. This makes the APY independently reproducible from Stacks mainnet data rather than a server-reported outline or target rate.

## Observed compounding / reward-credit cadence

The deployed `rewards-pox5-v1.process-rewards` function streams rewards by Bitcoin burn-block height and transfers released sBTC to `stbtc-reserve` when executed. Its release window is **2,100 Bitcoin blocks**. That does not prove automatic execution every block: calls may be direct keeper calls or nested calls during deposits and other activity.

The adapter inspects the latest **50 reserve asset events**, selects up to **20 unique transactions** containing positive sBTC transfers from `rewards-pox5-v1` to `stbtc-reserve`, uses Hiro's bulk transaction lookup, then checks transaction success, canonical status, and confirmation time. Metadata contains:

- most recent confirmed credit time and transaction ID;
- credit count, median inter-credit interval, and sample start/span;
- bounded sample definition and history truncation flag;
- the 2,100-block stream window.

This is **observed reward-credit cadence**, not a fixed compounding promise, full-history event count, or proof that every credit is immediately reinvested into a new bond. Missing history is marked `unavailable` with null observations and an error without suppressing valid primary metrics.

## Verification — October 14, 2026

The live adapter run reconciled gross TVL and the current exchange rate with the Stacking DAO app's public analytics data. At the observed block, the reconstructed trailing APY was approximately **1.59%**; the app's separate `api/apy` value is not used because it is a protocol estimate rather than a transparent trailing on-chain measurement.

TVL/APY are dynamic observations, not hardcoded values.

## Tests and cost

No new dependencies or secrets. Uses existing `stacks`, `http`, and decimal-safe `math` helpers.

```sh
pnpm exec tsx --test adapters/stacking-dao-stbtc/index.test.ts
RUN_LIVE_STBTC=1 pnpm exec tsx --test adapters/stacking-dao-stbtc/live.test.ts
pnpm build
pnpm test stacking-dao-stbtc
pnpm validate stacking-dao-stbtc
```

The primary path performs six read-only contract calls, a latest-block read, a small block search for the 30-day cutoff, two paginated contract-event streams, and one historical balance read. The optional compounding observation adds one asset-event read and one bulk transaction read. Normalization may additionally fetch the shared BTC price. Primary-source failures throw rather than persist zero or a stale fallback.

Custody is recorded as `multisig`: sBTC is pooled in smart contracts with DAO-controlled permissions and payout routes. Exposure includes the sBTC bridge/signers, Stacks contracts, bond liquidity, and protocol administration.
