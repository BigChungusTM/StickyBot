// Trailing stop configuration
export const trailingStopConfig = {
  // Core trailing settings
  initialTargetPct: 2.5,            // Initial 2.5% target
  trailTriggerPct: 1.0,             // Start trailing when 1% above target
  trailStepPct: 0.2,                // Trail in 0.2% increments
  maxTrailPct: 5.0,                 // Max 5% target (double initial)
  minHoldTimeMs: 300000,            // 5min minimum hold before trailing
  
  // Exit strategy configuration
  maxDrawdownPct: 1.5,              // Stop trailing if price drops 1.5% from high
  maxTrailDurationMs: 1800000,      // Stop trailing after 30 minutes max
  momentumExitThreshold: -0.3,      // Exit if momentum score drops below -0.3
  consecutiveDownMoves: 3,          // Exit after 3 consecutive price drops
  volumeDropThreshold: 0.4,         // Exit if volume drops 40% from trail start
  
  // Order management
  orderCheckIntervalMs: 30000,      // Check orders every 30 seconds
  updateCooldownMs: 30000,          // 30s between order updates
  maxConsecutiveTrails: 20,         // Maximum number of times to trail an order
  
  // Technical analysis
  volatilityThreshold: 0.5,         // When to be more/less aggressive
  volatilityLookback: 20,           // Number of candles for volatility calculation
  
  // Logging
  enableDebugLogs: true,
  logFilePath: './trailing_stop_logs.json',
  
  // Order settings
  productId: 'SYRUP-USDC',
  orderType: 'limit',
  postOnly: true,
  timeInForce: 'GTC'               // Good-Til-Cancelled
};

export default trailingStopConfig;
