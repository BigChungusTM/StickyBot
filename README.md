# SyrupBot Trading System
Please Note: This is 100% Vibe Coded. There is a current task list with changes that is updated in planning steps that shows where current functionality sits.

## Overview
SyrupBot is an advanced automated cryptocurrency trading bot focused on the SYRUP-USDC trading pair. The bot uses a sophisticated scoring system combining technical indicators, dip detection, and 24-hour low proximity to identify high-probability trading opportunities. It executes trades through the Coinbase Advanced Trade API.

## Key Features
- Real-time 1-minute candle data collection and caching (60-minute rolling window)
- 24-hour hourly candle tracking for accurate 24h low calculation
- Comprehensive technical analysis (RSI, MACD, Bollinger Bands, Stochastics, EMA)
- Advanced 21-point scoring system (8 tech + 3 dip + 10 24h low)
- 2-candle confirmation system with price-based decay
- 24-hour low proximity scoring for optimal entry timing
- Automatic position management with DCA support (max 3 attempts)
- Limit sell orders with 3.5% profit target (GTC orders)
- Manual trade detection and position synchronization
- Persistent position tracking across restarts
- Detailed logging and trade history
- Precise system clock-aligned trading cycles (minute + 500ms)

## Core Components

### 1. Candle Management
- `fetchInitialCandles()`: Fetches the initial set of 60 candles (1 hour of 1-minute candles)
- `fetchCandleData()`: Fetches new candle data on each cycle
- `backfillMissingCandles()`: Handles missing or incomplete candle data
- `saveCandlesToCache()`: Persists candle data to disk

### 2. Technical Analysis & Signal Generation
- `calculateIndicators()`: Computes all technical indicators using the most recent candle data
- `calculateBuyScore()`: Scores potential buys (0-8 points) based on technical conditions:
  - RSI position and momentum
  - Stochastic crossovers and position
  - MACD histogram and signal line
  - Price position relative to EMA(20)
  - Price position within Bollinger Bands
- `calculateDipScore()`: Scores price dips (0-3 points) based on distance from 60-minute high
- `calculate24hLowScore()`: Scores (0-10 points) based on proximity to 24-hour low
- `evaluateBuySignal()`: Combines technical, dip, and 24h low scores (21 points total) to generate buy signals
- `getTwoCandleConfirmation()`: Manages the 2-candle confirmation system with price-based decay

### 3. Order Execution
- `placeBuyOrder()`: Executes market buy orders
- `placeLimitSellOrder()`: Places limit sell orders with 3.5% profit target
- `updateBuySignalAfterOrder()`: Updates position tracking after successful orders
- `checkForManualBuys()`: Detects and accounts for manual trades

### 4. Trading Cycle
- `startTradingCycle()`: Main trading loop
- `checkAndExecuteTrades()`: Evaluates market conditions and executes trades
- `logTradeCycle()`: Logs current market state and trading decisions

## Configuration

### Buy Signal Configuration
```javascript
buyConfig: {
  minScore: 11,               // Minimum score (out of 21) to consider a buy
  rsiOversold: 30,           // RSI threshold for oversold conditions
  rsiOverbought: 70,         // RSI threshold for overbought conditions
  stochOversold: 20,         // Stochastic %K threshold for oversold
  stochOverbought: 80,       // Stochastic %K threshold for overbought
  bbPeriod: 20,              // Bollinger Bands period
  bbStdDev: 2,               // Bollinger Bands standard deviations
  emaFastPeriod: 9,          // Fast EMA period (9)
  emaSlowPeriod: 21,         // Slow EMA period (21)
  emaVerySlowPeriod: 200,    // Very slow EMA period (200)
  macdFastPeriod: 12,        // MACD fast period
  macdSlowPeriod: 26,        // MACD slow period
  macdSignalPeriod: 9,       // MACD signal period
  stochPeriod: 14,           // Stochastic %K period
  stochKPeriod: 3,           // Stochastic %K smoothing
  stochDPeriod: 3,           // Stochastic %D smoothing
  minDipPercent: 1.5,        // Minimum dip percentage for scoring
  maxDipPercent: 4.0,        // Maximum dip percentage for scoring
  minPositionSize: 7,        // Minimum position size in USDC
  positionSizePercent: 20,   // Percentage of available balance to use per buy
  maxDollarCostAveraging: 3, // Maximum DCA attempts per signal
  sellProfitTarget: 0.035,   // 3.5% profit target for limit sells
  
  // 24h low scoring configuration
  low24hScoreRanges: [
    { maxPercent: 1.0, score: 10 },   // 0-1% above 24h low
    { maxPercent: 2.0, score: 8 },    // 1-2% above 24h low
    { maxPercent: 3.0, score: 6 },    // 2-3% above 24h low
    { maxPercent: 4.0, score: 4 },    // 3-4% above 24h low
    { maxPercent: 5.0, score: 2 },    // 4-5% above 24h low
    { maxPercent: Infinity, score: 0 } // >5% above 24h low
  ]
}
```

## Trading Strategy

### Buy Signal Generation (21-point System)

1. **Technical Analysis (8 points total)**
   - RSI: 1.5 points if <30, 0.5 points if <45
   - Stochastics: 0.5 points if K <20, 1 point if K crosses above D in oversold
   - MACD: 1 point if histogram is positive and rising
   - EMA: 1 point if price > EMA(20)
   - Bollinger Bands: 2 points if price < lower band, 1 point if near lower band
   - Volume: 1 point if above average volume
   - Trend: 1 point if EMAs in bullish alignment (9 > 21 > 200)
   - Momentum: 0.5 points if RSI rising

2. **Dip Score (3 points total)**
   - 0.5 points: 1.0-1.5% below 60-min high
   - 1.0 points: 1.5-2.0% below 60-min high
   - 1.5 points: 2.0-2.5% below 60-min high
   - 2.0 points: 2.5-3.0% below 60-min high
   - 2.5 points: 3.0-3.5% below 60-min high
   - 3.0 points: >3.5% below 60-min high

3. **24h Low Proximity (10 points total)**
   - 10 points: 0-1% above 24h low
   - 8 points: 1-2% above 24h low
   - 6 points: 2-3% above 24h low
   - 4 points: 3-4% above 24h low
   - 2 points: 4-5% above 24h low
   - 0 points: >5% above 24h low

4. **Confirmation System**
   - Requires 2/2 confirmations to trigger a buy
   - Confirmation decays by 0.5 if price increases
   - Confirmation increases by 1.0 if price decreases
   - No confirmation change if price movement is <0.25%
   - Confirmation capped at 2.0 (triggers buy)
   - Buy executed when confirmation reaches 2.0
   - Confirmation resets to 1.0 after buy to allow for DCA

5. **Minimum Score Requirements**
   - Total score must be ≥11/21 to consider a buy
   - Technical score must be ≥1/8
   - 24h low score must be ≥1/10

### Position Management
- **Buys**
  - Market orders for immediate execution
  - Position size: 20% of available USDC balance
  - Maximum 3 DCA attempts per signal
  - Minimum position size: 7 USDC

- **Sells**
  - Limit sell orders with 3.5% profit target
  - Good-Til-Canceled (GTC) orders
  - Only sells the specific bought amount
  - Tracks each sell order separately

- **Position Tracking**
  - Maintains average entry price
  - Tracks total position size
  - Detects and incorporates manual trades
  - Persists position data between restarts
  - Syncs with actual account balances

- **Risk Management**
  - 1-minute cooldown between buys
  - Maximum 3 DCA attempts per signal
  - Position size limited to 20% of balance
  - Stops buying if price increases >0.5% from signal

## Logging

### Log Files
- `logs/combined.log`: Combined log output
- `logs/error.log`: Error messages only
- `logs/trades.log`: Trade execution details
- `candle_cache.json`: Cached candle data

### Log Format
Each trade cycle logs:
- Current price and 24h change
- Technical indicator values
- Buy signal score and status
- Position information
- Order execution details

## Error Handling
The bot includes comprehensive error handling for:
- API rate limits
- Network connectivity issues
- Invalid market data
- Order execution failures
- Position tracking inconsistencies

## Security
- API keys are stored in environment variables
- Sensitive operations require confirmation
- All API requests are authenticated and encrypted

## Dependencies
- Node.js 16+
- coinbase-api
- winston (logging)
- technicalindicators (TA library)
- dotenv (environment variables)

## Setup
1. Install dependencies: `npm install`
2. Create `.env` file with your Coinbase API credentials
3. Run the bot: `node syrupBot.js`

## Monitoring
The bot provides real-time console output with:
- Current market conditions
- Indicator values
- Signal generation
- Order execution details

## Troubleshooting
Common issues and solutions:
- **No trades executing**: Check API keys and account balance
- **Missing candles**: Verify network connectivity and API rate limits
- **Invalid orders**: Ensure sufficient balance and correct trading pair
- **Position tracking issues**: Check trade history and account balance

## License
Proprietary - All rights reserved
