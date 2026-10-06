import { parseAbi } from "viem";

export const VAULT = "0x338e0a8008364a4d5139cB49E00e93bDb51290d6";
export const LP_TOKEN = "0xD1624bb76743dd8dC8D8043246e7338A5CD23772";
export const STRATEGY = "0x74E862277B5BEC233E2f1b0272CE1e215462507a";
export const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
export const DEPOSIT_QUEUE = "0x2Cd361544a3647Ab16A983cA2576f084abEA80D0";
export const VAULT_ID = "6aa2b5dacbaa03cb8d7bf0b7";
export const DASHBOARD = `https://app.pareto.credit/vault/${LP_TOKEN}`;
export const SNAPSHOT_URL = `https://api.pareto.credit/v1/public/vault-latest-blocks?limit=1&offset=0&order=desc&vaultId=${VAULT_ID}`;

export const vaultAbi = parseAbi([
  "function getContractValue() view returns (uint256)",
  "function token() view returns (address)",
  "function AATranche() view returns (address)",
  "function strategy() view returns (address)",
  "function managementFee() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function FULL_ALLOC() view returns (uint256)",
  "function defaulted() view returns (bool)",
  "function isEpochRunning() view returns (bool)",
  "function epochEndDate() view returns (uint256)",
]);
export const strategyAbi = parseAbi([
  "function unscaledApr() view returns (uint256)",
]);
