# Midas mHyperBTC

Tracks [Midas mHyperBTC](https://midas.app/mhyperbtc), a BTC-denominated tokenized certificate managed by Hyperithm. Investors hold an ERC-20; return accrues through NAV rather than a separate reward token.

## Data sources

Official Midas registry: [`config/constants/addresses.ts`](https://github.com/midas-apps/contracts/blob/main/config/constants/addresses.ts)

### Ethereum mainnet (headline)

| Role             | Address                                      |
| ---------------- | -------------------------------------------- |
| Token            | `0xC8495EAFf71D3A563b906295fCF2f685b1783085` |
| Data feed        | `0xb75B82b2012138815d1A2c4aB5B8b987da043157` |
| Custom feed      | `0x3359921992C33ef23169193a6C91F2944A82517C` |
| Deposit vault    | `0xeD22A9861C6eDd4f1292aeAb1E44661D5f3FE65e` |
| Redemption vault | `0x16d4f955B0aA1b1570Fe3e9bB2f8c19C407cdb67` |
| LayerZero OFT    | `0xb67f81069e890A1b3e02c7BED3A9f78bA54A445C` |

### Other official deployments

These are recorded in adapter metadata and are not added into headline TVL yet.

| Network   | Role             | Address                                      |
| --------- | ---------------- | -------------------------------------------- |
| Rootstock | Native token     | `0x7F71f02aE0945364F658860d67dbc10c86Ca3a3C` |
| Rootstock | Data feed        | `0xE1d9eF8784F0feDcf4e30105Aa17448AcBE7F367` |
| Rootstock | Deposit vault    | `0x82Dd60B6e3f1f3Db025a715952B0e9f96B7D7a53` |
| Rootstock | Redemption vault | `0x4F4da20f45Ce2c94e84B93e4D73f3F3F33b8B570` |
| Monad     | LayerZero token  | `0xF7Cf282eC810fDed974F99c0163E792f432892BC` |
| Monad     | Data feed        | `0xf91288dC7F33e6f4aD3B62090A86b8978B48b01c` |
| Monad     | OFT              | `0xe9977b9B22Ed2C19DCd68D0403163EFcd45bF874` |

Midas wires mHyperBTC as a direct-only LayerZero pathway from Ethereum to Monad. Rootstock is a separate native deployment with its own issuance and redemption contracts.

## TVL

```text
tvlBtc = token.totalSupply() * dataFeed.getDataInBase18() / 1e18
```

`getDataInBase18()` is the official Midas NAV, scaled to 18 decimals. The adapter reads token decimals on-chain instead of assuming 18.

Headline TVL is Ethereum-only. That matches the issuance home and avoids mixing Rootstock's native book or assuming LayerZero burn/mint accounting before those supplies are verified.

Live Ethereum check on 2026-08-19: `totalSupply = 287.005370386145`, `NAV = 1.02455304` BTC per token, so `tvlBtc ≈ 294.05`. RWA.xyz still screens `7D APY = 2.05%` and `30D APY = 2.75%`; its Ethereum supply snapshot on that page lagged the live contract by about `0.69` tokens.

## APY

Headline `rate` (`rateType: "apy"`) is the 30-day compounded NAV APY, the site-wide APY standard (RWA.xyz labels the same window `30D APY`).

```text
growth = navNow / nav30dAgo
apy30d = (growth ^ (365 / actualElapsedDays) - 1) * 100
```

The adapter also stores the 7-day compounded APY in metadata. If the RPC cannot serve the 30-day historical read, it falls back to the 7-day window (`metadata.rateWindow` says which). If both fail, the adapter throws instead of writing `rate = 0`.

The strategy is actively managed, so a trailing NAV window can legitimately go negative, and is published as-is. A frozen NAV feed reading exactly 0 growth still fails loudly in normalize.

## Environment

```bash
BITCOINYIELD_RPC_ETHEREUM=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
```

Archive or reasonably deep history is required for the 30-day and 7-day NAV windows. Public fallbacks may fail the historical reads.

## Cost estimate

About 8 JSON-RPC calls per hour:

- 1 multicall for `totalSupply`, `decimals`, and `getDataInBase18`
- latest block
- 30-day historical NAV + block
- 7-day historical NAV + block
