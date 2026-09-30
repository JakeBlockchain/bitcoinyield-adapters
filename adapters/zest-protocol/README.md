# Zest Protocol

Adapter for [Zest Protocol](https://zestprotocol.com), a Bitcoin lending market built on Stacks. Users supply sBTC and earn yield from both Zest's on-chain lending APY and the underlying sBTC's Stacks-cycle stacking yield.

## Data sources

- **TVL**: sum of sBTC balances held by Zest's vault contracts (`pool-vault` and `v0-vault-sbtc`) on Stacks, fetched via Hiro's REST API. Converted from satoshis (8 decimals) to BTC.
- **Supply APY**: read directly from the `v0-rates` Clarity contract (`get-rates-sbtc` function) on Stacks.
- **Stacking APR**: `next_cycle_max_defi_apr` from DegenLab's dual-stacking server. Forward-looking value — what new depositors will earn on the next cycle (post-halving-aware).
- **BTC price**: framework's `prices.getBtc()`. sBTC is treated as BTC 1:1 for USD valuation.

## Total APR

```
total_apy = supply_apy + stacking_apr
```

## File structure

- `index.ts` — adapter entry, wires everything together
- `vaults.ts` — fetches + sums sBTC balances across vaults
- `rates.ts` — fetches supply APY (on-chain) + stacking APR (HTTP)
- `constants.ts` — addresses + token identifiers

This split is purely for readability — the framework treats it as one adapter (only `index.ts` matters; the framework's loader follows the default export).

## Required environment

None for the public Hiro API + DegenLab API. Optionally:

- `BITCOINYIELD_STACKS_API` — override Hiro's base URL (default `https://api.hiro.so`)

## Cost estimate

~5 requests per hour:

- 2 Hiro REST calls (one per vault)
- 1 Hiro RPC call (read-only contract)
- 1 HTTP call to DegenLab
- 1 BTC price (cached across all adapters)
