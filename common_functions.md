# SyrupBot Common Functions Reference

## Core Trading Functions

### `SyrupTradingBot.constructor(config = {})`
Initializes the trading bot with configuration and sets up initial state.
- **Parameters**:
  - `config`: Object containing trading configuration (optional)
- **Initializes**:
  - Trading pair (default: 'SYRUP-USDC')
  - Account balances
  - Candle data
  - Technical indicators

### `async initialize()`
Sets up the trading bot by loading accounts, candle data, and indicators.
- **Loads**:
  - Account balances
  - Historical candle data
  - Technical indicators
- **Throws**: Error if initialization fails

### `async startTradingCycle()`
Main trading loop that runs continuously, updating data and making trading decisions.
- **Cycle**:
  1. Fetches latest candle data
  2. Updates technical indicators
  3. Evaluates trading signals
  4. Executes trades based on signals
  5. Waits for the next cycle

## Order Management

### `async placeBuyOrder(price, type = 'INITIAL')`
Places a market buy order.
- **Parameters**:
  - `price`: Target price for the order
  - `type`: Order type ('INITIAL', 'DCA', or 'CONFIRMED')
- **Returns**: Order response object or null if failed
- **Side Effects**:
  - Updates position tracking
  - Logs the trade
  - Sends Telegram notification

### `async placeLimitSellOrder(buyPrice, amount)`
Places a limit sell order after a successful buy.
- **Parameters**:
  - `buyPrice`: Purchase price (used to calculate target sell price)
  - `amount`: Quantity to sell
- **Returns**: Order response or null if failed
- **Side Effects**:
  - Updates position tracking
  - Logs the sale
  - Sends Telegram notification

## Technical Analysis

### `calculateIndicators()`
Calculates technical indicators based on recent candle data.
- **Calculates**:
  - RSI (Relative Strength Index)
  - MACD (Moving Average Convergence Divergence)
  - Bollinger Bands
  - EMAs (Exponential Moving Averages)
  - Stochastic Oscillator
- **Updates**: `this.indicators` with latest values

### `calculateBuyScore()`
Scores potential buy opportunities based on technical conditions.
- **Scores (0-21 points)**:
  - Technical conditions (0-8 points)
  - Price dip (0-3 points)
  - 24h low proximity (0-10 points)
- **Returns**: Total score and breakdown

## Data Management

### `async fetchCandleData()`
Fetches latest candle data from the exchange.
- **Updates**: `this.candles` with latest price data
- **Handles**:
  - Rate limiting
  - Data gaps
  - Connection errors

### `async updateHourlyCandles(force = false)`
Updates the hourly candle cache for 24h low calculations.
- **Parameters**:
  - `force`: Force update even if not due (default: false)
- **Updates**: `this.hourlyCandles`

## Position Management

### `async getAccountBalances()`
Fetches current account balances for all currencies.
- **Updates**: `this.accounts` with current balances
- **Returns**: Object containing currency balances

### `updateBuySignalAfterOrder(price, amount, orderResponse)`
Updates the active buy signal after a successful order.
- **Parameters**:
  - `price`: Execution price
  - `amount`: Filled amount
  - `orderResponse`: Exchange order response
- **Updates**: Position tracking and signal state

## Telegram Integration

### `TelegramService.sendMessage(chatId, message, options = {})`
Sends a message via Telegram.
- **Parameters**:
  - `chatId`: Target chat ID
  - `message`: Message text
  - `options`: Message options (parse_mode, etc.)
- **Returns**: Boolean indicating success

### `TelegramService.setupCommands(tradingBot)`
Sets up Telegram command handlers.
- **Parameters**:
  - `tradingBot`: Instance of the trading bot
- **Commands**:
  - `/start`: Bot introduction
  - `/status`: Current bot status
  - `/balance`: Account balances
  - `/pause`: Pause trading (admin)
  - `/resume`: Resume trading (admin)

## Helper Functions

### `formatPrice(price, currency = 'USDC')`
Formats a price with appropriate currency symbol and decimal places.
- **Parameters**:
  - `price`: Price to format
  - `currency`: Currency code (default: 'USDC')
- **Returns**: Formatted price string

### `logTrade(type, price, amount, metadata = {})`
Logs trade details to console and file.
- **Parameters**:
  - `type`: Trade type (e.g., 'BUY', 'SELL')
  - `price`: Execution price
  - `amount`: Trade amount
  - `metadata`: Additional trade details
- **Side Effects**:
  - Writes to trade log
  - Sends Telegram notification

## Error Handling

### `handleApiError(error, context = '')`
Standardized error handling for API calls.
- **Parameters**:
  - `error`: Error object
  - `context`: Context for error message
- **Returns**: Formatted error message
- **Side Effects**: Logs error details

## Configuration

### Default Configuration
```javascript
{
  tradingPair: 'SYRUP-USDC',
  baseCurrency: 'SYRUP',
  quoteCurrency: 'USDC',
  currencySymbol: '$',
  // ... other configuration options
}
```

## Environment Variables
- `COINBASE_API_KEY_ID`: Coinbase API key
- `COINBASE_API_SECRET`: Coinbase API secret
- `COINBASE_API_NICKNAME`: API key nickname
- `TELEGRAM_BOT_TOKEN`: Telegram bot token
- `TELEGRAM_CHAT_ID`: Target chat ID for notifications
- `TELEGRAM_ADMIN_USERNAME`: Admin username for restricted commands
- `TELEGRAM_NOTIFICATIONS_ENABLED`: Enable/disable notifications (true/false)
