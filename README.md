# 🍯 SyrupBot Trading System

**Note:** This is a high-frequency trading bot specifically designed for the SYRUP-USDC trading pair on Coinbase Advanced Trade. The bot uses a sophisticated 21-point scoring system with 2-candle confirmation to identify high-probability trading opportunities.

## 🆕 Recent Updates
- **2024-06-13**: Enhanced Telegram integration with improved error handling and logging
- **2024-06-13**: Fixed chat ID handling for Telegram notifications
- **2024-06-13**: Added comprehensive function documentation in `common_functions.md`
- **2024-06-13**: Improved error handling for order placement and execution
- **2024-06-12**: Updated sell profit target to 4% (from 3.5%)

## Overview
SyrupBot is an advanced automated cryptocurrency trading bot focused on the SYRUP-USDC trading pair. The bot uses a sophisticated scoring system combining technical indicators, dip detection, and 24-hour low proximity to identify high-probability trading opportunities. It executes trades through the Coinbase Advanced Trade API.

## ✨ Key Features
- **Real-time Data**
  - 1-minute candle data collection and caching (60-minute rolling window)
  - 24-hour hourly candle tracking for accurate 24h low calculation
  - Precise system clock-aligned trading cycles (minute + 500ms)

- **Technical Analysis**
  - Comprehensive indicators (RSI, MACD, Bollinger Bands, Stochastics, EMA)
  - Advanced 21-point scoring system (8 tech + 3 dip + 10 24h low)
  - 2-candle confirmation system with price-based decay
  - 24-hour low proximity scoring for optimal entry timing

- **Trading Features**
  - Automatic position management with DCA support (max 3 attempts)
  - Limit sell orders with 4% profit target (GTC orders)
  - Manual trade detection and position synchronization
  - Persistent position tracking across restarts

- **Monitoring & Alerts**
  - Real-time Telegram notifications for trades and errors
  - Detailed logging and trade history
  - System status monitoring and alerts
  - Public-safe command interface via Telegram

## Installation

### Prerequisites
- Node.js (v14 or later)
- npm (comes with Node.js)
- Coinbase Advanced Trade API credentials

### Windows
1. Clone the repository:
   ```
   git clone https://github.com/yourusername/StickyBot.git
   cd StickyBot
   ```
2. Run the installer:
   ```
   install.bat
   ```
3. Edit the `.env` file with your configuration
4. Start the bot:
   ```
   start.bat
   ```

### Linux/macOS
1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/StickyBot.git
   cd StickyBot
   ```
2. Make the scripts executable:
   ```bash
   chmod +x install.sh start.sh
   ```
3. Run the installer:
   ```bash
   ./install.sh
   ```
4. Edit the `.env` file with your configuration
5. Start the bot:
   ```bash
   ./start.sh
   ```

## 📚 Documentation

### 🎯 21-Point Scoring System

SyrupBot uses a sophisticated 21-point scoring system to evaluate buy signals, combining multiple technical and fundamental factors:

#### 1. Technical Score (0-10 points, 47.6% weight)
- **RSI (2 points)**: 
  - 2 points if RSI < 35
  - 1 point if RSI < 45
  - 0.5 points if RSI < 50
- **MACD (2 points)**:
  - 1 point if MACD histogram is positive
  - 1 point if MACD line is above signal line
- **Bollinger Bands (2 points)**:
  - 1 point if price is below lower band
  - 1 point if price is in lower 30% of bands
- **EMA (2 points)**:
  - 1 point if price > EMA20
  - 1 point if EMA20 > EMA50
- **Volume (2 points)**:
  - 1 point if volume > 1.3x 20-period average
  - 1 point if volume is increasing for 2+ periods

#### 2. Dip Score (0-5 points, 23.8% weight)
- **60-Minute High (0-5 points)**:
  - 5 points: >4% below 60m high
  - 4 points: 3-4% below
  - 3 points: 2-3% below
  - 2 points: 1-2% below
  - 1 point: 0.5-1% below
  - 0 points: <0.5% below

#### 3. Blended Score (0-3 points, 14.3% weight)
- **24h Low + 60m High Blend (0-3 points)**:
  - 50/50 weighted average of 24h low and 60m high scores
  - Scaled to 0-3 point range
  - Example: (24h_low_score * 0.5) + (60m_high_score * 0.5) * 0.3

#### 4. Conditions Bonus (0-3 points, 14.3% weight)
- **CEX-Specific Conditions**:
  - 1 point: RSI in optimal range (40-70)
  - 1 point: MACD showing improvement
  - 1 point: Price above 24h VWAP

#### Buy Signal Threshold
- **Minimum Score**: 12/21 points (55%) required for buy consideration
- **Ideal Entry**: 15+ points for higher probability trades
- **Max Score**: 21 points (all conditions met)

### CEX Trading Suitability
- **Market Hours**: Optimized for 24/7 CEX trading
- **Liquidity**: Designed for liquid pairs with tight spreads
- **Order Types**: Supports limit and market orders
- **Fees**: Accounts for taker/maker fee structure
- **Slippage**: Minimized through smart order routing

For detailed documentation of all functions and their usage, see [COMMON_FUNCTIONS.md](common_functions.md).

## 🏗️ Core Components

### 1. Candle Management
- `fetchInitialCandles()`: Fetches the initial set of 60 candles (1 hour of 1-minute candles)
- `fetchCandleData()`: Fetches new candle data on each cycle
- `updateHourlyCandles()`: Maintains 24-hour candle history for low calculations
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
- `placeLimitSellOrder()`: Places limit sell orders with 4% profit target
- `updateBuySignalAfterOrder()`: Updates position tracking after successful orders
- `checkForManualBuys()`: Detects and accounts for manual trades

### 4. Trading Cycle
- `startTradingCycle()`: Main trading loop
- `tradingLoop()`: Core trading logic and timing
- `checkAndExecuteTrades()`: Evaluates market conditions and executes trades
- `logTradeCycle()`: Logs current market state and trading decisions
- `waitForNextMinute()`: Ensures precise timing of trading cycles

## 🔧 Configuration

### Environment Variables
Create a `.env` file with the following variables:
```
# Coinbase API Configuration
COINBASE_API_KEY_ID=your_api_key_id
COINBASE_API_SECRET=your_api_secret
COINBASE_API_NICKNAME=your_nickname

# Trading Configuration
TRADING_PAIR=SYRUP-USDC
BASE_CURRENCY=SYRUP
QUOTE_CURRENCY=USDC

# Telegram Configuration
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_ADMIN_USERNAME=your_telegram_username
TELEGRAM_NOTIFICATIONS_ENABLED=true
```

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
  
  // 24h average low scoring configuration - points based on % above/below 24h average low
  // Scores range from 0-10 with 0.5% increments from -5% to +5%
  low24hScoreRanges: [
    { maxPercent: -5.0, score: 10 },   // -5% or below 24h avg low: 10 points
    { maxPercent: -4.5, score: 9.5 },  // -4.5% to -5%: 9.5 points
    { maxPercent: -4.0, score: 9 },    // -4% to -4.5%: 9 points
    { maxPercent: -3.5, score: 8.5 },  // -3.5% to -4%: 8.5 points
    { maxPercent: -3.0, score: 8 },    // -3% to -3.5%: 8 points
    { maxPercent: -2.5, score: 7.5 },  // -2.5% to -3%: 7.5 points
    { maxPercent: -2.0, score: 7 },    // -2% to -2.5%: 7 points
    { maxPercent: -1.5, score: 6.5 },  // -1.5% to -2%: 6.5 points
    { maxPercent: -1.0, score: 6 },    // -1% to -1.5%: 6 points
    { maxPercent: -0.5, score: 5.5 },  // -0.5% to -1%: 5.5 points
    { maxPercent: 0.0, score: 5 },     // 0% to -0.5%: 5 points
    { maxPercent: 0.5, score: 4.5 },   // 0% to 0.5%: 4.5 points
    { maxPercent: 1.0, score: 4 },     // 0.5% to 1%: 4 points
    { maxPercent: 1.5, score: 3.5 },   // 1% to 1.5%: 3.5 points
    { maxPercent: 2.0, score: 3 },     // 1.5% to 2%: 3 points
    { maxPercent: 2.5, score: 2.5 },   // 2% to 2.5%: 2.5 points
    { maxPercent: 3.0, score: 2 },     // 2.5% to 3%: 2 points
    { maxPercent: 3.5, score: 1.5 },   // 3% to 3.5%: 1.5 points
    { maxPercent: 4.0, score: 1 },     // 3.5% to 4%: 1 point
    { maxPercent: 4.5, score: 0.5 },   // 4% to 4.5%: 0.5 points
    { maxPercent: 5.0, score: 0.1 },   // 4.5% to 5%: 0.1 points (min score)
    { maxPercent: Infinity, score: 0 } // >5% above 24h avg low: 0 points
  ]
}
```

## API Reference

This project includes API reference documentation from the `coinbase-api` NPM package in the `refdocs` directory. These documents provide detailed information about the available API endpoints and their usage.

### Available Reference Documents
- `coinbase.service.md`: Documentation for the Coinbase service wrapper
- `rest-client.md`: REST client implementation details
- `types.md`: TypeScript type definitions
- `websocket-client.md`: WebSocket client documentation

These reference documents are automatically generated from the `coinbase-api` package and can be useful when:
- Implementing new API calls
- Debugging API-related issues
- Understanding the available methods and their parameters
- Working with WebSocket connections

## License

This project is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for details.

## Donations

If you find this project useful and would like to support its development, please consider making a donation:

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://www.paypal.com/donate/?business=jolardy%40hotmail.co.uk&no_recurring=0&item_name=Support+SyrupBot+Development&currency_code=USD)

Your support helps keep this project maintained and improved!

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
   The bot calculates a 24-hour average low using hourly candles from the past 24 hours. If hourly data is unavailable, it falls back to using 1-minute candles. The score is based on how close the current price is to this 24h average low, with more granular scoring at 0.5% increments. The system awards higher scores when the price is at or below the 24h average low.

   - 10 points: -5% or below 24h average low
   - 9.5 points: -4.5% to -5% below
   - 9 points: -4% to -4.5% below
   - 8.5 points: -3.5% to -4% below
   - 8 points: -3% to -3.5% below
   - 7.5 points: -2.5% to -3% below
   - 7 points: -2% to -2.5% below
   - 6.5 points: -1.5% to -2% below
   - 6 points: -1% to -1.5% below
   - 5.5 points: -0.5% to -1% below
   - 5 points: 0% to -0.5% below
   - 4.5 points: 0% to 0.5% above
   - 4 points: 0.5% to 1% above
   - 3.5 points: 1% to 1.5% above
   - 3 points: 1.5% to 2% above
   - 2.5 points: 2% to 2.5% above
   - 2 points: 2.5% to 3% above
   - 1.5 points: 3% to 3.5% above
   - 1 point: 3.5% to 4% above
   - 0.5 points: 4% to 4.5% above
   - 0.1 points: 4.5% to 5% above
   - 0 points: >5% above 24h average low
   
   The scoring uses a dynamic range-based system that can be configured in `buyConfig.low24hScoreRanges`. The system calculates the percentage difference between the current price and the 24h average low, then assigns a score based on the configured ranges.

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