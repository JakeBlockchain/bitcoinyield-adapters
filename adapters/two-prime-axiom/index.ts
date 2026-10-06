import { defineAdapter, ethereum, http } from "@bitcoinyield/adapters";
import {
  DASHBOARD,
  SNAPSHOT_URL,
  STRATEGY,
  VAULT,
  strategyAbi,
  vaultAbi,
} from "./constants.js";
import { buildResult } from "./result.js";
import { parseSnapshot } from "./snapshot.js";

export default defineAdapter({
  slug: "two-prime-axiom",
  name: "Two Prime Axiom WBTC Yield",
  url: DASHBOARD,
  category: "lending",
  custody: "custodial",
  requires: { rpc: ["ethereum"] },

  async fetch() {
    const client = ethereum.getClient();
    const [block, data] = await Promise.all([
      client.getBlock(),
      http.get<unknown>(SNAPSHOT_URL),
    ]);
    // All contract observations refer to one block, independent of the daily API snapshot.
    const [
      contractValue,
      token,
      tranche,
      strategy,
      managementFee,
      performanceFee,
      feeScale,
      defaulted,
      isEpochRunning,
      epochEnd,
      grossApr,
    ] = await client.multicall({
      blockNumber: block.number,
      allowFailure: false,
      contracts: [
        { address: VAULT, abi: vaultAbi, functionName: "getContractValue" },
        { address: VAULT, abi: vaultAbi, functionName: "token" },
        { address: VAULT, abi: vaultAbi, functionName: "AATranche" },
        { address: VAULT, abi: vaultAbi, functionName: "strategy" },
        { address: VAULT, abi: vaultAbi, functionName: "managementFee" },
        { address: VAULT, abi: vaultAbi, functionName: "fee" },
        { address: VAULT, abi: vaultAbi, functionName: "FULL_ALLOC" },
        { address: VAULT, abi: vaultAbi, functionName: "defaulted" },
        { address: VAULT, abi: vaultAbi, functionName: "isEpochRunning" },
        { address: VAULT, abi: vaultAbi, functionName: "epochEndDate" },
        { address: STRATEGY, abi: strategyAbi, functionName: "unscaledApr" },
      ],
    });

    return [
      buildResult(parseSnapshot(data), {
        blockNumber: block.number,
        timestamp: block.timestamp,
        contractValue,
        token,
        tranche,
        strategy,
        managementFee,
        performanceFee,
        feeScale,
        defaulted,
        isEpochRunning,
        epochEnd,
        grossApr,
      }),
    ];
  },
});
