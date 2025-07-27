// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
  // Log the error to the file for permanent record
  try {
    // Use a basic console.error as logger might not be initialized
    console.error(`Unhandled Rejection: ${reason?.stack || reason}`);
  } catch (e) {
    console.error('Logging the unhandled rejection failed:', e);
  }
  // Exit the process to prevent unpredictable state
  process.exit(1);
});

import { CBAdvancedTradeClient } from 'coinbase-api';
import dotenv from 'dotenv';
import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import TrailingStopManager from './trailingStopManager.js';
import TechnicalIndicators from './technicalIndicators.js';
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

// Messages to filter out from console output
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

// Configure logger with consolidated transports
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    // Console transport with filtering and formatting
    new winston.transports.Console({
      level: 'debug',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
        winston.format.printf(info => {
          // Always show buy signal related logs
          if (info.message && info.message.includes('Buy Signal -')) {
            return `${info.level}: ${info.message}`;
          }
          
          // Filter out unwanted messages
          if (filteredMessages.some(msg => info.message && info.message.includes && info.message.includes(msg))) {
            return false;
          }
          
          // Show all other debug logs with level prefix
          if (info.level === 'debug') {
            return `[${info.level}]: ${info.message}`;
          }
          
          return `${info.level}: ${info.message}`;
        })
      )
    }),
    
    // Error log file (errors only)
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 7, // Keep 7 days of logs
      tailable: true
    }),
    
    // Combined log file (all levels)
    new winston.transports.File({
      filename: path.join(logsDir, 'syrup-bot-combined.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 7, // Keep 7 days of logs
      tailable: true
    }),
    
    // Trade cycle specific log
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
    
    // Debug log file (all debug messages)
    new winston.transports.File({
      filename: path.join(logsDir, 'debug.log'),
      level: 'debug',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
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
    
    // Initialize TrailingStopManager
    this.trailingStop = new TrailingStopManager(this.coinbaseService, logger);
    logger.info('Trailing stop manager initialized');
    
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
      minScore: 5,    // Minimum score out of 10 to consider a buy (4 tech + 3 dip + 3 24h low)
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
      volumeSpikeMultiplier: 1.3,  // Reduced from 1.5 to be less strict
      minDipPercent: 0.5,  // Reduced from 1.5% to 0.5% below 60-min high
      maxDipPercent: 5.0,  // Increased from 4% to 5% below 60-min high
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
  /**
   * Get formatted account balances for display
  /** 
  /**
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
  /**
   * Get formatted list of open orders for display in Telegram
  /** 
  /**
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
      
      // Format each order and calculate total potential earnings
      const formattedOrders = [];
      let totalPotentialEarnings = 0;
      let totalSyrupForSale = 0;
      
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
          // Calculate potential value for this order (only for sell orders)
          let orderPotentialValue = 0;
          if (order.side === 'SELL' && remaining > 0) {
            orderPotentialValue = remaining * price;
            totalPotentialEarnings += orderPotentialValue;
            totalSyrupForSale += remaining;
          }
          
          const orderLines = [
            `\n${i + 1}. ${orderType} ${formattedSize} ${this.baseCurrency} @ ${formattedPrice} ${this.quoteCurrency}`,
            `   Status: ${order.status || 'UNKNOWN'} (${filledPct.toFixed(1)}% filled)`,
            `   Value: ${formattedValue} ${this.quoteCurrency}`
          ];
          
          // Add potential earnings for sell orders
          if (order.side === 'SELL' && remaining > 0) {
            orderLines.push(`   Potential: ${orderPotentialValue.toFixed(2)} ${this.quoteCurrency}`);
          }
          
          orderLines.push(`   Created: ${new Date(order.created_time).toLocaleString()}`);
          
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
      
      // Add summary of potential earnings from sell orders
      let summaryLines = [];
      if (totalSyrupForSale > 0) {
        const avgSellPrice = totalPotentialEarnings / totalSyrupForSale;
        summaryLines.push(
          '\n💹 *Potential Earnings Summary*',
          `Total ${this.baseCurrency} for Sale: ${totalSyrupForSale.toFixed(1)}`,
          `Average Sell Price: ${avgSellPrice.toFixed(4)} ${this.quoteCurrency}`,
          `Total Potential: ${totalPotentialEarnings.toFixed(2)} ${this.quoteCurrency}`
        );
      }
      
      // Combine all orders and summary into a single message
      const header = `📋 *Open Orders (${formattedOrders.length})*`;
      const message = [header, ...formattedOrders, ...summaryLines].join('\n');
      
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
    const HOURLY_CACHE_FILE = path.join(scriptDir, 'hourly_candle_cache.json');
    
    try {
      logger.debug('[HourlyCandles] Loading hourly candles from cache file');
      
      // Check if the cache file exists
      try {
        await fs.access(HOURLY_CACHE_FILE);
        logger.debug(`[HourlyCandles] Cache file found: ${HOURLY_CACHE_FILE}`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          logger.warn('[HourlyCandles] No hourly cache file found, will create a new one');
          return [];
        }
        logger.error(`[HourlyCandles] Error accessing hourly cache file: ${error.message}`);
        throw error;
      }
      
      // Read and parse cache file
      try {
        const data = await fs.readFile(HOURLY_CACHE_FILE, 'utf8');
        if (!data || data.trim() === '') {
          logger.warn('[HourlyCandles] Hourly cache file is empty');
          return [];
        }
        
        const parsed = JSON.parse(data);
        logger.debug(`[HourlyCandles] Successfully parsed hourly cache file: ${typeof parsed}`);
        
        // Validate parsed data structure
        if (!parsed || typeof parsed !== 'object') {
          logger.error(`[HourlyCandles] Invalid hourly cache format: ${typeof parsed}`);
          return [];
        }
        
        if (!Array.isArray(parsed.candles)) {
          logger.error(`[HourlyCandles] Missing or invalid candles array: ${typeof parsed.candles}`);
          return [];
        }
        
        logger.debug(`[HourlyCandles] Found ${parsed.candles.length} raw hourly candles in cache`);
        
        // Check if metadata is reversed
        if (parsed.metadata) {
          const firstCandleTime = new Date(parsed.metadata.firstCandle).getTime();
          const lastCandleTime = new Date(parsed.metadata.lastCandle).getTime();
          
          if (firstCandleTime > lastCandleTime) {
            logger.warn('[HourlyCandles] Detected reversed metadata in hourly candle cache');
            // We'll fix this when we save the processed candles
          }
        }
        
        // Process and validate each candle
        const candles = [];
        let validCandles = 0;
        let invalidCandles = 0;
        let nonNumericFields = 0;
        
        for (const candle of parsed.candles) {
          try {
            const processed = processCandle(candle);
            if (processed) {
              // Ensure all required fields are numeric
              const requiredFields = ['open', 'high', 'low', 'close', 'volume'];
              const hasNonNumericFields = requiredFields.some(field => 
                typeof processed[field] !== 'number' || isNaN(processed[field])
              );
              
              if (hasNonNumericFields) {
                nonNumericFields++;
                continue;
              }
              
              candles.push(processed);
              validCandles++;
            } else {
              invalidCandles++;
            }
          } catch (candleError) {
            logger.debug(`[HourlyCandles] Error processing candle: ${candleError.message}`);
            invalidCandles++;
          }
        }
        
        if (invalidCandles > 0 || nonNumericFields > 0) {
          logger.warn(`[HourlyCandles] Found ${invalidCandles} invalid candles and ${nonNumericFields} candles with non-numeric fields`);
        }
        
        if (candles.length === 0) {
          logger.error('[HourlyCandles] No valid hourly candles found in cache');
          return [];
        }
        
        // Sort by time (oldest first) - this is critical for indicator calculations
        candles.sort((a, b) => a.time - b.time);
        
        // Log if candles were originally in reverse order
        const originalOrder = parsed.candles.map(c => c.time);
        const sortedOrder = candles.map(c => c.time);
        const wasReversed = originalOrder.length > 1 && 
                          originalOrder[0] > originalOrder[originalOrder.length - 1] &&
                          sortedOrder[0] < sortedOrder[sortedOrder.length - 1];
        
        if (wasReversed) {
          logger.warn('[HourlyCandles] Candles were in reverse order and have been sorted correctly (oldest first)');
        }
        
        // Remove duplicates
        const uniqueCandles = candles.filter((candle, index, array) => 
          index === 0 || candle.time !== array[index - 1].time
        );
        
        if (uniqueCandles.length < candles.length) {
          logger.debug(`[HourlyCandles] Removed ${candles.length - uniqueCandles.length} duplicate candles`);
        }
        
        // Limit to last MAX_HOURLY_CANDLES candles
        const limitedCandles = uniqueCandles.slice(-MAX_HOURLY_CANDLES);
        
        // Log time range of candles
        if (limitedCandles.length > 0) {
          const firstCandle = limitedCandles[0];
          const lastCandle = limitedCandles[limitedCandles.length - 1];
          const startTime = new Date(firstCandle.time * 1000).toISOString();
          const endTime = new Date(lastCandle.time * 1000).toISOString();
          logger.info(`[HourlyCandles] Loaded ${limitedCandles.length} hourly candles from ${startTime} to ${endTime}`);
        }
        
        logger.info(`[HourlyCandles] Successfully loaded ${limitedCandles.length} valid hourly candles from cache (${invalidCandles} invalid, limited to last ${MAX_HOURLY_CANDLES} candles)`);
        return limitedCandles;
      } catch (parseError) {
        logger.error(`[HourlyCandles] Error parsing hourly cache file: ${parseError.message}`);
        return [];
      }
    } catch (error) {
      logger.error(`[HourlyCandles] Critical error loading hourly candles: ${error.message}`, { stack: error.stack });
      return [];
    }
  }

  /**
  /**
   * Load candles from cache file
  /** 
  /**
   * @returns {Promise<Array>} Array of processed candles
   */
  async loadCandlesFromCache() {
    try {
      logger.info('Loading candles from cache...');
      
      const data = await fs.readFile(CACHE_FILE, 'utf8');
      logger.debug(`Read ${data.length} bytes from candle cache file`);
      
      const parsed = JSON.parse(data);
      
      // Validate and parse cached candles
      if (!parsed || !Array.isArray(parsed.candles)) {
        logger.warn('Invalid cache file format or empty candles array');
        this.candles = [];
        return [];
      }
      
      logger.debug(`Raw cache contains ${parsed.candles.length} candles`);
      
      if (parsed.candles.length > 0) {
        logger.debug(`First raw candle sample: ${JSON.stringify(parsed.candles[0])}`);
        logger.debug(`Last raw candle sample: ${JSON.stringify(parsed.candles[parsed.candles.length-1])}`);
      }
      
      const candles = [];
      let validCandles = 0;
      let invalidCandles = 0;
      
      // Process each candle and validate it
      for (const candle of parsed.candles) {
        const processed = processCandle(candle);
        if (processed) {
          // Ensure all numeric fields are actually numbers
          if (typeof processed.open === 'string') processed.open = parseFloat(processed.open);
          if (typeof processed.high === 'string') processed.high = parseFloat(processed.high);
          if (typeof processed.low === 'string') processed.low = parseFloat(processed.low);
          if (typeof processed.close === 'string') processed.close = parseFloat(processed.close);
          if (typeof processed.volume === 'string') processed.volume = parseFloat(processed.volume);
          
          // Verify all required fields are present and valid
          if (processed.time && 
              !isNaN(processed.open) && 
              !isNaN(processed.high) && 
              !isNaN(processed.low) && 
              !isNaN(processed.close) && 
              !isNaN(processed.volume)) {
            candles.push(processed);
            validCandles++;
          } else {
            logger.debug(`Invalid candle data: ${JSON.stringify(processed)}`);
            invalidCandles++;
          }
        } else {
          invalidCandles++;
        }
      }
      
      logger.debug(`After processing: ${validCandles} valid candles, ${invalidCandles} invalid candles`);
      
      if (candles.length === 0) {
        logger.warn('No valid candles found in cache file');
        this.candles = [];
        return [];
      }
      
      // Sort by time (oldest first) and remove duplicates
      const uniqueCandles = candles
        .sort((a, b) => a.time - b.time)
        .filter((candle, index, array) => 
          index === 0 || candle.time !== array[index - 1].time
        );
      
      // Check if we have enough candles for indicators
      const sufficientForMacd = uniqueCandles.length >= 26;
      const sufficientForEma = uniqueCandles.length >= 20;
      
      logger.info(`Loaded ${uniqueCandles.length} valid candles from cache (${invalidCandles} invalid)`);
      logger.info(`Sufficient for indicators: MACD=${sufficientForMacd ? 'YES' : 'NO'}, EMA20=${sufficientForEma ? 'YES' : 'NO'}`);
      
      // Verify candle data quality
      const sampleSize = Math.min(5, uniqueCandles.length);
      if (sampleSize > 0) {
        const samples = uniqueCandles.slice(-sampleSize);
        const validPrices = samples.every(c => 
          typeof c.open === 'number' && !isNaN(c.open) &&
          typeof c.high === 'number' && !isNaN(c.high) &&
          typeof c.low === 'number' && !isNaN(c.low) &&
          typeof c.close === 'number' && !isNaN(c.close)
        );
        
        logger.debug(`Price data quality check (last ${sampleSize} candles): ${validPrices ? 'VALID' : 'INVALID'}`);
        
        if (!validPrices) {
          logger.warn('Invalid price data detected in candles, attempting to fix...');
          // Attempt to fix invalid price data
          for (const candle of uniqueCandles) {
            candle.open = typeof candle.open === 'number' ? candle.open : parseFloat(candle.open) || 0;
            candle.high = typeof candle.high === 'number' ? candle.high : parseFloat(candle.high) || 0;
            candle.low = typeof candle.low === 'number' ? candle.low : parseFloat(candle.low) || 0;
            candle.close = typeof candle.close === 'number' ? candle.close : parseFloat(candle.close) || 0;
            candle.volume = typeof candle.volume === 'number' ? candle.volume : parseFloat(candle.volume) || 0;
          }
        }
      }
      
      if (uniqueCandles.length > 0) {
        const firstCandle = uniqueCandles[0];
        const lastCandle = uniqueCandles[uniqueCandles.length - 1];
        const firstTime = new Date(firstCandle.time * 1000).toISOString();
        const lastTime = new Date(lastCandle.time * 1000).toISOString();
        const timeRangeMinutes = Math.round((lastCandle.time - firstCandle.time) / 60);
        
        logger.info(`Candle time range: ${timeRangeMinutes} minutes (${firstTime} to ${lastTime})`);
        logger.debug(`First candle: ${JSON.stringify(firstCandle)}`);
        logger.debug(`Last candle: ${JSON.stringify(lastCandle)}`);
        
        // Check if we have enough candles for indicator calculations
        if (uniqueCandles.length < 26) {
          logger.warn(`WARNING: Only ${uniqueCandles.length} candles loaded from cache. At least 26 candles are needed for MACD calculation.`);
        } else {
          logger.info(`Successfully loaded ${uniqueCandles.length} candles from cache, sufficient for indicator calculations.`);
        }
      }
      
      // Assign to this.candles
      this.candles = uniqueCandles;
      return uniqueCandles;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn('Candle cache file not found, will create on next save');
      } else {
        logger.error('Error reading or parsing candle cache file:', error);
      }
      this.candles = [];
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
    const HOURLY_CACHE_FILE = path.join(scriptDir, 'hourly_candle_cache.json');
    let tempPath = '';
    
    try {
      if (!this.hourlyCandles || this.hourlyCandles.length === 0) {
        logger.warn('[HourlyCandles] No hourly candles to save to cache');
        return;
      }
      
      // Sort candles by time (oldest first)
      const sortedCandles = [...this.hourlyCandles].sort((a, b) => a.time - b.time);
      
      // Ensure all candle fields are numbers, not strings
      const processedCandles = sortedCandles.map(candle => ({
        time: typeof candle.time === 'string' ? parseInt(candle.time, 10) : candle.time,
        open: typeof candle.open === 'string' ? parseFloat(candle.open) : candle.open,
        high: typeof candle.high === 'string' ? parseFloat(candle.high) : candle.high,
        low: typeof candle.low === 'string' ? parseFloat(candle.low) : candle.low,
        close: typeof candle.close === 'string' ? parseFloat(candle.close) : candle.close,
        volume: typeof candle.volume === 'string' ? parseFloat(candle.volume) : candle.volume
      }));
      
      // Create metadata - ensure firstCandle is older than lastCandle
      const firstCandle = processedCandles[0];
      const lastCandle = processedCandles[processedCandles.length - 1];
      
      const metadata = {
        tradingPair: this.tradingPair,
        granularity: '1h',
        count: processedCandles.length,
        firstCandle: new Date(firstCandle.time * 1000).toISOString(),
        lastCandle: new Date(lastCandle.time * 1000).toISOString(),
        savedAt: new Date().toISOString()
      };
      
      // Verify metadata is correctly ordered
      const firstTime = new Date(metadata.firstCandle).getTime();
      const lastTime = new Date(metadata.lastCandle).getTime();
      
      if (firstTime > lastTime) {
        logger.warn('[HourlyCandles] Metadata ordering issue detected and fixed');
        // Swap the values to fix the ordering
        [metadata.firstCandle, metadata.lastCandle] = [metadata.lastCandle, metadata.firstCandle];
      }
      
      // Create cache object
      const cacheData = {
        metadata,
        candles: processedCandles
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
      
      logger.info(`[HourlyCandles] Saved ${processedCandles.length} hourly candles to cache`);
      logger.debug(`[HourlyCandles] Time range: ${metadata.firstCandle} to ${metadata.lastCandle}`);
      
    } catch (error) {
      logger.error('[HourlyCandles] Error saving hourly candles to cache:', error);
      // Don't throw, as this isn't a critical error
      logger.warn('[HourlyCandles] Continuing without saving to hourly cache');
      
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
  /**
   * Fetches initial candle data from the API and processes it
  /** 
  /**
   * @returns {Promise<Array>} Array of processed candles
  /** 
  /**
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
  /**
   * Backfills candle data by breaking down large time ranges into smaller windows
  /** 
  /**
   * to avoid API time range limits.
  /** 
  /**
   * @param {number} startTime - Start time in seconds
  /** 
  /**
   * @param {number} endTime - End time in seconds
  /** 
  /**
   * @param {number} [maxWindowHours=4] - Maximum window size in hours
  /** 
  /**
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
    
    // If this is the first fetch and we have no candles, try to load from cache first
    if (!this._initialCandleLoadDone && (!this.candles || this.candles.length === 0)) {
      logger.info('First fetch detected, attempting to load candles from cache first');
      try {
        await this.loadCandlesFromCache();
        logger.info(`Loaded ${this.candles?.length || 0} candles from cache`);
        this._initialCandleLoadDone = true;
      } catch (error) {
        logger.warn('Failed to load candles from cache, will fetch from API', { error: error.message });
      }
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
    const defaultIndicatorValue = null;
    logger.debug('--- Entering calculateIndicators ---');

    try {
        if (!this.candles || this.candles.length < 20) {
            logger.warn(`Not enough candle data to calculate all indicators. Have ${this.candles?.length || 0}, need at least 20.`);
            // Reset indicators to default if not enough data
            this.indicators = { 
                ...this.indicators, 
                ema20: defaultIndicatorValue, 
                rsi: defaultIndicatorValue, 
                macd: null, 
                bb: null, 
                stochK: defaultIndicatorValue, 
                stochD: defaultIndicatorValue 
            };
            return;
        }

        const closes = this.candles.map(c => parseFloat(c.close));
        const highs = this.candles.map(c => parseFloat(c.high));
        const lows = this.candles.map(c => parseFloat(c.low));
        
        logger.debug(`Calculating indicators with ${closes.length} data points.`);

        // Initialize with default values
        let ema20 = defaultIndicatorValue, ema50 = defaultIndicatorValue, ema200 = defaultIndicatorValue;
        let rsi = defaultIndicatorValue;
        let stoch = { k: defaultIndicatorValue, d: defaultIndicatorValue };
        let bb = { upper: defaultIndicatorValue, middle: defaultIndicatorValue, lower: defaultIndicatorValue };
        let macd = { MACD: defaultIndicatorValue, signal: defaultIndicatorValue, histogram: defaultIndicatorValue };

        // --- EMA Calculations ---
        try {
            // Use TechnicalIndicators class for EMA calculation
            const ema20Array = TechnicalIndicators.calculateEMA(closes, 20);
            if (ema20Array.length > 0) ema20 = ema20Array[ema20Array.length - 1];
            logger.debug(`EMA20 calculation result: ${ema20}`);
        } catch (e) { logger.error(`Error calculating EMA20: ${e.message}`); }

        try {
            const ema50Array = TechnicalIndicators.calculateEMA(closes, 50);
            if (ema50Array.length > 0) ema50 = ema50Array[ema50Array.length - 1];
        } catch (e) { logger.error(`Error calculating EMA50: ${e.message}`); }

        try {
            const ema200Array = TechnicalIndicators.calculateEMA(closes, 200);
            if (ema200Array.length > 0) ema200 = ema200Array[ema200Array.length - 1];
        } catch (e) { logger.error(`Error calculating EMA200: ${e.message}`); }

        // --- RSI Calculation ---
        try {
            const rsiResult = TechnicalIndicators.calculateRSI(closes);
            rsi = rsiResult.value;
        } catch (e) { logger.error(`Error calculating RSI: ${e.message}`); }

        // --- MACD Calculation ---
        try {
            const macdResult = TechnicalIndicators.calculateMACD(closes);
            macd = {
                MACD: macdResult.macd,
                signal: macdResult.signal,
                histogram: macdResult.histogram
            };
            logger.debug(`MACD calculation result: ${JSON.stringify(macd)}`);
        } catch (e) { logger.error(`Error calculating MACD: ${e.message}`); }

        // --- Bollinger Bands Calculation ---
        try {
            const bbResult = TechnicalIndicators.calculateBollingerBands(closes);
            bb = {
                upper: bbResult.upper,
                middle: bbResult.middle,
                lower: bbResult.lower
            };
        } catch (e) { logger.error(`Error calculating Bollinger Bands: ${e.message}`); }

        // --- Stochastic Calculation (simplified as we don't have a direct method) ---
        try {
            // For now, leave stoch as default until we implement or import a stochastic oscillator
            stoch = { k: 50, d: 50 }; // Default neutral values
        } catch (e) { logger.error(`Error calculating Stochastic: ${e.message}`); }

        const currentPrice = closes.length > 0 ? closes[closes.length - 1] : 0;
        const currentVolume = this.candles.length > 0 ? parseFloat(this.candles[this.candles.length - 1].volume) : 0;

        // Store the latest values
        this.indicators = {
            ...this.indicators,
            price: currentPrice,
            volume: currentVolume,
            ema20, ema50, ema200, rsi,
            stochK: stoch.k, stochD: stoch.d,
            bbUpper: bb.upper, bbMiddle: bb.middle, bbLower: bb.lower,
            macd: macd.MACD, macdSignal: macd.signal, macdHistogram: macd.histogram,
        };

        logger.debug('Finished indicator calculation. Results:', { 
            rsi: this.indicators.rsi, 
            ema20: this.indicators.ema20, 
            macdHist: this.indicators.macdHistogram 
        });

    } catch (error) {
        logger.error('!!! CRITICAL ERROR in calculateIndicators !!!', error);
        // Fallback to ensure indicators object is not left in a broken state
        this.indicators = { 
            ...this.indicators, 
            ema20: defaultIndicatorValue, 
            rsi: defaultIndicatorValue, 
            macd: null, 
            bb: null, 
            stochK: defaultIndicatorValue, 
            stochD: defaultIndicatorValue 
        };
    }
  }

  // Calculate dip score optimized for 1-minute trading
  calculateDipScore(currentPrice) {
    let score = 0;
    const reasons = [];
    const metrics = {};
    
    try {
      // 1. Get recent price lows for different timeframes (in minutes)
      const fiveMinLow = this.getRecentLow(5);
      const fifteenMinLow = this.getRecentLow(15);
      const oneHourLow = this.getRecentLow(60);
      
      // 2. Calculate percentage above each low (safeguard against division by zero)
      const pctAbove5m = fiveMinLow > 0 ? ((currentPrice - fiveMinLow) / fiveMinLow) * 100 : 0;
      const pctAbove15m = fifteenMinLow > 0 ? ((currentPrice - fifteenMinLow) / fifteenMinLow) * 100 : 0;
      const pctAbove1h = oneHourLow > 0 ? ((currentPrice - oneHourLow) / oneHourLow) * 100 : 0;
      
      // Store metrics for debugging
      metrics.pctAbove5m = pctAbove5m;
      metrics.pctAbove15m = pctAbove15m;
      metrics.pctAbove1h = pctAbove1h;
      
      // 3. Calculate volume metrics (5-minute average)
      const volume5mAvg = this.calculateVolumeAverage(5);
      const currentVolume = this.candles[this.candles.length - 1]?.volume || 0;
      const volumeRatio = volume5mAvg > 0 ? (currentVolume / volume5mAvg) : 1;
      metrics.volumeRatio = volumeRatio;
      
      // 4. Score based on 5-minute low position (0-2 points)
      if (pctAbove5m <= 0.05) {  // Within 0.05% of 5-min low
        score += 2.0;
        reasons.push('At 5-min low (strong dip)');
      } else if (pctAbove5m <= 0.1) {
        score += 1.5;
        reasons.push('Near 5-min low (good dip)');
      } else if (pctAbove5m <= 0.2) {
        score += 0.5;
        reasons.push('Approaching 5-min low');
      }
      
      // 5. Score based on 15-minute low position (0-2 points)
      if (pctAbove15m <= 0.1) {  // Within 0.1% of 15-min low
        score += 2.0;
        reasons.push('At 15-min low (strong dip)');
      } else if (pctAbove15m <= 0.25) {
        score += 1.0;
        reasons.push('Near 15-min low');
      } else if (pctAbove15m <= 0.5) {
        score += 0.5;
        reasons.push('Approaching 15-min low');
      }
      
      // 6. Add volume spike bonus (0-1 point)
      if (volumeRatio >= 2.0) {  // 200% of 5-min average
        score += 1.0;
        reasons.push('Strong volume spike (200%+)');
      } else if (volumeRatio >= 1.5) {
        score += 0.5;
        reasons.push('Moderate volume increase (150%+)');
      }
      
      // 7. Cap at 5 points (the max for dip score)
      score = Math.min(5.0, score);
      
      logger.debug('Dip score calculation:', {
        currentPrice,
        fiveMinLow,
        fifteenMinLow,
        oneHourLow,
        pctAbove5m,
        pctAbove15m,
        pctAbove1h,
        volumeRatio,
        score
      });
      
    } catch (error) {
      logger.error('Error in calculateDipScore:', error);
      return { score: 0, reasons: ['Error calculating dip score'], metrics: {} };
    }
    
    return {
      score: parseFloat(score.toFixed(2)),
      reasons,
      metrics
    };
  }
  
  // Calculate volume average over specified number of minutes
  calculateVolumeAverage(minutes) {
    try {
      const recentCandles = this.candles.slice(-minutes);
      if (recentCandles.length === 0) return 0;
      
      const sum = recentCandles.reduce((acc, candle) => acc + parseFloat(candle.volume || 0), 0);
      return sum / recentCandles.length;
    } catch (error) {
      logger.error('Error calculating volume average:', error);
      return 0;
    }
  }

  // Calculate buy score based on technical indicators (0-10)
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
    
    // 1. RSI - Weighted scoring (Max 2.0 pts)
    if (rsi <= 30) {
      score += 2.0;
      reasons.push(`RSI ${rsi.toFixed(1)} (Strong Oversold)`);
    } else if (rsi <= 40) {
      score += 1.6;
      reasons.push(`RSI ${rsi.toFixed(1)} (Oversold)`);
    } else if (rsi <= 50) {
      score += 0.8;
      reasons.push(`RSI ${rsi.toFixed(1)} (Neutral)`);
    } else if (rsi <= 60) {
      score += 0.4;
      reasons.push(`RSI ${rsi.toFixed(1)} (Mildly Overbought)`);
    }
    
    // 2. Stochastic - Enhanced scoring (Max 2.0 pts)
    if (stochK < 20 && stochD < 20) {
      score += 1.6;
      reasons.push(`Stoch K:${stochK.toFixed(1)} D:${stochD.toFixed(1)} (Oversold)`);
    } else if (stochK > stochD) {
      if (stochK < 30) {
        score += 1.2;
        reasons.push('Stoch K > D in oversold zone (Strong Buy)');
      } else {
        score += 0.6;
        reasons.push('Stoch K > D (Buy)');
      }
    }
    
    // 3. MACD - Enhanced scoring (Max 2.0 pts)
    if (macd.histogram > 0) {
      if (macd.histogram > macd.signal * 1.2) {
        score += 1.2;
        reasons.push('MACD histogram strongly positive');
      } else {
        score += 0.8;
        reasons.push('MACD histogram positive');
      }
    }
    
    // Additional point for MACD line above signal line
    if (macd.MACD > macd.signal) {
      score += 0.4;
      reasons.push('MACD line > Signal line');
    }
    
    // 4. Price vs EMAs (Max 2 pts)
    if (price > ema) {
      score += 1.0;
      reasons.push('Price > EMA(20)');
      
      // Additional points for being above longer EMAs
      if (indicators.ema50 && price > indicators.ema50) {
        score += 0.5;
        reasons.push('Price > EMA(50)');
      }
      if (indicators.ema200 && price > indicators.ema200) {
        score += 0.5;
        reasons.push('Price > EMA(200)');
      }
    }
    
    // 5. Bollinger Bands with enhanced scoring (Max 2.0 pts)
    if (bb && typeof bb === 'object' && bb.lower !== undefined) {
      const bbWidth = bb.upper - bb.lower;
      const pricePosition = (price - bb.lower) / bbWidth;
      
      if (price <= bb.lower) {
        score += 2.0; // Strong buy signal when price is at or below lower BB
        reasons.push('Price at or below lower BB (Strong Buy)');
      } else if (pricePosition < 0.25) {
        score += 1.2;
        reasons.push('Price in lower BB quartile (Good Buy)');
      } else if (pricePosition < 0.5) {
        score += 0.6;
        reasons.push('Price in lower half of BB');
      }
      
      // Add BB width as volatility indicator
      const bbWidthPercent = (bbWidth / bb.middle) * 100;
      if (bbWidthPercent > 5) { // High volatility
        score += 0.4;
        reasons.push('High volatility (BB width > 5%)');
      }
    } else {
      logger.warn('Invalid or missing Bollinger Bands data');
    }
    
    // Cap score at 10 and round to 1 decimal place
    const finalScore = Math.min(10, parseFloat(score.toFixed(1)));
    
    // Calculate confidence level based on score
    let confidence = 'Low';
    if (finalScore >= 7) confidence = 'High';
    else if (finalScore >= 4) confidence = 'Medium';
    
    return {
      score: finalScore,
      reasons,
      confidence,
      timestamp: new Date().toISOString(),
      indicators: {
        rsi,
        stochK,
        stochD,
        macd: macd.histogram,
        priceVsEma: price - ema,
        bbWidth: bb.upper - bb.lower
      }
    };
  }
  

  
  /**
  /**
   * Calculate dip score based on price drop from recent high
  /** 
  /**
   * @param {number} currentPrice - Current price
  /** 
  /**
   * @returns {Object} Dip score and related information
   */
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
  /**
   * Fetches the initial set of hourly candles (30 hours worth) and keeps the most recent 24 hours
  /** 
  /**
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
  /**
   * Calculates a score based on how close the current price is to the 24-hour average low
  /** 
  /**
   * Higher scores indicate the price is closer to the 24h average low
  /** 
  /**
   * @param {number} currentPrice - The current price to evaluate
  /** 
  /**
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

  /**
  /**
   * Calculates the 24-hour average high price and percentage above/below current price
  /** 
  /**
   * @param {number} currentPrice - The current price to evaluate against
  /** 
  /**
   * @returns {Object} Object containing avgHigh24h and percentBelow24hHigh
   */
  async calculate24hHighPrice(currentPrice) {
    try {
      // Ensure we have a valid current price
      if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
        throw new Error(`Invalid current price: ${currentPrice}`);
      }
      
      let avgHigh24h = 0;
      let percentBelow24hHigh = 0;
      
      // Ensure we have enough data
      if (!this.hourlyCandles || this.hourlyCandles.length < 24) {
        // Fallback to 1-minute candles if we don't have hourly data yet
        logger.warn('No hourly candles available, falling back to 1-minute candles for 24h high');
        const dailyCandles = (this.candles || []).slice(-1440);
        
        if (dailyCandles.length < 60) {
          throw new Error('Insufficient data for 24h average high calculation');
        }
        
        const validDailyCandles = dailyCandles.filter(candle => 
          candle && typeof candle.high === 'number' && !isNaN(candle.high) && candle.high > 0
        );
        
        if (validDailyCandles.length === 0) {
          throw new Error('No valid daily candles found for 24h average high calculation');
        }
        
        // Calculate maximum of all daily highs as fallback
        const highs = validDailyCandles.map(c => c.high);
        avgHigh24h = Math.max(...highs);
      } else {
        // Use hourly candles for 24h high (maximum) calculation
        const validHourlyCandles = this.hourlyCandles
          .slice(-24) // Only use the last 24 hours
          .filter(candle => 
            candle && typeof candle.high === 'number' && !isNaN(candle.high) && candle.high > 0
          );
        
        if (validHourlyCandles.length === 0) {
          throw new Error('No valid hourly candles found for 24h average high calculation');
        }
        
        // Calculate the maximum high of the last 24 hourly candles
        const highs = validHourlyCandles.map(c => c.high);
        avgHigh24h = Math.max(...highs);
      }
      
      // Ensure we have a valid avgHigh24h before proceeding
      if (typeof avgHigh24h !== 'number' || isNaN(avgHigh24h) || avgHigh24h <= 0) {
        throw new Error(`Invalid 24h average high value: ${avgHigh24h}`);
      }
      
      // Calculate percentage below the 24h average high
      percentBelow24hHigh = ((avgHigh24h - currentPrice) / avgHigh24h) * 100;
      
      // Ensure we have a valid percentage
      if (isNaN(percentBelow24hHigh) || !isFinite(percentBelow24hHigh)) {
        throw new Error(`Invalid percentage calculation: currentPrice=${currentPrice}, avgHigh24h=${avgHigh24h}`);
      }
      
      return {
        avgHigh24h,
        percentBelow24hHigh,
        currentPrice
      };
      
    } catch (error) {
      logger.error(`Error in calculate24hHighPrice: ${error.message}`, { currentPrice });
      return {
        avgHigh24h: null,
        percentBelow24hHigh: 0,
        currentPrice: currentPrice || 0,
        error: error.message
      };
    }
  }

  /**
  /**
   * Calculates a blended score based on 24h low and 60m high prices
  /** 
  /**
   * @param {number} currentPrice - The current price to evaluate
  /** 
  /**
   * @param {Object} low24hScoreResult - Optional pre-calculated 24h low score result
  /** 
  /**
   * @param {Object} high60mData - Optional pre-calculated 60m high data
  /** 
  /**
   * @returns {Promise<Object>} Object containing blended score and component scores
   */
  async calculateBlendedScore(currentPrice, low24hScoreResult = null, high24hData = null) {
    const logPrefix = '[calculateBlendedScore]';
    logger.debug(`${logPrefix} === START ===`);
    logger.debug(`${logPrefix} Input - currentPrice: ${currentPrice}, type: ${typeof currentPrice}`);
    
    // Track timing for performance
    const startTime = Date.now();
    
    try {
      // Validate currentPrice
      if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
        const errorMsg = `Invalid current price: ${currentPrice} (type: ${typeof currentPrice})`;
        logger.error(`${logPrefix} ${errorMsg}`);
        throw new Error(errorMsg);
      }
  
      // Calculate 24h low score if not provided
      let low24hScore = 0;
      if (low24hScoreResult?.score !== undefined) {
        low24hScore = Number(low24hScoreResult.score) || 0;
        logger.debug(`${logPrefix} Using provided 24h low score: ${low24hScore}`);
      } else {
        const low24hResult = await this.calculate24hLowScore(currentPrice);
        low24hScore = Number(low24hResult?.score) || 0;
        logger.debug(`${logPrefix} Calculated 24h low score: ${low24hScore}`);
      }
      
      // Ensure the score is within valid range (0-10)
      low24hScore = Math.max(0, Math.min(10, low24hScore));
      
      // Get or calculate 24h high data
      if (!high24hData) {
        high24hData = await this.calculate24hHighPrice(currentPrice);
      }
  
      const percentBelow24hHigh = high24hData.percentBelow24hHigh || 0;
      let high24hScore = 0;
  
      // Calculate 24h high score (0-10 scale)
      if (percentBelow24hHigh < 0) {
        high24hScore = 0;  // New high - don't buy at new highs
      } else if (percentBelow24hHigh <= 0.5) {
        high24hScore = 1;  // Within 0.5% of high
      } else if (percentBelow24hHigh <= 1.5) {
        high24hScore = 3;  // 0.5-1.5% below
      } else if (percentBelow24hHigh <= 3.0) {
        high24hScore = 6;  // 1.5-3.0% below
      } else if (percentBelow24hHigh <= 5.0) {
        high24hScore = 8;  // 3.0-5.0% below
      } else {
        high24hScore = 10; // More than 5.0% below
      }
      
      high24hScore = Math.max(0, Math.min(10, high24hScore));
      
      // Set weights (70% to high score, 30% to low score)
      const low24hWeight = 0.3;
      const high24hWeight = 0.7;
      
      // Calculate blended score
      logger.debug('=== Blended Score Calculation ===');
      logger.debug('Inputs - low24hScore:', low24hScore, 'high24hScore:', high24hScore);
      logger.debug('Weights - low24hWeight:', low24hWeight, 'high24hWeight:', high24hWeight);
      
      const blendedScore = (low24hScore * low24hWeight) + (high24hScore * high24hWeight);
      logger.debug('Raw blended score:', blendedScore);
      
      // Ensure score is within bounds and round to 1 decimal
      const finalScore = Math.round(Math.max(0, Math.min(10, blendedScore)) * 10) / 10;
      logger.debug('Final blended score (bounded and rounded):', finalScore);
      
      return {
        score: finalScore,
        low24hScore,
        high24hScore,
        percentBelow24hHigh,
        low24hWeight,
        high24hWeight,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error(`Error in calculateBlendedScore: ${error.message}`, { error });
      return {
        score: 0,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
  /**
   * Calculates the 60-minute high price and percentage above/below current price
  /** 
  /**
   * @param {number} currentPrice - The current price to evaluate against
  /** 
  /**
   * @returns {Object} Object containing detailed 60m high analysis
   */
  async calculate60mHighPrice(currentPrice) {
  try {
    // Ensure we have a valid current price
    if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
      throw new Error(`Invalid current price: ${currentPrice}`);
    }
    
    // Initialize result object with default values
    const result = {
      high60m: 0,
      percentBelow60mHigh: 0,
      currentPrice,
      timeSinceHighMs: 0,
      highCandlesAgo: 0,
      volumeAtHigh: 0,
      highTime: null,
      isNewHigh: false,
      highConfidence: 1.0,
      reasons: []
    };
    
    // Use 1-minute candles for 60-minute high calculation
    const sixtyMinuteCandles = (this.candles || []).slice(-60); // Last 60 minutes
    
    if (sixtyMinuteCandles.length < 30) { // Require at least 30 minutes of data
      throw new Error(`Insufficient data for 60m high calculation (${sixtyMinuteCandles.length} candles)`);
    }
    
    // Filter out invalid candles and add timestamp parsing
    const now = Date.now();
    const validCandles = sixtyMinuteCandles
      .map((candle, index) => ({
        ...candle,
        index,
        timestamp: candle.timestamp ? new Date(candle.timestamp).getTime() : now - ((60 - index) * 60000)
      }))
      .filter(candle => 
        candle && 
        typeof candle.high === 'number' && 
        !isNaN(candle.high) && 
        candle.high > 0 &&
        candle.timestamp
      );
    
    if (validCandles.length === 0) {
      throw new Error('No valid candles found for 60m high calculation');
    }
    
    // Find the highest high in the last 60 minutes with its index
    let highestCandle = validCandles[0];
    validCandles.forEach(candle => {
      if (candle.high > highestCandle.high) {
        highestCandle = candle;
      }
    });
    
    result.high60m = highestCandle.high;
    
    // Calculate time since high
    const currentTime = validCandles[validCandles.length - 1]?.timestamp || now;
    result.timeSinceHighMs = currentTime - highestCandle.timestamp;
    result.highTime = new Date(highestCandle.timestamp).toISOString();
    
    // Calculate how many candles ago the high occurred
    result.highCandlesAgo = validCandles.length - 1 - highestCandle.index;
    
    // Get volume at high
    result.volumeAtHigh = highestCandle.volume || 0;
    
    // Check if current price is a new high
    result.isNewHigh = currentPrice > result.high60m;
    
    // Calculate percentage below the 60m high (negative if it's a new high)
    result.percentBelow60mHigh = ((result.high60m - currentPrice) / result.high60m) * 100;
    
    // Adjust confidence based on data quality
    result.highConfidence = Math.min(1, validCandles.length / 60);
    
    // Add reasons for high confidence
    if (result.highConfidence < 0.7) {
      result.reasons.push(`Low confidence: Only ${validCandles.length} valid candles`);
    }
    
    if (result.isNewHigh) {
      result.reasons.push('Current price is a new 60-minute high');
    } else {
      result.reasons.push(`Price is ${result.percentBelow60mHigh.toFixed(2)}% below 60m high`);
      result.reasons.push(`High was ${result.highCandlesAgo} candles ago`);
      
      // Add volume context
      const currentVolume = validCandles[validCandles.length - 1]?.volume || 0;
      const volumeRatio = currentVolume > 0 ? (result.volumeAtHigh / currentVolume) : 1;
      
      if (volumeRatio > 1.5) {
        result.reasons.push(`High volume at peak (${volumeRatio.toFixed(1)}x current)`);
        result.highConfidence = Math.min(1, result.highConfidence * 1.1);
      }
    }
    
    // Ensure we have valid values
    if (isNaN(result.percentBelow60mHigh) || !isFinite(result.percentBelow60mHigh)) {
      throw new Error(`Invalid percentage calculation: currentPrice=${currentPrice}, high60m=${result.high60m}`);
    }
    
    return result;
    
  } catch (error) {
    logger.error(`Error in calculate60mHighPrice: ${error.message}`, { 
      currentPrice,
      error: error.stack 
    });
    
    return {
      high60m: null,
      percentBelow60mHigh: 0,
      currentPrice: currentPrice || 0,
      error: error.message,
      highConfidence: 0,
      reasons: [`Error: ${error.message}`]
    };
  }
}

  /**
  /**
   * Calculates the 12-hour high price and percentage above/below current price
  /** 
  /**
   * @param {number} currentPrice - The current price to evaluate against
  /** 
  /**
   * @returns {Object} Object containing high12h and percentBelow12hHigh
   */
  async calculate12hHighPrice(currentPrice) {
    try {
      // Ensure we have a valid current price
      if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
        throw new Error(`Invalid current price: ${currentPrice}`);
      }
      
      let high12h = 0;
      let percentBelow12hHigh = 0;
      
      // Ensure we have enough data
      if (!this.hourlyCandles || this.hourlyCandles.length < 12) {
        // Fallback to 1-minute candles if we don't have enough hourly data yet
        logger.warn('Not enough hourly candles available, falling back to 1-minute candles for 12h high');
        const halfDayCandles = (this.candles || []).slice(-720); // 12 hours of 1-minute candles
        
        if (halfDayCandles.length < 360) { // At least 6 hours of data
          throw new Error('Insufficient data for 12h high calculation');
        }
        
        const validHalfDayCandles = halfDayCandles.filter(candle => 
          candle && typeof candle.high === 'number' && !isNaN(candle.high) && candle.high > 0
        );
        
        if (validHalfDayCandles.length === 0) {
          throw new Error('No valid candles found for 12h high calculation');
        }
        
        // Find the highest high in the last 12 hours
        high12h = Math.max(...validHalfDayCandles.map(candle => candle.high));
      } else {
        // Use hourly candles for 12h high calculation
        const validHourlyCandles = this.hourlyCandles
          .slice(-12) // Only use the last 12 hours
          .filter(candle => 
            candle && typeof candle.high === 'number' && !isNaN(candle.high) && candle.high > 0
          );
        
        if (validHourlyCandles.length === 0) {
          throw new Error('No valid hourly candles found for 12h high calculation');
        }
        
        // Find the highest high in the last 12 hours
        high12h = Math.max(...validHourlyCandles.map(candle => candle.high));
      }
      
      // Ensure we have a valid high12h before proceeding
      if (typeof high12h !== 'number' || isNaN(high12h) || high12h <= 0) {
        throw new Error(`Invalid 12h high value: ${high12h}`);
      }
      
      // Calculate percentage below the 12h high
      percentBelow12hHigh = ((high12h - currentPrice) / high12h) * 100;
      
      // Ensure we have a valid percentage
      if (isNaN(percentBelow12hHigh) || !isFinite(percentBelow12hHigh)) {
        throw new Error(`Invalid percentage calculation: currentPrice=${currentPrice}, high12h=${high12h}`);
      }
      
      return {
        high12h,
        percentBelow12hHigh,
        currentPrice
      };
      
    } catch (error) {
      logger.error(`Error in calculate12hHighPrice: ${error.message}`, { currentPrice });
      return {
        high12h: null,
        percentBelow12hHigh: 0,
        currentPrice: currentPrice || 0,
        error: error.message
      };
    }
  }

  // Helper method to calculate the score from pre-computed values
  calculate24hLowScoreFromValues(low24h, currentPrice, percentAbove24hLow) {
    // ... (rest of the code remains the same)
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
      
      // Granular linear scoring: 0-10 pts where 10 = at/under 24h low, losing 1 point per 1% above low
      // e.g. 0%-1% above -> 9 pts, 5% above -> 5 pts, ≥10% above -> 0 pts
      let score = 10 - percentAbove24hLow;
      if (percentAbove24hLow < 0) score = 10; // price below low gets max
      score = Math.max(0, Math.min(10, score));
      const scoreRange = `${percentAbove24hLow.toFixed(2)}% above low`;
      
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

  /**
  /**
   * Calculate VWAP (Volume Weighted Average Price) from candles
  /** 
  /**
   * @param {Array} candles - Array of candle data
  /** 
  /**
   * @returns {number} VWAP value
   */
  /**
  /**
   * Calculate Volume Weighted Average Price (VWAP) from candle data
  /** 
  /**
   * @param {Array} candles - Array of candle objects with high, low, close, and volume properties
  /** 
  /**
   * @returns {number} - The calculated VWAP value or 0 if calculation fails
   */
  calculateVWAP(candles) {
    try {
      // Validate input
      if (!candles) {
        logger.warn('[VWAPDebug] calculateVWAP called with null/undefined candles');
        return 0;
      }
      
      if (!Array.isArray(candles)) {
        logger.warn(`[VWAPDebug] calculateVWAP called with non-array: ${typeof candles}`);
        return 0;
      }
      
      if (candles.length === 0) {
        logger.warn('[VWAPDebug] calculateVWAP called with empty candle array');
        return 0;
      }
      
      logger.debug(`[VWAPDebug] Calculating VWAP with ${candles.length} candles`);
      
      // Filter out invalid candles
      const validCandles = candles.filter(candle => {
        if (!candle) return false;
        
        // Check for required numeric properties
        const hasRequiredProps = typeof candle.high === 'number' && !isNaN(candle.high) &&
                                typeof candle.low === 'number' && !isNaN(candle.low) &&
                                typeof candle.close === 'number' && !isNaN(candle.close);
        
        if (!hasRequiredProps) {
          logger.debug('[VWAPDebug] Found invalid candle missing required numeric properties');
          return false;
        }
        
        return true;
      });
      
      if (validCandles.length === 0) {
        logger.warn('[VWAPDebug] No valid candles found for VWAP calculation');
        return 0;
      }
      
      if (validCandles.length < candles.length) {
        logger.warn(`[VWAPDebug] Filtered out ${candles.length - validCandles.length} invalid candles`);
      }
      
      let cumulativeTPV = 0;
      let cumulativeVolume = 0;
      
      for (const candle of validCandles) {
        // Calculate typical price: (high + low + close) / 3
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        
        // Ensure volume is a number and not negative
        const volume = typeof candle.volume === 'number' && !isNaN(candle.volume) ? 
                      Math.max(0, candle.volume) : 0;
        
        cumulativeTPV += typicalPrice * volume;
        cumulativeVolume += volume;
      }
      
      // Check if we have any volume
      if (cumulativeVolume <= 0) {
        logger.warn('[VWAPDebug] Zero cumulative volume in VWAP calculation');
        return 0;
      }
      
      const vwap = cumulativeTPV / cumulativeVolume;
      
      // Validate the result
      if (isNaN(vwap) || !isFinite(vwap)) {
        logger.error(`[VWAPDebug] VWAP calculation resulted in invalid value: ${vwap}`);
        return 0;
      }
      
      logger.debug(`[VWAPDebug] VWAP calculated successfully: ${vwap}`);
      return vwap;
    } catch (error) {
      logger.error('[VWAPDebug] Error calculating VWAP:', error);
      return 0;
    }
  }

  /**
  /**
   * Calculate volume spike percentage compared to average volume
  /** 
  /**
   * @param {Array} volumeHistory - Array of volume values
  /** 
  /**
   * @param {number} currentVolume - Current volume
  /** 
  /**
   * @param {number} lookbackPeriod - Number of periods to look back
  /** 
  /**
   * @returns {number} Volume spike percentage (1.0 = 100% spike, 0 = no spike)
   */
  calculateVolumeSpike(volumeHistory, currentVolume, lookbackPeriod = 20) {
    if (!volumeHistory || volumeHistory.length < lookbackPeriod) return 0;
    
    const recentVolumes = volumeHistory.slice(-lookbackPeriod);
    const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
    
    return avgVolume > 0 ? (currentVolume - avgVolume) / avgVolume : 0;
  }

  /**
  /**
   * Evaluate candle momentum based on recent candles
  /** 
  /**
   * @param {Array} candles - Array of candle data (most recent first)
  /** 
  /**
   * @param {number} lookback - Number of candles to analyze
  /** 
  /**
   * @returns {Object} Momentum analysis results
   */
  analyzeCandleMomentum(candles, lookback = 3) {
    if (!candles || candles.length < lookback) {
      return { score: 0, reasons: ['Insufficient candle data'] };
    }
    
    let score = 0;
    const reasons = [];
    const recentCandles = candles.slice(0, lookback);
    
    // Check for consecutive green candles
    const greenCandles = recentCandles.filter(c => c.close > c.open).length;
    if (greenCandles >= 2) {
      score += 1;
      reasons.push(`${greenCandles} consecutive green candles`);
    }
    
    // Check for increasing volume
    const volumes = recentCandles.map(c => c.volume || 0);
    const volumeIncreasing = volumes.every((v, i, arr) => i === 0 || v > arr[i-1]);
    if (volumeIncreasing && volumes[0] > 0) {
      score += 1;
      reasons.push('Volume increasing');
    }
    
    // Check for higher highs and higher lows
    const highs = recentCandles.map(c => c.high);
    const lows = recentCandles.map(c => c.low);
    const higherHighs = highs.every((h, i) => i === 0 || h > highs[i-1]);
    const higherLows = lows.every((l, i) => i === 0 || l > lows[i-1]);
    
    if (higherHighs && higherLows) {
      score += 1;
      reasons.push('Higher highs & higher lows');
    } else if (higherHighs) {
      score += 0.5;
      reasons.push('Higher highs');
    } else if (higherLows) {
      score += 0.5;
      reasons.push('Higher lows');
    }
    
    return { score: Math.min(3, score), reasons };
  }

  /**
  /**
   * Calculate technical indicators from candle data.
  /** 
  /**
   * This method populates `this.indicators` with the latest values for
  /** 
  /**
   * EMA, RSI, Bollinger Bands, MACD, and Stochastic.
  /** 
  /**
   * It includes checks to ensure there is sufficient historical data.
   */
  calculateIndicators() {
    logger.info('=== CALCULATING TECHNICAL INDICATORS ===');
    logger.debug(`[IndicatorDiagnostic] this.candles type: ${typeof this.candles}, length: ${this.candles?.length || 'N/A'}`);
    
    // Detailed candle data inspection
    if (this.candles && Array.isArray(this.candles)) {
      const firstCandle = this.candles[0];
      const lastCandle = this.candles[this.candles.length - 1];
      
      logger.debug(`[IndicatorDiagnostic] Candle time range: ${new Date(firstCandle.time * 1000).toISOString()} to ${new Date(lastCandle.time * 1000).toISOString()}`);
      logger.debug(`[IndicatorDiagnostic] First candle: ${JSON.stringify(firstCandle)}`);
      logger.debug(`[IndicatorDiagnostic] Last candle: ${JSON.stringify(lastCandle)}`);
      
      // Check for string values in numeric fields
      const sampleCandles = this.candles.slice(0, 5);
      let stringFieldsFound = false;
      
      for (let i = 0; i < sampleCandles.length; i++) {
        const candle = sampleCandles[i];
        const numericFields = ['open', 'high', 'low', 'close', 'volume'];
        
        for (const field of numericFields) {
          if (typeof candle[field] === 'string') {
            stringFieldsFound = true;
            logger.warn(`[IndicatorDiagnostic] Found string value in candle[${i}].${field}: ${candle[field]}`);
          }
        }
      }
      
      if (stringFieldsFound) {
        logger.warn('[IndicatorDiagnostic] String values found in numeric fields. Will attempt to convert to numbers.');
        
        // Convert string values to numbers
        for (let i = 0; i < this.candles.length; i++) {
          const candle = this.candles[i];
          const numericFields = ['open', 'high', 'low', 'close', 'volume'];
          
          for (const field of numericFields) {
            if (typeof candle[field] === 'string') {
              const numValue = parseFloat(candle[field]);
              if (!isNaN(numValue)) {
                candle[field] = numValue;
              }
            }
          }
        }
        
        logger.info('[IndicatorDiagnostic] Converted string values to numbers in candle data');
      }
      
      // Check for NaN values in numeric fields and replace with 0
      let nanValuesFound = false;
      for (let i = 0; i < this.candles.length; i++) {
        const candle = this.candles[i];
        const numericFields = ['open', 'high', 'low', 'close', 'volume'];
        
        for (const field of numericFields) {
          if (isNaN(candle[field])) {
            nanValuesFound = true;
            logger.warn(`[IndicatorDiagnostic] Found NaN value in candle[${i}].${field}`);
            candle[field] = 0; // Replace NaN with 0
          }
        }
      }
      
      if (nanValuesFound) {
        logger.warn('[IndicatorDiagnostic] NaN values found and replaced with 0');
      }
    }

    const defaultIndicators = {
      price: this.indicators?.price || 0,
      ema20: null, rsi: null, bb: null, macd: null,
      macdSignal: null, macdHistogram: null, prevMacdHistogram: null, stochastic: null,
    };

    // Step 1: Validate candle data exists
    if (!this.candles) {
      logger.error(`[IndicatorDiagnostic] this.candles is ${this.candles === null ? 'null' : 'undefined'}`);
      logger.error('Insufficient candle data for technical indicators. Please ensure candle_cache.json exists and contains valid data.');
      this.indicators = defaultIndicators;
      return;
    }
    
    // Step 2: Validate sufficient candle count
    if (this.candles.length < 26) {
      logger.error(`[IndicatorDiagnostic] Insufficient candle count: ${this.candles.length} (need at least 26 for MACD)`);
      if (this.candles.length > 0) {
        const firstCandle = this.candles[0];
        const lastCandle = this.candles[this.candles.length - 1];
        logger.debug(`[IndicatorDiagnostic] Candle time range: ${new Date(firstCandle.time * 1000).toISOString()} to ${new Date(lastCandle.time * 1000).toISOString()}`);
      }
      logger.error('Insufficient candle data for technical indicators. Please ensure candle_cache.json exists and contains valid data.');
      this.indicators = defaultIndicators;
      if (this.candles && this.candles.length > 0) {
        this.indicators.price = this.candles[this.candles.length - 1].close;
      }
      return;
    }
    
    // Step 3: Validate candle data structure
    const sampleCandle = this.candles[0];
    const requiredFields = ['time', 'open', 'high', 'low', 'close', 'volume'];
    const missingFields = requiredFields.filter(field => typeof sampleCandle[field] === 'undefined');
    
    if (missingFields.length > 0) {
      logger.error(`[IndicatorDiagnostic] Candle data missing required fields: ${missingFields.join(', ')}`);
      logger.error(`[IndicatorDiagnostic] Sample candle: ${JSON.stringify(sampleCandle)}`);
      this.indicators = defaultIndicators;
      return;
    }

    // Use candles directly without sorting (matching working backup implementation)
    const recentCandles = this.candles;
    const closePrices = recentCandles.map(c => parseFloat(c.close));
    const highPrices = recentCandles.map(c => parseFloat(c.high));
    const lowPrices = recentCandles.map(c => parseFloat(c.low));

    const areAllNumbers = closePrices.every(p => typeof p === 'number' && !isNaN(p));
    logger.debug(`[IndicatorDebug] Processing ${closePrices.length} close prices. All valid numbers: ${areAllNumbers}. Sample: ${JSON.stringify(closePrices.slice(-5))}`);
    if (!areAllNumbers) {
      logger.error('[IndicatorDebug] Found non-numeric or NaN values in closePrices array!', { 
        invalidData: closePrices.map((p, i) => ({ index: i, value: p, type: typeof p })).filter(item => typeof item.value !== 'number' || isNaN(item.value))
      });
      this.indicators = defaultIndicators; // Stop further calculation
      return;
    }

    const newIndicators = { ...defaultIndicators };
    newIndicators.price = closePrices[closePrices.length - 1];

    try {
      // Calculate EMA20 using TechnicalIndicators reference implementation
      if (closePrices.length >= 20) {
        logger.debug(`[IndicatorDebug] Calculating EMA20 with ${closePrices.length} prices`);
        
        try {
          // Ensure we have valid numeric prices
          const numericPrices = closePrices.map(p => {
            if (p === null || p === undefined) return 0;
            if (typeof p === 'string') return parseFloat(p) || 0;
            if (isNaN(p)) return 0;
            return Number(p);
          });
          
          logger.debug(`[IndicatorDebug] Prepared ${numericPrices.length} numeric prices for EMA20`);
          
          // Check if all values are the same (which can cause EMA calculation to fail)
          const allSameValue = numericPrices.every(price => price === numericPrices[0]);
          if (allSameValue) {
            logger.debug('[IndicatorDebug] All close prices have the same value, adding variations');
            // Add a small variation to prevent calculation failure
            for (let i = 0; i < numericPrices.length; i++) {
              numericPrices[i] += (i * 0.0001);
            }
          }
          
          // Calculate EMA using the reference implementation approach
          const period = 20;
          const multiplier = 2 / (period + 1);
          const ema = [numericPrices[0]];
          
          for (let i = 1; i < numericPrices.length; i++) {
            ema.push((numericPrices[i] * multiplier) + (ema[i - 1] * (1 - multiplier)));
          }
          
          // Get the latest EMA value
          const emaValue = ema[ema.length - 1];
          
          if (typeof emaValue === 'number' && !isNaN(emaValue)) {
            newIndicators.ema20 = emaValue;
            logger.debug(`[IndicatorDebug] EMA20 calculated successfully: ${newIndicators.ema20}`);
          } else {
            logger.warn('[IndicatorDebug] EMA calculation returned invalid result, using fallback');
            newIndicators.ema20 = numericPrices[numericPrices.length - 1]; // Use latest price as fallback
          }
        } catch (emaError) {
          logger.error('[IndicatorDebug] Error calculating EMA20:', emaError);
          logger.error(`[IndicatorDebug] Error details: ${emaError.message}`);
          // Use latest price as fallback
          newIndicators.ema20 = closePrices[closePrices.length - 1];
          logger.debug(`[IndicatorDebug] Using fallback EMA20 value: ${newIndicators.ema20}`);
        }
      } else {
        logger.warn(`[IndicatorDebug] Insufficient data for EMA20: ${closePrices.length} prices (need 20)`);
        newIndicators.ema20 = closePrices.length > 0 ? closePrices[closePrices.length - 1] : 0;
      }

      // Calculate RSI
      if (closePrices.length >= 15) { // RSI requires n+1 periods
        try {
          const rsiResult = RSI.calculate({ period: 14, values: closePrices });
          logger.debug(`[IndicatorDebug] RSI Raw Output (last 3): ${JSON.stringify(rsiResult.slice(-3))}`);
          if (rsiResult && rsiResult.length > 0) {
            newIndicators.rsi = rsiResult[rsiResult.length - 1];
            logger.debug(`[IndicatorDebug] RSI calculated: ${newIndicators.rsi}`);
          }
        } catch (rsiError) {
          logger.error('[IndicatorDebug] Error calculating RSI:', rsiError);
        }
      }

      // Calculate Bollinger Bands
      if (closePrices.length >= 20) {
        try {
          const bbResult = BollingerBands.calculate({ period: 20, values: closePrices, stdDev: 2 });
          logger.debug(`[IndicatorDebug] BB Raw Output (last 3): ${JSON.stringify(bbResult.slice(-3))}`);
          if (bbResult && bbResult.length > 0) {
            newIndicators.bb = bbResult[bbResult.length - 1];
            logger.debug(`[IndicatorDebug] BB calculated: upper=${newIndicators.bb.upper}, middle=${newIndicators.bb.middle}, lower=${newIndicators.bb.lower}`);
          }
        } catch (bbError) {
          logger.error('[IndicatorDebug] Error calculating Bollinger Bands:', bbError);
        }
      }

      // Calculate MACD using TechnicalIndicators reference implementation
      if (closePrices.length >= 26) {
        logger.debug(`[IndicatorDebug] Calculating MACD with ${closePrices.length} prices`);
        try {
          // Ensure we have valid numeric prices
          const numericPrices = closePrices.map(p => {
            if (p === null || p === undefined) return 0;
            if (typeof p === 'string') return parseFloat(p) || 0;
            if (isNaN(p)) return 0;
            return Number(p);
          });
          
          logger.debug(`[IndicatorDebug] Prepared ${numericPrices.length} numeric prices for MACD`);
          
          // Check if all values are the same (which can cause MACD calculation to fail)
          const allSameValue = numericPrices.every(price => price === numericPrices[0]);
          if (allSameValue) {
            logger.debug('[IndicatorDebug] All close prices have the same value, adding variations');
            // Add a small variation to prevent calculation failure
            for (let i = 0; i < numericPrices.length; i++) {
              numericPrices[i] += (i * 0.0001);
            }
          }
          
          // Calculate MACD using the reference implementation approach
          const fastPeriod = 12;
          const slowPeriod = 26;
          const signalPeriod = 9;
          
          // Calculate exponential moving averages
          const multiplierFast = 2 / (fastPeriod + 1);
          const multiplierSlow = 2 / (slowPeriod + 1);
          const multiplierSignal = 2 / (signalPeriod + 1);
          
          // Calculate Fast EMA
          const emaFast = [numericPrices[0]];
          for (let i = 1; i < numericPrices.length; i++) {
            emaFast.push((numericPrices[i] * multiplierFast) + (emaFast[i - 1] * (1 - multiplierFast)));
          }
          
          // Calculate Slow EMA
          const emaSlow = [numericPrices[0]];
          for (let i = 1; i < numericPrices.length; i++) {
            emaSlow.push((numericPrices[i] * multiplierSlow) + (emaSlow[i - 1] * (1 - multiplierSlow)));
          }
          
          // MACD line = EMA(12) - EMA(26)
          const macdLine = emaFast.map((fast, i) => fast - emaSlow[i]);
          
          // Signal line = EMA(9) of MACD line
          const signalLine = [macdLine[0]];
          for (let i = 1; i < macdLine.length; i++) {
            signalLine.push((macdLine[i] * multiplierSignal) + (signalLine[i - 1] * (1 - multiplierSignal)));
          }
          
          // Histogram = MACD - Signal
          const histogram = macdLine.map((macd, i) => macd - signalLine[i]);
          
          // Get the latest values
          const latestMACD = macdLine[macdLine.length - 1];
          const latestSignal = signalLine[signalLine.length - 1];
          const latestHistogram = histogram[histogram.length - 1];
          const prevHistogram = histogram.length > 1 ? histogram[histogram.length - 2] : 0;
          
          // Assign values to indicators
          newIndicators.macd = latestMACD;
          newIndicators.macdSignal = latestSignal;
          newIndicators.macdHistogram = latestHistogram;
          newIndicators.prevMacdHistogram = prevHistogram;
          
          logger.debug(`[IndicatorDebug] MACD values: MACD=${newIndicators.macd}, Signal=${newIndicators.macdSignal}, Histogram=${newIndicators.macdHistogram}`);
        } catch (macdError) {
          logger.error('[IndicatorDebug] Error calculating MACD:', macdError);
          logger.error(`[IndicatorDebug] MACD error details: ${macdError.message}`);
          // Use fallback values
          newIndicators.macd = 0;
          newIndicators.macdSignal = 0;
          newIndicators.macdHistogram = 0;
          newIndicators.prevMacdHistogram = 0;
          logger.debug('[IndicatorDebug] Using fallback MACD values due to calculation error');
        }
      } else {
        logger.warn(`[IndicatorDebug] Insufficient data for MACD: ${closePrices.length} prices (need 26)`);
        // Use fallback values
        newIndicators.macd = 0;
        newIndicators.macdSignal = 0;
        newIndicators.macdHistogram = 0;
        newIndicators.prevMacdHistogram = 0;
      }

      // Calculate Stochastic
      if (highPrices.length >= 14 && lowPrices.length >= 14 && closePrices.length >= 14) {
        try {
          const stochInput = { 
            high: highPrices, 
            low: lowPrices, 
            close: closePrices, 
            period: 14, 
            signalPeriod: 3 
          };
          const stochResult = Stochastic.calculate(stochInput);
          logger.debug(`[IndicatorDebug] Stochastic Raw Output (last 3): ${JSON.stringify(stochResult.slice(-3))}`);
          if (stochResult && stochResult.length > 0) {
            newIndicators.stochastic = stochResult[stochResult.length - 1];
            logger.debug(`[IndicatorDebug] Stochastic calculated: k=${newIndicators.stochastic.k}, d=${newIndicators.stochastic.d}`);
          }
        } catch (stochError) {
          logger.error('[IndicatorDebug] Error calculating Stochastic:', stochError);
        }
      }
    } catch (error) {
      logger.error('[IndicatorDebug] CRITICAL ERROR during indicator calculation:', { message: error.message, stack: error.stack });
    }
    
    this.indicators = newIndicators;

    // Create a comprehensive indicator status report with improved handling for zero values
    const formatIndicator = (value, decimals) => {
      if (value === null || value === undefined) return 'N/A';
      const numValue = parseFloat(value);
      return isNaN(numValue) ? 'N/A' : numValue.toFixed(decimals);
    };
    
    const indicatorStatus = {
      price: formatIndicator(this.indicators.price, 4),
      ema20: formatIndicator(this.indicators.ema20, 4),
      rsi: formatIndicator(this.indicators.rsi, 2),
      macd: formatIndicator(this.indicators.macd, 6),
      macdSignal: formatIndicator(this.indicators.macdSignal, 6),
      macdHistogram: formatIndicator(this.indicators.macdHistogram, 6),
      stochK: formatIndicator(this.indicators.stochastic?.k, 2),
      stochD: formatIndicator(this.indicators.stochastic?.d, 2),
      bbUpper: formatIndicator(this.indicators.bb?.upper, 4),
      bbMiddle: formatIndicator(this.indicators.bb?.middle, 4),
      bbLower: formatIndicator(this.indicators.bb?.lower, 4),
    };
    
    // Log the raw indicator values for debugging
    logger.debug('[IndicatorDebug] Raw indicator values:', {
      ema20: this.indicators.ema20,
      macdHistogram: this.indicators.macdHistogram,
      macd: this.indicators.macd,
      macdSignal: this.indicators.macdSignal
    });
    
    // Check for N/A values in critical indicators
    const criticalIndicators = ['ema20', 'macdHistogram'];
    const missingIndicators = criticalIndicators.filter(ind => indicatorStatus[ind] === 'N/A');
    
    if (missingIndicators.length > 0) {
      logger.warn(`[IndicatorWarning] Missing critical indicators: ${missingIndicators.join(', ')}. Check candle data quality and quantity.`);
    } else {
      logger.info('[IndicatorSuccess] All critical indicators calculated successfully!');
    }
    
    // Log the full indicator status
    logger.info('=== INDICATOR STATUS REPORT ===');
    logger.info(`Price: ${indicatorStatus.price}`);
    logger.info(`EMA20: ${indicatorStatus.ema20}`);
    logger.info(`RSI: ${indicatorStatus.rsi}`);
    logger.info(`MACD: ${indicatorStatus.macd}`);
    logger.info(`MACD Signal: ${indicatorStatus.macdSignal}`);
    logger.info(`MACD Histogram: ${indicatorStatus.macdHistogram}`);
    logger.info(`Stochastic K: ${indicatorStatus.stochK}, D: ${indicatorStatus.stochD}`);
    logger.info(`Bollinger Bands: Upper=${indicatorStatus.bbUpper}, Middle=${indicatorStatus.bbMiddle}, Lower=${indicatorStatus.bbLower}`);
    logger.info('==============================');
  }

  // Evaluate buy signal based on all conditions with CEX-friendly logic
  async evaluateBuySignal(indicators) {
    if (!indicators || typeof indicators !== 'object') {
      logger.error('Invalid indicators object in evaluateBuySignal');
      return {
        score: 0,
        reasons: ['Invalid indicators data'],
        confirmed: false
      };
    }
    
    const currentPrice = indicators.price;
    if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
      logger.error('Invalid current price in evaluateBuySignal');
      return {
        score: 0,
        reasons: ['Invalid current price'],
        confirmed: false
      };
    }
    
    // Calculate VWAP-based metrics
    const vwap = this.calculateVWAP(this.candles.slice(0, 100));
    const priceVsVwap = vwap > 0 ? (currentPrice - vwap) / vwap * 100 : 0;
    
    // Calculate volume spike
    const volumeHistory = this.candles.map(c => c.volume || 0);
    const volumeSpike = this.calculateVolumeSpike(volumeHistory, indicators.volume || 0);
    
    // Analyze candle momentum
    const momentum = this.analyzeCandleMomentum(this.candles.slice(0, 5));
    
    // Calculate technical indicators score
    const techScore = this.calculateBuyScore(indicators) || { score: 0 };
    
    // Calculate dip score based on 60m high
    const dipScore = this.calculateDipScore(currentPrice) || { score: 0 };
    
    // Refresh hourly candles to keep 24h calculations current
    try {
      await this.updateHourlyCandles(true); // force refresh so 24h high/low use latest data
    } catch (e) {
      logger.warn('Failed to refresh hourly candles for 24h metrics:', e.message);
    }

    // Get 24h low score
    let low24hScore;
    try {
      low24hScore = await this.calculate24hLowScore(currentPrice);
    } catch (error) {
      logger.error('Error calculating 24h low score:', error.message);
      low24hScore = {
        score: 0,
        reasons: ['Error calculating 24h low score'],
        low24h: 0,
        currentPrice: currentPrice,
        percentAbove24hLow: 0
      };
    }
    const high12hInfo        = await this.calculate12hHighPrice(currentPrice);
    const high24hInfo       = await this.calculate24hHighPrice(currentPrice);
    const blendedScoreResult = await this.calculateBlendedScore(
      currentPrice,
      low24hScore,
      high24hInfo
    ) || { score: 0 };
    
    // Scale blended score to 0-3 points (14.3% of total 21 points)
    const blendedScoreValue = Math.min(3, (blendedScoreResult.score / 10) * 3);
    const blendedScoreFormatted = parseFloat(blendedScoreValue.toFixed(2));
    
    // Get 24h VWAP information
    let vwap24hInfo;
    try {
      // Load hourly candles with validation
      logger.debug('[VWAP24hDebug] Loading hourly candles from cache');
      const hourlyCandles = await this.loadHourlyCandlesFromCache();
      
      if (!hourlyCandles || !Array.isArray(hourlyCandles)) {
        throw new Error(`Invalid hourly candles: ${typeof hourlyCandles}`);
      }
      
      if (hourlyCandles.length === 0) {
        throw new Error('No hourly candles available');
      }
      
      logger.debug(`[VWAP24hDebug] Loaded ${hourlyCandles.length} hourly candles`);
      
      // Get last 24 hours of candles with validation
      const last24hCandles = hourlyCandles.slice(-24); // Last 24 hours
      logger.debug(`[VWAP24hDebug] Using ${last24hCandles.length} candles for 24h VWAP calculation`);
      
      if (last24hCandles.length < 6) { // At least 6 hours of data (25% of a day)
        logger.warn(`[VWAP24hDebug] Insufficient hourly candles for reliable 24h VWAP: ${last24hCandles.length}`);
      }
      
      // Log sample of candles being used
      if (last24hCandles.length > 0) {
        const firstCandle = last24hCandles[0];
        const lastCandle = last24hCandles[last24hCandles.length - 1];
        logger.debug(`[VWAP24hDebug] Candle time range: ${new Date(firstCandle.time * 1000).toISOString()} to ${new Date(lastCandle.time * 1000).toISOString()}`);
      }
      
      // Calculate VWAP with enhanced method
      const vwap24h = this.calculateVWAP(last24hCandles);
      logger.debug(`[VWAP24hDebug] Calculated 24h VWAP: ${vwap24h}`);
      
      // Calculate price vs VWAP percentage with validation
      let priceVsVwap24h = 0;
      if (vwap24h > 0 && typeof currentPrice === 'number' && !isNaN(currentPrice)) {
        priceVsVwap24h = (currentPrice - vwap24h) / vwap24h * 100;
        logger.debug(`[VWAP24hDebug] Price vs VWAP24h: ${priceVsVwap24h.toFixed(2)}%`);
      } else {
        logger.warn(`[VWAP24hDebug] Cannot calculate price vs VWAP24h: vwap24h=${vwap24h}, currentPrice=${currentPrice}`);
      }
      
      vwap24hInfo = {
        vwap24h,
        priceVsVwap24h,
        isAboveVWAP: currentPrice > vwap24h,
        candleCount: last24hCandles.length
      };
      
      logger.debug(`[VWAP24hDebug] VWAP24h info: ${JSON.stringify(vwap24hInfo)}`);
    } catch (error) {
      logger.error('[VWAP24hDebug] Error calculating 24h VWAP:', error);
      vwap24hInfo = {
        vwap24h: 0,
        priceVsVwap24h: 0,
        isAboveVWAP: false,
        error: error.message
      };
    }
    
    // Define buy conditions for CEX trading - More responsive settings
    const buyConditions = {
      // RSI between 35-70 (wider range for CEX, lowered from 40 to 35 for more responsiveness)
      rsiOk: indicators.rsi >= 35 && indicators.rsi <= 70,
      
      // MACD histogram positive or showing improvement - more sensitive to small improvements
      macdImproving: (typeof indicators.macdHistogram === 'number' && indicators.macdHistogram > -0.001) || // More lenient threshold
                    (typeof indicators.macdHistogram === 'number' && typeof indicators.prevMacdHistogram === 'number' && 
                     indicators.macdHistogram > indicators.prevMacdHistogram),
      
      // Price near EMA20 (-2% to +3% range) - Wider range below EMA20
      nearEMA20: indicators.ema20 > 0 && 
                currentPrice > indicators.ema20 * 0.98 && // More lenient (was 0.99)
                currentPrice < indicators.ema20 * 1.03,
      
      // Price above VWAP (bullish) - No change, this is a good filter
      aboveVWAP: vwap24hInfo.isAboveVWAP,
      
      // Volume at least 20% above average (reduced from 30% for more responsiveness)
      goodVolume: volumeSpike > 0.2,
      
      // Some positive momentum - No change
      hasMomentum: momentum.score >= 1,
      
      // Price not too extended from VWAP (avoiding overbought) - More lenient
      notTooExtended: vwap24hInfo.isAboveVWAP ? 
                     vwap24hInfo.priceVsVwap24h < 30 : // Increased from 25% to 30% above VWAP
                     true
    };
    
    // Calculate score components with proper weights for 21-point scale
    const reasons = [];
    
    // 1. Technical Score: 0-8 points (38.1% of total) - Adjusted for more responsiveness
    const techScoreComponent = Math.min(8, (techScore?.score || 0) * 0.9); // Increased from 0.8 to 0.9 for more responsive scoring
    
    // 2. Dip Score: 0-5 points (23.8% of total)
    const dipScoreComponent = Math.min(5, dipScore?.score || 0);
    
    // 3. Conditions Bonus: 0-4 points (19.0% of total)
    const conditionScores = [];
    if (buyConditions.rsiOk) {
      conditionScores.push(1);
      reasons.push('RSI in optimal range (40-70)');
    }
    if (buyConditions.macdImproving) {
      conditionScores.push(1);
      reasons.push('MACD showing improvement');
    }
    if (buyConditions.aboveVWAP) {
      conditionScores.push(1);
      reasons.push('Price above 24h VWAP');
    }
    // Add volume condition
    if (buyConditions.goodVolume) {
      conditionScores.push(1);
      reasons.push('Volume above average');
    }
    const conditionsBonus = Math.min(4, conditionScores.reduce((sum, score) => sum + score, 0));
    
    // 4. Blended Score: 0-4 points (19.0% of total)
    const blendedScoreComponent = Math.min(4, blendedScoreValue * (4/3)); // Scale up from 3 to 4
    
    // Calculate total score (0-21 points)
    let totalScore = techScoreComponent + dipScoreComponent + conditionsBonus + blendedScoreComponent;
    
    // Validate score components sum correctly
    const validateScores = (components) => {
      const expectedTotal = 21;
      const maxScores = components.reduce((sum, comp) => sum + comp.max, 0);
      
      if (Math.abs(maxScores - expectedTotal) > 0.01) {
        logger.warn(`Score component max values sum to ${maxScores}, expected ${expectedTotal}`);
        return false;
      }
      
      const currentTotal = components.reduce((sum, comp) => sum + comp.value, 0);
      if (Math.abs(currentTotal - totalScore) > 0.01) {
        logger.warn(`Score component values sum to ${currentTotal}, but totalScore is ${totalScore}`);
        return false;
      }
      
      return true;
    };
    
    // Run validation
    const components = [
      { name: 'Technical', value: techScoreComponent, max: 8 },
      { name: 'Dip', value: dipScoreComponent, max: 5 },
      { name: 'Conditions', value: conditionsBonus, max: 4 },
      { name: 'Blended', value: blendedScoreComponent, max: 4 }
    ];
    
    if (!validateScores(components)) {
      logger.warn('Score validation failed - check component calculations');
    }
    
    // Set buy threshold (57% of 21 = ~12)
    const buyThreshold = Math.ceil(21 * 0.57); // 12 points - adjusted for more conservative buying
    const isBuySignal = totalScore >= buyThreshold;
    
    // Log score component details for debugging
    logger.debug('Score Component Details:', {
      techScoreComponent,
      dipScoreComponent,
      conditionsBonus,
      blendedScoreComponent,
      totalScore,
      buyThreshold,
      isBuySignal
    });

    // Format score for consistent display
    const formatScore = (value, max) => ({
      display: `${parseFloat(value || 0).toFixed(2)}/${max}`,
      percentage: `${((value / 21) * 100).toFixed(1)}%`
    });

    // Log score breakdown in 21-point scale
    const scoreComponents = [
      { 
        name: '1. Technical', 
        value: techScoreComponent, 
        max: 8,
        description: 'Based on RSI, MACD, and other indicators'
      },
      { 
        name: '2. Dip', 
        value: dipScoreComponent, 
        max: 5,
        description: 'Based on recent price drops'
      },
      { 
        name: '3. Conditions', 
        value: conditionsBonus, 
        max: 4,
        description: 'Market conditions (RSI, MACD, VWAP, Volume)'
      },
      { 
        name: '4. Blended', 
        value: blendedScoreComponent, 
        max: 4,
        description: '24h low / 24h high price analysis'
      }
    ];

    logger.info('\n=== 📊 BUY SIGNAL SCORE BREAKDOWN (0-21 scale) ===');
    
    // Log header
    logger.info('Component         Score     Weight   Contribution');
    logger.info('----------------------------------------------');
    
    // Log each score component with detailed breakdown
    scoreComponents.forEach(({ name, value, max, description }) => {
      const weightPct = (max / 21 * 100).toFixed(1);
      const contribution = (value / 21 * 100).toFixed(1);
      logger.info(
        `${name.padEnd(16)} ${value.toFixed(2).padStart(4)}/${max}` +
        `  ${weightPct}%`.padStart(8) +
        `  ${contribution}%`.padStart(12) +
        `  ${description}`
      );
    });
    
    // Log total score and threshold
    logger.info('----------------------------------------------');
    logger.info(
      `${'TOTAL SCORE'.padEnd(16)}` +
      `${totalScore.toFixed(2).padStart(4)}/21` +
      `${'100.0%'.padStart(14)}` +
      `  ${isBuySignal ? '✅ BUY SIGNAL' : '❌ NO SIGNAL'}`
    );
    
    // Log decision
    logger.info('\n=== 📈 DECISION ===');
    logger.info(`- BUY THRESHOLD:     ${buyThreshold} points (55% of 21)`);
    logger.info(`- CURRENT SCORE:     ${totalScore.toFixed(2)}/21 (${(totalScore/21*100).toFixed(1)}%)`);
    logger.info(`- SIGNAL:            ${isBuySignal ? '✅ BUY' : '❌ NO SIGNAL'}`);
    logger.info('===================================\n');
    
    // Log detailed breakdown for debugging
    logger.debug('Score Components:', {
      technicalScore: techScoreComponent,
      dipScore: dipScoreComponent,
      conditionsBonus: conditionsBonus,
      blendedScore: blendedScoreComponent,
      totalScore: totalScore,
      isBuySignal: isBuySignal,
      timestamp: new Date().toISOString()
    });

    // Log the score components for debugging
    logger.debug('Score Components:', {
      techScore: techScoreComponent,
      dipScore: dipScoreComponent,
      conditionsBonus,
      blendedScore: blendedScoreComponent,
      totalScore,
      buyThreshold,
      isBuySignal
    });
    
    // Log the blended score components for transparency
    logger.info(`📊 Blended Score Components (24h Low: ${blendedScoreResult.low24hScore.toFixed(1)} | 24h High: ${blendedScoreResult.high24hScore.toFixed(1)})`);
    logger.info(`   - 24h Low: ${blendedScoreResult.low24hScore.toFixed(1)}/10 (${low24hScore.percentAbove24hLow?.toFixed(2) || '0.00'}% above 24h low)`);
    logger.info(`   - 24h High: ${blendedScoreResult.high24hScore.toFixed(1)}/10 (${blendedScoreResult.percentBelow24hHigh?.toFixed(2) || '0.00'}% below 24h high)`);
    logger.info(`   - Blended: ${blendedScoreResult.score.toFixed(1)}/10 (${(blendedScoreResult.score * 10).toFixed(1)}% of max)`);
    
    // Ensure total score is within 0-21 bounds
    totalScore = Math.max(0, Math.min(totalScore, 21));
    
    // Format buy signal evaluation for better logging
    const formatDecimal = (num, decimals = 8) => {
      if (num === null || num === undefined) return 'N/A';
      const value = parseFloat(num);
      // Ensure zero values are displayed properly and not treated as falsy
      return isNaN(value) ? 'N/A' : (value === 0 ? '0' : value.toFixed(decimals));
    };

    // Calculate price percentage difference
    const calculatePctDiff = (current, reference) => {
      if (!reference || reference === 0) return 0;
      return ((current - reference) / reference) * 100;
    };

    // Log detailed buy signal evaluation
    if (totalScore >= this.buyConfig.minScore || logger.level === 'debug') {
      logger.info('\n=== 📊 BUY SIGNAL EVALUATION ===');
      
      // Price and Score Summary
      const entryThreshold = this.buyConfig.minScore * 1.5;
      const maxPossibleScore = 21; // Maximum possible score in the 21-point system
      
      logger.info(`🔹 Current Price: $${formatDecimal(currentPrice)}`);
      // Score Breakdown with consistent formatting
      logger.info('\n📊 SCORE BREAKDOWN (0-21 scale):');
      
      // Reuse the formatScore function from above
      const formatScore = (value, max) => ({
        display: `${(parseFloat(value) || 0).toFixed(2)}/${max}`,
        percentage: `${((parseFloat(value) || 0) / 21 * 100).toFixed(1)}%`
      });

      // Show technical score (8/21 weight)
      const techDisplay = formatScore(techScoreComponent, 8);
      logger.info(`- Technical Score: ${techDisplay.display.padEnd(10)} (${techDisplay.percentage} of total)`);
      
      // Show dip score (5/21 weight)
      const dipDisplay = formatScore(dipScoreComponent, 5);
      logger.info(`- Dip Score:       ${dipDisplay.display.padEnd(10)} (${dipDisplay.percentage} of total)`);
      
      // Show blended score components (4/21 weight)
      const blendedDisplay = formatScore(blendedScoreComponent, 4);
      logger.info(`- Blended Score:   ${blendedDisplay.display.padEnd(10)} (${blendedDisplay.percentage} of total)`);
      
      if (blendedScoreResult) {
        logger.info(`  • 24h Low:  ${formatDecimal(blendedScoreResult.low24hScore || 0, 2)}/10`);
        logger.info(`  • 24h High: ${formatDecimal(blendedScoreResult.high24hScore, 2)}/10`);
        logger.info(`  • Blended:  ${formatDecimal(blendedScoreResult.score, 2)}/10`);
      }
      
      // Show conditions bonus (4/21 weight) only once
      const conditionsDisplay = formatScore(conditionsBonus, 4);
      logger.info(`- Conditions:      ${conditionsDisplay.display.padEnd(10)} (${conditionsDisplay.percentage} of total)`);
      
      // Log individual conditions if any
      if (reasons.length > 0) {
        reasons.forEach(reason => logger.info(`  • ${reason}`));
      }
      
      // Show total score and thresholds
      const totalDisplay = formatScore(totalScore, 21);
      const thresholdDisplay = formatScore(buyThreshold, 21);
      
      logger.info('\n🎯 SCORE SUMMARY:');
      logger.info(`- Total Score:   ${totalScore.toFixed(2)}/21    (${(totalScore/21*100).toFixed(1)}% of max)`);
      logger.info(`- Buy Threshold: ${buyThreshold}         (${(buyThreshold/21*100).toFixed(1)}% of max)`);
      logger.info(`   Threshold: ${buyThreshold}/21 (${(buyThreshold/21*100).toFixed(1)}%)`);
      
      // Indicator Values
      logger.info('\n📈 INDICATORS:');
      logger.info(`- RSI: ${formatDecimal(indicators.rsi, 2)} ${indicators.rsi < 30 ? '🔴' : indicators.rsi > 70 ? '🟢' : '⚪'}`);
      
      // Show EMA20 with proper handling - ensure zero values are displayed correctly
      const ema20Value = this.indicators && typeof this.indicators.ema20 === 'number' && !isNaN(this.indicators.ema20)
        ? `$${formatDecimal(this.indicators.ema20)} (${calculatePctDiff(this.indicators.price, this.indicators.ema20).toFixed(2)}%)` 
        : 'N/A';
      logger.info(`- EMA20: ${ema20Value}`);
      
      // Show VWAP if it has a valid value
      const vwapValue = vwap24hInfo?.vwap24h !== undefined && vwap24hInfo.vwap24h !== null
        ? `$${formatDecimal(vwap24hInfo.vwap24h)} (${formatDecimal(calculatePctDiff(this.indicators.price, vwap24hInfo.vwap24h), 2)}%)` 
        : 'N/A';
      logger.info(`- VWAP24h: ${vwapValue}`);
      
      // Show MACD Histogram with proper null/undefined/zero check
      const macdHistogram = this.indicators?.macdHistogram;
      const macdHistValue = (macdHistogram !== null && macdHistogram !== undefined && !isNaN(macdHistogram))
        ? `${formatDecimal(macdHistogram, 6)} ${macdHistogram >= 0 ? '🟢' : '🔴'}` 
        : 'N/A';
      logger.info(`- MACD Hist: ${macdHistValue}`);
      
      // Debug log for indicators object
      logger.debug('Indicators object:', {
        ema20: this.indicators?.ema20,
        macdHistogram: this.indicators?.macdHistogram,
        rsi: this.indicators?.rsi,
        price: this.indicators?.price,
        currentPrice: currentPrice
      });
      
      // Buy Conditions
      logger.info('\n✅ CONDITIONS MET:');
      if (reasons.length > 0) {
        reasons.forEach(reason => logger.info(`- ${reason}`));
      } else {
        logger.info('- No specific conditions met');
      }
      
      // Additional context
      logger.info('\n📌 CONTEXT:');
      const rsiSignal = indicators.rsi < 30 ? 'Oversold (Good Buy)' : 
                       indicators.rsi > 70 ? 'Overbought (Caution)' : 'Neutral';
      const emaSignal = currentPrice > indicators.ema20 ? 'Above EMA20 (Bullish)' : 'Below EMA20 (Bearish)';
      
      logger.info(`- RSI Signal: ${rsiSignal}`);
      logger.info(`- EMA20 Signal: ${emaSignal}`);
      
      logger.info('==============================\n');
    }
    
    // Check if we have an active buy signal that needs to be monitored
    if (this.activeBuySignal.isActive) {
      const priceIncreasePct = ((currentPrice - this.activeBuySignal.signalPrice) / this.activeBuySignal.signalPrice) * 100;
      
      // Update confirmation based on new score
      const confirmationThreshold = 7; // Slightly lower threshold for CEX
      const isConfirmed = totalScore >= confirmationThreshold;
      
      // If we have a new high score, update the active signal
      if (totalScore > this.activeBuySignal.highestScore) {
        this.activeBuySignal.highestScore = totalScore;
        this.activeBuySignal.highestScoreTime = currentTime;
      }
      
      // If price has moved significantly against us, reset the signal
      const maxDrawdownPct = 2; // 2% max drawdown before reset
      if (priceIncreasePct < -maxDrawdownPct) {
        logger.info(`Resetting buy signal due to ${priceIncreasePct.toFixed(2)}% drawdown`);
        this.resetBuySignal('price_drawdown');
        return {
          score: 0,
          reasons: ['Signal reset due to drawdown'],
          confirmed: false
        };
      }
      
      return {
        score: totalScore,
        reasons: [`Active signal monitoring (${reasons.join(', ')})`],
        confirmed: isConfirmed,
        isActiveSignal: true,
        priceIncreasePct
      };
    }
    
    // For new signals, require the standard threshold (12/21)
    // We're using the same buyThreshold (12 points) that was defined earlier
    // This ensures consistency in our buy signal evaluation
    const meetsThreshold = totalScore >= buyThreshold; // Using the 12/21 threshold consistently
    
    // Calculate all price metrics needed for logging
    const low24hScoreResult = await this.calculate24hLowScore(currentPrice);
    const blendedScore = await this.calculateBlendedScore(currentPrice, low24hScoreResult, high24hInfo);    
    
    // Log detailed price metrics and scoring information
    if (totalScore >= this.buyConfig.minScore || logger.level === 'debug') {
      logger.info('\n💰 PRICE LEVELS:');
      
      // Calculate and format price differences
      const formatPriceLevel = (priceInfo, label) => {
        if (!priceInfo) return '';
        const price = priceInfo.high60m || priceInfo.high12h || priceInfo.avgHigh24h;
        const pctDiff = calculatePctDiff(currentPrice, price);
        return `- ${label}: $${formatDecimal(price)} (${pctDiff >= 0 ? '+' : ''}${formatDecimal(pctDiff, 2)}%)`;
      };
      
      logger.info(`- Current: $${formatDecimal(currentPrice)}`);
      
      if (high12hInfo?.high12h) logger.info(formatPriceLevel(high12hInfo, '12h High'));
      if (high24hInfo?.avgHigh24h) logger.info(formatPriceLevel({ avgHigh24h: high24hInfo.avgHigh24h }, '24h High'));
      
      // Support and resistance levels
      if (indicators.bollingerBands) {
        logger.info('\n📉 SUPPORT/RESISTANCE:');
        logger.info(`- Upper BB: $${formatDecimal(indicators.bollingerBands.upper)}`);
        logger.info(`- Middle BB: $${formatDecimal(indicators.bollingerBands.middle)}`);
        logger.info(`- Lower BB: $${formatDecimal(indicators.bollingerBands.lower)}`);
      }
      
      // Log blended score details if available
      if (blendedScore) {
        logger.info('\n🔄 BLENDED SCORE:');
        const totalBlended = (blendedScore.low24hScore || 0) + (blendedScore.high24hScore || 0);
        if (totalBlended > 0) {
          const low24hWeight = (blendedScore.low24hScore / totalBlended * 100).toFixed(1);
          const high24hWeight = (blendedScore.high24hScore / totalBlended * 100).toFixed(1);
          logger.info(`- Score: ${formatDecimal(blendedScore.score, 2)}/10`);
          logger.info(`- 24h Low: ${formatDecimal(blendedScore.low24hScore, 2)} (${low24hWeight}% weight)`);
          logger.info(`- 24h High: ${formatDecimal(blendedScore.high24hScore, 2)} (${high24hWeight}% weight)`);
        }
        
        if (blendedScore.reasons?.length) {
          logger.info('  Analysis:');
          blendedScore.reasons.forEach(r => {
            if (typeof r === 'string' && r.includes(':')) {
              const [key, ...valueParts] = r.split(':');
              logger.info(`  - ${key.trim()}: ${valueParts.join(':').trim()}`);
            } else {
              logger.info(`  - ${r}`);
            }
          });
        }
      }
      
      // Log evaluation status with more context
      logger.info('\n🔍 EVALUATION:');
      // Use the same buyThreshold (12/21) that was defined earlier for consistency
      // No need to redefine meetsThreshold as it's already defined above
      
      logger.info(`- Score: ${totalScore.toFixed(2)}/21`);
      logger.info(`- Status: ${isBuySignal ? '✅ BUY SIGNAL' : '❌ NO SIGNAL'}`);
      logger.info(`- Active Signal: ${this.activeBuySignal.isActive ? '✅ YES' : '❌ NO'}`);
      
      if (this.activeBuySignal.isActive) {
        const priceChange = ((currentPrice - this.activeBuySignal.signalPrice) / this.activeBuySignal.signalPrice * 100).toFixed(2);
        logger.info(`- Signal Price: $${this.activeBuySignal.signalPrice} (${priceChange}% ${parseFloat(priceChange) >= 0 ? '↑' : '↓'})`);
        logger.info(`- Confirmations: ${this.activeBuySignal.confirmations}`);
      }
    }
    
    // Return the evaluation result
    return {
      score: totalScore,
      reasons: meetsThreshold ? reasons : ['Score below threshold'],
      confirmed: meetsThreshold,
      isActiveSignal: false,
      vwap24h: vwap24hInfo.vwap24h,
      priceVsVwap24h: vwap24hInfo.priceVsVwap24h,
      volumeSpike: volumeSpike,
      momentum: momentum.score
    };
    
    // Check if we have an active buy signal that needs to be monitored
    if (this.activeBuySignal.isActive) {
      const priceIncreasePct = ((currentPrice - this.activeBuySignal.signalPrice) / this.activeBuySignal.signalPrice) * 100;
      
      const activeSignalInfo = {
        timestamp: currentTime.toISOString(),
        signal: {
          price: this.activeBuySignal.signalPrice,
          time: new Date(this.activeBuySignal.signalTime).toISOString(),
          confirmations: this.activeBuySignal.confirmations,
          lastConfirmation: this.activeBuySignal.lastConfirmationTime ? 
            new Date(this.activeBuySignal.lastConfirmationTime).toISOString() : null
        },
        current: {
          price: currentPrice,
          priceChangePct: parseFloat(priceIncreasePct.toFixed(4))
        },
        position: {
          buyCount: this.activeBuySignal.buyCount,
          totalInvested: this.activeBuySignal.totalInvested,
          totalQuantity: this.activeBuySignal.totalQuantity,
          averagePrice: this.activeBuySignal.averagePrice
        }
      };
      
      logger.debug('Active Buy Signal State:', JSON.stringify(activeSignalInfo, null, 2));
      
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
        high24hInfo: {
          avgHigh24h: parseFloat(high24hInfo.avgHigh24h?.toFixed(4) || 0),
          percentBelow24hHigh: high24hInfo.percentBelow24hHigh
        },
        high12hInfo: {
          high12h: parseFloat(high12hInfo.high12h?.toFixed(4) || 0),
          percentBelow12hHigh: high12hInfo.percentBelow12hHigh,
          currentPrice: parseFloat(high12hInfo.currentPrice?.toFixed(4) || 0)
        },
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
    
    // Debug log for confirmation status - only log if not already confirmed
    if (isConfirmed && !this.activeBuySignal.confirmationProcessed) {
      logger.debug('Confirmation check', {
        confirmed: confirmation.confirmed,
        hasEnoughConfirmations,
        totalScore,
        minScore: this.buyConfig.minScore,
        activeSignal: this.activeBuySignal.isActive,
        confirmations: this.activeBuySignal.confirmations
      });
    }
    
    // If we don't have an active signal or required data, skip to the output generation
    const hasActiveSignal = this.activeBuySignal.isActive && 
                          this.activeBuySignal.signalPrice !== null && 
                          this.activeBuySignal.signalTime !== null;
    
    if (!hasActiveSignal) {
      // Reset any existing active signal data
      this.activeBuySignal = {
        isActive: false,
        signalPrice: null,
        signalTime: null,
        confirmations: 0,
        lastConfirmationTime: null,
        totalInvested: 0,
        totalQuantity: 0,
        averagePrice: 0,
        buyCount: 0,
        lastBuyPrice: 0,
        orderIds: []
      };
    }
    
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
      
      // Log the confirmation - this will be shown in the main signal output
      logger.debug('2-candle buy signal confirmed, executing buy order', {
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
    
    // Format the 24h and 12h high prices for display
    const formattedHigh24h = this.formatHighPrice(high24hInfo);
    const formattedHigh12h = this.formatHighPrice(high12hInfo, 12);
    
    // Filter out any score-related reasons to avoid duplication
    const filteredTechReasons = techScore.reasons.filter(r => 
      !r.includes('Score:') && 
      !r.includes('24h High:') && 
      !r.includes('12h High:') &&
      !r.includes('Low 24h:')
    );
    
    // Format the current time for the log header
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0].replace(/-/g, '').slice(2);
    const timeStr = now.toTimeString().slice(0, 8);
    
    // Format the price change string
    const priceChangePercent = indicators.priceChangePercent || 0;
    const priceChange = indicators.priceChange || 0;
    const priceChangeStr = priceChange >= 0 ? 
      `📈 +${priceChange.toFixed(8)} (+${priceChangePercent.toFixed(2)}%)` : 
      `📉 ${priceChange.toFixed(8)} (${priceChangePercent.toFixed(2)}%)`;
    
    // Create a minimal reasons array with just the essential information
    const allReasons = [
      `=== ${dateStr} | ${timeStr} ===`,
      `📊 ${this.tradingPair} - Buy Signal Evaluation`,
      `💵 Price: ${currentPrice.toFixed(4)}`,
      `📊 Total Score: ${totalScore}/21`,
      `⚡ Status: ${isConfirmed ? '✅ Confirmed' : this.activeBuySignal.isActive ? '⏳ Pending' : 'No Signal'}`,
      this.activeBuySignal.isActive 
        ? `⏳ Signal active (${this.activeBuySignal.confirmations}/2 confirmations)`
        : 'No active signal'
    ];
    
    // Update last log time
    this.activeBuySignal.lastSignalLogTime = currentTime;

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
  /**
   * Gets the current bot status
  /** 
  /**
   * @returns {Promise<Object>} Status object
   */
  async start() {
    try {
      logger.info('Starting SyrupBot...');
      
      // Load candles from cache first
      logger.info('Loading candles from cache before startup...');
      await this.loadCandlesFromCache();
      
      // Log candle status after loading
      if (!this.candles) {
        logger.error('[CRITICAL] this.candles is null or undefined after loadCandlesFromCache');
      } else {
        logger.info(`[DIAGNOSTIC] Loaded ${this.candles.length} candles from cache`);
        if (this.candles.length > 0) {
          const firstCandle = this.candles[0];
          const lastCandle = this.candles[this.candles.length - 1];
          logger.info(`[DIAGNOSTIC] Candle time range: ${new Date(firstCandle.time * 1000).toISOString()} to ${new Date(lastCandle.time * 1000).toISOString()}`);
          logger.info(`[DIAGNOSTIC] First candle: ${JSON.stringify(firstCandle)}`);
          logger.info(`[DIAGNOSTIC] Last candle: ${JSON.stringify(lastCandle)}`);
          logger.info(`[DIAGNOSTIC] Sufficient for indicators: ${this.candles.length >= 26 ? 'YES' : 'NO'} (need 26+ for MACD)`);
        }
      }
      
      // Initialize Telegram bot
      if (this.config.telegram && this.config.telegram.enabled) {
        try {
          await this.setupTelegramCommands();
        } catch (error) {
          logger.error('Failed to set up Telegram commands:', error);
        }
      }
      
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
  /**
   * Sends a trade notification to Telegram
  /** 
  /**
   * @param {string} message - The message to send
  /** 
  /**
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
  /**
   * Notifies about a buy order
  /** 
  /**
   * @param {Object} order - The executed buy order
  /** 
  /**
   * @param {number} amount - The amount of base currency bought
  /** 
  /**
   * @param {number} price - The price per unit
  /** 
  /**
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
  /**
   * Notifies about a sell order
  /** 
  /**
   * @param {Object} order - The executed sell order
  /** 
  /**
   * @param {number} amount - The amount of base currency sold
  /** 
  /**
   * @param {number} price - The price per unit
  /** 
  /**
   * @param {number} total - The total received in quote currency
  /** 
  /**
   * @param {number} profitPct - The profit percentage
   */
  async notifySellOrder(order, amount, price, total, profitPct) {
    if (!this.telegramService?.enabled) return;
    
    const profitEmoji = profitPct >= 0 ? '📈' : '📉';
    const profitText = profitPct >= 0 ? 'Profit' : 'Loss';
    const isLimitOrder = order.order_type === 'limit' || order.type === 'limit';
    const orderType = isLimitOrder ? 'LIMIT GTC' : 'MARKET';
    
    const message = `💰 *${orderType} SELL ORDER ${isLimitOrder ? 'PLACED' : 'EXECUTED'}*\n` +
      `🔹 *Amount:* ${this.formatNumber(amount, 2)} ${this.baseCurrency}\n` +
      `🔹 *Price:* ${this.formatNumber(price, 4)} ${this.quoteCurrency}\n` +
      `🔹 *Total:* ${this.formatNumber(total, 2)} ${this.quoteCurrency}\n` +
      (isLimitOrder ? `🔹 *Time in Force:* GTC\n` : '') +
      `🔹 *${profitText}:* ${profitEmoji} ${Math.abs(profitPct).toFixed(2)}%\n` +
      `🔹 *Order ID:* \`${order.id}\``;
    
    await this.sendTelegramNotification(message);
  }

  /**
  /**
   * Notifies about an error
  /** 
  /**
   * @param {string} context - The context where the error occurred
  /** 
  /**
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
    } else if (currency === 'SYRUP' || this.quoteCurrency === 'USDC') {
      // SYRUP in USDC: 4 decimal places for consistency with USDC formatting
      return num.toFixed(4);
    }
    
    // Default formatting for other currencies
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency === 'USD' ? 'USD' : 'XXX',
      minimumFractionDigits: 2,
      maximumFractionDigits: 8
    }).format(num) + (currency === 'USD' ? '' : ` ${currency}`);
  }

  // Format high price for display (60m, 12h, or 24h)
  formatHighPrice(highInfo, timeframe = '24h') {
    try {
      let highField, percentField;
      
      // Determine which fields to use based on timeframe
      switch(timeframe) {
        case '60m':
          highField = 'high60m';
          percentField = 'percentBelow60mHigh';
          break;
        case '12h':
          highField = 'high12h';
          percentField = 'percentBelow12hHigh';
          break;
        case '24h':
        default:
          highField = 'avgHigh24h';
          percentField = 'percentBelow24hHigh';
      }
      
      if (!highInfo[highField] && highInfo[highField] !== 0) return 'N/A';
      
      const percentValue = highInfo[percentField] || 0;
      const percentText = percentValue >= 0 
        ? `${percentValue.toFixed(2)}% below`
        : `${Math.abs(percentValue).toFixed(2)}% above`;
        
      return `$${parseFloat(highInfo[highField]).toFixed(8)} (${percentText})`;
    } catch (error) {
      logger.error('Error formatting high price:', { error, highInfo, timeframe });
      return 'N/A';
    }
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
      let formatNum = (value, decimals = 4) => 
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
      
      // Format indicators - simplified approach with direct logging of raw values
      // This helps identify if the issue is with calculation or formatting
      logger.debug('Raw indicator values from this.indicators:', this.indicators);
      
      // Parse indicator values with proper debugging
      const emaValue = parseFloat(this.indicators.ema20 || 0);
      const rsiValue = parseFloat(this.indicators.rsi || 0);
      const macdHist = parseFloat(this.indicators.macdHistogram || 0);
      const macdSignal = parseFloat(this.indicators.macdSignal || 0);
      const macdLine = parseFloat(this.indicators.macdLine || 0);
      const stochK = parseFloat(this.indicators.stochK || 0);
      const stochD = parseFloat(this.indicators.stochD || 0);
      const bbUpper = parseFloat(this.indicators.bbUpper || 0);
      const bbMiddle = parseFloat(this.indicators.bbMiddle || 0);
      const bbLower = parseFloat(this.indicators.bbLower || 0);
      
      // Log parsed values for debugging
      logger.debug('Parsed indicator values:', {
        emaValue,
        rsiValue,
        macdHist,
        macdSignal,
        macdLine
      });
      
      // Determine if price is above or below EMA
      const priceVsEma = latestCandle.close > emaValue ? 'ABOVE' : 'BELOW';
      const emaDiffPercent = ((latestCandle.close - emaValue) / emaValue * 100).toFixed(2);
      
      // Ensure price is a valid number before passing to evaluateBuySignal
      const currentPrice = parseFloat(latestCandle.close);
      if (isNaN(currentPrice) || currentPrice <= 0) {
        logger.warn('Invalid candle close price detected', { 
          close: latestCandle.close, 
          parsed: currentPrice,
          candle: latestCandle
        });
      }
      
      // Calculate buy signal
      const buySignal = await this.evaluateBuySignal({
        ema: emaValue,
        rsi: rsiValue,
        stochK: stochK,
        stochD: stochD,
        bb: { upper: bbUpper, middle: bbMiddle, lower: bbLower },
        macd: { histogram: macdHist, signal: macdSignal, MACD: macdLine },
        price: currentPrice > 0 ? currentPrice : 0.0001 // Ensure valid price, use small positive fallback if invalid
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
      
      // Use the reasons array from the buy signal which already has the formatted output
      const buySignalInfo = buySignal.reasons.join('\n');
      
      // Create log message - simplified to only show the new scoring system output
      const logMessage = [
        `\n=== ${formattedTime} ===`,
        `📊 ${this.tradingPair} - ${candleTime.split(' ')[1]}`,
        `💵 Price: ${this.formatPrice(latestCandle.close, this.quoteCurrency)} ${priceChangeSymbol} ${priceChange} (${priceChangePercent}%)`,
        `📈 High: ${this.formatPrice(latestCandle.high, this.quoteCurrency)} | 📉 Low: ${this.formatPrice(latestCandle.low, this.quoteCurrency)}`,
        `📊 Volume: ${formatNum(latestCandle.volume, 2)} ${this.baseCurrency}`,
        '--- BUY SIGNAL ---',
        buySignalInfo,  // This already contains all the signal information
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
            ema: this.indicators.ema20,
            rsi: this.indicators.rsi,
            stoch: this.indicators.stochastic,
            bb: this.indicators.bb,
            macd: { 
              line: this.indicators.macd, 
              signal: this.indicators.macdSignal, 
              histogram: this.indicators.macdHistogram 
            }
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
  /**
   * Check and execute trades based on signals
  /** 
  /**
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
      
      // Use the proper 12/21 threshold (55% of max score)
      const buyThreshold = Math.ceil(21 * 0.47); // 10 points - adjusted for more responsive buying
      
      if (signal && signal.score >= buyThreshold) {
        logger.info(`Buy signal detected with score ${signal.score}/21 (threshold: ${buyThreshold}/21)`);
        
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
      } else if (signal) {
        logger.info(`Buy signal rejected: score ${signal.score.toFixed(2)}/21 below threshold of ${buyThreshold}/21`);
      }
      
    } catch (error) {
      logger.error('Error in checkAndExecuteTrades:', error);
    }
  }
  
  /**
  /**
   * Place a limit sell order after a successful buy
  /** 
  /**
   * @param {number} buyPrice - Price at which the asset was bought
  /** 
  /**
   * @param {number} amount - Amount of base currency to sell
  /** 
  /**
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
      
      // Calculate sell price with 3% profit target
      const sellPrice = parseFloat((buyPrice * 1.03).toFixed(3));
      
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
  /**
   * Place a buy order and handle the response with confirmation
  /** 
  /**
   * @param {number} price - Current price
  /** 
  /**
   * @param {string} type - Type of buy (INITIAL, DCA, or CONFIRMED)
  /** 
  /**
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
  /**
   * Update the active buy signal after a successful order
  /** 
  /**
   * @param {number} price - Price of the order
  /** 
  /**
   * @param {number} amount - Amount in quote currency
  /** 
  /**
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
  /**
   * Log trade details
  /** 
  /**
   * @param {string} type - Type of trade (e.g., 'BUY', 'SELL_LIMIT', 'BUY_FAILED')
  /** 
  /**
   * @param {number} price - Price of the trade
  /** 
  /**
   * @param {number} amount - Amount in quote currency
  /** 
  /**
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
  /**
   * Reset the active buy signal and clean up related state
  /** 
  /**
   * @param {string} reason - Reason for the reset (for logging)
  /** 
  /**
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

  /**
  /**
   * Check for existing sell orders at startup and track them
  /** 
  /**
   * @private
   */
  async checkForExistingSellOrders() {
    try {
      logger.info('🔍 [ONE-TIME CHECK] Checking for existing open sell orders...');
      
      // Get all open orders for the trading pair
      const openOrders = await this.coinbaseService.getOpenOrders(this.tradingPair);
      
      logger.debug(`[ONE-TIME CHECK] getOpenOrders response: ${JSON.stringify(openOrders, null, 2)}`);
      
      if (openOrders && openOrders.orders && openOrders.orders.length > 0) {
        logger.info(`📊 Found ${openOrders.orders.length} open sell order(s) at startup`);
        
        // Filter for SELL and LIMIT orders
        const sellLimitOrders = openOrders.orders.filter(order => 
          order.order_type === 'LIMIT' && 
          (order.side === 'SELL' || order.side === 'SELL_LIMIT')
        );
        
        // Log details of each open order
        sellLimitOrders.forEach((order, index) => {
          const orderId = order.order_id || 'unknown';
          const price = order.price || 'unknown';
          const size = order.size || 'unknown';
          const filled = order.filled_size || '0';
          const remaining = order.remaining_size || size;
          const type = order.order_type || 'unknown';
          const timeInForce = order.time_in_force || 'GTC';
          
          logger.info(`  Order #${index + 1}:`);
          logger.info(`    ID: ${orderId}`);
          logger.info(`    Type: ${type} (${timeInForce})`);
          logger.info(`    Price: ${price} ${this.quoteCurrency}`);
          logger.info(`    Size: ${size} ${this.baseCurrency}`);
          logger.info(`    Filled: ${filled} ${this.baseCurrency}`);
          logger.info(`    Remaining: ${remaining} ${this.baseCurrency}`);
          
          // Track the limit order
          if (orderId && price && size) {
            this.trackLimitOrder(
              orderId,
              parseFloat(remaining),
              parseFloat(price),
              0, // Unknown buy price for existing orders
              'SELL_LIMIT'
            );
            logger.info('    ✅ Added to active limit orders tracking');
          }
        });
        
        // Notify via Telegram if available
        if (this.telegramService?.enabled) {
          const message = `🔍 Found ${sellLimitOrders.length} open sell order(s) at startup. ` +
                         'Type /orders to view details.';
          await this.telegramService.sendMessage(message);
        }
      } else {
        logger.info('ℹ️ No open sell orders found at startup');
      }
    } catch (error) {
      logger.error('❌ Error checking for open sell orders:', error);
      // Don't throw, just log the error
    }
  }

  /**
  /**
   * Start the main trading cycle
  /** 
  /**
   * @returns {Promise<boolean>} True if the trading cycle started successfully
   */
  async startTradingCycle() {
    if (this.isRunning) {
      logger.warn('Trading cycle is already running');
      return false;
    }

    this.isRunning = true;
    logger.info('🚀 Starting trading cycle...');

    try {
      // NOTE: The bot is now initialized in the main() function before this is called.
      // The redundant initialize() call has been removed.

      // Check for existing sell orders
      logger.info('🔍 Checking for existing sell orders...');
      await this.checkForExistingSellOrders();
      logger.info('✅ Existing sell orders checked');

      // Initialize and start the trailing stop manager in the background
      try {
        logger.info('🚀 [TRAILING STOP] Initializing trailing stop manager...');
        const initialized = await this.trailingStop.initialize();

        if (!initialized) {
          throw new Error('Failed to initialize trailing stop manager');
        }

        logger.info('✅ [TRAILING STOP] Trailing stop manager initialized');

        // Start the trailing stop manager but DO NOT await it.
        // This allows it to run in the background without blocking the main trading loop.
        logger.info('🚀 [TRAILING STOP] Starting trailing stop manager in the background...');

        logger.info('✅ [TRAILING STOP] Trailing stop manager started successfully');

      } catch (error) {
        logger.error('❌ [TRAILING STOP] Error in trailing stop manager:', error);
        // Attempt to stop the trailing stop manager if it was partially started
        try {
          if (this.trailingStop) {
            await this.trailingStop.stop();
          }
        } catch (stopError) {
          logger.error('❌ [TRAILING STOP] Error stopping trailing stop manager:', stopError);
        }
        // Continue with the trading cycle even if trailing stop fails
      }

      // Start the trading loop
      logger.info('🔄 Starting main trading loop...');
      await this.tradingLoop();
      logger.info('✅ Trading loop completed');

      return true;

    } catch (error) {
      logger.error('❌ Error in trading cycle:', error);

      // Make sure to stop the trailing stop manager on error
      if (this.trailingStop && typeof this.trailingStop.stop === 'function') {
        try {
          logger.info('🛑 Stopping trailing stop manager due to error...');
          await this.trailingStop.stop();
        } catch (stopError) {
          logger.error('❌ Error stopping trailing stop manager:', stopError);
        }
      }

      this.isRunning = false;
      throw error;
    }
  }

  /**
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
  /**
   * Add a limit order to the tracking system
  /** 
  /**
   * @param {string} orderId - The order ID from the exchange
  /** 
  /**
   * @param {number} amount - The amount of base currency in the order
  /** 
  /**
   * @param {number} price - The limit price of the order
  /** 
  /**
   * @param {number} buyPrice - The original buy price (for profit calculation)
  /** 
  /**
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
    let lastMinute = -1; // Track the last minute we processed
    
    try {
      while (this.isRunning) {
        const now = new Date();
        const currentMinute = now.getMinutes();
        const currentSecond = now.getSeconds();
        const currentMs = now.getMilliseconds();
        
        // Calculate time until next minute + 500ms
        const msUntilNextMinute = (60 - currentSecond) * 1000 - currentMs + 500;
        
        try {
          // If we've crossed into a new minute, wait until 500ms past the minute
          if (currentMinute !== lastMinute) {
            lastMinute = currentMinute;
            
            // If we're not already past the 500ms mark, wait until then
            if (currentSecond === 0 && currentMs < 500) {
              await new Promise(resolve => setTimeout(resolve, 500 - currentMs));
            }
          }
          // Update hourly candles every hour
          if (now - lastHourlyUpdate >= 3600000) {
            await this.updateHourlyCandles(true);
            lastHourlyUpdate = now;
          }
          
          // Check for filled limit orders periodically
          if (now - lastOrderCheck >= ORDER_CHECK_INTERVAL) {
            await this.checkFilledLimitOrders();
            lastOrderCheck = now;
            
            // Log current status every time we check orders (every 30s)
            this.logTradeCycle();
          }
          
          // Fetch latest candle data
          await this.fetchCandleData();
          
          // Calculate technical indicators before checking for trades
          await this.calculateIndicators();
          
          // Check and execute trades
          await this.checkAndExecuteTrades();
          
          // Calculate time to sleep until next cycle
          const nowMs = Date.now();
          const nextCycleTime = Math.ceil(nowMs / 60000) * 60000 + 500; // Next :00.5
          const sleepTime = Math.max(100, nextCycleTime - nowMs); // At least 100ms sleep
          
          // Sleep until next cycle
          await new Promise(resolve => setTimeout(resolve, sleepTime));
          
        } catch (error) {
          logger.error('Error in trading cycle iteration:', error);
          // Wait a bit before retrying to prevent tight error loops
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    } finally {
      // Final cleanup
      this.isRunning = false;
      
      // Stop the trailing stop manager when the trading loop ends
      if (this.trailingStop) {
        try {
          logger.info('🛑 Stopping trailing stop manager...');
          await this.trailingStop.stop();
        } catch (stopError) {
          logger.error('Error stopping trailing stop manager:', stopError);
        }
      }
      
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

// Main execution function
async function main() {
  try {
    console.log('[MAIN] Starting SYRUP-USDC Trading Bot');
    const syrupBot = new SyrupTradingBot();
    console.log('[MAIN] Bot instantiated. Initializing...');
    await syrupBot.initialize();
    console.log('[MAIN] Bot initialized. Starting trading cycle...');
    await syrupBot.startTradingCycle();
    console.log('[MAIN] Trading cycle finished (this should not happen).');
    console.log('[MAIN] Bot is now running. Press Ctrl+C to stop.');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nStopping trading bot...');
      await syrupBot.stop(); // Assuming a stop method exists for cleanup
      console.log('Bot stopped gracefully.');
      process.exit(0);
    });

  } catch (error) {
    console.error('CRITICAL: Unhandled error during bot execution:', error);
    process.exit(1);
  }
}

// Run the bot
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}

export default SyrupTradingBot;

