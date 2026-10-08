// E2E fixture chain only. It reuses Portaldot V3 EVM chain ID so the UI chain checks
// behave as on testnet; it is NOT Portaldot and results are never live evidence.
module.exports = {
  networks: {
    hardhat: {
      chainId: 420420777,
      hardfork: "cancun",
      mining: { auto: true },
      accounts: { count: 3 },
    },
  },
};
