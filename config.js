const coinbaseConfig = {
  apiKeyId: "organizations/7f995056-3045-44b3-9fe8-a27623b69d14/apiKeys/2ec4c104-317a-4a1f-8778-e12541fc2b37",
  apiSecret: "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIAGUaBwZuFhy+eXDG583O3YnTv6FseR9gRlsDx1TxGwyoAoGCCqGSM49\nAwEHoUQDQgAEnKWJQtORST4l/3Byp1twxuMj0gTD73cT8CRUORb6MwqQHGGXv8Rq\nADIUfphR6nJ/ImK+O6+rIr81/H7kkHoKdQ==\n-----END EC PRIVATE KEY-----\n",
  apiNickname: "tradjo",
  portfolioName: "Tradjo",
  signatureAlgorithm: "ES256"
};

const tradingConfig = {
  feePercentage: 0.6, // Default trading fee percentage (maker fee, as percent)
  makerFee: 0.6,      // Maker fee (as percent)
  takerFee: 1.2,      // Taker fee (as percent)
  profitThreshold: 2.0, // Default minimum profit threshold (%)
  postOnlySells: true // Use post-only (maker) limit orders for sells
};

module.exports = {
  coinbaseConfig,
  tradingConfig
};