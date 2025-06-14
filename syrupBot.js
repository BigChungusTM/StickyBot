import { CBAdvancedTradeClient } from 'coinbase-api';
import dotenv from 'dotenv';
import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import axios from 'axios';
import { coinbaseService } from './coinbase.service.js';
import { telegramService } from './telegram.service.js';
import { 
  SMA, EMA, RSI, Stochastic, BollingerBands, MACD 
} from 'technicalindicators';
import { setTimeout as sleep } from 'timers/promises';

// Timestamp utility functions
const parseTimestamp = (timestamp) => {
  if (timestamp === undefined || timestamp === null) {
    logger.warn('Received undefined or null timestamp');
    return null;
  }
  
  try {
    // If it's already a number, assume it's a Unix timestamp
    if (typeof timestamp === 'number') {
      // If it's in milliseconds, convert to seconds
      return timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp;
    }
    
    // If it's a string that can be parsed as a number
    if (typeof timestamp === 'string') {
      // Check if it's a numeric string
      if (/^\d+$/.test(timestamp)) {
        const num = parseInt(timestamp, 10);
        return num > 1e12 ? Math.floor(num / 1000) : num;
      }
      
      // Handle ISO 8601 format with timezone
      if (timestamp.includes('T') && timestamp.includes('Z')) {
        const date = new Date(timestamp);
        if (!isNaN(date.getTime())) {
          return Math.floor(date.getTime() / 1000);
        }
      }
      
      // Handle other date string formats
      const date = new Date(timestamp);
      if (!isNaN(date.getTime())) {
        return Math.floor(date.getTime() / 1000);
      }
    }
    
    // If it's an object with getTime method (Date object)
    if (typeof timestamp === 'object' && typeof timestamp.getTime === 'function') {
      return Math.floor(timestamp.getTime() / 1000);
    }
    
    logger.warn('Could not parse timestamp:', { 
      timestamp, 
      type: typeof timestamp,
      constructor: timestamp?.constructor?.name 
    });
    return null;
  } catch (error) {
    logger.error('Error parsing timestamp:', { 
      timestamp, 
      error: error.message,
      stack: error.stack 
    });
    return null;
  }
};

// Process and validate a single candle
const processCandle = (candle) => {
  try {
    if (!candle) {
      logger.warn('Skipping null/undefined candle');
      return null;
    }

    // Handle different candle formats
    let candleData;
    if (candle.candle) {
      // Format: { candle: { ... }, timestamp: 'ISO string' }
      candleData = {
        ...candle.candle,
        time: candle.timestamp || candle.candle.time
      };
    } else if (candle.start) {
      // Format: { start: timestamp, open: ..., high: ..., low: ..., close: ..., volume: ... }
      candleData = {
        ...candle,
        time: candle.start
      };
    } else {
      // Assume direct candle format
      candleData = { ...candle };
    }

    // Validate required fields
    const requiredFields = ['time', 'open', 'high', 'low', 'close', 'volume'];
    for (const field of requiredFields) {
      if (candleData[field] === undefined) {
        logger.warn(`Skipping candle with missing field: ${field}`, { candle });
        return null;
      }
    }

    // Parse timestamp (handle both seconds and milliseconds)
    const time = parseTimestamp(candleData.time);
    if (isNaN(time) || time <= 0) {
      logger.warn('Skipping candle with invalid timestamp:', { 
        time: candleData.time,
        parsedTime: time,
        type: typeof candleData.time
      });
      return null;
    }

    // Convert all numeric fields to numbers
    const numericFields = ['open', 'high', 'low', 'close', 'volume'];
    const processedCandle = { time };
    
    for (const field of numericFields) {
      const value = parseFloat(candleData[field]);
      if (isNaN(value) || value < 0) {
        logger.warn(`Skipping candle with invalid ${field}:`, { 
          field, 
          value: candleData[field],
          type: typeof candleData[field]
        });
        return null;
      }
      processedCandle[field] = value;
    }

    return processedCandle;
  } catch (error) {
    logger.error('Error processing candle:', error, { 
      candle: JSON.stringify(candle).substring(0, 200) 
    });
    return null;
  }
};

// Format timestamp for display
const formatTimestamp = (timestamp) => {
  if (!timestamp) return 'N/A';
  // Convert from seconds to milliseconds if needed
  const date = new Date(timestamp * 1000);
  return date.toISOString();
};

// Get directory name in ES module
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const CACHE_FILE = path.join(scriptDir, 'candle_cache.json');
const HOURLY_CACHE_FILE = path.join(scriptDir, 'hourly_candle_cache.json');
const MAX_CANDLES = 10080; // 1 week of 1-minute candles (60*24*7)
const MAX_HOURLY_CANDLES = 24; // 24 hours of hourly candles

// Load environment variables
dotenv.config();

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure logs directory exists
const logsDir = path.join(scriptDir, 'logs');
if (!fsSync.existsSync(logsDir)) {
  fsSync.mkdirSync(logsDir, { recursive: true });
}

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    // Console transport - filter out verbose logs
    new winston.transports.Console({
      level: 'warn', // Only show warnings and errors by default
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
        winston.format((info) => {
          // Filter out verbose logs from console
          const filteredMessages = [
            'TRADE_CYCLE',
            'TRADE_EXECUTED',
            'Updating hourly candles',
            'Fetching candles for',
            'Trying Advanced Trade API',
            'Advanced Trade API Params',
            'Got candles using',
            'Skipping hourly candle update',
            'Hourly candle update already in progress'
          ];
          
          if (filteredMessages.some(msg => info.message && info.message.includes && info.message.includes(msg))) {
            return false;
          }
          return info;
        })()
      )
    }),
    // Daily file transport for all logs
    new winston.transports.File({
      filename: path.join(logsDir, 'syrup-bot-combined.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 7, // Keep 7 days of logs
      tailable: true,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    }),
    // Separate file for trade cycle data
    new winston.transports.File({
      filename: path.join(logsDir, 'trade-cycle.log'),
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, message, ...meta }) => {
          return `${timestamp} - ${message}`;
        })
      ),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 30, // Keep 30 days of trade cycle logs
    }),
    // File transport for all logs including debug
    new winston.transports.File({
      filename: path.join(logsDir, 'syrup-bot-debug.log'),
      level: 'debug',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    })
  ]
});

// Configuration with environment variable fallbacks
const config = {
  apiKey: process.env.COINBASE_API_KEY || '',
  apiSecret: process.env.COINBASE_API_SECRET || '',
  tradingPair: process.env.TRADING_PAIR || 'SYRUP-USDC',
  baseCurrency: process.env.BASE_CURRENCY || 'SYRUP',
  quoteCurrency: process.env.QUOTE_CURRENCY || 'USDC',
  currencySymbol: '$',
  candleInterval: 'ONE_MINUTE',
  candleLimit: 60, // 60 minutes of 1-minute candles
  maxCacheSize: MAX_CANDLES,
  cacheFile: CACHE_FILE,
  // Technical indicator periods
  indicators: {
    ema: { period: parseInt(process.env.EMA_PERIOD, 10) || 20 },
    rsi: { period: parseInt(process.env.RSI_PERIOD, 10) || 14 },
    stoch: { period: parseInt(process.env.STOCH_PERIOD, 10) || 14, signal: parseInt(process.env.STOCH_SIGNAL, 10) || 3, kPeriod: parseInt(process.env.STOCH_K_PERIOD, 10) || 3 },
    bb: { period: parseInt(process.env.BB_PERIOD, 10) || 20, stdDev: parseInt(process.env.BB_STD_DEV, 10) || 2 },
    macd: { 
      fastPeriod: parseInt(process.env.MACD_FAST_PERIOD, 10) || 12, 
      slowPeriod: parseInt(process.env.MACD_SLOW_PERIOD, 10) || 26, 
      signalPeriod: parseInt(process.env.MACD_SIGNAL_PERIOD, 10) || 9 
    }
  }
};

// Log trading configuration
console.log('=== Trading Configuration ===');
console.log(`Trading Pair: ${config.tradingPair}`);
console.log(`Base Currency: ${config.baseCurrency}`);
console.log(`Quote Currency: ${config.quoteCurrency}`);
console.log(`Currency Symbol: ${config.currencySymbol}`);
console.log(`Candle Interval: ${config.candleInterval}`);
console.log(`Candle Limit: ${config.candleLimit}`);
console.log(`Max Cache Size: ${config.maxCacheSize}`);
console.log(`Cache File: ${config.cacheFile}`);
console.log(`Indicators:`);
console.log(`  EMA Period: ${config.indicators.ema.period}`);
console.log(`  RSI Period: ${config.indicators.rsi.period}`);
console.log(`  Stochastic Period: ${config.indicators.stoch.period}`);
console.log(`  Stochastic Signal: ${config.indicators.stoch.signal}`);
console.log(`  Stochastic K Period: ${config.indicators.stoch.kPeriod}`);
console.log(`  Bollinger Bands Period: ${config.indicators.bb.period}`);
console.log(`  Bollinger Bands Std Dev: ${config.indicators.bb.stdDev}`);
console.log(`  MACD Fast Period: ${config.indicators.macd.fastPeriod}`);
console.log(`  MACD Slow Period: ${config.indicators.macd.slowPeriod}`);
console.log(`  MACD Signal Period: ${config.indicators.macd.signalPeriod}`);
console.log('=== Environment Variables ===');
console.log('NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('COINBASE_API_KEY_ID:', process.env.COINBASE_API_KEY_ID ? '*** (set)' : 'not set');
console.log('COINBASE_API_SECRET:', process.env.COINBASE_API_SECRET ? '*** (set)' : 'not set');
console.log('COINBASE_API_NICKNAME:', process.env.COINBASE_API_NICKNAME || 'not set');
console.log('TRADING_PAIR:', process.env.TRADING_PAIR || 'not set');

// Initialize Coinbase Advanced Trade client
let client;
try {
  client = new CBAdvancedTradeClient(
    {
      // API credentials from environment variables
      apiKey: process.env.COINBASE_API_KEY_ID || '',
      apiSecret: process.env.COINBASE_API_SECRET || '',
      // Add API nickname if needed
      apiNickname: process.env.COINBASE_API_NICKNAME || 'SYRUP-Bot',
      // Optional: Set to true to use the sandbox environment
      // sandbox: process.env.NODE_ENV !== 'production',
      // Add debug logging
      logger: {
        info: console.log,
        error: console.error,
        debug: console.debug,
        warn: console.warn
      }
    },
    {
      // Optional: Axios request config
      timeout: 10000, // Increased timeout to 10 seconds
      headers: {
        'User-Agent': 'SYRUP-USDC-Trader/1.0',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    }
  );
  console.log('Coinbase API client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Coinbase API client:', error.message);
  process.exit(1);
}

class SyrupTradingBot {
  constructor(config = {}) {
    // Initialize config with defaults
    this.config = {
      tradingPair: 'SYRUP-USDC',
      baseCurrency: 'SYRUP',
      quoteCurrency: 'USDC',
      currencySymbol: '$',
      ...config // Override defaults with provided config
    };
    
    // Track active limit orders
    this.activeLimitOrders = new Map();
    
    this.processedConfirmations = new Set(); // Track processed confirmations
    this.client = client;
    this.coinbaseService = coinbaseService; // Initialize coinbaseService
    this.telegramService = telegramService; // Initialize telegramService
    
    // Initialize Telegram command handlers if Telegram is enabled
    if (this.telegramService.enabled) {
      this.setupTelegramCommands();
    }
    
    this.tradingPair = this.config.tradingPair;
    this.baseCurrency = this.config.baseCurrency;
    this.quoteCurrency = this.config.quoteCurrency;
    this.currencySymbol = this.config.currencySymbol;
    this.accounts = {};
    this.candles = [];
    this.hourlyCandles = []; // Store hourly candles for 24h low calculation
    this.lastHourlyCandleUpdate = 0;
    this.indicators = {};
    this.isRunning = false;
    this._isFetching = false;
    this._isBackfilling = false;
    this._lastFetchTime = 0;
    
    // Buy scoring configuration
    this.buyConfig = {
      minScore: 11,  // Minimum score out of 21 to consider a buy (7 tech + 3 dip + 11 24h low)
      rsiOversold: 30,
      rsiOverbought: 70,
      stochOversold: 20,
      stochOverbought: 80,
      bbPeriod: 20,
      bbStdDev: 2,
      emaFastPeriod: 9,
      emaSlowPeriod: 21,
      emaVerySlowPeriod: 200,
      macdFastPeriod: 12,
      macdSlowPeriod: 26,
      macdSignalPeriod: 9,
      stochPeriod: 14,
      stochKPeriod: 3,
      stochDPeriod: 3,
      volumeSpikeMultiplier: 1.5,
      minDipPercent: 1.5,  // 1.5% below 60-min high
      maxDipPercent: 4.0,  // 4% below 60-min high
      minPositionSize: 7,     // Minimum position size in quote currency (7 USDC)
      positionSizePercent: 20, // Percentage of available balance to use per buy
      maxDollarCostAveraging: 3, // Maximum number of times to DCA into a position
      profitTargetPercent: 4.0,  // 4% profit target for limit sells
      // 24h low scoring configuration - points based on % above/below 24h average low
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
    };
    
    // Track buy signals for 2-candle confirmation
    this.pendingBuySignals = [];
    this.lastBuyScore = 0;
    
    // Track active buy signal state
    this.activeBuySignal = {
      isActive: false,          // Whether there's an active buy signal
      signalPrice: null,        // Price when signal was first triggered
      signalTime: null,         // Timestamp when signal was first triggered
      confirmations: 0,         // Number of confirmations received
      lastConfirmationTime: null, // Timestamp of last confirmation
      totalInvested: 0,         // Total amount of quote currency invested
      totalQuantity: 0,         // Total quantity of base currency bought
      averagePrice: 0,          // Weighted average price of all buys
      buyCount: 0,              // Number of buy orders placed for this signal
      lastBuyPrice: 0,          // Price of the last buy order
      orderIds: []              // Array of order IDs for this signal
    };
    
    // Track all trades for P&L calculation
    this.tradeHistory = [];
    
    // Track the last buy time to prevent rapid consecutive buys
    this.lastBuyTime = 0;
    this.buyCooldown = 60 * 1000; // 1 minute cooldown between buys
  }

  async loadAccounts() {
    try {
      // Load actual balances from the exchange
      const balances = await this.getAccountBalances();
      
      // Initialize accounts object with default values
      this.accounts = {
        [this.baseCurrency]: { available: '0', balance: '0', hold: '0' },
        [this.quoteCurrency]: { available: '0', balance: '0', hold: '0' }
      };
      
      // Update accounts with actual balances if available
      for (const [currency, balance] of Object.entries(balances)) {
        if (this.accounts[currency]) {
          this.accounts[currency] = {
            ...this.accounts[currency],
            ...balance
          };
        }
      }
      
      return this.accounts;
      
    } catch (error) {
      console.error('Error loading accounts:', error.message);
      this.isRunning = false;
      throw error; // Re-throw to be handled by the caller
    }
  }

  async getAccountBalances() {
    try {
      const accounts = await this.client.rest.account.listAccounts();
      this.accounts = accounts.reduce((acc, account) => ({
        ...acc,
        [account.currency]: account
      }), {});
      return this.accounts;
    } catch (error) {
      console.error('Error fetching account balances:', error);
      throw error;
    }
  }

  /**
   * Get formatted account balances for display
   * @returns {Promise<string>} Formatted balance string
   */
  async getFormattedBalances() {
    try {
      const accounts = await this.getAccountBalances();
      const baseBalance = accounts[this.baseCurrency]?.available || '0.0';
      const quoteBalance = accounts[this.quoteCurrency]?.available || '0.0';
      
      return `💰 *Account Balances* \n` +
             `${this.baseCurrency}: *${parseFloat(baseBalance).toFixed(2)}*\n` +
             `${this.quoteCurrency}: *${parseFloat(quoteBalance).toFixed(2)}*`;
    } catch (error) {
      console.error('Error getting formatted balances:', error);
      return '❌ Error fetching account balances. Please try again later.';
    }
  }

  /**
   * Get formatted list of open orders for display in Telegram
   * @returns {Promise<string>} Formatted open orders string or null if no orders
   */
  async getFormattedOpenOrders() {
    try {
      // Get open orders from Coinbase service
      const openOrders = await this.coinbaseService.getOpenOrders();
      
      // If no open orders, return null to show a different message
      if (!openOrders || openOrders.length === 0) {
        return null;
      }
      
      // Format each order
      const formattedOrders = [];
      
      for (let i = 0; i < openOrders.length; i++) {
        try {
          const order = openOrders[i];
          const orderType = order.side === 'SELL' ? '🟢 Sell' : '🔵 Buy';
          
          // Extract order details from the nested structure
          const orderConfig = order.order_configuration?.limit_limit_gtc || {};
          
          // Parse numeric values with proper error handling
          const size = parseFloat(orderConfig.base_size || '0') || 0;
          const filled = parseFloat(order.filled_size || '0') || 0;
          const remaining = Math.max(0, size - filled); // Ensure non-negative
          const price = parseFloat(orderConfig.limit_price || '0') || 0;
          
          console.log(`\n=== Processing order ${i + 1} ===`);
          console.log('Order ID:', order.order_id);
          console.log('Size:', size, 'Filled:', filled, 'Remaining:', remaining);
          console.log('Price:', price, 'Type:', orderType);
          
          // Calculate filled percentage safely
          let filledPct = 0;
          if (size > 0) {
            filledPct = Math.min(100, Math.max(0, (filled / size) * 100)); // Clamp between 0-100
          }
          
          // Format values according to requirements
          const formattedSize = remaining.toFixed(1); // XX.X format for SYRUP
          const formattedPrice = price.toFixed(4);    // X.XXXX format for USDC
          const orderValue = remaining * price;
          const formattedValue = orderValue >= 0.01 ? orderValue.toFixed(2) : '<0.01'; // Handle very small values
          
          // Format the order line
          const orderLines = [
            `\n${i + 1}. ${orderType} ${formattedSize} ${this.baseCurrency} @ ${formattedPrice} ${this.quoteCurrency}`,
            `   Status: ${order.status || 'UNKNOWN'} (${filledPct.toFixed(1)}% filled)`,
            `   Value: ${formattedValue} ${this.quoteCurrency}`,
            `   Created: ${new Date(order.created_time).toLocaleString()}`
          ];
          
          // Add order ID if available
          if (order.order_id && order.order_id !== 'N/A') {
            orderLines.push(`   Order ID: ${order.order_id}`);
          }
          
          formattedOrders.push(orderLines.join('\n'));
          
        } catch (err) {
          console.error(`Error formatting order ${i + 1}:`, err);
          // Skip this order but continue with others
          continue;
        }
      }
      
      // If we couldn't format any orders, return null
      if (formattedOrders.length === 0) {
        console.error('No valid orders could be formatted');
        return null;
      }
      
      // Combine all orders into a single message
      const header = `📋 *Open Orders (${formattedOrders.length})*`;
      const message = [header, ...formattedOrders].join('\n');
      
      // Ensure the message isn't too long for Telegram (max 4096 chars)
      const MAX_MESSAGE_LENGTH = 4000; // Leave some room for the header
      return message.length > MAX_MESSAGE_LENGTH 
        ? message.substring(0, MAX_MESSAGE_LENGTH) + '... (truncated)'
        : message;
      
    } catch (error) {
      console.error('Error getting open orders:', error);
      return '❌ Error fetching open orders. Please try again later.';
    }
  }

  async initialize() {
    // Prevent multiple initializations
    if (this._isInitializing) {
      logger.warn('Initialization already in progress, skipping duplicate initialize');
      return false;
    }
    
    this._isInitializing = true;
    
    try {
      console.log('\n=== Initializing SYRUP-USDC Trading Bot ===\n');
      
      // Load accounts and log balances immediately
      console.log('Loading account balances...');
      await this.loadAccounts();
      
      // Force immediate display of account balances with proper formatting
      const baseBalance = parseFloat(this.accounts[this.baseCurrency]?.balance || 0);
      const baseAvailable = parseFloat(this.accounts[this.baseCurrency]?.available || 0);
      const quoteBalance = parseFloat(this.accounts[this.quoteCurrency]?.balance || 0);
      const quoteAvailable = parseFloat(this.accounts[this.quoteCurrency]?.available || 0);
      
      console.log('\n=== ACCOUNT BALANCES ===');
      console.log(`${this.baseCurrency.padEnd(8)}: ${this.formatPrice(baseBalance, this.baseCurrency)} (Available: ${this.formatPrice(baseAvailable, this.baseCurrency)})`);
      console.log(`${this.quoteCurrency.padEnd(8)}: ${this.formatPrice(quoteBalance, this.quoteCurrency)} (Available: ${this.formatPrice(quoteAvailable, this.quoteCurrency)})`);
      console.log('========================\n');
      
      // Check if trading pair is valid
      console.log('Verifying trading pair...');
      await this.checkProductDetails();
      
      // Load candle data - wait for this to complete before proceeding
      logger.info('Loading initial candle data...');
      await this.fetchInitialCandles();
      
      // Ensure we have candles before proceeding
      if (this.candles.length === 0) {
        throw new Error('Failed to load initial candle data');
      }
      
      // Load hourly candles before starting the trading cycle
      logger.info('Loading hourly candle data...');
      try {
        // First try to load from cache
        this.hourlyCandles = await this.loadHourlyCandlesFromCache();
        
        // If no cached data or it's too old, fetch fresh data
        const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
        const lastCandleTime = this.hourlyCandles.length > 0 
          ? this.hourlyCandles[this.hourlyCandles.length - 1].time 
          : 0;
          
        if (this.hourlyCandles.length === 0 || lastCandleTime < oneHourAgo) {
          logger.info('Fetching fresh hourly candle data...');
          await this.updateHourlyCandles(true);
          
          // Update last update time
          this.lastHourlyCandleUpdate = Math.floor(Date.now() / 1000);
        } else {
          logger.info(`Using ${this.hourlyCandles.length} cached hourly candles`);
        }
        
        if (this.hourlyCandles.length === 0) {
          logger.warn('No hourly candles available, 24h low calculation will be less accurate');
        } else {
          logger.info(`Successfully loaded ${this.hourlyCandles.length} hours of candle data for 24h low calculation`);
        }
      } catch (hourlyError) {
        logger.error('Error loading hourly candles:', hourlyError);
        logger.warn('Continuing with 1-minute candles for 24h low calculation');
      }
      
      this.initialized = true;
      logger.info('Initialization completed successfully');
    } catch (error) {
      logger.error('Error during initialization:', error);
      throw new Error('Failed to initialize: ' + error.message);
    } finally {
      this.initializing = false;
    }
  }
  
  async loadCachedCandles() {
    try {
      const data = await fs.readFile(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      // Validate and parse cached candles
      if (parsed && Array.isArray(parsed.candles)) {
        const candles = [];
        let validCandles = 0;
        let invalidCandles = 0;
        
        for (const candle of parsed.candles) {
          const processed = processCandle(candle);
          if (processed) {
            candles.push(processed);
            validCandles++;
          } else {
            invalidCandles++;
          }
        }
        
        // Sort by time (oldest first), remove duplicates, and limit to last 60 candles
        const uniqueCandles = candles
          .sort((a, b) => a.time - b.time)
          .filter((candle, index, array) => 
            index === 0 || candle.time !== array[index - 1].time
          )
          .slice(-60); // Only keep the last 60 candles (60 minutes)
        
        logger.info(`Loaded ${uniqueCandles.length} valid 1m candles from cache (${invalidCandles} invalid, limited to last 60 candles)`);
        return uniqueCandles;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('Error reading 1m cache file:', error);
      } else {
        logger.info('No 1m cache file found, will create a new one');
      }
    }
    return [];
  }

  /**
   * Loads hourly candles from the cache file
   * @returns {Promise<Array>} Array of processed hourly candles
   */
  async loadHourlyCandlesFromCache() {
    try {
      // Ensure cache directory exists
      try {
        await fs.access(HOURLY_CACHE_FILE);
      } catch (error) {
        if (error.code === 'ENOENT') {
          logger.info('No hourly cache file found, will create a new one');
          return [];
        }
        throw error;
      }
      
      const data = await fs.readFile(HOURLY_CACHE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      // Validate and parse cached hourly candles
      if (parsed && Array.isArray(parsed.candles)) {
        const candles = [];
        let validCandles = 0;
        let invalidCandles = 0;
        
        for (const candle of parsed.candles) {
          const processed = processCandle(candle);
          if (processed) {
            candles.push(processed);
            validCandles++;
          } else {
            invalidCandles++;
          }
        }
        
        // Sort by time (oldest first), remove duplicates, and limit to last 24 candles
        const uniqueCandles = candles
          .sort((a, b) => a.time - b.time)
          .filter((candle, index, array) => 
            index === 0 || candle.time !== array[index - 1].time
          )
          .slice(-MAX_HOURLY_CANDLES);
        
        logger.info(`Loaded ${uniqueCandles.length} valid hourly candles from cache (${invalidCandles} invalid, limited to last ${MAX_HOURLY_CANDLES} candles)`);
        return uniqueCandles;
      }
      return [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Error reading hourly cache file:', error);
      }
      return [];
    }
  }

  async saveCandlesToCache() {
    if (!this.candles || this.candles.length === 0) {
      logger.warn('No 1m candles to save to cache');
      return;
    }
    
    try {
      // Create a clean copy of candles with just the data we want to save
      // Take only the most recent 60 candles
      const recentCandles = this.candles.slice(-60);
      const candlesToSave = recentCandles.map(candle => ({
        time: candle.time,  // Already in Unix seconds
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      }));
      
      const cacheData = {
        candles: candlesToSave,
        timestamp: Math.floor(Date.now() / 1000), // Save current time in Unix seconds
        metadata: {
          tradingPair: this.tradingPair,
          count: candlesToSave.length,
          firstCandle: candlesToSave.length > 0 ? formatTimestamp(candlesToSave[0].time) : null,
          lastCandle: candlesToSave.length > 0 ? formatTimestamp(candlesToSave[candlesToSave.length - 1].time) : null
        }
      };
      
      // Write to a temporary file first, then rename to avoid corruption
      const tempPath = `${CACHE_FILE}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(cacheData, null, 2));
      
      // On Windows, we need to remove the destination file first if it exists
      try {
        await fs.unlink(CACHE_FILE);
      } catch (e) {
        // Ignore if file doesn't exist
        if (e.code !== 'ENOENT') throw e;
      }
      
      // Rename temp file to final name
      await fs.rename(tempPath, CACHE_FILE);
      
      logger.info(`Saved ${candlesToSave.length} 1m candles to cache`);
      
    } catch (error) {
      logger.error('Error saving 1m candles to cache:', error);
      // Don't throw, as this isn't a critical error
      logger.warn('Continuing without saving to 1m cache');
    }
  }

  /**
   * Saves hourly candles to cache file
   */
  async saveHourlyCandlesToCache() {
    if (!this.hourlyCandles || this.hourlyCandles.length === 0) {
      logger.warn('No hourly candles to save to cache');
      return;
    }
    
    let tempPath = '';
    try {
      // Create a clean copy of hourly candles with just the data we want to save
      // Take only the most recent 24 candles
      const recentCandles = this.hourlyCandles.slice(-MAX_HOURLY_CANDLES);
      const candlesToSave = recentCandles.map(candle => ({
        time: candle.time,  // Already in Unix seconds
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      }));
      
      const cacheData = {
        candles: candlesToSave,
        timestamp: Math.floor(Date.now() / 1000), // Save current time in Unix seconds
        metadata: {
          tradingPair: this.tradingPair,
          granularity: '1h',
          count: candlesToSave.length,
          firstCandle: candlesToSave.length > 0 ? formatTimestamp(candlesToSave[0].time) : null,
          lastCandle: candlesToSave.length > 0 ? formatTimestamp(candlesToSave[candlesToSave.length - 1].time) : null
        }
      };
      
      // Write to a temporary file first, then rename to avoid corruption
      tempPath = `${HOURLY_CACHE_FILE}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(cacheData, null, 2));
      
      // On Windows, we need to remove the destination file first if it exists
      try {
        await fs.access(HOURLY_CACHE_FILE);
        await fs.unlink(HOURLY_CACHE_FILE);
      } catch (e) {
        // Ignore if file doesn't exist
        if (e.code !== 'ENOENT') throw e;
      }
      
      // Rename temp file to final name
      await fs.rename(tempPath, HOURLY_CACHE_FILE);
      
      logger.info(`Saved ${candlesToSave.length} hourly candles to cache`);
    } catch (error) {
      logger.error('Error saving hourly candles to cache:', error);
      // Don't throw, as this isn't a critical error
      logger.warn('Continuing without saving to hourly cache');
      
      // Clean up temp file if it exists
      if (tempPath) {
        try {
          await fs.unlink(tempPath);
        } catch (e) {
          // Ignore errors in cleanup
        }
      }
    }
  }

  /**
   * Fetches initial candle data from the API and processes it
   * @returns {Promise<Array>} Array of processed candles
   * @throws {Error} If no candles are returned or if there's an error processing them
   */
  async fetchInitialCandles() {
    try {
      logger.info('Fetching initial candle data...');
      const response = await this.client.getPublicProductCandles({
        product_id: this.tradingPair,
        granularity: config.candleInterval,
        limit: 300
      });
      
      if (!response?.candles?.length) {
        throw new Error('No candles returned in API response');
      }

      const newCandles = [];
      let validCandles = 0;
      let invalidCandles = 0;
      
      for (const candle of response.candles) {
        const processed = processCandle(candle);
        if (processed) {
          newCandles.push(processed);
          validCandles++;
        } else {
          invalidCandles++;
        }
      }
      
      if (validCandles === 0) {
        throw new Error('No valid candles could be processed from the API response');
      }
      
      // Sort by time (oldest first) and remove duplicates
      this.candles = newCandles
        .sort((a, b) => a.time - b.time)
        .filter((candle, index, array) => 
          index === 0 || candle.time !== array[index - 1].time
        );
      
      logger.info(`Processed ${validCandles} valid candles (${invalidCandles} invalid)`);
      
      if (this.candles.length > 0) {
        await this.saveCandlesToCache();
      } else {
        logger.warn('No valid candles to save to cache');
      }
      
      return this.candles;
      
    } catch (error) {
      logger.error('Error in fetchInitialCandles:', error);
      throw error;
    }
  }

  async backfillMissingCandles() {
    const requestId = `backfill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const MAX_CANDLES = 60; // Enforce 60-candle limit (1 hour of 1-minute candles)
    
    // Prevent multiple concurrent backfills
    if (this._isBackfilling) {
      logger.debug(`[${requestId}] Backfill already in progress, skipping`);
      return;
    }
    
    try {
      this._isBackfilling = true;
      logger.info(`[${requestId}] Starting backfill process (max ${MAX_CANDLES} candles)...`);
      
      // If we have no candles at all, fetch initial data
      if (!this.candles || this.candles.length === 0) {
        logger.info(`[${requestId}] No candles available, fetching initial data...`);
        await this.fetchInitialCandles();
        return;
      }
      
      // Process and validate all candles
      const candleMap = new Map(); // Use a map to deduplicate by timestamp
      let invalidCandles = 0;
      
      logger.debug(`[${requestId}] Validating ${this.candles.length} existing candles`);
      
      // Process existing candles, keeping only the most recent ones
      for (const candle of this.candles) {
        try {
          const processed = processCandle(candle);
          if (processed) {
            // Only keep the most recent candle for each timestamp
            if (!candleMap.has(processed.time) || 
                (candleMap.get(processed.time).time < processed.time)) {
              candleMap.set(processed.time, processed);
            }
          } else {
            invalidCandles++;
            logger.debug(`[${requestId}] Invalid candle filtered out:`, candle);
          }
        } catch (error) {
          invalidCandles++;
          logger.debug(`[${requestId}] Error processing candle:`, error);
        }
      }
      
      // Convert map values to array, sort by time, and enforce 60-candle limit
      this.candles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-MAX_CANDLES); // Enforce 60-candle limit
      
      if (invalidCandles > 0) {
        logger.info(`[${requestId}] Filtered out ${invalidCandles} invalid candles during backfill`);
      }
      
      logger.info(`[${requestId}] Validated ${this.candles.length} candles after backfill`);
      
      // If we don't have enough valid candles, fetch initial data
      if (this.candles.length < 5) {
        logger.info(`[${requestId}] Not enough valid candles (${this.candles.length}), fetching initial data...`);
        await this.fetchInitialCandles();
        return;
      }
      
      // Get the newest candle timestamp in seconds
      const newestCandle = this.candles[this.candles.length - 1];
      const newestTime = Math.floor(newestCandle.time / 1000);
      
      // Validate timestamp
      if (isNaN(newestTime) || newestTime <= 0) {
        throw new Error(`[${requestId}] Invalid newest candle time: ${newestCandle.time}`);
      }
      
      const now = Math.floor(Date.now() / 1000);
      const oneHourAgo = now - 3600; // Only need to maintain 1 hour of data (60 candles)
      
      // Only backfill if we're missing data within the last hour
      if (newestTime < oneHourAgo - 60) { // Allow 1 minute buffer
        const missingMinutes = Math.min(
          Math.floor((now - newestTime) / 60), // Max missing minutes
          MAX_CANDLES - this.candles.length // Don't exceed our 60-candle limit
        );
        
        if (missingMinutes > 0) {
          logger.info(`[${requestId}] Missing ${missingMinutes} minutes of data, backfilling...`);
          // Fetch missing data using fetchCandleData which will respect our 60-candle limit
          await this.fetchCandleData(true);
        }
      }
      
      // Enforce 60-candle limit after backfill
      if (this.candles.length > MAX_CANDLES) {
        const removeCount = this.candles.length - MAX_CANDLES;
        this.candles = this.candles.slice(-MAX_CANDLES);
        logger.debug(`[${requestId}] Trimmed ${removeCount} oldest candles to maintain 60-candle limit`);
      }
      
      // Save the updated candles to cache
      if (this.candles.length > 0) {
        await this.saveCandlesToCache();
        logger.debug(`[${requestId}] Backfill complete, maintaining ${this.candles.length} most recent candles`);
      } else {
        logger.warn(`[${requestId}] No valid candles to save after backfill`);
      }
      
    } catch (error) {
      logger.error(`[${requestId}] Error in backfillMissingCandles:`, error);
      throw error; // Re-throw to be handled by the caller
    } finally {
      this._isBackfilling = false;
      logger.debug(`[${requestId}] Backfill process completed`);
    }
  }

  async fetchInitialCandles() {
    try {
      logger.info('Fetching initial candle data...');
      const response = await this.client.getPublicProductCandles({
        product_id: this.tradingPair,
        granularity: config.candleInterval,
        limit: 300
      });
      
      if (!response?.candles?.length) {
        throw new Error('No candles returned in API response');
      }

      const newCandles = [];
      let validCandles = 0;
      let invalidCandles = 0;
      
      for (const candle of response.candles) {
        const processed = processCandle(candle);
        if (processed) {
          newCandles.push(processed);
          validCandles++;
        } else {
          invalidCandles++;
        }
      }
      
      if (validCandles === 0) {
        throw new Error('No valid candles could be processed from the API response');
      }
      
      // Sort by time (oldest first) and remove duplicates
      this.candles = newCandles
        .sort((a, b) => a.time - b.time)
        .filter((candle, index, array) => 
          index === 0 || candle.time !== array[index - 1].time
        );
      
      logger.info(`Processed ${validCandles} valid candles (${invalidCandles} invalid)`);
      
      if (this.candles.length > 0) {
        await this.saveCandlesToCache();
      } else {
        logger.warn('No valid candles to save to cache');
      }
      
      return this.candles;
      
    } catch (error) {
      logger.error('Error in fetchInitialCandles:', error);
      throw error;
    }
  }

  /**
   * Backfills candle data by breaking down large time ranges into smaller windows
   * to avoid API time range limits.
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   * @param {number} [maxWindowHours=4] - Maximum window size in hours
   * @returns {Promise<Array>} - Array of processed candles
   */
  async backfillWithSmallerWindows(startTime, endTime, maxWindowHours = 4) {
    const windowMs = maxWindowHours * 60 * 60 * 1000; // Convert to milliseconds
    const startDate = new Date(startTime * 1000);
    const endDate = new Date(endTime * 1000);
    let currentStart = startDate;
    
    const allCandles = [];
    
    logger.info(`Backfilling with smaller windows from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    while (currentStart < endDate) {
      const currentEnd = new Date(Math.min(currentStart.getTime() + windowMs, endDate.getTime()));
      
      logger.info(`Fetching window: ${currentStart.toISOString()} to ${currentEnd.toISOString()}`);
      
      try {
        // First try with Unix timestamps in seconds
        const startUnix = Math.floor(currentStart.getTime() / 1000);
        const endUnix = Math.floor(currentEnd.getTime() / 1000);
        logger.debug(`Trying with Unix timestamps: start=${startUnix}, end=${endUnix}`);
        
        const apiResponse = await this.client.getPublicProductCandles({
          product_id: this.tradingPair,
          start: startUnix.toString(),
          end: endUnix.toString(),
          granularity: 'ONE_MINUTE'
        });
        
        logger.debug('Successfully fetched candles with Unix timestamps');
        
        if (apiResponse?.candles?.length > 0) {
          const processed = this.processCandlesFromResponse(apiResponse);
          allCandles.push(...processed);
          logger.info(`Added ${processed.length} candles from window, total: ${allCandles.length}`);
        }
      } catch (error) {
        logger.error(`Error fetching window ${currentStart.toISOString()} to ${currentEnd.toISOString()}:`, error.message);
        
        // If we hit a rate limit, wait and retry with a smaller window
        if (error.message?.includes('rate limit') || error.status === 429) {
          const retryAfter = parseInt(error.headers?.['retry-after'] || '5', 10) * 1000;
          logger.warn(`Rate limited. Will retry after ${retryAfter}ms before retrying with smaller window...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          
          // Try again with half the window size
          return this.backfillWithSmallerWindows(
            Math.floor(currentStart.getTime() / 1000),
            Math.floor(currentEnd.getTime() / 1000),
            maxWindowHours / 2
          );
        }
      }
      
      // Move to next window
      currentStart = new Date(currentEnd.getTime() + 1000); // Add 1s to avoid overlap
      
      // Add a small delay between requests to avoid rate limiting
      if (currentStart < endDate) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    // Sort and deduplicate all candles
    const uniqueCandles = [];
    const seen = new Set();
    
    allCandles
      .sort((a, b) => a.time - b.time)
      .forEach(candle => {
        if (!seen.has(candle.time)) {
          seen.add(candle.time);
          uniqueCandles.push(candle);
        }
      });
    
    logger.info(`Backfill complete. Processed ${uniqueCandles.length} unique candles`);
    return uniqueCandles;
  }
  


  async checkProductDetails() {
    try {
      // Get the list of all products
      const response = await this.client.rest.get('/api/v3/brokerage/products');
      const products = response.products || [];
      
      // Find our specific trading pair
      const product = products.find(p => p.product_id === this.tradingPair);
      
      if (!product) {
        // Only log a warning in debug mode since we know SYRUP-USDC is valid
        logger.debug(`Trading pair ${this.tradingPair} not found in product list, but continuing anyway`);
        return true;
      }
      
      // Only log if there's an actual issue with the product
      if (product.trading_disabled || product.status !== 'online') {
        logger.warn(`Trading issue detected for ${this.tradingPair}: status=${product.status}, trading_disabled=${product.trading_disabled}`);
      }
      
      return true;
      
    } catch (error) {
      // Only log a debug message since we want to continue anyway
      logger.debug('Product details check skipped - will continue with trading');
      return true;
    }
  }
  
  processCandlesFromResponse(response) {
    if (!response?.candles?.length) return [];
    
    const processedCandles = [];
    
    for (const candle of response.candles) {
      try {
        // Handle different response formats
        const c = candle.candle || candle;
        
        // Extract candle data with fallbacks
        const time = c.start || c.time;
        const open = parseFloat(c.open);
        const high = parseFloat(c.high);
        const low = parseFloat(c.low);
        const close = parseFloat(c.close);
        const volume = parseFloat(c.volume || 0);
        
        // Skip if we don't have required fields
        if (!time || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) {
          logger.warn('Skipping invalid candle data', { candle });
          continue;
        }
        
        // Convert time to seconds if it's in milliseconds
        const timestamp = time > 1e12 ? Math.floor(time / 1000) : time;
        
        processedCandles.push({
          time: timestamp,
          open,
          high,
          low,
          close,
          volume: isNaN(volume) ? 0 : volume
        });
        
      } catch (error) {
        logger.warn('Error processing candle:', { error, candle });
      }
    }
    
    return processedCandles;
  }

  async fetchCandleData(backfill = false) {
    const requestId = `fetch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date();
    const nowMs = now.getTime();
    
    // Prevent multiple concurrent fetches
    if (this._isFetching) {
      logger.debug(`[${requestId}] Fetch already in progress, skipping`);
      return this.candles;
    }
    
    // Rate limiting - don't allow fetches more than once every 30 seconds
    if (this._lastFetchTime && (nowMs - this._lastFetchTime < 30000)) {
      logger.debug(`[${requestId}] Rate limited, last fetch was ${(nowMs - this._lastFetchTime) / 1000} seconds ago`);
      return this.candles;
    }
    
    this._isFetching = true;
    this._lastFetchTime = nowMs;
    
    // Set a timeout to prevent hanging
    this._fetchTimeout = setTimeout(() => {
      if (this._isFetching) {
        logger.warn(`[${requestId}] Fetch timed out after 30 seconds`);
        this._isFetching = false;
        if (this._fetchTimeout) {
          clearTimeout(this._fetchTimeout);
          this._fetchTimeout = null;
        }
      }
    }, 30000);
    
    const cleanup = () => {
      if (this._fetchTimeout) {
        clearTimeout(this._fetchTimeout);
        this._fetchTimeout = null;
      }
      this._isFetching = false;
    };
    
    try {
      logger.debug(`[${requestId}] Starting candle data fetch`, { backfill });
      
        // If we're not backfilling, check if we already have recent data
        if (!backfill && this.candles.length > 0) {
          const lastCandleTime = this.candles[this.candles.length - 1]?.time || 0;
          const nowSec = Math.floor(now.getTime() / 1000);
          const secondsSinceLastCandle = nowSec - lastCandleTime;
          
          // If we have data from the last 45 seconds, use the cached data
          if (secondsSinceLastCandle < 45) {
            logger.debug(`[${requestId}] Using cached candle data`, { 
              lastCandleTime: new Date(lastCandleTime * 1000).toISOString(),
              now: now.toISOString(),
              ageSeconds: secondsSinceLastCandle
            });
            return this.candles;
          }
        }
        
        // Calculate time range for the request - only fetch what we need
        const endTime = new Date(now);
        let startTime;
        
        if (backfill && this.candles.length === 0) {
          // For initial backfill with no existing candles, just get the last 60 minutes
          startTime = new Date(now.getTime() - 3600000);
          logger.debug('Initial backfill: fetching last 60 minutes of data');
        } else if (this.candles.length > 0) {
          // For regular updates, only fetch new data since our last candle
          const lastCandleTime = new Date(this.candles[this.candles.length - 1].time * 1000);
          startTime = new Date(lastCandleTime.getTime() - 60000); // Start 1 minute before last candle to ensure no gaps
          logger.debug(`Fetching new candles since last candle at ${lastCandleTime.toISOString()}`);
        } else {
          // Default case: just get the last 60 minutes
          startTime = new Date(now.getTime() - 3600000);
          logger.debug('No existing candles, fetching last 60 minutes of data');
        }
      
        // Ensure we don't request data from the future
        if (startTime > now) {
          startTime = new Date(now.getTime() - 3600000);
        }
        
        // Ensure start time is not before end time
        if (endTime <= startTime) {
          logger.warn('End time is not after start time, adjusting...');
          startTime = new Date(endTime.getTime() - 3600000); // Set start to 1 hour before end
        }
        
        logger.info(`Fetching candle data`, { 
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          backfill,
          tradingPair: this.tradingPair
        });
        
        // Convert to ISO strings for the API and ensure they're in the correct format
        const startIso = startTime.toISOString();
        const endIso = endTime.toISOString();
        
        // Log the exact request parameters for debugging
        logger.debug('Fetching candles with params:', {
          product_id: this.tradingPair,
          start: startIso,
          end: endIso,
          granularity: 'ONE_MINUTE'
        });
        
        let apiResponse;
        
        try {
          // First try with Unix timestamps in seconds
          const startUnix = Math.floor(startTime.getTime() / 1000);
          const endUnix = Math.floor(endTime.getTime() / 1000);
          logger.debug(`Trying with Unix timestamps: start=${startUnix}, end=${endUnix}`);
          
          apiResponse = await this.client.getPublicProductCandles({
            product_id: this.tradingPair,
            start: startUnix.toString(),
            end: endUnix.toString(),
            granularity: 'ONE_MINUTE'
          });
          
          logger.debug('Successfully fetched candles with Unix timestamps');
        } catch (unixError) {
          // If that fails, try with ISO strings
          logger.warn('Failed to fetch with Unix timestamps, trying with ISO strings', { error: unixError.message });
          
          try {
            apiResponse = await this.client.getPublicProductCandles({
              product_id: this.tradingPair,
              start: startIso,
              end: endIso,
              granularity: 'ONE_MINUTE'
            });
            logger.debug('Successfully fetched candles with ISO strings');
          } catch (isoError) {
            logger.error('Failed to fetch candles with both Unix and ISO timestamps', { 
              unixError: unixError.message, 
              isoError: isoError.message 
            });
            throw new Error(`Failed to fetch candles: ${isoError.message}`);
          }
        }
        
        // Validate the API response
        if (!apiResponse?.candles) {
          throw new Error('Invalid response format from getPublicProductCandles');
        }
        
        // Process the candles
        const processedCandles = this.processCandlesFromResponse(apiResponse);
        
        if (backfill) {
          // For backfill, replace all candles
          this.candles = processedCandles;
          logger.info(`Backfilled ${processedCandles.length} candles`);
        } else {
          // For regular updates, merge and deduplicate candles
          let addedCount = 0;
          const candleMap = new Map();
          
          // Add existing candles to map (except possibly stale ones)
          this.candles.forEach(candle => {
            // Only keep candles from the last 65 minutes (slight buffer over 60)
            if (candle.time * 1000 > now.getTime() - 3900000) { // 65 minutes in ms
              candleMap.set(candle.time, candle);
            }
          });
          
          // Add new candles, overwriting any with the same timestamp
          processedCandles.forEach(candle => {
            if (!candleMap.has(candle.time)) {
              addedCount++;
            }
            candleMap.set(candle.time, candle);
          });
          
          // Convert map values to array, sort by time, and take most recent 60 candles
          const MAX_CANDLES = 60;
          const allCandles = Array.from(candleMap.values())
            .sort((a, b) => a.time - b.time);
            
          // Always take the most recent 60 candles
          this.candles = allCandles.slice(-MAX_CANDLES);
          
          // Log if we had to trim any candles
          if (allCandles.length > MAX_CANDLES) {
            const removed = allCandles.length - MAX_CANDLES;
            logger.debug(`Trimmed ${removed} old candles, maintaining ${this.candles.length} most recent candles`);
          }
          
          if (addedCount > 0) {
            logger.info(`Merged ${addedCount} new candles, maintaining ${this.candles.length} most recent candles`);
          }
        }
        
        // Save to cache if we have candles
        if (this.candles.length > 0) {
          try {
            await this.saveCandlesToCache();
            logger.debug('Successfully saved candles to cache');
          } catch (cacheError) {
            logger.error('Error saving candles to cache:', cacheError);
          }
        }
        
        return this.candles;
        
      } catch (error) {
        logger.error(`[${requestId}] Error fetching candle data:`, {
          error: error.message,
          stack: error.stack,
          code: error.code,
          requestId,
          backfill
        });
        
        // If we have cached data, return that instead of failing
        if (this.candles.length > 0) {
          logger.warn('Returning cached candle data due to error');
          return this.candles;
        }
        
        // For rate limiting, add additional backoff
        if (error.response?.status === 429) {
          const retryAfter = error.response.headers['retry-after'] || 60;
          logger.warn(`Rate limited. Will retry after ${retryAfter} seconds`);
          this._lastFetchTime = nowMs + (retryAfter * 1000);
        }
        
        throw error;
      } finally {
        cleanup();
        
        // Ensure we don't get stuck in a failed state
        if (this._isFetching) {
          logger.warn('Force resetting _isFetching flag in finally block');
          this._isFetching = false;
        }
      }
    }
  
  calculateIndicators() {
    try {
      if (this.candles.length === 0) {
        return;
      }
      
      // Get the most recent candles (up to the maximum period needed by any indicator)
      const maxPeriod = Math.max(
        this.buyConfig.emaSlowPeriod || 0,
        this.buyConfig.stochPeriod || 0,
        this.buyConfig.bbPeriod || 0,
        this.buyConfig.macdSlowPeriod || 0
      );
      
      // Get the most recent candles needed for calculations
      const recentCandles = this.candles.slice(-(maxPeriod * 2) - 1);
      
      const closes = recentCandles.map(c => parseFloat(c.close));
      const highs = recentCandles.map(c => parseFloat(c.high));
      const lows = recentCandles.map(c => parseFloat(c.low));
      
      // Calculate indicators
      const ema = EMA.calculate({
        values: closes,
        period: this.buyConfig.emaSlowPeriod
      });
      
      const rsi = RSI.calculate({
        values: closes,
        period: this.buyConfig.rsiPeriod || 14
      });
      
      const stoch = Stochastic.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: this.buyConfig.stochPeriod || 14,
        signalPeriod: this.buyConfig.stochDPeriod || 3,
        kPeriod: this.buyConfig.stochKPeriod || 3
      });
      
      const bb = BollingerBands.calculate({
        values: closes,
        period: this.buyConfig.bbPeriod || 20,
        stdDev: this.buyConfig.bbStdDev || 2
      });
      
      const macd = MACD.calculate({
        values: closes,
        fastPeriod: this.buyConfig.macdFastPeriod || 12,
        slowPeriod: this.buyConfig.macdSlowPeriod || 26,
        signalPeriod: this.buyConfig.macdSignalPeriod || 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
      });
      
      // Get the most recent close price as the current price
      const currentPrice = recentCandles.length > 0 ? 
        parseFloat(recentCandles[recentCandles.length - 1].close) : 0;
      
      // Store the latest values
      this.indicators = {
        price: currentPrice,  // Add current price to indicators
        ema: ema[ema.length - 1] || 0,
        rsi: rsi[rsi.length - 1] || 0,
        stochK: stoch[stoch.length - 1] ? stoch[stoch.length - 1].k : 0,
        stochD: stoch[stoch.length - 1] ? stoch[stoch.length - 1].d : 0,
        bbUpper: bb[bb.length - 1] ? bb[bb.length - 1].upper : 0,
        bbMiddle: bb[bb.length - 1] ? bb[bb.length - 1].middle : 0,
        bbLower: bb[bb.length - 1] ? bb[bb.length - 1].lower : 0,
        macd: macd[macd.length - 1] ? macd[macd.length - 1].histogram : 0,
        macdSignal: macd[macd.length - 1] ? macd[macd.length - 1].signal : 0,
        macdLine: macd[macd.length - 1] ? macd[macd.length - 1].MACD : 0
      };
      
      logger.debug('Updated indicators with price:', { 
        price: this.indicators.price,
        ema: this.indicators.ema,
        rsi: this.indicators.rsi
      });
    } catch (error) {
      logger.error('Error in calculateIndicators:', error);
      throw error;
    }
  }

  // Calculate buy score based on technical indicators (0-8)
  calculateBuyScore(indicators) {
    let score = 0;
    const reasons = [];
    const config = this.buyConfig;
    const ema = indicators.ema || 0;
    const rsi = indicators.rsi || 0;
    const macd = indicators.macd || { histogram: 0, signal: 0, MACD: 0 };
    const stochK = indicators.stochK || 0;
    const stochD = indicators.stochD || 0;
    const bb = indicators.bb || { upper: 0, middle: 0, lower: 0 };
    const price = this.candles[this.candles.length - 1]?.close || 0;
    
    // 1. RSI - Oversold condition (Max 1.5 pts)
    if (rsi < config.rsiOversold) {
      score += 1.5;
      reasons.push(`RSI ${rsi.toFixed(1)} < ${config.rsiOversold}`);
    } else if (rsi < 45) {
      score += 0.5;
      reasons.push(`RSI ${rsi.toFixed(1)} < 45`);
    }
    
    // 2. Stochastic - Oversold and crossovers (Max 2 pts)
    if (stochK < config.stochOversold) {
      score += 0.5;
      reasons.push(`Stoch K ${stochK.toFixed(1)} < ${config.stochOversold}`);
    }
    
    // Bullish crossover (K crosses above D)
    if (stochK > stochD && stochK < 30) {
      score += 1.5;
      reasons.push('Stoch bullish crossover (K > D) in oversold zone');
    }
    
    // 3. MACD - Bullish signals (Max 1.5 pts)
    if (macd.histogram > 0) {
      score += 0.5;
      reasons.push('MACD histogram positive');
    }
    
    if (macd.histogram > 0 && macd.histogram > macd.signal) {
      score += 1;
      reasons.push('MACD histogram rising');
    }
    
    // 4. Price vs EMA (Max 1.5 pts)
    if (price > ema) {
      score += 0.5;
      reasons.push('Price > EMA(20)');
    }
    
    // 5. Bollinger Bands (Max 1.5 pts)
    if (bb && typeof bb === 'object' && bb.lower !== undefined) {
      if (price <= bb.lower) {
        score += 1.5;
        reasons.push('Price at or below lower BB');
      } else if (bb.upper !== undefined && price < ((bb.upper - bb.lower) * 0.25) + bb.lower) {
        score += 1;
        reasons.push('Price in lower BB quartile');
      }
    } else {
      // If BB data is invalid, skip this scoring component
      logger.warn('Invalid or missing Bollinger Bands data');
    }
    
    // Cap score at 8
    const finalScore = Math.min(8, score);
    
    return {
      score: parseFloat(finalScore.toFixed(1)),
      reasons,
      timestamp: new Date().toISOString()
    };
  }
  
  // Calculate dip score based on % below 60-min high (0-3 pts)
  // Each point is now 0.5% lower than before (e.g., 0.5 points at 1.0% drop, 1 point at 1.5% drop, etc.)
  calculateDipScore(currentPrice) {
    // Get last 60 candles (1 hour)
    const hourCandles = this.candles.slice(-60);
    if (hourCandles.length < 5) {
      return { 
        score: 0, 
        reasons: ['Insufficient data for dip calculation'],
        high60m: 0,
        currentPrice,
        priceDrop: 0,
        timestamp: new Date().toISOString()
      };
    }
    
    // Find highest high in the last hour
    const high60m = Math.max(...hourCandles.map(c => c.high));
    
    // Handle case where high60m is 0 or invalid
    if (!high60m || high60m <= 0) {
      logger.warn('Invalid high60m value in calculateDipScore:', { high60m, currentPrice });
      return { 
        score: 0, 
        reasons: ['Invalid high price for dip calculation'],
        high60m: 0,
        currentPrice,
        priceDrop: 0,
        timestamp: new Date().toISOString()
      };
    }
    
    const priceDrop = ((high60m - currentPrice) / high60m) * 100;
    
    let score = 0;
    const reasons = [];
    
    // Adjusted thresholds (0.5% lower than before)
    if (priceDrop >= 3.5) {
      score = 3;
      reasons.push(`Price ${priceDrop.toFixed(2)}% below 60-min high`);
    } else if (priceDrop >= 3.0) {
      score = 2.5;
      reasons.push(`Price ${priceDrop.toFixed(2)}% below 60-min high`);
    } else if (priceDrop >= 2.5) {
      score = 2;
      reasons.push(`Price ${priceDrop.toFixed(2)}% below 60-min high`);
    } else if (priceDrop >= 2.0) {
      score = 1.5;
      reasons.push(`Price ${priceDrop.toFixed(2)}% below 60-min high`);
    } else if (priceDrop >= 1.5) {
      score = 1;
      reasons.push(`Price ${priceDrop.toFixed(2)}% below 60-min high`);
    } else if (priceDrop >= 1.0) {
      score = 0.5;
      reasons.push(`Price ${priceDrop.toFixed(2)}% below 60-min high`);
    }
    
    return {
      score: parseFloat(score.toFixed(1)),
      reasons,
      high60m,
      currentPrice,
      priceDrop: parseFloat(priceDrop.toFixed(2)),
      timestamp: new Date().toISOString()
    };
  }
  
  // Update hourly candles by fetching the latest hourly data
  async updateHourlyCandles(force = false) {
    const now = Date.now();
    
    // If we have recent data and not forced, skip update
    const hasRecentData = this.hourlyCandles.length > 0 && 
                         now - this.lastHourlyCandleUpdate < 300000; // 5 minutes in ms
    
    if (!force && hasRecentData) {
      logger.debug('Skipping hourly candle update - data is recent');
      return;
    }
    
    // Prevent multiple concurrent updates
    if (this._isUpdatingHourlyCandles) {
      logger.debug('Hourly candle update already in progress');
      return;
    }
    
    this._isUpdatingHourlyCandles = true;
    
    try {
      logger.info('Updating hourly candles...');
      
      // If we don't have any hourly candles yet, fetch the initial set
      if (this.hourlyCandles.length === 0) {
        this.hourlyCandles = await this.fetchInitialHourlyCandles();
      }
      
      // Get the timestamp of the most recent candle
      const lastCandleTime = this.hourlyCandles.length > 0 
        ? this.hourlyCandles[this.hourlyCandles.length - 1].start 
        : 0;
      
      // Calculate the start time for fetching new candles (1 hour after the last candle)
      const startTime = lastCandleTime > 0 ? lastCandleTime + 3600 : Math.floor(Date.now() / 1000) - 3600;
      const endTime = Math.floor(Date.now() / 1000);
      
      // Only fetch if we need to (startTime is before current time)
      if (startTime < endTime) {
        logger.debug(`Fetching new hourly candles from ${new Date(startTime * 1000).toISOString()} to ${new Date(endTime * 1000).toISOString()}`);
        
        // Fetch new hourly candles (3600 seconds = 1 hour)
        const response = await coinbaseService.getProductCandles(
          this.tradingPair,
          3600, // 1 hour in seconds
          startTime.toString(), // Ensure we pass a string
          endTime.toString()    // Ensure we pass a string
        );
        
        if (response && response.candles && Array.isArray(response.candles) && response.candles.length > 0) {
          // Process and validate the new candles
          const newCandles = [];
          const invalidCandles = [];
          
          for (const candle of response.candles) {
            try {
              const processed = processCandle(candle);
              if (processed) {
                // Only add candles that are newer than our last candle
                if (processed.start > lastCandleTime) {
                  newCandles.push(processed);
                }
              }
            } catch (error) {
              invalidCandles.push({ candle, error: error.message });
            }
          }
          
          // Log any invalid candles
          if (invalidCandles.length > 0) {
            logger.warn(`Skipped ${invalidCandles.length} invalid hourly candles during update`, {
              invalidCandles: invalidCandles.map(ic => ({
                timestamp: ic.candle?.start || 'unknown',
                error: ic.error
              }))
            });
          }
          
          // Add new candles to our cache
          if (newCandles.length > 0) {
            logger.info(`Adding ${newCandles.length} new hourly candles to cache`);
            this.hourlyCandles = [...this.hourlyCandles, ...newCandles];
            
            // Keep only the most recent 24 candles (24 hours)
            if (this.hourlyCandles.length > 24) {
              this.hourlyCandles = this.hourlyCandles.slice(-24);
            }
            
            // Save to cache
            await this.saveHourlyCandlesToCache();
          } else {
            logger.debug('No new hourly candles to add');
          }
        } else {
          logger.debug('No new hourly candles returned from API');
        }
      } else {
        logger.debug('No need to update hourly candles - data is up to date');
      }
      
      this.lastHourlyCandleUpdate = now;
      logger.debug('Hourly candles updated successfully', {
        totalCandles: this.hourlyCandles.length,
        latestCandle: this.hourlyCandles[this.hourlyCandles.length - 1]?.start 
          ? new Date(this.hourlyCandles[this.hourlyCandles.length - 1].start * 1000).toISOString() 
          : 'none'
      });
      
    } catch (error) {
      logger.error('Error updating hourly candles:', error);
      // Don't throw the error, just log it
    } finally {
      this._isUpdatingHourlyCandles = false;
    }
  }

  /**
   * Fetches the initial set of hourly candles (30 hours worth) and keeps the most recent 24 hours
   * @returns {Promise<Array>} Array of processed hourly candles
   */
  async fetchInitialHourlyCandles() {
    try {
      logger.info('Fetching initial hourly candle data...');
      
      // Calculate time range: from 30 hours ago to now
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = endTime - (30 * 60 * 60); // 30 hours ago
      
      logger.debug(`Fetching hourly candles from ${new Date(startTime * 1000).toISOString()} to ${new Date(endTime * 1000).toISOString()}`);
      
      // Fetch hourly candles (3600 seconds = 1 hour)
      const response = await coinbaseService.getProductCandles(
        this.tradingPair,
        3600, // 1 hour in seconds
        startTime.toString(), // Ensure we pass a string
        endTime.toString()    // Ensure we pass a string
      );
      
      if (!response || !response.candles || !Array.isArray(response.candles)) {
        throw new Error('Invalid response format from getProductCandles');
      }
      
      // Process and validate the candles
      const processedCandles = [];
      const invalidCandles = [];
      
      for (const candle of response.candles) {
        try {
          const processed = processCandle(candle);
          if (processed) {
            processedCandles.push(processed);
          }
        } catch (error) {
          invalidCandles.push({ candle, error: error.message });
        }
      }
      
      // Log any invalid candles
      if (invalidCandles.length > 0) {
        logger.warn(`Skipped ${invalidCandles.length} invalid hourly candles`, {
          invalidCandles: invalidCandles.map(ic => ({
            timestamp: ic.candle?.start || 'unknown',
            error: ic.error
          }))
        });
      }
      
      // Sort candles by timestamp (oldest first)
      processedCandles.sort((a, b) => a.start - b.start);
      
      // Keep only the most recent 24 candles (24 hours)
      const recentCandles = processedCandles.slice(-24);
      
      // Set the hourly candles before saving to cache
      this.hourlyCandles = recentCandles;
      
      logger.info(`Fetched and processed ${recentCandles.length} recent hourly candles`, {
        totalFetched: processedCandles.length,
        invalidCount: invalidCandles.length,
        kept: recentCandles.length,
        timeRange: {
          start: recentCandles[0]?.start ? new Date(recentCandles[0].start * 1000).toISOString() : 'none',
          end: recentCandles[recentCandles.length - 1]?.start ? 
               new Date(recentCandles[recentCandles.length - 1].start * 1000).toISOString() : 'none'
        }
      });
      
      // Save the fetched candles to cache
      try {
        await this.saveHourlyCandlesToCache();
        logger.info('Successfully saved initial hourly candles to cache');
      } catch (cacheError) {
        logger.error('Error saving initial hourly candles to cache:', cacheError);
        // Don't throw, as we still want to return the candles we fetched
      }
      
      return recentCandles;
      
    } catch (error) {
      logger.error('Error in fetchInitialHourlyCandles:', error);
      throw error;
    }
  }
  
  /**
   * Calculates a score based on how close the current price is to the 24-hour average low
   * Higher scores indicate the price is closer to the 24h average low
   * @param {number} currentPrice - The current price to evaluate
   * @returns {Object} Score and metadata about the 24h average low calculation
   */
  async calculate24hLowScore(currentPrice) {
    try {
      // Ensure we have a valid current price
      if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
        throw new Error(`Invalid current price: ${currentPrice}`);
      }
      
      let avgLow24h = 0;
      let percentAbove24hLow = 0;
      
      // Ensure we have enough data
      if (!this.hourlyCandles || this.hourlyCandles.length < 24) {
        // Fallback to 1-minute candles if we don't have hourly data yet
        logger.warn('No hourly candles available, falling back to 1-minute candles');
        const dailyCandles = (this.candles || []).slice(-1440);
        
        if (dailyCandles.length < 60) {
          throw new Error('Insufficient data for 24h average low calculation');
        }
        
        const validDailyCandles = dailyCandles.filter(candle => 
          candle && typeof candle.low === 'number' && !isNaN(candle.low) && candle.low > 0
        );
        
        if (validDailyCandles.length === 0) {
          throw new Error('No valid daily candles found for 24h average low calculation');
        }
        
        // Calculate average of all daily lows as fallback
        const sum = validDailyCandles.reduce((sum, candle) => sum + candle.low, 0);
        avgLow24h = sum / validDailyCandles.length;
      } else {
        // Use hourly candles for 24h average low calculation
        const validHourlyCandles = this.hourlyCandles
          .slice(-24) // Only use the last 24 hours
          .filter(candle => 
            candle && typeof candle.low === 'number' && !isNaN(candle.low) && candle.low > 0
          );
        
        if (validHourlyCandles.length === 0) {
          throw new Error('No valid hourly candles found for 24h average low calculation');
        }
        
        // Calculate the average of the last 24 hourly lows
        const sum = validHourlyCandles.reduce((sum, candle) => sum + candle.low, 0);
        avgLow24h = sum / validHourlyCandles.length;
      }
      
      // Ensure we have a valid avgLow24h before proceeding
      if (typeof avgLow24h !== 'number' || isNaN(avgLow24h) || avgLow24h <= 0) {
        throw new Error(`Invalid 24h average low value: ${avgLow24h}`);
      }
      
      // Calculate percentage above the 24h average low
      percentAbove24hLow = ((currentPrice - avgLow24h) / avgLow24h) * 100;
      
      // Ensure we have a valid percentage
      if (isNaN(percentAbove24hLow) || !isFinite(percentAbove24hLow)) {
        throw new Error(`Invalid percentage calculation: currentPrice=${currentPrice}, avgLow24h=${avgLow24h}`);
      }
      
      return this.calculate24hLowScoreFromValues(avgLow24h, currentPrice, percentAbove24hLow);
      
    } catch (error) {
      logger.error(`Error in calculate24hLowScore: ${error.message}`, { currentPrice });
      return {
        score: 0,
        reasons: [`Error calculating 24h low score: ${error.message}`],
        low24h: 0,
        currentPrice: currentPrice || 0,
        percentAbove24hLow: 0,
        timestamp: new Date().toISOString()
      };
    }
  }
  
  // Helper method to calculate the score from pre-computed values
  calculate24hLowScoreFromValues(low24h, currentPrice, percentAbove24hLow) {
    try {
      // Input validation
      if (typeof low24h !== 'number' || isNaN(low24h) || low24h <= 0) {
        throw new Error(`Invalid low24h: ${low24h}`);
      }
      if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
        throw new Error(`Invalid currentPrice: ${currentPrice}`);
      }
      if (typeof percentAbove24hLow !== 'number' || isNaN(percentAbove24hLow)) {
        throw new Error(`Invalid percentAbove24hLow: ${percentAbove24hLow}`);
      }
      
      // Ensure we have valid score ranges
      if (!Array.isArray(this.buyConfig?.low24hScoreRanges) || this.buyConfig.low24hScoreRanges.length === 0) {
        throw new Error('Invalid or missing low24hScoreRanges configuration');
      }
      
      // Find the appropriate score based on the configured ranges
      let score = 0;
      let scoreRange = '>5%';
      
      for (const range of this.buyConfig.low24hScoreRanges) {
        if (range && typeof range.maxPercent === 'number' && 
            typeof range.score === 'number' && 
            percentAbove24hLow <= range.maxPercent) {
          score = range.score;
          scoreRange = range.maxPercent === Infinity ? '>5%' : `≤${range.maxPercent}%`;
          break;
        }
      }
      
      // Format values safely for display
      const formatValue = (value, decimals = 6) => {
        try {
          if (typeof value !== 'number' || isNaN(value)) return 'N/A';
          return value.toFixed(decimals);
        } catch (e) {
          return 'N/A';
        }
      };
      
      return {
        score,
        reasons: [
          `24h Low Score: ${score}/10 (${formatValue(percentAbove24hLow, 2)}% above 24h low, range: ${scoreRange})`,
          `Low 24h: ${formatValue(low24h)}`,
          `Current: ${formatValue(currentPrice)}`,
          `Percent above: ${formatValue(percentAbove24hLow, 2)}%`
        ],
        low24h,
        currentPrice,
        percentAbove24hLow,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error(`Error in calculate24hLowScoreFromValues: ${error.message}`, { 
        low24h, 
        currentPrice, 
        percentAbove24hLow 
      });
      
      return {
        score: 0,
        reasons: [`Error in 24h low score calculation: ${error.message}`],
        low24h: low24h || 0,
        currentPrice: currentPrice || 0,
        percentAbove24hLow: percentAbove24hLow || 0,
        timestamp: new Date().toISOString()
      };
    }
  }
  
  // Get 2-candle confirmation for buy signals
  getTwoCandleConfirmation() {
    // Keep only signals from the last 5 minutes to ensure we don't lose signals too quickly
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    this.pendingBuySignals = this.pendingBuySignals
      .filter(signal => new Date(signal.timestamp) >= fiveMinutesAgo);
    
    // Sort signals by timestamp to ensure correct order (oldest first)
    const sortedSignals = [...this.pendingBuySignals].sort((a, b) => 
      new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    // Debug log the current state of pending signals
    if (sortedSignals.length > 0) {
      logger.debug(`Pending signals (${sortedSignals.length}):`, {
        signals: sortedSignals.map(s => ({
          time: s.timestamp,
          score: s.score,
          price: s.price
        }))
      });
    }
    
    // Need at least 2 signals within the time window
    if (sortedSignals.length >= 2) {
      // Try to find two valid signals that are at least 1 minute apart
      for (let i = sortedSignals.length - 1; i > 0; i--) {
        const latestSignal = sortedSignals[i];
        
        // Find the most recent previous signal that's at least 1 minute older
        for (let j = i - 1; j >= 0; j--) {
          const prevSignal = sortedSignals[j];
          const timeDiff = (new Date(latestSignal.timestamp) - new Date(prevSignal.timestamp)) / 1000 / 60; // in minutes
          
          // If signals are from different candles (at least 1 minute apart) and both meet minimum score
          if (timeDiff >= 1) {
            if (latestSignal.score >= this.buyConfig.minScore && 
                prevSignal.score >= this.buyConfig.minScore) {
              
              logger.info('2-candle confirmation detected', {
                timestamp: new Date().toISOString(),
                latestScore: latestSignal.score,
                prevScore: prevSignal.score,
                timeDiffMinutes: timeDiff.toFixed(2),
                signals: [
                  { time: prevSignal.timestamp, score: prevSignal.score, price: prevSignal.price },
                  { time: latestSignal.timestamp, score: latestSignal.score, price: latestSignal.price }
                ]
              });
              
              return {
                confirmed: true,
                score: ((latestSignal.score + prevSignal.score) / 2).toFixed(1),
                reasons: [
                  '✅ 2-candle confirmation:',
                  `- Current candle score: ${latestSignal.score}`,
                  `- Previous candle score: ${prevSignal.score}`,
                  `- Time between signals: ${timeDiff.toFixed(2)} minutes`
                ]
              };
            }
            break; // Only check the most recent valid time difference
          }
        }
      }
    }
    
    return { 
      confirmed: false,
      pendingCount: this.pendingBuySignals.length,
      pendingSignals: sortedSignals.map(s => ({
        time: s.timestamp,
        score: s.score,
        price: s.price
      }))
    };
  }

  // Evaluate buy signal based on all conditions
  async evaluateBuySignal(indicators) {
    if (!indicators || typeof indicators !== 'object') {
      logger.error('Invalid indicators object in evaluateBuySignal:', indicators);
      return {
        score: 0,
        reasons: ['Invalid indicators data'],
        confirmed: false
      };
    }
    
    const currentPrice = indicators.price;
    if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
      logger.error('Invalid current price in evaluateBuySignal:', currentPrice);
      return {
        score: 0,
        reasons: ['Invalid current price'],
        confirmed: false
      };
    }
    
    const currentTime = new Date();
    
    // Calculate all score components
    const techScore = this.calculateBuyScore(indicators);
    const dipScore = this.calculateDipScore(currentPrice);
    let low24hScore;
    
    try {
      logger.debug(`Calculating 24h low score for price: ${currentPrice}`);
      low24hScore = await this.calculate24hLowScore(currentPrice);
    } catch (error) {
      logger.error('Error calculating 24h low score:', error);
      low24hScore = {
        score: 0,
        reasons: ['Error calculating 24h low score'],
        low24h: 0,
        currentPrice: currentPrice,
        percentAbove24hLow: 0
      };
    }
    
    // Calculate total score (tech + dip + 24h low)
    const maxPossibleScore = 21; // 8 (tech) + 3 (dip) + 10 (24h low)
    const totalScore = Math.min(maxPossibleScore, techScore.score + dipScore.score + low24hScore.score);
    
    // Log the score calculation with detailed breakdown
    logger.debug('Buy signal score calculation', {
      timestamp: currentTime.toISOString(),
      techScore: {
        value: techScore.score,
        max: 8,
        reasons: techScore.reasons
      },
      dipScore: {
        value: dipScore.score,
        max: 3,
        reasons: dipScore.reasons
      },
      low24hScore: {
        value: low24hScore.score,
        max: 10,
        low24h: low24hScore.low24h,
        currentPrice: low24hScore.currentPrice,
        percentAbove24hLow: low24hScore.percentAbove24hLow,
        reasons: low24hScore.reasons
      },
      totalScore: {
        value: totalScore,
        max: 21,
        minRequired: this.buyConfig.minScore,
        meetsThreshold: totalScore >= this.buyConfig.minScore
      },
      price: currentPrice,
      hasActiveSignal: this.activeBuySignal.isActive,
      activeSignalConfirmations: this.activeBuySignal.confirmations
    });
    
    // Log detailed score information
    logger.debug('Buy signal scores:', {
      techScore: techScore.score,
      dipScore: dipScore.score,
      low24hScore: low24hScore.score,
      totalScore: totalScore,
      minRequired: this.buyConfig.minScore,
      time: currentTime.toISOString()
    });
    
    // Check if we have an active buy signal that needs to be monitored
    if (this.activeBuySignal.isActive) {
      const priceIncreasePct = ((currentPrice - this.activeBuySignal.signalPrice) / this.activeBuySignal.signalPrice) * 100;
      
      // Log the current active signal state
      logger.debug('Active buy signal state:', {
        timestamp: currentTime.toISOString(),
        signalPrice: this.activeBuySignal.signalPrice,
        currentPrice,
        priceIncreasePct: priceIncreasePct.toFixed(4) + '%',
        confirmations: this.activeBuySignal.confirmations,
        lastConfirmationTime: this.activeBuySignal.lastConfirmationTime ? 
          new Date(this.activeBuySignal.lastConfirmationTime).toISOString() : null,
        buyCount: this.activeBuySignal.buyCount,
        totalInvested: this.activeBuySignal.totalInvested,
        totalQuantity: this.activeBuySignal.totalQuantity
      });
      
      // If price increased by 0.5% or more, cancel the buy signal
      if (priceIncreasePct >= 0.5) {
        logger.info('Cancelling buy signal due to price increase', {
          signalPrice: this.activeBuySignal.signalPrice,
          currentPrice,
          increasePct: priceIncreasePct.toFixed(2) + '%',
          confirmations: this.activeBuySignal.confirmations
        });
        
        const cancelledSignal = {
          techScore: techScore.score,
          dipScore: dipScore.score,
          totalScore: parseFloat(totalScore.toFixed(1)),
          confirmed: false,
          signalStatus: 'cancelled',
          signalPrice: this.activeBuySignal.signalPrice,
          priceIncreasePct: parseFloat(priceIncreasePct.toFixed(2)),
          reasons: [
            ...techScore.reasons,
            ...dipScore.reasons,
            '❌ Buy signal cancelled: Price increased by 0.5% or more after signal'
          ]
        };
        
        // Reset the active signal
        this.activeBuySignal = {
          isActive: false,          // Whether there's an active buy signal
          signalPrice: null,        // Price when signal was first triggered
          signalTime: null,         // Timestamp when signal was first triggered
          confirmations: 0,         // Number of confirmations received
          lastConfirmationTime: null, // Timestamp of last confirmation
          totalInvested: 0,         // Total amount of quote currency invested
          totalQuantity: 0,         // Total quantity of base currency bought
          averagePrice: 0,          // Weighted average price of all buys
          buyCount: 0,              // Number of buy orders placed for this signal
          lastBuyPrice: 0,          // Price of the last buy order
          orderIds: []              // Array of order IDs for this signal
        };
        logger.info('New buy signal activated', { 
          price: currentPrice,
          totalScore: totalScore,
          techScore: techScore.score,
          dipScore: dipScore.score,
          low24hScore: low24hScore.score,
          signalId: this.activeBuySignal.signalId
        });
      } else {
        // Only increment confirmation if this is a new candle (at least 1 minute since last confirmation)
        const minutesSinceLastConfirmation = (currentTime - this.activeBuySignal.lastConfirmationTime) / 60000;
        if (minutesSinceLastConfirmation >= 1) {
          const newConfirmations = Math.min(2, this.activeBuySignal.confirmations + 1);
          
          // Only increment confirmations if the score remains strong
          if (totalScore >= this.buyConfig.minScore) {
            this.activeBuySignal.confirmations = newConfirmations;
            this.activeBuySignal.lastConfirmationTime = currentTime;
            
            logger.debug('Incremented confirmation count', {
              prevConfirmations: this.activeBuySignal.confirmations - 1,
              newConfirmations: newConfirmations,
              totalScore: totalScore,
              minutesSinceLastConfirmation: minutesSinceLastConfirmation.toFixed(2),
              signalId: this.activeBuySignal.signalId
            });
          } else {
            logger.debug('Skipping confirmation increment - score below threshold', {
              totalScore: totalScore,
              minRequired: this.buyConfig.minScore,
              signalId: this.activeBuySignal.signalId
            });
          }
        }
      }
    }
    
    // Clean up old signals (older than 5 minutes) at the start of each evaluation
    const fiveMinutesAgo = new Date(currentTime - 5 * 60 * 1000);
    this.pendingBuySignals = this.pendingBuySignals.filter(
      signal => new Date(signal.timestamp) >= fiveMinutesAgo
    );

    // Add to pending signals if total score is good enough
    if (totalScore >= this.buyConfig.minScore) {
      const newSignal = {
        ...techScore,
        price: currentPrice,
        timestamp: currentTime.toISOString(),
        score: totalScore, // Total score out of 21
        techScore: techScore.score, // Individual component scores for reference
        dipScore: dipScore.score,
        low24hScore: low24hScore.score,
        confirmations: this.activeBuySignal.isActive ? this.activeBuySignal.confirmations : 0,
        // Add a unique identifier for this signal
        id: `${currentTime.getTime()}-${currentPrice.toFixed(8)}`
      };
      
      // Log the new signal
      logger.debug('New buy signal detected', {
        timestamp: currentTime.toISOString(),
        totalScore: totalScore,
        techScore: techScore.score,
        price: newSignal.price,
        hasActiveSignal: this.activeBuySignal.isActive,
        currentConfirmations: this.activeBuySignal.confirmations
      });
      
      // If no active signal, this is a new signal
      if (!this.activeBuySignal.isActive) {
        this.activeBuySignal = {
          isActive: true,
          signalPrice: currentPrice,
          signalTime: currentTime,
          confirmations: 1,
          lastConfirmationTime: currentTime,
          orderIds: [],
          initialScore: totalScore, // Store the initial score for reference
          signalId: newSignal.id // Track which signal triggered this buy
        };
        logger.info('New buy signal activated', { 
          price: currentPrice,
          totalScore: totalScore,
          techScore: techScore.score,
          dipScore: dipScore.score,
          low24hScore: low24hScore.score,
          signalId: newSignal.id
        });
      } else {
        // Only increment confirmation if this is a new candle (at least 1 minute since last confirmation)
        const minutesSinceLastConfirmation = (currentTime - this.activeBuySignal.lastConfirmationTime) / 60000;
        if (minutesSinceLastConfirmation >= 1) {
          const newConfirmations = Math.min(2, this.activeBuySignal.confirmations + 1);
          
          // Only increment confirmations if the score remains strong
          if (totalScore >= this.buyConfig.minScore) {
            this.activeBuySignal.confirmations = newConfirmations;
            this.activeBuySignal.lastConfirmationTime = currentTime;
            
            logger.debug('Incremented confirmation count', {
              prevConfirmations: this.activeBuySignal.confirmations - 1,
              newConfirmations: newConfirmations,
              totalScore: totalScore,
              minutesSinceLastConfirmation: minutesSinceLastConfirmation.toFixed(2),
              signalId: this.activeBuySignal.signalId
            });
          } else {
            logger.debug('Skipping confirmation increment - score below threshold', {
              totalScore: totalScore,
              minRequired: this.buyConfig.minScore,
              signalId: this.activeBuySignal.signalId
            });
          }
        }
      }
      
      // Check if we already have a very similar signal in the queue
      const isDuplicate = this.pendingBuySignals.some(signal => {
        const timeDiff = Math.abs(new Date(signal.timestamp) - currentTime) / 1000; // in seconds
        return (
          // Same price (with small epsilon) and similar score within 10 seconds
          (Math.abs(signal.price - newSignal.price) < 0.0001 && 
           Math.abs(signal.score - newSignal.score) < 0.1 &&
           timeDiff < 10) ||
          // Or same signal ID (for deduplication after restarts)
          signal.id === newSignal.id
        );
      });
      
      if (!isDuplicate) {
        // Keep only the most recent 5 signals to prevent queue bloat
        if (this.pendingBuySignals.length >= 5) {
          this.pendingBuySignals.shift(); // Remove oldest signal
        }
        
        this.pendingBuySignals.push(newSignal);
        logger.debug('Added new signal to pending queue', { 
          totalPending: this.pendingBuySignals.length,
          score: techScore.score,
          price: newSignal.price,
          timestamp: newSignal.timestamp,
          signalId: newSignal.id
        });
      } else {
        logger.debug('Skipping duplicate signal', {
          price: newSignal.price,
          score: newSignal.score,
          timestamp: newSignal.timestamp,
          signalId: newSignal.id
        });
      }
    }
    
    // Check for 2-candle confirmation
    const confirmation = this.getTwoCandleConfirmation();
    const hasEnoughConfirmations = this.activeBuySignal.isActive && this.activeBuySignal.confirmations >= 2;
    const isConfirmed = (confirmation.confirmed || hasEnoughConfirmations) && 
                      totalScore >= this.buyConfig.minScore;
    
    // Debug log for confirmation status
    if (isConfirmed) {
      logger.debug('Confirmation check', {
        confirmed: confirmation.confirmed,
        hasEnoughConfirmations,
        totalScore,
        minScore: this.buyConfig.minScore,
        activeSignal: this.activeBuySignal.isActive,
        confirmations: this.activeBuySignal.confirmations
      });
    }
    
    // If we don't have an active signal or required data, return early
    if (!this.activeBuySignal.isActive || this.activeBuySignal.signalPrice === null || this.activeBuySignal.signalTime === null) {
      return {
        techScore: techScore.score,
        dipScore: dipScore.score,
        low24hScore: low24hScore.score,
        totalScore: parseFloat(totalScore.toFixed(1)),
        confirmed: false,
        signalStatus: 'inactive',
        signalPrice: null,
        confirmations: 0,
        reasons: ['No active signal or missing signal data'],
        _24hLow: low24hScore.low24h,
        percentAbove24hLow: low24hScore.percentAbove24hLow,
        pendingSignalsCount: this.pendingBuySignals.length
      };
    }
    
    // Create confirmation key with active signal data
    const confirmationKey = `${this.activeBuySignal.signalPrice.toFixed(8)}-${this.activeBuySignal.signalTime}`;
    const isNewConfirmation = isConfirmed && 
                            this.activeBuySignal.isActive && 
                            !this.processedConfirmations.has(confirmationKey);
                            
    if (isNewConfirmation) {
      // Mark this confirmation as processed
      this.processedConfirmations.add(confirmationKey);
      
      // Clean up old confirmations (keep last 10 minutes)
      const now = Date.now();
      for (const key of this.processedConfirmations) {
        const [price, time] = key.split('-');
        if (now - new Date(time).getTime() > 10 * 60 * 1000) { // 10 minutes
          this.processedConfirmations.delete(key);
        }
      }
      // Mark this confirmation as processed to prevent duplicates
      this.activeBuySignal.confirmationProcessed = true;
      this.activeBuySignal.confirmations = 2; // Ensure we have 2 confirmations
      this.activeBuySignal.lastConfirmationTime = currentTime;
      
      // Log the confirmation
      logger.info('2-candle buy signal confirmed, executing buy order', {
        price: this.activeBuySignal.signalPrice,
        currentPrice,
        confirmations: this.activeBuySignal.confirmations,
        score: totalScore,
        timestamp: currentTime.toISOString()
      });
      
      // Execute buy order immediately
      try {
        await this.placeBuyOrder(currentPrice, 'CONFIRMED');
      } catch (error) {
        logger.error('Failed to execute buy order after confirmation:', error);
        // Reset confirmation processed flag on error to allow retry
        this.activeBuySignal.confirmationProcessed = false;
      }
    }
    
    // Combine all reasons for logging
    const allReasons = [
      `=== Buy Signal ===`,
      `📊 Score: ${techScore.score}/8 (Tech) + ${dipScore.score}/3 (Dip) + ${low24hScore.score}/10 (24h Low) = ${totalScore}/21`,
      `⚪ Status: ${isConfirmed ? '✅ Confirmed' : this.activeBuySignal.isActive ? '⏳ Pending' : 'No Signal'}`,
      `24h Low: $${low24hScore.low24h?.toFixed(8) || 'N/A'} (${low24hScore.percentAbove24hLow?.toFixed(2) || '0.00'}% above)`,
      '---',
      ...techScore.reasons.filter(r => !r.includes('Score:')),
      ...dipScore.reasons.filter(r => !r.includes('Score:')),
      ...low24hScore.reasons.filter(r => !r.includes('Score:') && !r.includes('24h Low:')),
      this.activeBuySignal.isActive 
        ? `⏳ Signal active (${this.activeBuySignal.confirmations}/2 confirmations, ${((currentPrice - this.activeBuySignal.signalPrice) / this.activeBuySignal.signalPrice * 100).toFixed(2)}% from signal)`
        : 'No active signal',
      isConfirmed ? '✅ 2-candle confirmation' : '',
      `Pending signals in queue: ${this.pendingBuySignals.length}`,
      `===========================`
    ].filter(Boolean); // Remove any empty strings

    return {
      techScore: techScore.score,
      dipScore: dipScore.score,
      low24hScore: low24hScore.score,
      totalScore: parseFloat(totalScore.toFixed(1)),
      confirmed: isConfirmed || (this.activeBuySignal.isActive && this.activeBuySignal.confirmations >= 2),
      signalStatus: this.activeBuySignal.isActive ? 'active' : 'inactive',
      signalPrice: this.activeBuySignal.signalPrice,
      confirmations: this.activeBuySignal.confirmations,
      reasons: allReasons,
      // Include additional data for debugging
      _24hLow: low24hScore.low24h,
      percentAbove24hLow: low24hScore.percentAbove24hLow,
      pendingSignalsCount: this.pendingBuySignals.length
    };
  }

  /**
   * Sets up Telegram bot command handlers
   */
  setupTelegramCommands() {
    if (!this.telegramService || !this.telegramService.enabled) return;
    
    console.log('Setting up Telegram commands...');
    
    // Pass the bot instance to the Telegram service
    this.telegramService.setupCommands(this);
    
    console.log('Telegram commands set up successfully');

    console.log('Telegram commands initialized');
  }

  /**
   * Gets the current bot status
   * @returns {Promise<Object>} Status object
   */
  async getStatus() {
    try {
      const [balance, ticker, position] = await Promise.all([
        this.coinbaseService.getAccountBalance(this.quoteCurrency),
        this.coinbaseService.getTicker(this.tradingPair),
        this.getCurrentPosition()
      ]);

      return {
        balance: parseFloat(balance.available).toFixed(2),
        currentPrice: parseFloat(ticker.price).toFixed(4),
        priceChange24h: parseFloat(ticker.price_24h_change).toFixed(2),
        position: position ? position.amount.toFixed(2) : '0.00',
        avgPrice: position ? position.avgPrice.toFixed(4) : '0.00',
        lastTrade: this.lastTradeTime ? new Date(this.lastTradeTime).toLocaleString() : 'No trades yet',
        isTradingPaused: this.isTradingPaused
      };
    } catch (error) {
      console.error('Error getting status:', error);
      throw new Error('Failed to fetch status');
    }
  }

  /**
   * Sends a trade notification to Telegram
   * @param {string} message - The message to send
   * @param {boolean} isError - Whether this is an error message
   */
  async sendTelegramNotification(message, isError = false) {
    if (!this.telegramService?.enabled) return;
    
    try {
      // Format message with emoji and timestamp
      const formattedMessage = `${isError ? '❌ ' : 'ℹ️ '} *${this.tradingPair}*\n` +
        `${message}\n` +
        `_${new Date().toLocaleString()}_`;
      
      await this.telegramService.broadcast(formattedMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Failed to send Telegram notification:', error);
    }
  }

  /**
   * Notifies about a buy order
   * @param {Object} order - The executed buy order
   * @param {number} amount - The amount of base currency bought
   * @param {number} price - The price per unit
   * @param {number} total - The total cost in quote currency
   */
  async notifyBuyOrder(order, amount, price, total) {
    if (!this.telegramService?.enabled) return;
    
    // Calculate the actual total based on amount and price
    const calculatedTotal = amount * price;
    
    // Use the calculated total instead of the passed total parameter
    const message = `✅ *BUY ORDER EXECUTED*\n` +
      `🔹 *Amount:* ${this.formatNumber(amount, 2)} ${this.baseCurrency}\n` +
      `🔹 *Price:* ${this.formatNumber(price, 4)} ${this.quoteCurrency}\n` +
      `🔹 *Total:* ${this.formatNumber(calculatedTotal, 4)} ${this.quoteCurrency}\n` +
      `🔹 *Order ID:* \`${order.id || 'N/A'}\``;
    
    await this.sendTelegramNotification(message);
  }

  /**
   * Notifies about a sell order
   * @param {Object} order - The executed sell order
   * @param {number} amount - The amount of base currency sold
   * @param {number} price - The price per unit
   * @param {number} total - The total received in quote currency
   * @param {number} profitPct - The profit percentage
   */
  async notifySellOrder(order, amount, price, total, profitPct) {
    if (!this.telegramService?.enabled) return;
    
    const profitEmoji = profitPct >= 0 ? '📈' : '📉';
    const profitText = profitPct >= 0 ? 'Profit' : 'Loss';
    
    const message = `💰 *SELL ORDER EXECUTED*\n` +
      `🔹 *Amount:* ${this.formatNumber(amount, 2)} ${this.baseCurrency}\n` +
      `🔹 *Price:* ${this.formatNumber(price, 4)} ${this.quoteCurrency}\n` +
      `🔹 *Total:* ${this.formatNumber(total, 2)} ${this.quoteCurrency}\n` +
      `🔹 *${profitText}:* ${profitEmoji} ${Math.abs(profitPct).toFixed(2)}%\n` +
      `🔹 *Order ID:* \`${order.id}\``;
    
    await this.sendTelegramNotification(message);
  }

  /**
   * Notifies about an error
   * @param {string} context - The context where the error occurred
   * @param {Error} error - The error object
   */
  async notifyError(context, error) {
    if (!this.telegramService?.enabled) return;
    
    const errorMessage = error.response?.data?.message || error.message || 'Unknown error';
    const message = `❌ *ERROR*: ${context}\n` +
      `\`\`\`\n${errorMessage}\n\`\`\``;
    
    await this.sendTelegramNotification(message, true);
  }

  // Format price or amount with appropriate decimal precision
  formatPrice(price, currency = 'USD') {
    // Handle undefined, null, or empty values
    if (price === undefined || price === null || price === '') {
      return '0.0';
    }
    
    // Convert to number if it's a string
    const num = typeof price === 'string' ? parseFloat(price) : Number(price);
    
    // Handle invalid numbers
    if (isNaN(num)) {
      logger.warn(`Invalid number format for ${currency}: ${price}`);
      return '0.0';
    }
    
    // Special formatting for specific currencies
    if (currency === 'USDC' || currency === 'USD') {
      // USDC: 4 decimal places for consistency with Coinbase
      return num.toFixed(4);
    } else if (currency === 'SYRUP') {
      // SYRUP: 1 decimal place as per requirements
      return num.toFixed(1);
    }
    
    // Default formatting for other currencies
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency === 'USD' ? 'USD' : 'XXX',
      minimumFractionDigits: 2,
      maximumFractionDigits: 8
    }).format(num) + (currency === 'USD' ? '' : ` ${currency}`);
  }

  formatTimestamp(timestamp) {
    try {
      // Convert to Date object using our utility function
      const date = new Date(parseTimestamp(timestamp) * 1000 || Date.now());
      
      // Format as DD-MM-YY | HH:MM:SS
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = String(date.getFullYear()).slice(-2);
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      
      return `${day}-${month}-${year} | ${hours}:${minutes}:${seconds}`;
    } catch (error) {
      logger.warn('Error formatting timestamp, using current time', { error });
      // Return current time in a safe format
      const now = new Date();
      return now.toISOString().replace('T', ' ').replace(/\..+/, '');
    }
  }
  
  async logTradeCycle() {
    if (this.candles.length === 0) {
      logger.warn('No candle data available for trade cycle');
      return;
    }
    
    try {
      const latestCandle = this.candles[this.candles.length - 1];
      const formatNumber = (value, decimals = 4) => 
        typeof value === 'number' ? value.toFixed(decimals) : 'N/A';
      
      // Calculate price change since last candle if available
      let priceChange = 'N/A';
      let priceChangePercent = 'N/A';
      let priceChangeSymbol = '';
      
      if (this.candles.length >= 2) {
        const currentClose = latestCandle.close;
        const previousClose = this.candles[this.candles.length - 2].close;
        priceChange = (currentClose - previousClose).toFixed(8);
        priceChangePercent = ((currentClose - previousClose) / previousClose * 100).toFixed(2);
        priceChangeSymbol = currentClose >= previousClose ? '📈' : '📉';
      }
      
      const currentTime = new Date();
      const formattedTime = this.formatTimestamp(currentTime);
      const candleTime = this.formatTimestamp(latestCandle.time * 1000);
      
      // Format indicators
      const emaValue = this.indicators.ema ? parseFloat(this.indicators.ema) : 0;
      const rsiValue = this.indicators.rsi ? parseFloat(this.indicators.rsi) : 0;
      const stochK = this.indicators.stochK ? parseFloat(this.indicators.stochK) : 0;
      const stochD = this.indicators.stochD ? parseFloat(this.indicators.stochD) : 0;
      const bbUpper = this.indicators.bbUpper ? parseFloat(this.indicators.bbUpper) : 0;
      const bbMiddle = this.indicators.bbMiddle ? parseFloat(this.indicators.bbMiddle) : 0;
      const bbLower = this.indicators.bbLower ? parseFloat(this.indicators.bbLower) : 0;
      const macdHist = this.indicators.macd ? parseFloat(this.indicators.macd) : 0;
      const macdSignal = this.indicators.macdSignal ? parseFloat(this.indicators.macdSignal) : 0;
      const macdLine = this.indicators.macdLine ? parseFloat(this.indicators.macdLine) : 0;
      
      // Determine if price is above or below EMA
      const priceVsEma = latestCandle.close > emaValue ? 'ABOVE' : 'BELOW';
      const emaDiffPercent = ((latestCandle.close - emaValue) / emaValue * 100).toFixed(2);
      
      // Calculate buy signal
      const buySignal = await this.evaluateBuySignal({
        ema: emaValue,
        rsi: rsiValue,
        stochK: stochK,
        stochD: stochD,
        bb: { upper: bbUpper, middle: bbMiddle, lower: bbLower },
        macd: { histogram: macdHist, signal: macdSignal, MACD: macdLine },
        price: latestCandle.close
      });
      
      // Format buy signal info
      let statusEmoji = '⚪';
      let statusText = 'No Signal';
      
      if (buySignal.signalStatus === 'cancelled') {
        statusEmoji = '❌';
        statusText = `Cancelled (${buySignal.priceIncreasePct}% increase)`;
      } else if (buySignal.signalStatus === 'active') {
        statusEmoji = '🟡';
        statusText = `Active (${buySignal.confirmations}/2 confirmations)`;
        
        // Show price change from signal price if available
        if (buySignal.signalPrice) {
          const pctChange = ((latestCandle.close - buySignal.signalPrice) / buySignal.signalPrice * 100).toFixed(2);
          statusText += `, ${pctChange}% from signal`;
        }
      } else if (buySignal.confirmed) {
        statusEmoji = '🟢';
        statusText = 'Confirmed';
      }
      
      // Filter out duplicate reasons that we're handling separately
      const filteredReasons = buySignal.reasons.filter(r => 
        !r.includes('2-candle confirmation') && 
        !r.includes('Signal active') &&
        !r.includes('Waiting for confirmation')
      );
      
      const buySignalInfo = [
        '=== Buy Signal ===',
        `📊 Score: ${buySignal.techScore}/8 (Tech) + ${buySignal.dipScore}/3 (Dip) + ${buySignal.low24hScore}/10 (24h Low) = ${buySignal.totalScore}/21`,
        `${statusEmoji} Status: ${statusText}`,
        ...(buySignal.signalPrice ? [`Signal Price: ${this.formatPrice(buySignal.signalPrice)}`] : []),
        ...(buySignal._24hLow ? [`24h Low: ${this.formatPrice(buySignal._24hLow)} (${buySignal.percentAbove24hLow?.toFixed(2) || '0.00'}% above)`] : []),
        ...(filteredReasons.length > 0 ? ['---', ...filteredReasons] : []),
        ...(buySignal.confirmed ? ['✅ 2-candle confirmation'] : [])
      ].filter(line => line).join('\n');
      
      // Create log message
      const logMessage = [
        `\n=== ${formattedTime} ===`,
        `📊 ${this.tradingPair} - ${candleTime.split(' ')[1]}`,
        `💵 Price: ${this.formatPrice(latestCandle.close, this.quoteCurrency)} ${priceChangeSymbol} ${priceChange} (${priceChangePercent}%)`,
        `📈 High: ${this.formatPrice(latestCandle.high, this.quoteCurrency)} | 📉 Low: ${this.formatPrice(latestCandle.low, this.quoteCurrency)}`,
        `📊 Volume: ${formatNumber(latestCandle.volume, 2)} ${this.baseCurrency}`,
        '--- TECHNICAL INDICATORS ---',
        `📈 EMA(${config.indicators.ema.period}): ${this.formatPrice(emaValue, this.quoteCurrency)} (${priceVsEma} by ${Math.abs(emaDiffPercent)}%)`,
        `📊 RSI(${config.indicators.rsi.period}): ${formatNumber(rsiValue, 2)} ${rsiValue > 70 ? '🔴' : rsiValue < 30 ? '🟢' : '⚪'}`,
        `📊 Stoch K/D(${config.indicators.stoch.period}): ${formatNumber(stochK, 1)} / ${formatNumber(stochD, 1)} ${stochK > 80 || stochD > 80 ? '🔴' : stochK < 20 || stochD < 20 ? '🟢' : '⚪'}`,
        `📊 BB(${config.indicators.bb.period}): ${this.formatPrice(bbUpper, this.quoteCurrency)} | ${this.formatPrice(bbMiddle, this.quoteCurrency)} | ${this.formatPrice(bbLower, this.quoteCurrency)}`,
        `📊 MACD: ${formatNumber(macdLine, 6)} | Signal: ${formatNumber(macdSignal, 6)} | Hist: ${formatNumber(macdHist, 6)}`,
        '--- BUY SIGNAL ---',
        buySignalInfo,  // Use the formatted buySignalInfo we created earlier
        '==========================='
      ].join('\n');
      
      // Log to console
      console.log(logMessage);
      
      // Log trade cycle to file
      try {
        // Create a simplified version for the log file
        const logEntry = {
          timestamp: currentTime.toISOString(),
          price: latestCandle.close,
          indicators: {
            ema: emaValue,
            rsi: rsiValue,
            stoch: { k: stochK, d: stochD },
            bb: { upper: bbUpper, middle: bbMiddle, lower: bbLower },
            macd: { line: macdLine, signal: macdSignal, histogram: macdHist }
          },
          priceChange: {
            amount: parseFloat(priceChange),
            percent: parseFloat(priceChangePercent)
          },
          buySignal: {
            score: buySignal.score,
            status: buySignal.signalStatus || 'none',
            confirmations: buySignal.confirmations || 0,
            reasons: buySignal.reasons || []
          }
        };
        
        // Log to the trade cycle log file with a specific message to filter by
      logger.log({ 
        level: 'info',
        message: 'TRADE_CYCLE',
        ...logEntry 
      });
      } catch (logError) {
        console.error('Error logging trade cycle to file:', logError);
      }
      
    } catch (error) {
      logger.error('Error in logTradeCycle:', error);
      console.error('Error logging trade cycle:', error.message);
    }
  }
  
  /**
   * Check and execute trades based on signals
   * Simplified version that focuses on order submission
   */
  async checkAndExecuteTrades() {
    try {
    // Refresh account balances before checking conditions
    await this.getAccountBalances();
    
    if (!this.candles || this.candles.length === 0) {
      logger.warn('No candle data available');
      return;
    }
    
    // Get the latest candle
    const latestCandle = this.candles[this.candles.length - 1];
    const currentPrice = parseFloat(latestCandle.close);
    
    // Get fresh quote balance
    const quoteBalance = parseFloat(this.accounts[this.quoteCurrency]?.available || 0);
    const minPositionSize = parseFloat(this.buyConfig.minPositionSize);
    
    logger.debug('Balance check:', {
      quoteBalance,
      minPositionSize,
      hasEnoughBalance: quoteBalance >= minPositionSize,
      timestamp: new Date().toISOString()
    });
    
    // Check if we have enough funds to trade
    if (quoteBalance < minPositionSize) {
      logger.warn(`Insufficient ${this.quoteCurrency} balance to trade. Available: ${quoteBalance} ${this.quoteCurrency}, Required: ${minPositionSize} ${this.quoteCurrency}`);
      return;
    }
      
      // Reset active buy signal if we have no position and signal is stale
      if (this.activeBuySignal.isActive && 
          Date.now() - this.activeBuySignal.lastConfirmationTime > 3600000) { // 1 hour
        logger.info('Resetting stale buy signal');
        this.resetBuySignal();
      }
      
      // Calculate indicators
      this.calculateIndicators();
      
      // Evaluate buy signal
      const signal = await this.evaluateBuySignal(this.indicators);
      
      // Log signal evaluation details
      logger.debug('Signal evaluation result:', {
        timestamp: new Date().toISOString(),
        hasSignal: !!signal,
        signalScore: signal?.score,
        minRequiredScore: this.buyConfig.minScore,
        meetsScoreThreshold: signal?.score >= this.buyConfig.minScore,
        activeBuySignal: this.activeBuySignal.isActive ? {
          isActive: true,
          confirmations: this.activeBuySignal.confirmations,
          lastConfirmationTime: new Date(this.activeBuySignal.lastConfirmationTime).toISOString(),
          buyCount: this.activeBuySignal.buyCount
        } : { isActive: false },
        pendingSignalsCount: this.pendingBuySignals.length,
        quoteBalance: quoteBalance,
        minPositionSize: this.buyConfig.minPositionSize,
        hasSufficientFunds: quoteBalance >= this.buyConfig.minPositionSize
      });
      
      if (signal && signal.score >= this.buyConfig.minScore) {
        logger.info(`Buy signal detected with score ${signal.score}/${this.buyConfig.minScore}`);
        
        // Place buy order with the current price
        try {
          await this.placeBuyOrder(currentPrice, 'AUTO');
        } catch (error) {
          logger.error('Error placing buy order:', {
            error: error.message,
            stack: error.stack,
            price: currentPrice,
            timestamp: new Date().toISOString()
          });
        }
      }
      
    } catch (error) {
      logger.error('Error in checkAndExecuteTrades:', error);
    }
  }
  
  /**
   * Place a limit sell order after a successful buy
   * @param {number} buyPrice - Price at which the asset was bought
   * @param {number} amount - Amount of base currency to sell
   * @returns {Promise<Object|null>} Order response or null if failed
   */
  async placeLimitSellOrder(buyPrice, amount) {
    try {
      if (!amount || amount <= 0) {
        logger.warn('Invalid amount for limit sell order');
        return null;
      }

      // Format the trading pair (e.g., 'SYRUP-USDC')
      const formattedTradingPair = this.tradingPair.replace('/', '-').toUpperCase();
      
      // Calculate sell price with 4% profit target
      const sellPrice = parseFloat((buyPrice * 1.04).toFixed(4));
      
      // Format amount to 1 decimal place for SYRUP
      const formattedAmount = parseFloat(amount.toFixed(1));
      
      logger.info(`Placing limit sell order for ${formattedAmount} ${this.baseCurrency}...`);
      
      logger.info(`Limit sell order details - ` +
        `Trading Pair: ${formattedTradingPair}, ` +
        `Base: ${this.baseCurrency}, ` +
        `Quote: ${this.quoteCurrency}, ` +
        `Side: SELL, ` +
        `Size: ${formattedAmount} ${this.baseCurrency}, ` +
        `Price: ${sellPrice.toFixed(4)} ${this.quoteCurrency}, ` +
        `Order Type: limit, ` +
        `Time in Force: GTC`);
        
      // Log the formatted amount for debugging
      logger.debug(`Formatted sell amount: ${formattedAmount} ${this.baseCurrency} (raw: ${amount})`);
      
      const orderResponse = await this.coinbaseService.submitOrder(
        formattedTradingPair,  // productId (e.g., 'SYRUP-USDC')
        'SELL',               // side
        formattedAmount,       // size - amount of SYRUP to sell (formatted to 1 decimal)
        'limit',              // orderType
        sellPrice,            // price for limit order
        true                  // postOnly - ensure maker order
      );
      
      // Check for successful response - handle both direct order_id and success_response.order_id
      const orderId = orderResponse?.order_id || orderResponse?.success_response?.order_id;
      
      if (orderId) {
      logger.info(`Limit sell order placed successfully. ID: ${orderId}`);
      
      // Log the sell order details
      const tradeResponse = orderResponse.success_response || orderResponse;
      this.logTrade('SELL_LIMIT', sellPrice, amount * sellPrice, {
        ...tradeResponse,
        filled_size: formattedAmount,
        executed_value: (amount * sellPrice).toFixed(8)
      });
      
      // Reset the buy signal after a successful sell
      this.resetBuySignal('sell order executed');
      
      return tradeResponse;
      } else {
        logger.error('Unexpected order response format:', JSON.stringify(orderResponse, null, 2));
        throw new Error('Invalid response format when placing limit sell order');
      }
    } catch (error) {
      logger.error('Error placing limit sell order:', error.message || error);
      if (error.response?.data) {
        logger.error('Error details:', error.response.data);
      }
      return null;
    }
  }

  /**
   * Place a buy order and handle the response with confirmation
   * @param {number} price - Current price
   * @param {string} type - Type of buy (INITIAL, DCA, or CONFIRMED)
   * @returns {Promise<Object|null>} Order response or null if failed
   */
  async placeBuyOrder(price, type = 'INITIAL') {
    const orderLabel = `[${type} BUY]`;
    let positionSize = 0;
    
    try {
      // 1. Check if we're in cooldown period
      const timeSinceLastBuy = Date.now() - this.lastBuyTime;
      if (timeSinceLastBuy < this.buyCooldown) {
        const remainingMs = this.buyCooldown - timeSinceLastBuy;
        const remainingSec = Math.ceil(remainingMs / 1000);
        logger.warn(`${orderLabel} Cooldown active. ${remainingSec}s remaining.`);
        
        // Log this as a skipped trade due to cooldown
        this.logTrade('BUY_SKIPPED', price, 0, {
          reason: `Cooldown active (${remainingSec}s remaining)`,
          lastBuyTime: new Date(this.lastBuyTime).toISOString(),
          cooldownMs: this.buyCooldown,
          timestamp: new Date().toISOString()
        });
        
        return null;
      }
      
      // 2. Check account balance and calculate position size
      await this.getAccountBalances();
      const quoteBalance = parseFloat(this.accounts[this.quoteCurrency]?.available || 0);
      const minPositionSize = parseFloat(this.buyConfig.minPositionSize);
      
      // Log detailed balance information
      logger.debug('Buy order balance check:', {
        availableBalance: quoteBalance,
        minPositionSize: minPositionSize,
        hasEnoughBalance: quoteBalance >= minPositionSize,
        timestamp: new Date().toISOString()
      });
      
      // 2.1 Check if we have enough balance for minimum trade size
      if (quoteBalance < minPositionSize) {
        const warningMsg = `${orderLabel} Insufficient ${this.quoteCurrency} balance. ` +
                        `Available: ${this.formatPrice(quoteBalance, this.quoteCurrency)} ${this.quoteCurrency}, ` +
                        `Minimum required: ${this.formatPrice(minPositionSize, this.quoteCurrency)} ${this.quoteCurrency}`;
        
        logger.warn(warningMsg);
        
        // If we have an active buy signal but not enough balance, reset it
        if (this.activeBuySignal.isActive) {
          logger.info(`${orderLabel} Resetting active buy signal due to insufficient funds`);
          this.resetBuySignal();
        }
        
        // Log this as a skipped trade due to insufficient funds
        this.logTrade('BUY_SKIPPED', price, 0, {
          reason: `Insufficient ${this.quoteCurrency} balance`,
          available: quoteBalance,
          required: minPositionSize,
          timestamp: new Date().toISOString()
        });
        
        return null;
      }
      
      // 3. Calculate position size in quote currency (USDC)
      const quoteAmount = Math.min(
        quoteBalance, // Don't exceed available balance
        Math.max(
          this.buyConfig.minPositionSize, // At least min position size
          quoteBalance * (this.buyConfig.positionSizePercent / 100) // Target percentage of balance
        )
      );
      
      // 4. Calculate how much SYRUP we can buy with the available USDC
      // Add a small buffer (0.5%) to account for price movement and fees
      const buffer = 0.995; // 0.5% buffer
      const estimatedPositionSize = (quoteAmount * buffer) / price;
      
      // Format the position size according to Coinbase's precision requirements for SYRUP
      // SYRUP uses 1 decimal place on Coinbase
      positionSize = Math.floor(estimatedPositionSize * 10) / 10; // Round down to 1 decimal place
      
      // Ensure exactly 1 decimal place
      positionSize = parseFloat(positionSize.toFixed(1));
      
      // Ensure we're not trying to buy less than the minimum order size
      // For SYRUP-USDC, the minimum order size is 1 SYRUP
      const minOrderSize = 1; // 1 SYRUP minimum
      if (positionSize < minOrderSize) {
        logger.warn(`${orderLabel} Calculated position size (${positionSize} ${this.baseCurrency}) is below minimum order size (${minOrderSize} ${this.baseCurrency})`);
        return null;
      }
      
      // Log the formatted position size for debugging
      logger.debug(`${orderLabel} Formatted position size: ${positionSize} ${this.baseCurrency} (raw: ${positionSize})`);
      
      // Format the position size and price for display
      const formattedPositionSize = this.formatPrice(positionSize, this.quoteCurrency);
      const formattedPrice = this.formatPrice(price, this.quoteCurrency);
      
      logger.info(`${orderLabel} Placing market order for ${formattedPositionSize} ${this.quoteCurrency} @ ~${formattedPrice} ${this.quoteCurrency}...`);
      
      // 5. Place the market order using the coinbase service
      const formattedTradingPair = this.tradingPair.replace('/', '-').toUpperCase();
      
      logger.info(`${orderLabel} Order details - ` +
        `Trading Pair: ${formattedTradingPair}, ` +
        `Base: ${this.baseCurrency}, ` +
        `Quote: ${this.quoteCurrency}, ` +
        `Side: BUY, ` +
        `Size: ${positionSize} ${this.baseCurrency}, ` +
        `Quote Amount: ~${(positionSize * price).toFixed(4)} ${this.quoteCurrency}, ` +
        `Order Type: market`);
      
      // Place the market buy order
      let orderResponse;
      try {
        const response = await this.coinbaseService.submitOrder(
          formattedTradingPair,  // productId (e.g., 'SYRUP-USDC')
          'BUY',                 // side
          positionSize,          // size in base currency (SYRUP)
          'market',              // orderType
          null,                  // price (not needed for market orders)
          false                  // postOnly (false for market orders)
        );
        
        // Handle different response formats
        if (response?.success_response?.order_id) {
          // New format: { success: true, success_response: { order_id: '...' } }
          orderResponse = response.success_response;
        } else if (response?.order_id) {
          // Direct format: { order_id: '...' }
          orderResponse = response;
        } else {
          throw new Error(`Invalid order response: ${JSON.stringify(response || {}, null, 2)}`);
        }
      } catch (error) {
        // Log the full error details for debugging
        logger.error(`${orderLabel} Order submission failed:`, {
          error: error.message,
          stack: error.stack,
          response: error.response?.data,
          request: {
            productId: formattedTradingPair,
            side: 'BUY',
            size: positionSize,
            orderType: 'market',
            price: null,
            postOnly: false
          },
          timestamp: new Date().toISOString()
        });
        throw error; // Re-throw to be handled by the outer catch block
      }
      
      logger.info(`${orderLabel} Order placed. ID: ${orderResponse.order_id}`);
      
      // 5. Log the successful order placement
      logger.info(`${orderLabel} Order placed successfully. ID: ${orderResponse.order_id}`);
      
      // 6. For market orders, we can proceed directly to place the sell order
      // since market orders are typically filled immediately or not at all
      try {
        // Log the successful buy
        this.logTrade('BUY', price, positionSize * price, orderResponse);
        
        // Update the active buy signal with this purchase
        this.updateBuySignalAfterOrder(price, positionSize * price, orderResponse);
        this.lastBuyTime = Date.now();
        
        // Place a limit sell order for this buy (4% profit target)
      if (positionSize > 0) {
          try {
            const formattedSellSize = this.formatPrice(positionSize, this.baseCurrency);
            logger.info(`Placing limit sell order for ${formattedSellSize} ${this.baseCurrency}...`);
            await this.placeLimitSellOrder(price, positionSize);
          } catch (sellError) {
            logger.error('Failed to place limit sell order after buy:', sellError);
            // Even if sell order fails, we still consider the buy successful
          }
        }
        
        return orderResponse;
        
      } catch (confirmError) {
        // If we can't confirm the order status, log the error but still try to proceed
        logger.error(`${orderLabel} Error confirming order ${orderResponse.order_id}:`, confirmError);
        
        // Log the buy with the information we have
        this.logTrade('BUY_UNCONFIRMED', price, positionSize, orderResponse || {});
        this.lastBuyTime = Date.now();
        
        return orderResponse || { status: 'UNCONFIRMED', order_id: `unconfirmed-${Date.now()}` };
      }
      
    } catch (error) {
      const errorMessage = error.message || String(error);
      logger.error(`${orderLabel} Failed to place order:`, errorMessage);
      
      // Log the failed order attempt
      this.logTrade('BUY_FAILED', price, positionSize, { 
        error: errorMessage,
        timestamp: new Date().toISOString(),
        ...(error.response?.data && { responseData: error.response.data })
      });
      
      // If we're rate limited, apply backoff
      if (error.response?.status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after'] || '5', 10) * 1000;
        logger.warn(`Rate limited. Waiting ${retryAfter}ms before next attempt...`);
        this.lastBuyTime = Date.now() + retryAfter - this.buyCooldown;
      }
      
      return null;
    }
  }

  /**
   * Update the active buy signal after a successful order
   * @param {number} price - Price of the order
   * @param {number} amount - Amount in quote currency
   * @param {Object} orderResponse - Order response from the exchange
   */
  updateBuySignalAfterOrder(price, amount, orderResponse) {
    try {
      // Extract order ID from the response
      const orderId = orderResponse?.order_id || orderResponse?.success_response?.order_id || `manual-${Date.now()}`;
      
      // For market orders, we might not have filled_size in the immediate response
      // So we'll use the amount and price passed to the function
      let filledSize = 0;
      let filledValue = 0;
      
      if (orderResponse?.success_response?.filled_size) {
        filledSize = parseFloat(orderResponse.success_response.filled_size);
      } else if (orderResponse?.filled_size) {
        filledSize = parseFloat(orderResponse.filled_size);
      } else {
        // Fallback to calculating from amount and price
        filledSize = amount / price;
      }
      
      if (orderResponse?.success_response?.executed_value) {
        filledValue = parseFloat(orderResponse.success_response.executed_value);
      } else if (orderResponse?.executed_value) {
        filledValue = parseFloat(orderResponse.executed_value);
      } else {
        // Fallback to using the amount passed to the function
        filledValue = amount;
      }
      
      // Skip if this is a sell order
      const orderSide = orderResponse?.side || (orderResponse?.success_response?.side || '').toUpperCase();
      if (orderSide === 'SELL' || orderSide === 'SELL_LIMIT') {
        return;
      }
      
      // If this is a new signal, initialize the activeBuySignal
      if (!this.activeBuySignal.isActive) {
        this.activeBuySignal = {
          isActive: true,
          signalPrice: price,
          signalTime: Date.now(),
          confirmations: 1,
          lastConfirmationTime: Date.now(),
          totalInvested: filledValue,
          totalQuantity: filledSize,
          averagePrice: price,
          buyCount: 1,
          lastBuyPrice: price,
          orderIds: [orderId]
        };
      } else {
        // Update existing signal
        const newTotalInvested = this.activeBuySignal.totalInvested + filledValue;
        const newTotalQuantity = this.activeBuySignal.totalQuantity + filledSize;
        
        this.activeBuySignal.totalInvested = newTotalInvested;
        this.activeBuySignal.totalQuantity = newTotalQuantity;
        this.activeBuySignal.averagePrice = newTotalInvested / newTotalQuantity;
        this.activeBuySignal.buyCount++;
        this.activeBuySignal.lastBuyPrice = price;
        this.activeBuySignal.orderIds.push(orderId);
        this.activeBuySignal.confirmations++;
        this.activeBuySignal.lastConfirmationTime = Date.now();
      }
      
      // Log the updated position
      logger.info(`Buy order executed. Position: ${this.activeBuySignal.totalQuantity.toFixed(2)} ${this.baseCurrency} ` +
                 `@ avg price ${this.activeBuySignal.averagePrice.toFixed(4)} ${this.quoteCurrency} ` +
                 `(Total: ${this.activeBuySignal.totalInvested.toFixed(2)} ${this.quoteCurrency})`);
      
      // Clear pending signals after a successful buy to allow new signals
      const pendingCount = this.pendingBuySignals.length;
      this.pendingBuySignals = [];
      this.lastBuyScore = 0;
      
      if (pendingCount > 0) {
        logger.info(`Cleared ${pendingCount} pending buy signals after successful buy order`);
      }
    } catch (error) {
      logger.error('Error updating buy signal after order:', error, {
        orderResponse: JSON.stringify(orderResponse, null, 2),
        errorMessage: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Log trade details
   * @param {string} type - Type of trade (e.g., 'BUY', 'SELL_LIMIT', 'BUY_FAILED')
   * @param {number} price - Price of the trade
   * @param {number} amount - Amount in quote currency
   * @param {Object} [metadata] - Additional trade metadata
   */
  async logTrade(type, price, amount, metadata = {}) {
    try {
      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        type,
        price,
        amount,
        ...metadata
      };
      
      // Log to console
      console.log(`[${timestamp}] ${type} ${this.tradingPair} @ ${price} - Amount: ${amount} ${this.quoteCurrency}`);
      
      // Add to trade history
      this.tradeHistory.push(logEntry);
      
      // Keep only the last 100 trades
      if (this.tradeHistory.length > 100) {
        this.tradeHistory.shift();
      }
      
      // Send trade notification to Telegram
      try {
        let message = '';
        const formattedPrice = this.formatPrice(price, this.quoteCurrency);
        const formattedAmount = this.formatPrice(amount, this.baseCurrency);
        
        switch(type) {
          case 'BUY':
            message = `🟢 BUY Order Filled\n` +
                     `💵 Price: ${formattedPrice} ${this.quoteCurrency}\n` +
                     `📊 Amount: ${formattedAmount} ${this.baseCurrency}\n` +
                     `💰 Total: ${this.formatPrice(price * amount, this.quoteCurrency)} ${this.quoteCurrency}`;
            break;
            
          case 'SELL_LIMIT':
            message = `🔴 SELL Order Filled\n` +
                     `💵 Price: ${formattedPrice} ${this.quoteCurrency}\n` +
                     `📊 Amount: ${formattedAmount} ${this.baseCurrency}\n`;
            
            if (metadata.profit) {
              const profitPct = (metadata.profit.percent * 100).toFixed(2);
              message += `💰 Profit: ${this.formatPrice(metadata.profit.amount, this.quoteCurrency)} ${this.quoteCurrency} (${profitPct}%)`;
            }
            break;
            
          case 'BUY_FAILED':
            message = `❌ BUY Order Failed\n` +
                     `💵 Price: ${formattedPrice} ${this.quoteCurrency}\n` +
                     `📊 Amount: ${formattedAmount} ${this.baseCurrency}\n` +
                     `⚠️ Reason: ${metadata.reason || 'Unknown'}`;
            break;
            
          case 'SELL_FAILED':
            message = `❌ SELL Order Failed\n` +
                     `💵 Price: ${formattedPrice} ${this.quoteCurrency}\n` +
                     `📊 Amount: ${formattedAmount} ${this.baseCurrency}\n` +
                     `⚠️ Reason: ${metadata.reason || 'Unknown'}`;
            break;
            
          default:
            // Don't send notifications for other trade types
            return logEntry;
        }
        
        await this.telegramService.notify(message);
      } catch (error) {
        console.error('Failed to send Telegram notification:', error);
      }
      
      return logEntry;
    } catch (error) {
      logger.error('Error in logTrade:', error);
      console.error('Error logging trade:', error.message);
      return null;
    }
  }

  /**
   * Reset the active buy signal and clean up related state
   * @param {string} reason - Reason for the reset (for logging)
   * @returns {boolean} Whether there was an active signal that was reset
   */
  resetBuySignal(reason = 'manual reset') {
    const wasActive = this.activeBuySignal.isActive;
    const signalId = this.activeBuySignal.signalId;
    
    // Log the reset with details about the previous state
    logger.info('Resetting buy signal state', {
      reason: reason,
      wasActive: wasActive,
      signalId: signalId,
      signalPrice: this.activeBuySignal.signalPrice,
      confirmations: this.activeBuySignal.confirmations,
      buyCount: this.activeBuySignal.buyCount,
      totalInvested: this.activeBuySignal.totalInvested,
      totalQuantity: this.activeBuySignal.totalQuantity,
      timestamp: new Date().toISOString()
    });
    
    // Reset the active buy signal
    this.activeBuySignal = {
      isActive: false,
      signalPrice: null,
      signalTime: null,
      confirmations: 0,
      lastConfirmationTime: null,
      orderIds: [],
      buyCount: 0,
      totalInvested: 0,
      totalQuantity: 0,
      averagePrice: 0,
      lastBuyPrice: 0,
      initialScore: 0,
      signalId: null
    };
    
    // Also clear any pending signals that might be related
    const pendingCount = this.pendingBuySignals.length;
    this.pendingBuySignals = [];
    this.lastBuyScore = 0;
    
    if (pendingCount > 0) {
      logger.info(`Cleared ${pendingCount} pending buy signals during reset`);
    }
    
    // Log the reset completion
    logger.debug('Buy signal state reset complete', {
      activeBuySignal: this.activeBuySignal,
      pendingSignalsCount: this.pendingBuySignals.length,
      timestamp: new Date().toISOString()
    });
    
    return wasActive;
  }

  getMsToNextMinute() {
    const now = new Date();
    // Calculate milliseconds until next full minute (aligned to system clock)
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    // Ensure we don't return 0 or negative values, but keep it close to the actual time
    return Math.max(10, msToNextMinute);
  }

  async waitForNextMinute() {
    const now = new Date();
    
    // Calculate milliseconds until next minute boundary
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    // Add 500ms to get to 500ms after the minute
    const msToWait = msToNextMinute + 500;
    
    // Calculate the target time for logging
    const targetTime = new Date(now.getTime() + msToWait);
    
    logger.debug(`Waiting ${msToWait}ms until ${targetTime.toISOString()} (${msToNextMinute}ms to next minute + 500ms)`);
    logger.debug(`Current time: ${now.toISOString()}`);
    
    // Wait until the target time
    if (msToWait > 0) {
      await new Promise(resolve => setTimeout(resolve, msToWait));
    } else {
      // If for some reason we calculated a negative wait time, just wait until next minute + 500ms
      const nextMinute = new Date(now);
      nextMinute.setMinutes(nextMinute.getMinutes() + 1, 0, 500);
      const fallbackWait = nextMinute.getTime() - now.getTime();
      logger.debug(`Fallback wait: ${fallbackWait}ms to ${nextMinute.toISOString()}`);
      await new Promise(resolve => setTimeout(resolve, fallbackWait));
    }
    
    // Log the actual time after waiting
    const afterWait = new Date();
    const actualWait = afterWait.getTime() - now.getTime();
    const drift = afterWait.getTime() - targetTime.getTime();
    
    logger.debug(`Resumed at: ${afterWait.toISOString()} ` +
                 `(target: ${targetTime.toISOString()}, ` +
                 `expected wait: ${msToWait}ms, ` +
                 `actual wait: ${actualWait}ms, ` +
                 `drift: ${drift}ms)`);
  }

  async startTradingCycle() {
    if (this.isRunning) {
      logger.warn('Trading cycle already running');
      return;
    }

    try {
      logger.info('Starting trading cycle...');
      this.isRunning = true;
      
      // Initialize accounts and load initial data
      await this.loadAccounts();
      await this.initialize();
      
      // Start the main trading loop
      this.tradingLoop().catch(error => {
        logger.error('Error in trading loop:', error);
      });
      
      return true;
    } catch (error) {
      logger.error('Failed to start trading cycle:', error);
      throw error;
    }
  }

  /**
   * Check for any filled limit orders and process them
   */
  async checkFilledLimitOrders() {
    try {
      if (this.activeLimitOrders.size === 0) return;
      
      logger.debug(`Checking ${this.activeLimitOrders.size} active limit orders...`);
      
      // Create a copy of the active orders to avoid modification during iteration
      const orderIds = Array.from(this.activeLimitOrders.keys());
      
      for (const orderId of orderIds) {
        try {
          const orderInfo = this.activeLimitOrders.get(orderId);
          if (!orderInfo) continue;
          
          logger.debug(`Checking status of limit order ${orderId}...`);
          
          // Check the order status
          const status = await this.coinbaseService.getOrderStatus(orderId);
          
          if (status.status === 'FILLED' && !status.alreadyProcessed) {
            logger.info(`Limit order ${orderId} has been filled!`);
            
            // Notify about the filled order
            const { amount, buyPrice, orderType } = orderInfo;
            const fillPrice = status.average_fill_price || orderInfo.price;
            const total = parseFloat(fillPrice) * parseFloat(amount);
            
            // Send notification
            await this.notifySellOrder(
              status.order || { id: orderId },
              parseFloat(amount),
              parseFloat(fillPrice),
              total,
              ((fillPrice - buyPrice) / buyPrice * 100).toFixed(2)
            );
            
            // Remove from active orders
            this.activeLimitOrders.delete(orderId);
            
            logger.info(`Processed filled limit order ${orderId}`);
          } else if (['CANCELLED', 'EXPIRED', 'REJECTED', 'FAILED'].includes(status.status)) {
            logger.warn(`Limit order ${orderId} has status: ${status.status}`);
            this.activeLimitOrders.delete(orderId);
          }
          
        } catch (error) {
          logger.error(`Error checking status of order ${orderId}:`, error.message || error);
          // Don't remove the order on error - we'll try again next time
        }
      }
      
    } catch (error) {
      logger.error('Error in checkFilledLimitOrders:', error.message || error);
    }
  }
  
  /**
   * Add a limit order to the tracking system
   * @param {string} orderId - The order ID from the exchange
   * @param {number} amount - The amount of base currency in the order
   * @param {number} price - The limit price of the order
   * @param {number} buyPrice - The original buy price (for profit calculation)
   * @param {string} orderType - Type of order (e.g., 'SELL_LIMIT')
   */
  trackLimitOrder(orderId, amount, price, buyPrice, orderType = 'SELL_LIMIT') {
    if (!orderId) {
      logger.warn('Cannot track order: No order ID provided');
      return;
    }
    
    this.activeLimitOrders.set(orderId, {
      amount,
      price,
      buyPrice,
      orderType,
      timestamp: Date.now()
    });
    
    logger.info(`Tracking new ${orderType} order ${orderId} for ${amount} @ ${price}`);
  }

  async tradingLoop() {
    let lastHourlyUpdate = Date.now();
    let lastOrderCheck = 0;
    const ORDER_CHECK_INTERVAL = 30000; // Check order status every 30 seconds
    let cycleError = null;
    
    try {
      while (this.isRunning) {
        try {
          const now = Date.now();
          
          // Update hourly candles every hour
          if (now - lastHourlyUpdate >= 3600000) {
            await this.updateHourlyCandles(true);
            lastHourlyUpdate = now;
          }
          
          // Check for filled limit orders periodically
          if (now - lastOrderCheck >= ORDER_CHECK_INTERVAL) {
            await this.checkFilledLimitOrders();
            lastOrderCheck = now;
          }
          
          // Fetch latest candle data
          await this.fetchCandleData();
          
          // Calculate indicators
          if (this.candles.length > 0) {
            this.calculateIndicators();
            
            // Check and execute trades
            await this.checkAndExecuteTrades();
            
            // Log current status periodically
            if (now % 60000 < 1000) { // Log roughly every minute
              this.logTradeCycle();
            }
          }
          
          // Wait until the next minute
          await this.waitForNextMinute();
          
        } catch (error) {
          logger.error('Error in trading cycle iteration:', error);
          // Wait a bit before retrying to prevent tight error loops
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    } finally {
      // Final cleanup
      this.isRunning = false;
      logger.info('Trading cycle stopped');
    }
  }

  async getAccountBalances() {
    try {
      logger.info('Fetching account balances...');
      
      // Get all accounts
      const response = await this.client.getAccounts();
      
      const accounts = response.accounts || [];
      
      if (accounts.length === 0) {
        logger.warn('No accounts found');
        return {};
      }
      
      // Log all account currencies for debugging
      const accountCurrencies = [...new Set(accounts.map(acc => acc.currency))];
      logger.debug(`Available account currencies: ${accountCurrencies.join(', ')}`);
      
      // Log raw account data for debugging
      logger.debug('Raw account data:', JSON.stringify(accounts, null, 2));
      
      // Filter for configured base and quote currency accounts
      const filteredAccounts = {};
      const foundCurrencies = [];
      
      for (const account of accounts) {
        if ([this.baseCurrency, this.quoteCurrency].includes(account.currency)) {
          // Try different property names for balance, including EurBalance for USDC
          const availableBalance = 
            (account.currency === 'USDC' && account.EurBalance) ? account.EurBalance :
            account.available_balance?.value || 
            account.available_balance || 
            account.balance?.available || 
            '0';
          
          const holdBalance = 
            account.hold?.value || 
            account.hold || 
            account.balance?.hold || 
            '0';
          
          // Parse and validate the balance values
          const available = parseFloat(availableBalance);
          const hold = parseFloat(holdBalance);
          
          if (isNaN(available) || isNaN(hold)) {
            logger.warn(`Invalid balance values for ${account.currency}: available=${availableBalance}, hold=${holdBalance}`);
            continue;
          }
          
          // Format the balance based on currency type
          const formattedAvailable = this.formatPrice(available, account.currency);
          const formattedHold = this.formatPrice(hold, account.currency);
          
          filteredAccounts[account.currency] = {
            available: formattedAvailable,
            balance: formattedAvailable, // Using available as the main balance
            hold: formattedHold
          };
          
          foundCurrencies.push(account.currency);
          logger.debug(`Processed account ${account.currency}: available=${formattedAvailable}, hold=${formattedHold}`);
        }
      }
      
      // Check if we found both required accounts
      const missingCurrencies = [this.baseCurrency, this.quoteCurrency].filter(
        curr => !foundCurrencies.includes(curr)
      );
      
      if (missingCurrencies.length > 0) {
        logger.warn(`Missing required accounts for currencies: ${missingCurrencies.join(', ')}`);
      } else {
        logger.info(`Successfully loaded ${foundCurrencies.length} accounts: ${foundCurrencies.join(', ')}`);
      }
      
      this.accounts = filteredAccounts;
      return filteredAccounts;
      
    } catch (error) {
      const errorMsg = `Failed to load accounts: ${error.message}`;
      logger.error(errorMsg, { error });
      throw new Error(errorMsg);
    } finally {
      // Clean up any resources if needed
    }
  }
} // End of SyrupTradingBot class

// Format currency with symbol
function formatCurrency(amount, currency) {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 8
  });
  return formatter.format(amount);
}

// Main function
async function main() {
  try {
    console.log('\n=== Starting SYRUP-USDC Trading Bot ===\n');
    
    const bot = new SyrupTradingBot();
    
    // Start the trading cycle
    console.log('\n=== Starting Trading Cycle ===');
    console.log('Bot is now running. Press Ctrl+C to stop.');
    
    // Handle process termination
    process.on('SIGINT', async () => {
      console.log('\nStopping trading bot...');
      bot.isRunning = false;
      if (bot.cycleTimeout) {
        clearTimeout(bot.cycleTimeout);
      }
      console.log('Trading bot stopped.');
      process.exit(0);
    });
    
    // Start the trading cycle
    await bot.startTradingCycle();
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.response) {
      console.error('API Error:', error.response.data || error.response.statusText);
    }
    process.exit(1);
  }
}

// Run the bot
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}

export default SyrupTradingBot;

