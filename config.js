// Load environment variables from .env file
require('dotenv').config();

// Validate required environment variables
const requiredEnvVars = [
  'COINBASE_API_KEY_ID',
  'COINBASE_API_SECRET',
  'COINBASE_API_NICKNAME',
  'PORTFOLIO_NAME'
];

// Check for missing required environment variables
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingVars.join(', ')}`);
  console.error('Please copy .env.example to .env and fill in the required values');
  process.exit(1);
}

const coinbaseConfig = {
  apiKeyId: process.env.COINBASE_API_KEY_ID,
  apiSecret: process.env.COINBASE_API_SECRET,
  apiNickname: process.env.COINBASE_API_NICKNAME,
  portfolioName: process.env.PORTFOLIO_NAME,
  signatureAlgorithm: "ES256"
};

const tradingConfig = {
  feePercentage: parseFloat(process.env.MAKER_FEE || '0.6'),
  makerFee: parseFloat(process.env.MAKER_FEE || '0.6'),
  takerFee: parseFloat(process.env.TAKER_FEE || '1.2'),
  profitThreshold: parseFloat(process.env.PROFIT_THRESHOLD || '2.0'),
  postOnlySells: process.env.POST_ONLY_SELLS !== 'false' // Defaults to true unless explicitly set to 'false'
};

// Log configuration (without sensitive data)
console.log('Loaded configuration:');
console.log(`- Portfolio: ${coinbaseConfig.portfolioName}`);
console.log(`- Maker Fee: ${tradingConfig.makerFee}%`);
console.log(`- Taker Fee: ${tradingConfig.takerFee}%`);
console.log(`- Profit Threshold: ${tradingConfig.profitThreshold}%`);
console.log(`- Post-Only Sells: ${tradingConfig.postOnlySells}`);

module.exports = {
  coinbaseConfig,
  tradingConfig
};