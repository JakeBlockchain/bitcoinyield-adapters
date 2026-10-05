/**
 * Merlin BTC Staking adapter — on-chain reads from the staking contract on
 * Merlin chain (replaces the earlier Browserbase scrape of merlinchain.io,
 * which kept recording a completed phase's stats instead of the live one).
 *
 * TVL: getPeriodStakeAmount summed over every live period, 18 decimals.
 *      Periods overlap: the next one opens about a day before the current
 *      one ends (period 5 opened 2026-10-05 with 0 staked while period 4
 *      still held ~101 BTC), so currentPeriod() alone reads 0 at rollover.
 * APR: the contract stores apr per period (x10_000), but Merlin sets the
 *      live period's apr retroactively, so it reads 0 mid-period. Fall back
 *      to the most recent period whose apr IS set; metadata.rateSource says
 *      which. The site's "8-21%" banner and "Historical Average: 11%" are
 *      marketing copy that does not reconcile with the chain (paid APRs so
 *      far: 17, 3, 1, 1), so we deliberately do not use them.
 */

import {
  defineAdapter,
  getEvmClient,
  math,
  requirePositive,
  type EvmChainConfig,
} from "@bitcoinyield/adapters";

const STAKING_CONTRACT = "0x78F813aA474167627AcF0A0005F523e0e6D561D0";

const MERLIN: EvmChainConfig = {
  id: 4200,
  name: "Merlin",
  rpcEnv: "BITCOINYIELD_RPC_MERLIN",
  fallbackRpcs: ["https://rpc.merlinchain.io", "https://merlin.drpc.org"],
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
};

const stakingAbi = [
  {
    type: "function",
    name: "currentPeriod",
    inputs: [],
    outputs: [{ type: "uint32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPeriodStakeAmount",
    inputs: [{ name: "_period", type: "uint32" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPeriodConfig",
    inputs: [{ name: "_period", type: "uint32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "startTimestamp", type: "uint32" },
          { name: "ndays", type: "uint32" },
          { name: "endTimestamp", type: "uint32" },
          { name: "apr", type: "uint32" },
          { name: "stakeCap", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

// The contract stores apr scaled by 10_000 (170000 = 17%).
const APR_SCALE = 10_000;

export default defineAdapter({
  slug: "merlin-btc",
  name: "Merlin Chain",
  url: "https://merlinchain.io",
  category: "staking",
  custody: "multisig",
  requires: { rpc: ["merlin"] },

  async fetch() {
    const client = getEvmClient(MERLIN);

    const period = await client.readContract({
      address: STAKING_CONTRACT,
      abi: stakingAbi,
      functionName: "currentPeriod",
    });

    const readPeriod = (p: number) =>
      Promise.all([
        client.readContract({
          address: STAKING_CONTRACT,
          abi: stakingAbi,
          functionName: "getPeriodStakeAmount",
          args: [p],
        }),
        client.readContract({
          address: STAKING_CONTRACT,
          abi: stakingAbi,
          functionName: "getPeriodConfig",
          args: [p],
        }),
      ]);

    // Walk back from the current period while periods are still running.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const [currentStake, config] = await readPeriod(period);
    const livePeriods = [period];
    let stakeRaw = currentStake;
    for (let p = period - 1; p >= 0; p--) {
      const [stake, cfg] = await readPeriod(p);
      if (cfg.endTimestamp <= nowSeconds) break;
      livePeriods.push(p);
      stakeRaw += stake;
    }

    const tvlBtc = requirePositive(math.fromUnits(stakeRaw, 18), "stakeBtc");

    // Walk back to the newest period with a set apr when the live one is 0.
    let aprRaw = config.apr;
    let aprPeriod = period;
    while (aprRaw === 0 && aprPeriod > 0) {
      aprPeriod--;
      aprRaw = (
        await client.readContract({
          address: STAKING_CONTRACT,
          abi: stakingAbi,
          functionName: "getPeriodConfig",
          args: [aprPeriod],
        })
      ).apr;
    }
    const apr = requirePositive(math.div(aprRaw, APR_SCALE), "apr");

    return [
      {
        symbol: "BTC",
        tvlBtc,
        rate: apr,
        rateType: "apr",
        metadata: {
          stakingContract: STAKING_CONTRACT,
          chainId: MERLIN.id,
          period,
          livePeriods,
          periodStart: config.startTimestamp,
          periodEnd: config.endTimestamp,
          stakeCapBtc: math.fromUnits(config.stakeCap, 18),
          rateSource:
            aprPeriod === period
              ? "current-period"
              : `last-set-period-${aprPeriod}`,
        },
      },
    ];
  },
});
