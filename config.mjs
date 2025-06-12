// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
  'COINBASE_API_KEY',
  'COINBASE_API_SECRET',
  'COINBASE_API_NICKNAME',
  'COINBASE_PORTFOLIO_NAME'
];

// Check for missing required environment variables
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error(`❌ Error: Missing required environment variables: ${missingVars.join(', ')}`);
  console.error('Please create a .env file with the required values');
  process.exit(1);
}

// Coinbase API Configuration
export const coinbaseConfig = {
  apiKeyId: process.env.COINBASE_API_KEY,
  apiSecret: process.env.COINBASE_API_SECRET,
  apiNickname: process.env.COINBASE_API_NICKNAME,
  portfolioName: process.env.COINBASE_PORTFOLIO_NAME,
  signatureAlgorithm: "ES256"
};

// Trading Configuration
export const tradingConfig = {
  feePercentage: parseFloat(process.env.FEE_PERCENTAGE || '0.6'),
  makerFee: parseFloat(process.env.MAKER_FEE || '0.6'),
  takerFee: parseFloat(process.env.TAKER_FEE || '1.2'),
  profitThreshold: parseFloat(process.env.PROFIT_THRESHOLD || '2.0'),
  postOnlySells: (process.env.POST_ONLY_SELLS || 'true').toLowerCase() === 'true'
};

// Trading Pair Configuration
export const pairConfig = {
  tradingPair: process.env.TRADING_PAIR || 'SYRUP-USDC',
  baseCurrency: process.env.BASE_CURRENCY || 'SYRUP',
  quoteCurrency: process.env.QUOTE_CURRENCY || 'USDC',
  currencySymbol: '$'
};

// Log configuration (without sensitive data)
console.log('✅ Loaded configuration:');
console.log(`- Portfolio: ${coinbaseConfig.portfolioName}`);
console.log(`- Trading Pair: ${pairConfig.tradingPair}`);
console.log(`- Maker Fee: ${tradingConfig.makerFee}%`);
console.log(`- Taker Fee: ${tradingConfig.takerFee}%`);
console.log(`- Profit Threshold: ${tradingConfig.profitThreshold}%`);
console.log(`- Post-Only Sells: ${tradingConfig.postOnlySells}`);
