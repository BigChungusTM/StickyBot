// Trailing stop configuration
export const trailingStopConfig = {
  // Trailing settings
  trailingStepPct: 0.3,             // 0.3% trailing step
  minPriceDiffToUpdate: 0.5,         // 0.5% price difference required to update order
  minProfitPct: 4.0,                // Minimum 4% profit target
  maxLimitMultiplier: 1.25,         // Max 125% of entry price
  
  // Order management
  orderCheckIntervalMs: 30000,       // Check orders every 30 seconds to prevent rate limiting
  priceUpdateIntervalMs: 1000,       // Update prices every second
  
  // Technical analysis periods (for future use)
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  rsiPeriod: 14,
  bbPeriod: 20,
  bbStdDev: 2,
  volumePeriod: 20,
  recentHighsPeriod: 10,
  
  // Risk management
  maxConsecutiveTrails: 20,          // Maximum number of times to trail an order
  cooldownPeriodMs: 30000,           // 30 sec cooldown after trail
  momentumThreshold: 0.5,            // Minimum momentum score (0-1) required to trail
  minProfitPercent: 1.0,             // Minimum profit percentage before trailing starts
  
  // Logging
  enableDebugLogs: true,
  logFilePath: './trailing_stop_logs.json',
  
  // Order settings
  productId: 'SYRUP-USDC',
  orderType: 'limit',
  postOnly: true
};

export default trailingStopConfig;
