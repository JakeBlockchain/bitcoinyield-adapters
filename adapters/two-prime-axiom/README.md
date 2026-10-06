# Two Prime Axiom WBTC Yield

WBTC-denominated institutional lending through Pareto on Ethereum. Lenders receive
pAXIOMBTC. Underlying lending/custody is off chain; the reported 150 WBTC first-loss
protection is a legal agreement, not an additional on-chain reserve to add to TVL.
Redemptions follow the facility's cycle and eligibility requirements.

## Sources and semantics

- **TVL:** the vault's `getContractValue()`, divided by 10^8. This is recorded
  WBTC credit NAV, not WBTC cash in the contract. No strategy-token double counting,
  queued deposits, other Pareto vaults, or first-loss pledge is added.
- **Headline:** Pareto's published `APRs.NET`, with `rateType: "apr"`.
  It is the quoted current lending rate net of management and performance fees,
  not a trailing payout or realized return. `rateWindow: "current-loan-terms"`
  makes the lack of a trailing window explicit. No APY-to-APR conversion occurs.
- **Projected APY:** Pareto's `APYs.NET` is kept in `metadata.projectedNetApy`.
  It assumes compounding and is not the repository's trailing 30-day realized APY.
- **Rate checks:** current `unscaledApr()`, `managementFee()`, `fee()` and
  `FULL_ALLOC()` must agree with the API. Net APR is checked against
  `(gross APR - annual management fee) * (1 - performance fee / 100)`.
  Use `unscaledApr()`: `getApr()` adjusts for the epoch/buffer and would overstate
  the calendar-year rate if used directly.
- **USD:** left to the framework's canonical BTC price; it can differ from
  Pareto's older USD valuation. WBTC is treated as BTC-denominated exposure.

The [public rate endpoint](https://api.pareto.credit/v1/public/vault-latest-blocks?limit=1&offset=0&order=desc&vaultId=6aa2b5dacbaa03cb8d7bf0b7)
works without authentication. The frontend `/api` gateway may reject server calls;
use `api.pareto.credit` directly. Transport uses the shared HTTP retries/timeouts.

## Contract addresses

| Role                   | Ethereum address                             |
| ---------------------- | -------------------------------------------- |
| Vault                  | `0x338e0a8008364a4d5139cB49E00e93bDb51290d6` |
| LP / dashboard ID      | `0xD1624bb76743dd8dC8D8043246e7338A5CD23772` |
| Strategy               | `0x74E862277B5BEC233E2f1b0272CE1e215462507a` |
| Queue (reference only) | `0x2Cd361544a3647Ab16A983cA2576f084abEA80D0` |
| WBTC                   | `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599` |

All chain reads are pinned to one block. Token, LP and strategy identities are
checked. Reverted reads, defaulted vaults, bad/missing data or a mismatch between
API and chain terms fail the run instead of persisting a fabricated zero.
An explicitly published zero net APR is accepted only when chain terms match.

## Update cadence and freshness

On October 6, 2026, the [public snapshot history](https://api.pareto.credit/v1/public/vault-blocks?limit=100&offset=0&vaultId=6aa2b5dacbaa03cb8d7bf0b7)
contained 39 observations, including 26 daily snapshots from September 11 through
October 6 at approximately **00:10 UTC**, plus intra-day updates around activity.
This is an observed reporting cadence, not a service-level guarantee or independent
daily attestation of off-chain custody. The LP price stayed unchanged during the
first running cycle and changed at its October 2 settlement; a daily snapshot does
not imply daily price discovery or daily payment.

The adapter rejects a rate snapshot older than 48 hours using its **block time**,
not its fetch time or rewritten `updatedAt`. Current NAV and daily rate-source
timestamps/block numbers are stored separately. The framework can poll hourly
without representing every poll as a new borrower attestation.

## Verified baseline (October 6, 2026)

- API block 26,129,661; independent chain block 26,135,938.
- NAV: **150.11975626 WBTC**.
- Gross APR **1.85%**, management fee **0.25% annually**, performance fee **0%**.
- Published net APR **1.60%**; projected net APY **1.61168729%**.
- Pareto's **$12,842,209** TVL reflects its $85,546.426401 WBTC price, not the
  canonical BTC price used by this framework.

## Environment, cost and validation

Optional `BITCOINYIELD_RPC_ETHEREUM`; otherwise the shared public fallbacks apply.
No archive RPC, wallet, API key, database driver or new dependency is required.
Per run: one latest-block RPC, one multicall (11 view reads), one public HTTP
snapshot, plus the framework's shared price lookup.

```sh
pnpm exec tsx --test tests/two-prime-axiom.test.ts
pnpm cli test two-prime-axiom
pnpm cli validate two-prime-axiom
```

These verify data ingestion, not the borrower's off-chain asset value, solvency,
legal first-loss enforceability or realized cash repayment.
