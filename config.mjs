// Coinbase API Configuration
export const coinbaseConfig = {
  apiKeyId: process.env.COINBASE_API_KEY || "organizations/7f995056-3045-44b3-9fe8-a27623b69d14/apiKeys/2ec4c104-317a-4a1f-8778-e12541fc2b37",
  apiSecret: process.env.COINBASE_API_SECRET || "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIAGUaBwZuFhy+eXDG583O3YnTv6FseR9gRlsDx1TxGwyoAoGCCqGSM49\nAwEHoUQDQgAEnKWJQtORST4l/3Byp1twxuMj0gTD73cT8CRUORb6MwqQHGGXv8Rq\nADIUfphR6nJ/ImK+O6+rIr81/H7kkHoKdQ==\n-----END EC PRIVATE KEY-----\n",
  apiNickname: process.env.COINBASE_API_NICKNAME || "tradjo",
  portfolioName: process.env.COINBASE_PORTFOLIO_NAME || "Tradjo",
  signatureAlgorithm: "ES256"
};

// Trading Configuration
export const tradingConfig = {
  feePercentage: parseFloat(process.env.FEE_PERCENTAGE) || 0.6, // Default trading fee percentage (maker fee, as percent)
  makerFee: parseFloat(process.env.MAKER_FEE) || 0.6,      // Maker fee (as percent)
  takerFee: parseFloat(process.env.TAKER_FEE) || 1.2,      // Taker fee (as percent)
  profitThreshold: parseFloat(process.env.PROFIT_THRESHOLD) || 2.0, // Default minimum profit threshold (%)
  postOnlySells: (process.env.POST_ONLY_SELLS || 'true').toLowerCase() === 'true' // Use post-only (maker) limit orders for sells
};

// Trading Pair Configuration
export const pairConfig = {
  tradingPair: process.env.TRADING_PAIR || 'SYRUP-USDC',
  baseCurrency: process.env.BASE_CURRENCY || 'SYRUP',
  quoteCurrency: process.env.QUOTE_CURRENCY || 'USDC',
  currencySymbol: '$'
};
