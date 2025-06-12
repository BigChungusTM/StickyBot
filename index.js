const { coinbaseService } = require('./coinbase.service.js');
const fs = require('fs');
const path = require('path');
const averagingIntegration = require('./averaging_integration.js');
const manualTransactionDetection = require('./manual_transaction_detection.js'); // Import manual transaction detection
const { evaluateEntrySellOpportunities, updatePositionAfterEntrySell } = require('./entry_sell_logic'); // Import entry sell logic
const { tradingConfig } = require('./config');
const recentLowPriceCheck = require('./recent_low_price_check.js'); // Import recent low price check
const recentHighPriceCheck = require('./recent_high_price_check.js'); // Import recent high price check
const candlePatternAnalyzer = require('./enhanced_candle_pattern_analyzer.js'); // Import enhanced candle pattern analyzer with better detection for XRP-USDC
const neutralPatternFilter = require('./neutral_pattern_filter.js'); // Import neutral pattern filter to detect low-conviction zones
const shortPositionManagement = require('./short_position_management.js'); // Import short position management
// Use process messaging for parent/child process communication with botmain.js
// This is the recommended way to communicate between the TraderBot and WhatsApp bot
const { EMA, MACD, RSI, BollingerBands, Stochastic } = require('technicalindicators');

// Define a dedicated position state file in the data directory
const POSITION_STATE_FILE_PATH = path.join(__dirname, '..', 'data', 'position_state.json');
const STATE_FILE_PATH = path.join(__dirname, 'xrp_usdc_bb_rsi_macd_stoch_state.json'); // Updated for XRP-USDC
const CANDLE_CACHE_FILE_PATH = path.join(__dirname, 'xrp_usdc_candles.json'); // Updated for XRP-USDC
const CYCLE_INFO_FILE_PATH = path.join(__dirname, '..', 'data', 'cycle_info.json');
const PRICE_HISTORY_FILE_PATH = path.join(__dirname, '..', 'data', 'price_history.json'); // Save in src directory
const TRADE_LOG_FILE_PATH = path.join(__dirname, '..', 'trader_history.json'); // Move to traderbot/
const PROFIT_FILE_PATH = path.join(__dirname, '..', 'cumulative_profit.json'); // Move to traderbot/
const MAX_CANDLES_TO_CACHE = 200;
const INITIAL_CANDLE_FETCH_HOURS = 1; // Reduced from 25 to 1 hour to avoid API errors

console.log("Hello, PnL Trading App! Starting Combined BB-RSI-MACD-Stoch Strategy Bot for XRP-USDC...");

const CANDLE_INTERVAL = 'ONE_MINUTE'; // Changed from FIFTEEN_MINUTE
const TRADING_INTERVAL_MS = 60 * 1000; // 1 minute interval
const NOTIFICATION_RETRY_COUNT = 3;

// Trading pair configuration
const TRADING_PAIR = 'XRP-USDC'; // Changed from XRP-USD
const BASE_CURRENCY = 'XRP'; // Base currency remains XRP
const QUOTE_CURRENCY = 'USDC'; // Changed from USD
const CURRENCY_SYMBOL = '$'; // Changed from €

// EMA parameters
const EMA_CLOSE_THRESHOLD_PERCENT = 0.1; // 0.1% threshold for EMA convergence

// Trend Analysis Parameters
const PEAK_LOOKBACK = 15; // Increased lookback for more confirmed peaks
const TREND_EMA_FAST = 21; // Slower fast EMA for longer trends
const TREND_EMA_SLOW = 55; // Slower EMA for longer trends
const DOWNTREND_RSI_THRESHOLD = 30; // More aggressive RSI threshold
const VOLUME_SURGE_THRESHOLD = 2.0; // Higher volume requirement
const FALSE_POSITIVE_THRESHOLD = 4; // More confirmations needed
const RECOVERY_THRESHOLD = 0.02; // 2% price recovery to consider uptrend
const MIN_HOLD_TIME = 3600000; // Minimum 1 hour hold time
const DEEP_DIP_THRESHOLD = 0.15; // 15% dip threshold for averaging down

// Recovery detection parameters
const RECOVERY_RSI_THRESHOLD = 55; // RSI threshold for recovery
const RECOVERY_VOLUME_RATIO = 1.3; // Volume increase for recovery confirmation

// Set minimum trade amounts - reduced to allow trading with smaller balances
// Note: With smaller amounts, fees will have a higher impact on profitability
const MIN_USDC_TRADE_AMOUNT = 10.0; // Reduced from 50.0 to allow trading with current balance
const MIN_XRP_TRADE_AMOUNT = 5.0; // Reduced from 20.0 to allow trading with current balance

// Trend Analysis Functions
function detectPeak(candles, index) {
    if (index < PEAK_LOOKBACK || index >= candles.length - 1) return false;
    
    const price = parseFloat(candles[index].close);
    let isPeak = true;
    
    // Check if current price is higher than surrounding prices
    for (let i = 1; i <= PEAK_LOOKBACK; i++) {
        const prevPrice = parseFloat(candles[index - i].close);
        const nextPrice = parseFloat(candles[index + 1].close);
        if (price <= prevPrice || price <= nextPrice) {
            isPeak = false;
            break;
        }
    }
    
    return isPeak;
}

function isLocalHigh(candles, currentIndex) {
    if (currentIndex < 2 || currentIndex >= candles.length - 2) return false;
    
    const currentPrice = parseFloat(candles[currentIndex].close);
    const prevPrice1 = parseFloat(candles[currentIndex - 1].close);
    const prevPrice2 = parseFloat(candles[currentIndex - 2].close);
    const nextPrice1 = parseFloat(candles[currentIndex + 1].close);
    const nextPrice2 = parseFloat(candles[currentIndex + 2].close);
    
    // Check if current price is higher than surrounding prices
    return currentPrice > prevPrice1 && 
           currentPrice > prevPrice2 && 
           currentPrice > nextPrice1 && 
           currentPrice > nextPrice2;
}

/**
 * Detect potential reversal patterns in a sequence of candles
 * @param {Array} candles - Array of candles to analyze
 * @returns {boolean} - True if a reversal pattern is detected
 */
function detectReversalPattern(candles) {
    if (candles.length < 3) return false;
    
    // Get the last three candles
    const c1 = candles[candles.length - 3]; // Oldest
    const c2 = candles[candles.length - 2]; // Middle
    const c3 = candles[candles.length - 1]; // Newest
    
    // Parse prices
    const open1 = parseFloat(c1.open);
    const close1 = parseFloat(c1.close);
    const high1 = parseFloat(c1.high);
    const low1 = parseFloat(c1.low);
    
    const open2 = parseFloat(c2.open);
    const close2 = parseFloat(c2.close);
    const high2 = parseFloat(c2.high);
    const low2 = parseFloat(c2.low);
    
    const open3 = parseFloat(c3.open);
    const close3 = parseFloat(c3.close);
    const high3 = parseFloat(c3.high);
    const low3 = parseFloat(c3.low);
    
    // Calculate candle body sizes
    const body1 = Math.abs(close1 - open1);
    const body2 = Math.abs(close2 - open2);
    const body3 = Math.abs(close3 - open3);
    
    // Check for bullish engulfing pattern
    const bullishEngulfing = 
        close1 < open1 && // First candle is bearish
        close2 > open2 && // Second candle is bullish
        open2 < close1 && // Second candle opens below first close
        close2 > open1 && // Second candle closes above first open
        body2 > body1; // Second candle body is larger
    
    // Check for morning star pattern
    const morningStar = 
        close1 < open1 && // First candle is bearish
        body2 < body1 * 0.5 && // Second candle has a small body (doji-like)
        close3 > open3 && // Third candle is bullish
        close3 > (open1 + close1) / 2; // Third candle closes above midpoint of first
    
    // Check for hammer pattern (potential reversal at bottom)
    const hammer = 
        close3 > open3 && // Bullish candle
        (close3 - low3) > 2 * (high3 - close3) && // Long lower wick
        (high3 - close3) < body3 * 0.3 && // Short or no upper wick
        low3 < Math.min(low1, low2); // New low point
    
    // Return true if any reversal pattern is detected
    return bullishEngulfing || morningStar || hammer;
}

/**
 * Check the consistency of a trend over a specified number of candles
 * @param {Array} candles - Array of candles
 * @param {number} currentIndex - Current candle index
 * @param {number} lookback - Number of candles to look back
 * @returns {number} - Trend consistency score (-10 to +10, positive = bullish)
 */
function checkTrendConsistency(candles, currentIndex, lookback) {
    if (currentIndex < lookback) return 0;
    
    let bullishCount = 0;
    let bearishCount = 0;
    let strongBullish = 0;
    let strongBearish = 0;
    
    // Analyze the specified number of candles
    for (let i = currentIndex - lookback + 1; i <= currentIndex; i++) {
        const open = parseFloat(candles[i].open);
        const close = parseFloat(candles[i].close);
        const high = parseFloat(candles[i].high);
        const low = parseFloat(candles[i].low);
        const bodySize = Math.abs(close - open);
        const totalRange = high - low;
        
        if (close > open) {
            bullishCount++;
            // Check if it's a strong bullish candle (body is >60% of range)
            if (bodySize > totalRange * 0.6) strongBullish++;
        } else if (close < open) {
            bearishCount++;
            // Check if it's a strong bearish candle (body is >60% of range)
            if (bodySize > totalRange * 0.6) strongBearish++;
        }
    }
    
    // Calculate trend score (-10 to +10)
    const trendScore = ((bullishCount - bearishCount) / lookback * 5) + 
                       ((strongBullish - strongBearish) / lookback * 5);
    
    return Math.max(-10, Math.min(10, trendScore)); // Clamp between -10 and +10
}

function calculateTrendStrength(candles, currentIndex) {
    if (currentIndex < 30) return { strength: 0, isDowntrend: false };
    
    // Calculate EMAs
    const prices = candles.slice(0, currentIndex + 1).map(c => parseFloat(c.close));
    const fastEMA = EMA.calculate({ period: TREND_EMA_FAST, values: prices });
    const slowEMA = EMA.calculate({ period: TREND_EMA_SLOW, values: prices });
    
    // Calculate slope of EMAs
    const fastSlope = (fastEMA[fastEMA.length - 1] - fastEMA[fastEMA.length - 2]);
    const slowSlope = (slowEMA[slowEMA.length - 1] - slowEMA[slowEMA.length - 2]);
    
    // Check volume trend
    const currentVolume = parseFloat(candles[currentIndex].volume);
    const avgVolume = candles
        .slice(currentIndex - 10, currentIndex)
        .reduce((sum, c) => sum + parseFloat(c.volume), 0) / 10;
    const volumeSurge = currentVolume > avgVolume * VOLUME_SURGE_THRESHOLD;
    
    // Calculate trend strength (-1 to 1, negative means downtrend)
    const strength = (fastSlope + slowSlope) / 2;
    const isDowntrend = strength < 0 && fastEMA[fastEMA.length - 1] < slowEMA[slowEMA.length - 1];
    
    return {
        strength: Math.abs(strength),
        isDowntrend,
        volumeConfirmation: volumeSurge
    };
}

function detectRecovery(candles, currentIndex) {
    if (currentIndex < 30) return false;
    
    // Check price recovery
    const currentPrice = parseFloat(candles[currentIndex].close);
    const lowestPrice = Math.min(...candles.slice(currentIndex - 10, currentIndex).map(c => parseFloat(c.close)));
    const priceRecovery = (currentPrice - lowestPrice) / lowestPrice;
    
    // Check volume trend
    const currentVolume = parseFloat(candles[currentIndex].volume);
    const avgVolume = candles
        .slice(currentIndex - 10, currentIndex)
        .reduce((sum, c) => sum + parseFloat(c.volume), 0) / 10;
    const volumeIncrease = currentVolume > avgVolume * RECOVERY_VOLUME_RATIO;
    
    // Check RSI
    const prices = candles.slice(0, currentIndex + 1).map(c => parseFloat(c.close));
    const rsiValues = RSI.calculate({ period: 14, values: prices });
    const currentRSI = rsiValues[rsiValues.length - 1];
    
    // Check EMA trend
    const emaFast = EMA.calculate({ period: TREND_EMA_FAST, values: prices });
    const emaSlow = EMA.calculate({ period: TREND_EMA_SLOW, values: prices });
    const emaUptrend = emaFast[emaFast.length - 1] > emaSlow[emaSlow.length - 1];
    
    return priceRecovery >= RECOVERY_THRESHOLD && 
           currentRSI >= RECOVERY_RSI_THRESHOLD && 
           (volumeIncrease || emaUptrend);
}

function checkFalsePositive(candles, currentIndex, trend) {
    let confirmations = 0;
    
    // 1. RSI confirmation
    const rsiValues = RSI.calculate({ period: 14, values: candles.slice(0, currentIndex + 1).map(c => parseFloat(c.close)) });
    const currentRSI = rsiValues[rsiValues.length - 1];
    if (currentRSI < DOWNTREND_RSI_THRESHOLD) confirmations++;
    
    // 2. Volume confirmation
    if (trend.volumeConfirmation) confirmations++;
    
    // 3. Price action confirmation (lower highs)
    const recent = candles.slice(currentIndex - 3, currentIndex + 1);
    const hasLowerHighs = recent.every((c, i) => i === 0 || parseFloat(c.high) <= parseFloat(recent[i-1].high));
    if (hasLowerHighs) confirmations++;
    
    // 4. MACD confirmation
    const prices = candles.slice(0, currentIndex + 1).map(c => parseFloat(c.close));
    const macdData = MACD.calculate({
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        values: prices
    });
    const currentMACD = macdData[macdData.length - 1];
    if (currentMACD.MACD < currentMACD.signal) confirmations++;
    
    return confirmations >= FALSE_POSITIVE_THRESHOLD;
}

// Helper function to handle trade notifications
async function sendTradeNotification(notificationData) {
    try {
        // Write to cycle_info.json for WhatsApp integration
        fs.writeFileSync(CYCLE_INFO_FILE_PATH, JSON.stringify(notificationData, null, 2));
        console.log(JSON.stringify(notificationData)); // Keep console log for debugging

        // Special handling for auto-averaging notifications which have a different format
        if (notificationData.type === 'auto_averaging' && notificationData.message) {
            // Auto-averaging notifications already have a formatted message
            let message = notificationData.message;
            
            // Use file-based notification which is more reliable than IPC when running from batch files
            const notificationFilePath = path.join(__dirname, '..', 'notification_queue.json');
            let notifications = [];
            
            // Read existing notifications if file exists
            if (fs.existsSync(notificationFilePath)) {
                try {
                    notifications = JSON.parse(fs.readFileSync(notificationFilePath, 'utf8'));
                } catch (err) {
                    console.error('[TraderBot] Error reading notification queue:', err);
                    notifications = [];
                }
            }
            
            // Add new notification
            notifications.push({
                id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                message,
                timestamp: Date.now(),
                sent: false
            });
            
            // Write back to file
            try {
                fs.writeFileSync(notificationFilePath, JSON.stringify(notifications, null, 2));
                console.log('[TraderBot] Notification added to queue file');
            } catch (err) {
                console.error('[TraderBot] Error writing notification queue:', err);
            }
            
            return; // Exit early for auto-averaging notifications
        }

        // Regular trade notifications
        let message = `🤖 *TRADE ALERT*\n\n`;
        
        // Action icon and type
        if (notificationData.action === 'BUY') {
            message += `🟢 *BUY ${notificationData.pair}*\n`;
        } else if (notificationData.action === 'SELL') {
            message += `🔴 *SELL ${notificationData.pair}*\n`;
        } else if (notificationData.action === 'PARTIAL_SELL') {
            message += `🟠 *PARTIAL SELL ${notificationData.pair}*\n`;
        } else if (notificationData.action === 'POSITION_ADJUSTED') {
            message += `🔄 *POSITION ADJUSTED ${notificationData.pair}*\n`;
        } else if (notificationData.action === 'POSITION_CLOSED') {
            message += `🔕 *POSITION CLOSED ${notificationData.pair}*\n`;
        } else if (notificationData.action === 'SELL_FAILED') {
            message += `⚠️ *SELL FAILED ${notificationData.pair}*\n`;
        }
        
        // Price and amount details
        message += `💰 Price: $${notificationData.price}\n`;
        message += `📊 Amount: ${notificationData.amount} XRP ($${notificationData.gbpValue})\n`;
        
        // Add profit details for sells
        if (notificationData.action === 'SELL' || notificationData.action === 'PARTIAL_SELL') {
            if (notificationData.entryPrice) {
                const priceChange = ((parseFloat(notificationData.price) - parseFloat(notificationData.entryPrice)) / parseFloat(notificationData.entryPrice) * 100).toFixed(2);
                message += `📈 Price Change: ${priceChange}%\n`;
            }
            if (notificationData.pnl) {
                // Ensure pnl is a number before using toFixed
                const pnlValue = typeof notificationData.pnl === 'number' ? notificationData.pnl : parseFloat(notificationData.pnl);
                message += `💸 P/L: $${isNaN(pnlValue) ? '0.00' : pnlValue.toFixed(2)}\n`;
            }
        }
        
        // Add trailing stop info if applicable
        if (notificationData.trailingStopPrice) {
            message += `🛑 Trailing Stop: $${notificationData.trailingStopPrice}\n`;
        }
        
        message += `\n📈 *Technical Indicators*\n` +
                  `RSI: ${notificationData.rsi}\n` +
                  `MACD: ${notificationData.macdLine}/${notificationData.macdSignal}\n` +
                  `Stoch: ${notificationData.stochK}/${notificationData.stochD}\n\n`;
                  
        // Add local price action info if available
        if (notificationData.isLocalLow) {
            message += `✅ Buying near local low\n`;
        }
        if (notificationData.isLocalHigh) {
            message += `✅ Selling near local high\n`;
        }
        
        message += `ℹ️ Reason:\n${notificationData.reason}\n\n` +
                  `💼 Balance: $${notificationData.balance} USDC`;

            // Use file-based notification which is more reliable than IPC when running from batch files
            const notificationFilePath = path.join(__dirname, '..', 'notification_queue.json');
            let notifications = [];
            
            // Read existing notifications if file exists
            if (fs.existsSync(notificationFilePath)) {
                try {
                    notifications = JSON.parse(fs.readFileSync(notificationFilePath, 'utf8'));
                } catch (err) {
                    console.error('[TraderBot] Error reading notification queue:', err);
                    notifications = [];
                }
            }
            
            // Add new notification
            notifications.push({
                id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                message,
                timestamp: Date.now(),
                sent: false
            });
            
            // Write back to file
            try {
                fs.writeFileSync(notificationFilePath, JSON.stringify(notifications, null, 2));
                console.log('[TraderBot] Notification added to queue file');
            } catch (err) {
                console.error('[TraderBot] Error writing notification queue:', err);
            }

            // Log trade entry for buy/sell actions
            if (notificationData.action === 'BUY' || notificationData.action === 'SELL') {
                await logTradeEntry({
                    timestamp: formatTimestamp(new Date()),
                    action: notificationData.action,
                    pair: notificationData.pair,
                    price: notificationData.price,
                    amountBtc: notificationData.amount,
                    amountGbp: notificationData.gbpValue,
                    orderId: notificationData.orderId,
                    reason: notificationData.reason,
                    signalDetails: notificationData.signalDetails || notificationData.reason,
                    entryPrice: notificationData.entryPrice,
                    pnl: notificationData.pnl || 0
                });
            }

            // Update state for successful trades
            if (notificationData.action === 'SELL' && !notificationData.reason.includes('failed') && !notificationData.reason.includes('Insufficient')) {
                // Full position close - only if it's a successful sell and not due to insufficient balance
                updateCumulativeProfit(parseFloat(notificationData.pnl || 0));
                lastSellActionTime = Date.now();
                lastSellPrice = parseFloat(notificationData.price);
                currentPosition = null;
                savePositionState();
                positionClosedThisCycle = true;
                console.log(`[Position] Full position closed at $${notificationData.price}`);
            } else if (notificationData.action === 'PARTIAL_SELL' && !notificationData.reason.includes('failed')) {
                // Partial position close
                updateCumulativeProfit(parseFloat(notificationData.pnl || 0));
                
                // Update current position with remaining amount
                if (currentPosition) {
                    const soldAmount = parseFloat(notificationData.amount);
                    const originalAmount = parseFloat(currentPosition.xrpAmount);
                    const remainingAmount = originalAmount - soldAmount;
                    
                    if (remainingAmount > 0) {
                        currentPosition.xrpAmount = remainingAmount.toFixed(8);
                        currentPosition.halfSoldOrCovered = true;
                        savePositionState();
                        console.log(`[Position] Partial position close: ${soldAmount.toFixed(8)} BTC sold, ${remainingAmount.toFixed(8)} BTC remaining`);
                    } else {
                        // If somehow we sold everything, treat as full close
                        lastSellActionTime = Date.now();
                        lastSellPrice = parseFloat(notificationData.price);
                        currentPosition = null;
                        savePositionState();
                        positionClosedThisCycle = true;
                        console.log(`[Position] Full position closed via partial sell at $${notificationData.price}`);
                    }
                }
            } else if (notificationData.action === 'POSITION_ADJUSTED') {
                // Position size was adjusted due to balance mismatch - don't close the position
                console.log(`[Position] Position size adjusted: ${notificationData.amount}`);
                // Position state was already updated in the main trading logic
            } else if (notificationData.action === 'SELL_FAILED') {
                // Sell failed due to insufficient balance - don't close the position
                console.log(`[Position] Sell failed: ${notificationData.reason}`);
                // Keep the position open, don't update state
            } else if (notificationData.action === 'BUY' && !notificationData.reason.includes('failed')) {
                lastSellActionTime = null;
                lastSellPrice = null;
                console.log(`[Position] New position opened at $${notificationData.price}`);
            }
        } catch (e) {
            console.error(`Notification failed:`, e.message);
        }
    }


let currentPosition = null;
let cachedCandles = [];
let tradeLog = [];
let cumulativeProfit = 0.0;
let lastSellActionTime = null;
let lastSellPrice = null;

// Variables for tracking consecutive positive candles
let consecutivePositiveCandles = 0;
let consecutivePriceIncreases = 0;
let lastPositiveCheckPrice = 0;
let sellConfirmationCount = 0;
let sellConfirmationRequired = 5; // Reduced from 6 to 5 as requested
let sellConfirmationResetThreshold = 0.1; // Reset counter only if price drops 0.1% below the take-profit threshold
let buyConfirmationCount = 0;
let buyConfirmationRequired = 4; // Require 4 confirmations before buying

// Define global variables for short position trading
let shortConfirmationCount = 0;
let shortConfirmationRequired = 4; // Require 4 consecutive short signals
let coverConfirmationCount = 0;
let coverConfirmationRequired = 6; // Require 6 consecutive cover signals before buying

// Variables for tracking continuous price drops during sell checks
let lastSellCheckPrice = 0;
let continuousPriceDropCount = 0;
let maxContinuousPriceDrops = 4; // Reset counter after 4 continuous drops

// --- Re-entry Logic Parameters ---
const PRICE_REENTRY_THRESHOLD = 0.01; // 1.0% above last SELL price - more conservative on re-entries
const TIME_COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown - longer cooldown to avoid quick re-entries

// --- Indicator Parameters ---
const BB_PERIOD = 20;
const BB_STD_DEV = 2.5; // Wider bands to catch more extreme moves
const RSI_PERIOD = 14;
const RSI_BUY_THRESHOLD = 30; // More extreme oversold condition required for buys
const RSI_SELL_THRESHOLD = 75; // More extreme overbought condition required for sells
const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 50;
const MACD_FAST_PERIOD = 12;
const MACD_SLOW_PERIOD = 26;
const MACD_SIGNAL_PERIOD = 9;
const STOCH_PERIOD = 14;
const STOCH_K_SMOOTH = 3;
const STOCH_D_SMOOTH = 3;
const STOCH_K_BUY_THRESHOLD = 20; // More extreme oversold condition for buys
const STOCH_K_SELL_THRESHOLD = 85; // More extreme overbought condition for sells

// --- Advanced Strategy Parameters ---
const EMA_PROXIMITY_TOLERANCE = 0.0025; // Tighter tolerance for EMA crossovers
const MACD_BUY_CONFIRMATION_OFFSET = -30; // Stronger MACD confirmation for buys
const MACD_SELL_CONFIRMATION_OFFSET = 30; // Stronger MACD confirmation for sells

// --- Price Action Parameters ---
const PRICE_ACTION_LOOKBACK = 5; // Look back candles for local highs/lows
const LOCAL_LOW_THRESHOLD = 0.005; // 0.5% threshold for local low detection
const LOCAL_HIGH_THRESHOLD = 0.005; // 0.5% threshold for local high detection

// --- Trade Parameters ---
const STOP_LOSS_PERCENT = 4.0; // Wider stop loss to allow for more price movement
const TRAILING_STOP_ACTIVATION_PERCENT = 2.0; // Activate trailing stop when profit reaches 2%
const TRAILING_STOP_DISTANCE_PERCENT = 1.5; // Trail by 1.5% of current price
const RISK_PERCENT_PER_TRADE = 35.0; // Slightly more conservative position sizing
const MIN_GBP_TRADE_AMOUNT = 1.00;
const MIN_BTC_TRADE_AMOUNT = 0.00001;
// const TRADING_FEE_PERCENT = 0.8; // Maximum trading fee percentage (replaced by tradingConfig.feePercentage)

// --- Position Management ---
const MIN_HOLD_TIME_MS = 3 * 60 * 60 * 1000; // Minimum 3 hours hold time (increased from 2)
const PROFIT_TAKING_THRESHOLD = 4.5; // Take partial profits at 4.5% (increased from 3%)
const PROFIT_TAKING_PERCENTAGE = 40; // Take 40% of position as profit (reduced from 50%)
const FULL_PROFIT_THRESHOLD = 8.0; // Consider full exit at 8% profit

// --- GBP Accumulation Strategy ---
const GBP_ACCUMULATION_TARGET = 1.0; // Target 1% increase in GBP per trade
const MACD_UPTREND_HOLD_MULTIPLIER = 1.5; // Hold 1.5x longer during MACD uptrends

const MIN_REQUIRED_CANDLES = Math.max(BB_PERIOD, RSI_PERIOD, EMA_SLOW_PERIOD, MACD_SLOW_PERIOD + MACD_SIGNAL_PERIOD, STOCH_PERIOD + STOCH_K_SMOOTH + STOCH_D_SMOOTH);

function formatTimestamp(date) {
    const pad = (num) => String(num).padStart(2, '0');
    const day = pad(date.getDate()); const month = pad(date.getMonth() + 1); const year = date.getFullYear();
    const hours = pad(date.getHours()); const minutes = pad(date.getMinutes()); const seconds = pad(date.getSeconds());
    return `${day}-${month}-${year} - ${hours}:${minutes}:${seconds}`;
}

function isEmaClose(emaFast, emaSlow) {
    if (!emaFast || !emaSlow) return false;
    const percentDiff = Math.abs(emaFast - emaSlow) / emaSlow * 100;
    return percentDiff < EMA_CLOSE_THRESHOLD_PERCENT;
}

/**
 * Check if there are consecutive positive candles
 * @param {Array} candles - Array of candles
 * @param {number} currentIndex - Current candle index
 * @returns {boolean} - True if there are at least 3 consecutive positive candles
 */
function checkConsecutivePositiveCandles(candles, currentIndex, count = 3) {
    if (currentIndex < count) return false;
    
    for (let i = 0; i < count; i++) {
        const candle = candles[currentIndex - i];
        if (parseFloat(candle.close) <= parseFloat(candle.open)) {
            return false;
        }
    }
    return true;
}
/**
 * Check for consecutive negative candles (for short positions)
 * @param {Array} candles - Array of candle data
 * @param {number} currentIndex - Current candle index
 * @param {number} count - Number of consecutive candles to check for
 * @returns {boolean} - True if there are at least 'count' consecutive negative candles
 */
function checkConsecutiveNegativeCandles(candles, currentIndex, count = 3) {
    if (currentIndex < count) return false;
    
    for (let i = 0; i < count; i++) {
        const candle = candles[currentIndex - i];
        if (parseFloat(candle.close) >= parseFloat(candle.open)) {
            return false;
        }
    }
    return true;
}

/**
 * Determine if we should confirm a sell based on multiple factors
 * @param {Array} candles - Array of candles
 * @param {number} currentIndex - Current candle index
 * @param {number} takeProfitPrice - The price at which we'd take profit (usually entry price + some margin)
 * @returns {boolean} - True if we should confirm the sell
 */
function shouldConfirmSell(candles, currentIndex, entryPrice) {
    if (currentIndex < 3) return false;
    
    const currentPrice = parseFloat(candles[currentIndex].close);
    
    // Check for continuous price drops during sell checks
    if (lastSellCheckPrice > 0) {
        if (currentPrice < lastSellCheckPrice) {
            continuousPriceDropCount++;
            console.log(`\x1b[33m[${new Date().toISOString()}] Continuous price drop detected: ${continuousPriceDropCount}/${maxContinuousPriceDrops} (${currentPrice.toFixed(8)} < ${lastSellCheckPrice.toFixed(8)})\x1b[0m`);
            
            // Reset sell confirmation count if we've had too many continuous drops
            if (continuousPriceDropCount >= maxContinuousPriceDrops && sellConfirmationCount > 0) {
                console.log(`\x1b[31m[${new Date().toISOString()}] SAFETY: Resetting sell confirmation count from ${sellConfirmationCount} to 0 due to ${continuousPriceDropCount} continuous price drops\x1b[0m`);
                sellConfirmationCount = 0;
                continuousPriceDropCount = 0;
                // Don't reset lastSellCheckPrice so we can continue tracking from this point
            }
        } else {
            // Reset continuous drop counter if price goes up
            continuousPriceDropCount = 0;
        }
    }
    
    // Update last sell check price
    lastSellCheckPrice = currentPrice;
    
    // 1. Basic profitability check - never sell at a loss
    const isProfitable = currentPrice > entryPrice;
    if (!isProfitable) return false;
    
    // 2. Calculate profit percentage
    const profitPercent = (currentPrice - entryPrice) / entryPrice * 100;
    
    // 3. Check for consecutive positive candles
    const hasConsecutivePositiveCandles = checkConsecutivePositiveCandles(candles, currentIndex);
    
    // 4. Check if we're in a strong uptrend (might want to hold longer)
    const isStrongUptrend = candles.slice(currentIndex-5, currentIndex+1).every(c => 
        parseFloat(c.close) > parseFloat(c.open));
    
    // Define take profit percentage (dynamic based on market conditions)
    const takeProfitPercent = 0.5; // 0.5% take profit
    
    // Check if we've hit take profit
    const takeProfitHit = currentPrice > entryPrice * (1 + (takeProfitPercent / 100));
    
    // Get information about consecutive positive candles
    const candleInfo = checkConsecutivePositiveCandles(candles, currentIndex);
    
    // Analyze candle patterns for sell signals
    const patternAnalysis = candlePatternAnalyzer.analyzePatterns(candles, new Date().toISOString());
    
    // If take profit is hit, check additional conditions
    if (takeProfitHit) {
        // If we have consecutive positive candles, we want to hold longer
        if (candleInfo.hasConsecutivePositives) {
            console.log(`Take profit hit, but we have ${consecutivePositiveCandles} consecutive positive candles with ${candleInfo.priceIncrease.toFixed(2)}% increase - holding for more gains`);
            return false;
        }
        
        // If we have strong bullish patterns, consider holding longer
        if (patternAnalysis.patternSignal === 'BULLISH' && patternAnalysis.netPatternScore > 2) {
            console.log(`\x1b[32m[${new Date().toISOString()}] Take profit hit, but strong bullish patterns detected (score: ${patternAnalysis.netPatternScore}). Holding for potential further gains.\x1b[0m`);
            return false;
        }
        // Store current candle information
const currentCandle = candles[currentIndex];
const isCurrentCandleRising = parseFloat(currentCandle.close) > parseFloat(currentCandle.open);

// Always increment the sell confirmation count up to 4 when take profit is hit
if (sellConfirmationCount < 4) {
    sellConfirmationCount++;
    console.log(`\x1b[33m[${new Date().toISOString()}] Incrementing sell confirmation count to ${sellConfirmationCount}/${sellConfirmationRequired} (aggressive mode)\x1b[0m`);
    
    // Still log information about candle conditions
    if (isCurrentCandleRising) {
        console.log(`Note: Current candle is still rising, but continuing confirmation count in aggressive mode`);
    }
} 
// If we're at 4 confirmations and the price is still rising, wait for a drop or stall
else if (sellConfirmationCount === 4 && isCurrentCandleRising) {
    // Check if the price increase is significant (more than 0.1%)
    const priceIncrease = ((currentPrice - lastSellCheckPrice) / lastSellCheckPrice) * 100;
    if (priceIncrease > 0.1) {
        console.log(`\x1b[32m[${new Date().toISOString()}] At 4 confirmations but price still rising significantly (${priceIncrease.toFixed(4)}%). Waiting for drop or stall before final confirmation.\x1b[0m`);
        return false;
    } else {
        console.log(`\x1b[33m[${new Date().toISOString()}] At 4 confirmations with minimal price increase (${priceIncrease.toFixed(4)}%). Adding final confirmation.\x1b[0m`);
        sellConfirmationCount++;
    }
}
// If we're at 4 confirmations and the price is dropping or flat, add the final confirmation
else if (sellConfirmationCount === 4) {
    console.log(`\x1b[33m[${new Date().toISOString()}] At 4 confirmations with price no longer rising. Adding final confirmation.\x1b[0m`);
    sellConfirmationCount++;
}
        
                // Accelerate sell confirmation if bearish patterns are detected
        if (patternAnalysis.patternSignal === 'BEARISH') {
            // Add extra confirmations based on the strength of bearish patterns
            const extraConfirmations = Math.min(3, Math.floor(patternAnalysis.netPatternScore * -1));
            sellConfirmationCount += extraConfirmations;
            
            // Enhanced bearish pattern notification with detailed information
            console.log(`\x1b[31m[${new Date().toISOString()}] ⚠️ BEARISH PATTERNS DETECTED! ⚠️\x1b[0m`);
            console.log(`\x1b[31m[${new Date().toISOString()}] Pattern Score: ${patternAnalysis.netPatternScore.toFixed(2)} | Adding ${extraConfirmations} extra sell confirmations\x1b[0m`);
            
            // Display the specific patterns detected
            if (patternAnalysis.patterns && patternAnalysis.patterns.length > 0) {
                console.log(`\x1b[31m[${new Date().toISOString()}] Detected Patterns:\x1b[0m`);
                patternAnalysis.patterns.forEach(pattern => {
                    console.log(`\x1b[31m[${new Date().toISOString()}]   - ${pattern.name}: ${pattern.description || 'Bearish reversal pattern'} (Score: ${pattern.score.toFixed(2)})\x1b[0m`);
                });
            }
            
            // Send notification to admin if it's a strong bearish signal (score < -2)
            if (patternAnalysis.netPatternScore < -2) {
                const notificationData = {
                    type: 'pattern_notification',
                    pair: TRADING_PAIR,
                    message: `Strong bearish patterns detected (Score: ${patternAnalysis.netPatternScore.toFixed(2)})`,
                    price: currentPrice.toFixed(8),
                    patterns: patternAnalysis.patterns ? patternAnalysis.patterns.map(p => p.name).join(', ') : 'Unknown'
                };
                console.log(JSON.stringify(notificationData));
            }
        }
    
        console.log(`\x1b[33m[${new Date().toISOString()}] Sell confirmation progress: ${sellConfirmationCount}/${sellConfirmationRequired}\x1b[0m`);
            
        // Only sell if we have enough confirmations
        return sellConfirmationCount >= sellConfirmationRequired;
    } else {
        // Only reset confirmation count if price has dropped significantly below take profit threshold
        // This adds tolerance for small fluctuations around the take profit level
        const takeProfitPrice = entryPrice * (1 + (takeProfitPercent / 100));
        const priceDropPercent = ((takeProfitPrice - currentPrice) / takeProfitPrice) * 100;
        
        if (priceDropPercent > sellConfirmationResetThreshold) {
            // Price has dropped enough below the take profit threshold to reset counter
            if (sellConfirmationCount > 0) {
                console.log(`\x1b[33m[${new Date().toISOString()}] Price dropped ${priceDropPercent.toFixed(4)}% below take profit threshold. Resetting sell confirmation count from ${sellConfirmationCount} to 0.\x1b[0m`);
                sellConfirmationCount = 0;
            }
        } else if (sellConfirmationCount > 0) {
            // Price is still close to take profit threshold, maintain counter but don't increment
            console.log(`\x1b[33m[${new Date().toISOString()}] Price near take profit threshold. Maintaining sell confirmation count at ${sellConfirmationCount}/${sellConfirmationRequired}.\x1b[0m`);
        }
        
        return false;
    }
}

/**
 * Determine if we should confirm covering a short position based on multiple factors
 * @param {Array} candles - Array of candles
 * @param {number} currentIndex - Current candle index
 * @param {number} entryPrice - The price at which we entered the short position
 * @param {Object} currentPosition - The current position object
 * @param {number} coverConfirmationCount - Current confirmation count
 * @param {number} coverConfirmationRequired - Required confirmations to cover
 * @returns {boolean} - True if we should confirm the cover
 */
function shouldConfirmCover(candles, currentIndex, entryPrice, currentPosition, coverConfirmationCount, coverConfirmationRequired) {
    if (currentIndex < 3) return false;
    
    const currentPrice = parseFloat(candles[currentIndex].close);
    
    // 1. Basic profitability check - never cover at a loss for short positions
    // For shorts, profit is when current price is LOWER than entry price
    const isProfitable = currentPrice < entryPrice;
    if (!isProfitable) return false;
    
    // 2. Calculate profit percentage for short position
    const profitPercent = (entryPrice - currentPrice) / entryPrice * 100;
    
    // 3. Check for consecutive negative candles (bearish momentum)
    const hasConsecutiveNegativeCandles = checkConsecutiveNegativeCandles(candles, currentIndex);
    
    // 4. Check if we're in a strong downtrend
    const isStrongDowntrend = currentPrice < parseFloat(candles[currentIndex-5].close) * 0.98;
    
    // 5. Increment cover confirmation count if conditions are met
    if (isProfitable && coverConfirmationCount < coverConfirmationRequired) {
        coverConfirmationCount++;
    } else if (!isProfitable) {
        coverConfirmationCount = 0;
    }
    
    // Decision logic:
    // - If profit is significant (2%+), cover immediately
    if (profitPercent >= 2) return true;
    
    // - If profit is good (1.2%+) and we have confirmation, cover
    if (profitPercent >= 1.2 && hasConsecutiveNegativeCandles) return true;
    
    // - If profit is modest (0.7%+) but not in strong downtrend, cover
    if (profitPercent >= 0.7 && !isStrongDowntrend) return true;
    
    // - If we have enough confirmations, cover
    if (coverConfirmationCount >= coverConfirmationRequired) return true;
    
    // - Otherwise, be patient and hold the short position
    return false;
}

// Detect if current price is at a local low point
function isLocalLow(candles, currentIndex) {
  if (currentIndex < PRICE_ACTION_LOOKBACK || currentIndex >= candles.length) return false;
  
  const currentPrice = parseFloat(candles[currentIndex].close);
  let isLow = true;
  
  // Check if current price is lower than previous candles
  for (let i = 1; i <= PRICE_ACTION_LOOKBACK; i++) {
    const comparePrice = parseFloat(candles[currentIndex - i].close);
    if (currentPrice > comparePrice * (1 - LOCAL_LOW_THRESHOLD)) {
      isLow = false;
      break;
    }
  }
  
  return isLow;
}

// Detect if current price is at a local high point
function isLocalHigh(candles, currentIndex) {
  if (currentIndex < PRICE_ACTION_LOOKBACK || currentIndex >= candles.length) return false;
  
  const currentPrice = parseFloat(candles[currentIndex].close);
  let isHigh = true;
  
  // Check if current price is higher than previous candles
  for (let i = 1; i <= PRICE_ACTION_LOOKBACK; i++) {
    const comparePrice = parseFloat(candles[currentIndex - i].close);
    if (currentPrice < comparePrice * (1 + LOCAL_HIGH_THRESHOLD)) {
      isHigh = false;
      break;
    }
  }
  
  return isHigh;
}

// Update trailing stop if needed
function updateTrailingStop(currentPosition, currentPrice) {
  if (!currentPosition || currentPosition.type !== 'LONG') return currentPosition;
  
  const entryPrice = parseFloat(currentPosition.entryPrice);
  const currentProfit = (currentPrice - entryPrice) / entryPrice * 100;
  
  // If profit exceeds activation threshold and trailing stop not yet active
  if (currentProfit >= TRAILING_STOP_ACTIVATION_PERCENT && !currentPosition.currentTrailingStopPrice) {
    console.log(`[TrailingStop] Activating trailing stop at ${currentProfit.toFixed(2)}% profit`);
    currentPosition.currentTrailingStopPrice = currentPrice * (1 - TRAILING_STOP_DISTANCE_PERCENT/100);
    return currentPosition;
  }
  
  // If trailing stop already active, update it if price moves higher
  if (currentPosition.currentTrailingStopPrice) {
    const newTrailingStop = currentPrice * (1 - TRAILING_STOP_DISTANCE_PERCENT/100);
    if (newTrailingStop > currentPosition.currentTrailingStopPrice) {
      console.log(`[TrailingStop] Updating trailing stop: ${currentPosition.currentTrailingStopPrice.toFixed(2)} -> ${newTrailingStop.toFixed(2)}`);
      currentPosition.currentTrailingStopPrice = newTrailingStop;
    }
  }
  
  return currentPosition;
}

// Check if trailing stop has been triggered
function isTrailingStopTriggered(currentPosition, currentPrice) {
  if (!currentPosition || !currentPosition.currentTrailingStopPrice) return false;
  return currentPrice < currentPosition.currentTrailingStopPrice;
}

// Check if we have consecutive positive candles
function checkConsecutivePositiveCandles(candles, currentIndex) {
    // Need at least 3 candles to check
    if (currentIndex < 2) return false;
    
    const currentCandle = candles[currentIndex];
    const prevCandle = candles[currentIndex - 1];
    const prevPrevCandle = candles[currentIndex - 2];
    
    // Check if current candle is positive (close > open)
    const currentCandlePositive = parseFloat(currentCandle.close) > parseFloat(currentCandle.open);
    
    // Check if price has increased by at least 0.5% from previous candle
    const priceIncrease = (parseFloat(currentCandle.close) - parseFloat(prevCandle.close)) / parseFloat(prevCandle.close);
    const significantIncrease = priceIncrease >= 0.005; // 0.5% increase
    
    // Update consecutive counters
    if (currentCandlePositive && significantIncrease) {
        consecutivePositiveCandles++;
        consecutivePriceIncreases++;
        lastPositiveCheckPrice = parseFloat(currentCandle.close);
    } else {
        consecutivePositiveCandles = 0;
        consecutivePriceIncreases = 0;
    }
    
    return {
        hasConsecutivePositives: consecutivePositiveCandles >= 2,
        hasSignificantIncreases: consecutivePriceIncreases >= 2,
        currentCandlePositive,
        priceIncrease: priceIncrease * 100 // Convert to percentage
    };
}

// Check if we should confirm a sell signal
function shouldConfirmSell(candles, currentIndex, takeProfitPrice) {
    // Get the entry price from the current position
    const entryPrice = currentPosition ? parseFloat(currentPosition.entryPrice) : 0;
    
    // Safety check - if no entry price is available, we can't confirm a sell
    if (!entryPrice) {
        console.error(`\x1b[41m[${new Date().toISOString()}] Error in shouldConfirmSell: No valid entry price available\x1b[0m`);
        return false;
    }
    
    // Define take profit percentage (same as in the first implementation)
    const takeProfitPercent = 0.5; // 0.5% take profit
    
    // Define sell confirmation reset threshold
    const sellConfirmationResetThreshold = 0.2; // Reset if price drops 0.2% below take profit
    const currentPrice = parseFloat(candles[currentIndex].close);
    const takeProfitHit = currentPrice >= parseFloat(takeProfitPrice);
    
    // Check if the position has been held for the minimum required time
    const positionAge = currentPosition ? (Date.now() - new Date(currentPosition.entryTime).getTime()) : 0;
    const minHoldTimeMs = 60 * 60 * 1000; // 1 hour minimum hold time
    
    if (positionAge < minHoldTimeMs) {
        const minutesRemaining = Math.ceil((minHoldTimeMs - positionAge) / (60 * 1000));
        console.log(`Position too new to sell (${minutesRemaining} minutes remaining until minimum hold time). Holding regardless of signals.`);
        return false;
    }
    
    // Get information about consecutive positive candles
    const candleInfo = checkConsecutivePositiveCandles(candles, currentIndex);
    
    // Analyze candle patterns for sell signals
    const patternAnalysis = candlePatternAnalyzer.analyzePatterns(candles, new Date().toISOString());
    
    // If take profit is hit, check additional conditions
    if (takeProfitHit) {
        // If we have consecutive positive candles, we want to hold longer
        if (candleInfo.hasConsecutivePositives) {
            console.log(`Take profit hit, but we have ${consecutivePositiveCandles} consecutive positive candles with ${candleInfo.priceIncrease.toFixed(2)}% increase - holding for more gains`);
            return false;
        }
        
        // If we have strong bullish patterns, consider holding longer
        if (patternAnalysis.patternSignal === 'BULLISH' && patternAnalysis.netPatternScore > 2) {
            console.log(`\x1b[32m[${new Date().toISOString()}] Take profit hit, but strong bullish patterns detected (score: ${patternAnalysis.netPatternScore}). Holding for potential further gains.\x1b[0m`);
            return false;
        }
        
        // Check if price is still rising in the current candle
        const currentCandle = candles[currentIndex];
        if (parseFloat(currentCandle.close) > parseFloat(currentCandle.open)) {
            console.log(`\x1b[32m[${new Date().toISOString()}] Current candle is still rising. Holding for potential further gains.\x1b[0m`);
            return false;
        }
        
        // Increment sell confirmation count
        sellConfirmationCount++;
        
        // Accelerate sell confirmation if bearish patterns are detected
        if (patternAnalysis.patternSignal === 'BEARISH') {
            // Add extra confirmations based on the strength of bearish patterns
            const extraConfirmations = Math.min(3, Math.floor(patternAnalysis.netPatternScore * -1));
            sellConfirmationCount += extraConfirmations;
            console.log(`\x1b[31m[${new Date().toISOString()}] Bearish candle patterns detected! Adding ${extraConfirmations} extra sell confirmations.\x1b[0m`);
        }
        
        console.log(`\x1b[33m[${new Date().toISOString()}] Sell confirmation progress: ${sellConfirmationCount}/${sellConfirmationRequired}\x1b[0m`);        
        // Only sell if we have enough confirmations
        return sellConfirmationCount >= sellConfirmationRequired;
    } else {
        // Only reset confirmation count if price has dropped significantly below take profit threshold
        // This adds tolerance for small fluctuations around the take profit level
        const takeProfitPrice = entryPrice * (1 + (takeProfitPercent / 100));
        const priceDropPercent = ((takeProfitPrice - currentPrice) / takeProfitPrice) * 100;
        
        if (priceDropPercent > sellConfirmationResetThreshold) {
            // Price has dropped enough below the take profit threshold to reset counter
            if (sellConfirmationCount > 0) {
                console.log(`\x1b[33m[${new Date().toISOString()}] Price dropped ${priceDropPercent.toFixed(4)}% below take profit threshold. Resetting sell confirmation count from ${sellConfirmationCount} to 0.\x1b[0m`);
                sellConfirmationCount = 0;
            }
        } else if (sellConfirmationCount > 0) {
            // Price is still close to take profit threshold, maintain counter but don't increment
            console.log(`\x1b[33m[${new Date().toISOString()}] Price near take profit threshold. Maintaining sell confirmation count at ${sellConfirmationCount}/${sellConfirmationRequired}.\x1b[0m`);
        }
        
        return false;
    }
}

// Detect if MACD is in an uptrend
function isMacdUptrend(candles, currentIndex, lookbackPeriod = 3) {
  if (currentIndex < lookbackPeriod || currentIndex >= candles.length) return false;
  
  // Get current and previous MACD values
  const currentCandle = candles[currentIndex];
  const macdValues = [];
  
  // Calculate MACD for current and previous candles
  for (let i = 0; i <= lookbackPeriod; i++) {
    const candleIndex = currentIndex - i;
    if (candleIndex < 0) continue;
    
    const prices = candles.slice(0, candleIndex + 1).map(c => parseFloat(c.close));
    const macdResult = MACD.calculate({
      values: prices,
      fastPeriod: MACD_FAST_PERIOD,
      slowPeriod: MACD_SLOW_PERIOD,
      signalPeriod: MACD_SIGNAL_PERIOD,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
    
    if (macdResult && macdResult.length > 0) {
      const lastMacd = macdResult[macdResult.length - 1];
      macdValues.push({
        macd: lastMacd.MACD,
        signal: lastMacd.signal,
        histogram: lastMacd.histogram
      });
    }
  }
  
  // Check if MACD is trending up
  if (macdValues.length < 2) return false;
  
  // Check if MACD line is rising
  let risingMacd = true;
  for (let i = 0; i < macdValues.length - 1; i++) {
    if (macdValues[i].macd < macdValues[i+1].macd) {
      risingMacd = false;
      break;
    }
  }
  
  // Check if histogram is positive or increasing
  let positiveHistogram = macdValues[0].histogram > 0;
  let increasingHistogram = true;
  for (let i = 0; i < macdValues.length - 1; i++) {
    if (macdValues[i].histogram < macdValues[i+1].histogram) {
      increasingHistogram = false;
      break;
    }
  }
  
  return risingMacd || (positiveHistogram && increasingHistogram);
}

// Calculate EUR accumulation from a potential sell
/**
 * Calculate profit/loss based on individual transactions
 * This enhanced version handles multiple buy transactions with different prices and accounts for trading fees
 * @param {Object} currentPosition - The current position with transaction history
 * @param {number} currentPrice - Current XRP price
 * @param {number} eurBalance - Available EUR balance
 * @param {number} [feePercentage=0.25] - Trading fee percentage (buy + sell combined)
 * @returns {Object} - Profit/loss information
 */
function calculateEurAccumulation(currentPosition, currentPrice, eurBalance, feePercentage = tradingConfig.feePercentage) {
  if (!currentPosition || !currentPosition.xrpAmount) return { accumulation: 0, percentage: 0, transactionDetails: [] };
  
  // Calculate EUR value if we sell at current price
  const xrpAmount = parseFloat(currentPosition.xrpAmount);
  // Account for sell-side fees
  const sellFeeMultiplier = 1 - (feePercentage / 100); // Full fee percentage as decimal
  const sellValue = xrpAmount * currentPrice * sellFeeMultiplier;
  
  // If we have transaction history, calculate profit/loss for each transaction
  const transactionDetails = [];
  let totalProfit = 0;
  
  if (currentPosition.transactions && currentPosition.transactions.length > 0) {
    // Only consider BUY transactions
    const buyTransactions = currentPosition.transactions.filter(t => t.type === 'BUY');
    
    // Calculate profit/loss for each transaction
    buyTransactions.forEach(transaction => {
      const txBtcAmount = parseFloat(transaction.xrpAmount);
      const txPrice = parseFloat(transaction.price);
      const txGbpAmount = parseFloat(transaction.gbpAmount);
      
      // Calculate profit/loss for this transaction including fees
      // Sell value minus buy cost, accounting for fees on both sides
      const txSellValue = txBtcAmount * currentPrice * sellFeeMultiplier;
      const txProfit = txSellValue - txGbpAmount;
      const txProfitPercent = (txProfit / txGbpAmount) * 100;
      
      transactionDetails.push({
        id: transaction.id,
        xrpAmount: txBtcAmount,
        entryPrice: txPrice,
        currentValue: txBtcAmount * currentPrice,
        effectiveSellValue: txSellValue.toFixed(2), // Format to 2 decimal places
        originalCost: txGbpAmount.toFixed(2), // Format to 2 decimal places
        profit: txProfit.toFixed(2), // Format to 2 decimal places
        profitPercent: txProfitPercent.toFixed(2), // Format to 2 decimal places
        timestamp: transaction.timestamp,
        reason: transaction.reason || 'MANUAL_BUY',
        isProfitableAfterFees: txProfit > 0
      });
      
      totalProfit += txProfit;
    });
  } else {
    // Fallback to legacy calculation if no transactions exist
    // Calculate original cost (what we paid for the BTC)
    const originalCost = xrpAmount * parseFloat(currentPosition.entryPrice);
    totalProfit = sellValue - originalCost;
    
    // Add a single transaction detail for the entire position
    transactionDetails.push({
      id: 'legacy-position',
      xrpAmount: xrpAmount,
      entryPrice: parseFloat(currentPosition.entryPrice),
      currentValue: (xrpAmount * currentPrice).toFixed(2), // Format to 2 decimal places
      effectiveSellValue: sellValue.toFixed(2), // Format to 2 decimal places
      originalCost: originalCost.toFixed(2), // Format to 2 decimal places
      profit: totalProfit.toFixed(2), // Format to 2 decimal places
      profitPercent: ((totalProfit / originalCost) * 100).toFixed(2), // Format to 2 decimal places
      timestamp: currentPosition.entryTime || new Date().toISOString(),
      reason: 'LEGACY_POSITION',
      isProfitableAfterFees: totalProfit > 0
    });
  }
  
  // Calculate percentage increase in total GBP
  const percentageIncrease = (totalProfit / gbpBalance) * 100;
  
  return {
    accumulation: parseFloat(totalProfit.toFixed(2)), // Format to 2 decimal places
    percentage: parseFloat(percentageIncrease.toFixed(2)), // Format to 2 decimal places
    transactionDetails: transactionDetails
  };
}

/**
 * Save the current position state to disk
 * This enhanced version tracks individual buy transactions
 */
function savePositionState() {
    const ts = formatTimestamp(new Date());
    try {
        // Create data directory if it doesn't exist
        const dataDir = path.join(__dirname, '..', 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        // Save to new position state file
        if (currentPosition) {
            // Add timestamps to position data for tracking
            const positionWithTimestamp = {
                ...currentPosition,
                lastUpdated: new Date().toISOString(),
                // Ensure entryTime exists - if not, set it to now
                entryTime: currentPosition.entryTime || new Date().toISOString(),
                // Ensure transactions array exists
                transactions: currentPosition.transactions || [{
                    type: 'BUY',
                    price: parseFloat(currentPosition.entryPrice),
                    xrpAmount: currentPosition.xrpAmount,
                    eurAmount: currentPosition.eurSpentOrReceived || currentPosition.gbpSpentOrReceived,
                    timestamp: currentPosition.entryTime || new Date().toISOString(),
                    id: `initial-${Date.now()}`
                }]
            };
            fs.writeFileSync(POSITION_STATE_FILE_PATH, JSON.stringify(positionWithTimestamp, null, 2), 'utf8');
            
            // Also save to old path for backward compatibility
            fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(positionWithTimestamp, null, 2), 'utf8');
        } else {
            // Clear position files if no position
            if (fs.existsSync(POSITION_STATE_FILE_PATH)) fs.unlinkSync(POSITION_STATE_FILE_PATH);
            if (fs.existsSync(STATE_FILE_PATH)) fs.unlinkSync(STATE_FILE_PATH);
        }
        console.log(`[${ts}] Position state saved/cleared.`);
    } catch (e) { console.error(`[${ts}] Error saving position state:`, e.message); }
}

/**
 * Load the current position state from disk
 * This enhanced version handles the transaction-based structure
 */
function loadPositionState() {
    const ts = formatTimestamp(new Date());
    try {
        // Try loading from new position state file first
        if (fs.existsSync(POSITION_STATE_FILE_PATH)) {
            const data = fs.readFileSync(POSITION_STATE_FILE_PATH, 'utf8');
            currentPosition = data ? JSON.parse(data) : null;
            console.log(`[${ts}] Position state loaded from data directory:`, currentPosition);
        }
        // Fall back to old file path if new one doesn't exist
        else if (fs.existsSync(STATE_FILE_PATH)) {
            const data = fs.readFileSync(STATE_FILE_PATH, 'utf8');
            currentPosition = data ? JSON.parse(data) : null;
            console.log(`[${ts}] Position state loaded from legacy location:`, currentPosition);
            // Save to new location for future use
            savePositionState();
        } else {
            currentPosition = null;
            console.log(`[${ts}] No position state found. Starting fresh.`);
        }
        
        // Validate position data
        if (currentPosition) {
            // Handle both old and new field naming conventions
            // Map new field names to old field names for backward compatibility
            const fieldMappings = {
                'amount': 'xrpAmount',
                'timestamp': 'entryTime'
            };
            
            // If using new field names, create compatibility fields
            if (currentPosition.amount && !currentPosition.xrpAmount) {
                currentPosition.xrpAmount = currentPosition.amount;
            }
            if (currentPosition.timestamp && !currentPosition.entryTime) {
                currentPosition.entryTime = currentPosition.timestamp;
            }
            if (!currentPosition.eurSpentOrReceived && currentPosition.transactions && currentPosition.transactions.length > 0) {
                // Calculate total EUR spent from transactions
                const buyTransactions = currentPosition.transactions.filter(t => t.type === 'BUY');
                let totalEur = 0;
                buyTransactions.forEach(t => {
                    totalEur += parseFloat(t.eurAmount || t.gbpAmount || 0);
                });
                currentPosition.eurSpentOrReceived = totalEur;
            }
            
            // Handle btcAmount as a fallback for xrpAmount (for backward compatibility)
            if (!currentPosition.xrpAmount && currentPosition.btcAmount) {
                console.log(`[${ts}] Position data is missing xrpAmount field. Using btcAmount value: ${currentPosition.btcAmount}`);
                currentPosition.xrpAmount = currentPosition.btcAmount;
            }
            
            // Ensure all required fields are present with fallbacks
            const requiredFields = ['type', 'entryPrice', 'entryTime'];
            // Only add xrpAmount to required fields if it's still missing after our fallback logic
            if (!currentPosition.xrpAmount) {
                requiredFields.push('xrpAmount');
            }
            
            const missingFields = requiredFields.filter(field => {
                // Check both the original field name and its potential mapping
                const mappedField = Object.entries(fieldMappings).find(([newField, oldField]) => oldField === field);
                const newFieldName = mappedField ? mappedField[0] : null;
                return !currentPosition.hasOwnProperty(field) && (!newFieldName || !currentPosition.hasOwnProperty(newFieldName));
            });
            
            if (missingFields.length > 0) {
                console.error(`[${ts}] Position data is missing required fields: ${missingFields.join(', ')}. Discarding.`);
                currentPosition = null;
            } else {
                // Ensure transactions array exists
                if (!currentPosition.transactions) {
                    currentPosition.transactions = [{
                        type: 'BUY',
                        price: parseFloat(currentPosition.entryPrice),
                        xrpAmount: currentPosition.xrpAmount || currentPosition.amount,
                        amount: currentPosition.xrpAmount || currentPosition.amount, // Add both field names for compatibility
                        eurAmount: currentPosition.eurSpentOrReceived || currentPosition.gbpSpentOrReceived || (parseFloat(currentPosition.entryPrice) * parseFloat(currentPosition.xrpAmount || currentPosition.amount)),
                        timestamp: currentPosition.entryTime || currentPosition.timestamp,
                        id: `initial-${Date.now()}`
                    }];
                    console.log(`[${ts}] Added transaction history to existing position.`);
                } else {
                    // Ensure all transactions have both old and new field names
                    currentPosition.transactions.forEach(tx => {
                        // Handle amount/xrpAmount
                        if (tx.amount && !tx.xrpAmount) tx.xrpAmount = tx.amount;
                        if (tx.xrpAmount && !tx.amount) tx.amount = tx.xrpAmount;
                        
                        // If gbpAmount is missing, calculate it
                        if (!tx.gbpAmount && tx.price && (tx.amount || tx.xrpAmount)) {
                            tx.gbpAmount = parseFloat(tx.price) * parseFloat(tx.amount || tx.xrpAmount);
                        }
                    });
                }
                
                // Calculate weighted average entry price from transactions
                const buyTransactions = currentPosition.transactions.filter(t => t.type === 'BUY');
                if (buyTransactions.length > 0) {
                    let totalBtc = 0;
                    let totalGbp = 0;
                    buyTransactions.forEach(t => {
                        totalBtc += parseFloat(t.amount || t.xrpAmount || 0);
                        totalGbp += parseFloat(t.gbpAmount || 0);
                    });
                    
                    // Update the weighted average entry price
                    if (totalBtc > 0) {
                        const weightedAvgPrice = totalGbp / totalBtc;
                        if (Math.abs(weightedAvgPrice - parseFloat(currentPosition.entryPrice)) > 0.01) {
                            console.log(`[${ts}] Updated weighted average entry price: $${weightedAvgPrice.toFixed(8)} (was $${currentPosition.entryPrice})`);
                            currentPosition.entryPrice = weightedAvgPrice.toFixed(2);
                        }
                    }
                }
                
                // Ensure both amount and xrpAmount exist and are in sync
                if (currentPosition.amount && !currentPosition.xrpAmount) {
                    currentPosition.xrpAmount = currentPosition.amount;
                } else if (currentPosition.xrpAmount && !currentPosition.amount) {
                    currentPosition.amount = currentPosition.xrpAmount;
                }
                
                // Make sure gbpSpentOrReceived is calculated if missing
                if (!currentPosition.gbpSpentOrReceived && buyTransactions.length > 0) {
                    let totalGbp = 0;
                    buyTransactions.forEach(t => {
                        totalGbp += parseFloat(t.gbpAmount || 0);
                    });
                    currentPosition.gbpSpentOrReceived = totalGbp;
                }
                
                console.log(`[${ts}] Valid position loaded: ${currentPosition.xrpAmount || currentPosition.amount} BTC @ $${currentPosition.entryPrice} with ${currentPosition.transactions.length} transaction(s)`);
            }
        }
    } catch (e) { 
        console.error(`[${ts}] Error loading position state:`, e.message); 
        currentPosition = null; 
    }
}

function saveCandleCache() {
    try { fs.writeFileSync(CANDLE_CACHE_FILE_PATH, JSON.stringify(cachedCandles.slice(-MAX_CANDLES_TO_CACHE), null, 2), 'utf8'); }
    catch (e) { console.error(`[${formatTimestamp(new Date())}] Error saving candle cache:`, e.message); }
}

function loadCandleCache() {
    const ts = formatTimestamp(new Date());
    try {
        if (fs.existsSync(CANDLE_CACHE_FILE_PATH)) {
            const data = fs.readFileSync(CANDLE_CACHE_FILE_PATH, 'utf8');
            cachedCandles = data ? JSON.parse(data) : [];
            console.log(`[${ts}] Candle cache loaded: ${cachedCandles.length}`);
        } else cachedCandles = [];
    } catch (e) { console.error(`[${ts}] Error loading candle cache:`, e.message); cachedCandles = []; }
}

function loadTradeLog() {
    const ts = formatTimestamp(new Date());
    try {
        if (fs.existsSync(TRADE_LOG_FILE_PATH)) {
            const data = fs.readFileSync(TRADE_LOG_FILE_PATH, 'utf8');
            tradeLog = data ? JSON.parse(data) : [];
            console.log(`[${ts}] Trade log loaded: ${tradeLog.length}`);
        } else { tradeLog = []; console.log(`[${ts}] Trade log file not found. Initializing.`);}
    } catch (e) { console.error(`[${ts}] Error loading trade log:`, e.message); tradeLog = []; }
}

function saveTradeLog() {
    try { fs.writeFileSync(TRADE_LOG_FILE_PATH, JSON.stringify(tradeLog, null, 2), 'utf8'); }
    catch (e) { console.error(`[${formatTimestamp(new Date())}] Error saving trade log:`, e.message); }
}

async function logTradeEntry(details) {
    tradeLog.push(details); saveTradeLog();
    // Ensure PNL is a number before using toFixed
    const pnlValue = typeof details.pnl === 'number' ? details.pnl : parseFloat(details.pnl || '0');
    console.log(`[${formatTimestamp(new Date())}] Trade logged: ${details.action} ${details.pair} @ ${details.price}, PNL: ${isNaN(pnlValue) ? '0.00' : pnlValue.toFixed(2)}`);
}

function loadCumulativeProfit() {
    const ts = formatTimestamp(new Date());
    try {
        if (fs.existsSync(PROFIT_FILE_PATH)) {
            const data = fs.readFileSync(PROFIT_FILE_PATH, 'utf8');
            cumulativeProfit = data ? parseFloat(data) : 0.0;
            if (isNaN(cumulativeProfit)) cumulativeProfit = 0.0;
            console.log(`[${ts}] Cumulative profit loaded: $${cumulativeProfit.toFixed(2)}`);
        } else { cumulativeProfit = 0.0; console.log(`[${ts}] Profit file not found. Initializing.`);}
    } catch (e) { console.error(`[${ts}] Error loading cumulative profit:`, e.message); cumulativeProfit = 0.0; }
}

function saveCumulativeProfit() {
    try {
        fs.writeFileSync(PROFIT_FILE_PATH, JSON.stringify({ profit: cumulativeProfit }, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error saving cumulative profit: ${error.message}`);
    }
}

/**
 * Update and save price history
 * @param {number} currentPrice - The current price
 * @param {string} timestamp - The current timestamp
 */
function updatePriceHistory(currentPrice, timestamp) {
    if (!currentPrice) return;
    
    try {
        // Create price history entry
        const priceEntry = {
            timestamp: new Date().toISOString(),
            price: currentPrice.toString(),
            formatted_time: timestamp
        };
        
        // Load existing price history
        let priceHistory = [];
        if (fs.existsSync(PRICE_HISTORY_FILE_PATH)) {
            try {
                const historyData = fs.readFileSync(PRICE_HISTORY_FILE_PATH, 'utf8');
                priceHistory = JSON.parse(historyData);
            } catch (error) {
                console.error(`Error reading price history: ${error.message}`);
                priceHistory = [];
            }
        }
        
        // Add new price entry
        priceHistory.push(priceEntry);
        
        // Keep only the last 24 hours of data (144 entries with 10-minute intervals)
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        priceHistory = priceHistory.filter(entry => {
            const entryTime = new Date(entry.timestamp).getTime();
            return entryTime >= oneDayAgo;
        });
        
        // Save updated price history
        fs.writeFileSync(PRICE_HISTORY_FILE_PATH, JSON.stringify(priceHistory, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error updating price history: ${error.message}`);
    }
}

function updateCumulativeProfit(pnl) {
    if (typeof pnl === 'number' && !isNaN(pnl)) {
        cumulativeProfit += pnl; saveCumulativeProfit();
        console.log(`[${formatTimestamp(new Date())}] Cumulative PNL: $${cumulativeProfit.toFixed(2)} (Last: $${pnl.toFixed(2)})`);
    } else console.warn(`[${formatTimestamp(new Date())}] Invalid PNL for update:`, pnl);
}

function calculatePositionSize(entryPrice, stopLossPrice, balanceUsdc, riskPercent) {
  if (!entryPrice || !stopLossPrice || !balanceUsdc || !riskPercent) return 0;
  const numEntry = parseFloat(entryPrice), numSL = parseFloat(stopLossPrice);
  const numBal = parseFloat(balanceUsdc), numRisk = parseFloat(riskPercent);
  if (numSL >= numEntry) return 0; // SL must be below entry for LONG

  // Account for trading fees
  const feeFactor = 1 + (tradingConfig.feePercentage / 100); // Fee adjustment for both entry and exit
  const effectiveEntry = numEntry * feeFactor;
  const effectiveSL = numSL / feeFactor;

  // Calculate maximum position size based on available balance
  const maxSpendable = Math.min(numBal * 0.95, numBal); // Never use more than 95% of balance
  
  // Calculate risk-adjusted position size
  const riskAmt = Math.min(maxSpendable * (numRisk / 100), maxSpendable);
  const stopDist = Math.abs(effectiveEntry - effectiveSL);
  if (stopDist === 0) return 0;

  // Calculate position size and round to 8 decimal places for clean trades
  const positionSize = riskAmt / stopDist;
  const finalSize = Math.floor(positionSize * 100000000) / 100000000;
  
  // Final safety check - ensure quote amount doesn't exceed available balance
  const quoteAmount = finalSize * numEntry;
  if (quoteAmount > maxSpendable) {
    return (maxSpendable / numEntry) * 0.99; // Additional 1% safety margin
  }
  
  return finalSize;
}

async function runTradingLogic() {
    const cycleTimestamp = formatTimestamp(new Date());
    console.log(`\n==================== ${cycleTimestamp} ====================`);
    console.log(`[${cycleTimestamp}] Starting Trading Logic Cycle`);

    let closePrices = [], highPrices = [], lowPrices = [];
    let currentPrice = null, currentBB = null, currentRSI = null;
    let currentEmaFast = null, currentEmaSlow = null;
    let currentMacdSet = null, prevMacdSet = null;
    let currentStoch = null, prevStoch = null;
    let isUpTrend = false, identifiedSignal = "NONE", signalReason = "Init";
    let eurBalance = "0"; // Initialize eurBalance here (holds USDC balance)

    try {
        const accountsData = await coinbaseService.getAccounts();
        if (!accountsData || !accountsData.accounts || accountsData.accounts.length === 0) {
            console.log(`[${cycleTimestamp}] No account data.`);
            // gbpBalance remains "0" or its last known value if this was not the first run
        } else {
            const usdcAcc = accountsData.accounts.find(acc => acc.currency === "USDC");
            const xrpAcc = accountsData.accounts.find(acc => acc.currency === "XRP");
            eurBalance = usdcAcc?.available_balance?.value || "0"; // Update if accounts are fetched
            
            // Check if we have XRP in wallet but no active position
            const xrpBalance = xrpAcc?.available_balance?.value || "0";
            const xrpBalanceFloat = parseFloat(xrpBalance);
            
            console.log(`[${cycleTimestamp}] XRP Balance: ${xrpBalanceFloat.toFixed(8)}`);
            console.log(`[${cycleTimestamp}] USDC Balance: ${parseFloat(eurBalance).toFixed(2)}`);
            
            // Check for manual transactions if we have an active position
            if (currentPosition) {
                // Check if auto-averaging occurred in the previous cycle
                if (currentPosition.autoAveragingOccurred) {
                    console.log(`[${cycleTimestamp}] Skipping manual transaction detection due to recent auto-averaging`);
                    // Reset the flag for future cycles
                    currentPosition.autoAveragingOccurred = false;
                    savePositionState();
                } else {
                    // Detect if a manual transaction (buy or sell) has occurred
                    const manualTransactionResult = manualTransactionDetection.detectManualTransaction(currentPosition, xrpBalanceFloat, cycleTimestamp);
                    
                    if (manualTransactionResult.manualTransactionDetected) {
                        // Handle the manual transaction by updating or closing the position
                        currentPosition = manualTransactionDetection.handleManualTransaction(currentPosition, manualTransactionResult, savePositionState, cycleTimestamp);
                        
                        // Save the updated position state
                        savePositionState();
                        
                        // If position was fully closed due to a manual sale, skip the rest of this cycle
                        if (!currentPosition) {
                            console.log(`[${cycleTimestamp}] Position closed due to manual sale. Skipping trading logic for this cycle.`);
                            return;
                        }
                    }
                }
            }
            
            // If we have XRP in wallet but no position is tracked, create one
            // Using a higher threshold (1.0 XRP) to avoid creating positions for very small amounts
            if (xrpBalanceFloat > 1.0 && !currentPosition) {
                console.log(`[${cycleTimestamp}] \x1b[33mDetected XRP in wallet (${xrpBalanceFloat.toFixed(8)}) but no active position. Creating position record.\x1b[0m`);
                
                // Create a new position with the current BTC amount
                // We'll use the current price as entry price (approximate)
                let currentMarketPrice = null;
                
                try {
                    // Try to get current price from product data
                    const productData = await coinbaseService.getProductData("XRP-USDC");
                    currentMarketPrice = productData?.price ? parseFloat(productData.price) : null;
                } catch (error) {
                    console.error(`[${cycleTimestamp}] Error getting product data: ${error.message}`);
                    // If we can't get the current price, use the latest candle close price as fallback
                    if (cachedCandles && cachedCandles.length > 0) {
                        const latestCandle = cachedCandles[cachedCandles.length - 1];
                        currentMarketPrice = parseFloat(latestCandle.close);
                        console.log(`[${cycleTimestamp}] Using latest candle price as fallback: $${currentMarketPrice.toFixed(8)}`);
                    }
                }
                
                if (currentMarketPrice) {
                    currentPosition = {
                        id: `recovered-${Date.now()}`,
                        type: 'LONG',
                        pair: 'XRP-USDC',
                        entryPrice: currentMarketPrice,
                        amount: xrpBalanceFloat,
                        xrpAmount: xrpBalanceFloat, // Add xrpAmount field to ensure compatibility
                        timestamp: Date.now(),
                        stopLoss: currentMarketPrice * 0.95, // Set a default stop loss at 5% below current price
                        transactions: [{
                            id: `recovered-tx-${Date.now()}`,
                            price: currentMarketPrice,
                            amount: xrpBalanceFloat,
                            xrpAmount: xrpBalanceFloat, // Add xrpAmount field to ensure compatibility
                            eurAmount: currentMarketPrice * xrpBalanceFloat, // Use EUR amount for proper profit calculation
                            timestamp: Date.now(),
                            type: 'BUY'
                        }]
                    };
                    savePositionState();
                    console.log(`[${cycleTimestamp}] \x1b[32mCreated recovery position at price $${currentMarketPrice.toFixed(8)}\x1b[0m`);
                } else {
                    console.error(`[${cycleTimestamp}] \x1b[31mCould not create recovery position: Unable to determine current market price\x1b[0m`);
                }
            }
        }
        console.log(`[${cycleTimestamp}] USDC Balance: ${parseFloat(eurBalance).toFixed(2)}`);
        if (currentPosition) console.log(`[${cycleTimestamp}] Active Position:`, currentPosition);

        const now = new Date();
        let startFetchUnix = cachedCandles.length > 0 ? (parseInt(cachedCandles[cachedCandles.length - 1].start) + 1).toString() : Math.floor((now.getTime() - INITIAL_CANDLE_FETCH_HOURS * 3600000) / 1000).toString();
        const endFetchUnix = Math.floor(now.getTime() / 1000).toString();

        if (cachedCandles.length === 0) console.log(`[${cycleTimestamp}] Initial candle fetch...`);
        
        const newCandlesData = await coinbaseService.getProductCandles("XRP-USDC", CANDLE_INTERVAL, startFetchUnix, endFetchUnix);
        const fetchedCandles = newCandlesData.candles || [];
        console.log(`[${cycleTimestamp}] Fetched ${fetchedCandles.length} new candles.`);
        
        // If we couldn't fetch any candles, log a warning but continue
        if (fetchedCandles.length === 0) {
            console.log(`[${cycleTimestamp}] Warning: No candles were fetched. Using cached data if available.`);
        }
        if (fetchedCandles.length > 0) {
            const lastCachedTs = cachedCandles.length > 0 ? parseInt(cachedCandles[cachedCandles.length - 1].start) : 0;
            fetchedCandles.forEach(nc => {
                if (parseInt(nc.start) > lastCachedTs) cachedCandles.push(nc);
                else if (parseInt(nc.start) === lastCachedTs) cachedCandles[cachedCandles.length - 1] = nc;
            });
            cachedCandles.sort((a, b) => parseInt(a.start) - parseInt(b.start));
            if (cachedCandles.length > MAX_CANDLES_TO_CACHE) cachedCandles.splice(0, cachedCandles.length - MAX_CANDLES_TO_CACHE);
            saveCandleCache();
        }
    } catch (e) {
        console.error(`[${cycleTimestamp}] Candle fetch/process error:`, e.message);
        if (cachedCandles.length < MIN_REQUIRED_CANDLES) { console.log(`Skipping: Insufficient cache.`); return; }
        console.log(`Proceeding with stale cache.`);
    }

    if (cachedCandles.length < MIN_REQUIRED_CANDLES) {
        console.log(`[${cycleTimestamp}] Not enough candles (${cachedCandles.length}/${MIN_REQUIRED_CANDLES}). Skipping.`);
        return;
    }
    
    console.log(`[${cycleTimestamp}] Applying strategy with ${cachedCandles.length} candles...`);
    
    // Analyze candle patterns using TA-Lib
    const patternAnalysis = candlePatternAnalyzer.analyzePatterns(cachedCandles, cycleTimestamp);
    try { // Main strategy logic try block
        closePrices = cachedCandles.map(c => parseFloat(c.close));
        highPrices = cachedCandles.map(c => parseFloat(c.high));
        lowPrices = cachedCandles.map(c => parseFloat(c.low));
        currentPrice = closePrices[closePrices.length - 1];

        currentBB = BollingerBands.calculate({ period: BB_PERIOD, values: closePrices, stdDev: BB_STD_DEV }).pop() || null;
        
        // Calculate RSI for current and previous periods
        const rsiValues = RSI.calculate({ period: RSI_PERIOD, values: closePrices });
        currentRSI = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : null;
        const prevRSI = rsiValues.length > 1 ? rsiValues[rsiValues.length - 2] : null;
        
        currentEmaFast = EMA.calculate({period: EMA_FAST_PERIOD, values: closePrices}).pop() || null;
        currentEmaSlow = EMA.calculate({period: EMA_SLOW_PERIOD, values: closePrices}).pop() || null;
        const macdRes = MACD.calculate({ values: closePrices, fastPeriod: MACD_FAST_PERIOD, slowPeriod: MACD_SLOW_PERIOD, signalPeriod: MACD_SIGNAL_PERIOD, SimpleMAOscillator: false, SimpleMASignal: false });
        currentMacdSet = macdRes.length > 0 ? macdRes[macdRes.length - 1] : null;
        prevMacdSet = macdRes.length > 1 ? macdRes[macdRes.length - 2] : null;
        const stochRes = Stochastic.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: STOCH_PERIOD, signalPeriod: STOCH_D_SMOOTH, kPeriod: STOCH_K_SMOOTH });
        currentStoch = stochRes.length > 0 ? stochRes[stochRes.length - 1] : null;
        prevStoch = stochRes.length > 1 ? stochRes[stochRes.length - 2] : null;

        console.log(`[${cycleTimestamp}] Data: P=${currentPrice?.toFixed(4)}, BB L=${currentBB?.lower?.toFixed(4)} M=${currentBB?.middle?.toFixed(4)} U=${currentBB?.upper?.toFixed(4)}, RSI=${currentRSI?.toFixed(2)}`);
        console.log(`  EMA F=${currentEmaFast?.toFixed(2)}, S=${currentEmaSlow?.toFixed(2)}, MACD L=${currentMacdSet?.MACD?.toFixed(4)}, S=${currentMacdSet?.signal?.toFixed(4)}, Stoch K=${currentStoch?.k?.toFixed(2)}, D=${currentStoch?.d?.toFixed(2)}`);

        identifiedSignal = "NONE"; signalReason = "Conditions not met.";
        if (currentEmaFast && currentEmaSlow) isUpTrend = currentEmaFast > currentEmaSlow; else signalReason = "EMA data incomplete.";

        let buyScore = 0;
        const emaClose = isEmaClose(currentEmaFast, currentEmaSlow);
        
        // Stricter MACD requirement - must be ABOVE signal line and rising
        const macdBuy = currentMacdSet && prevMacdSet && 
            (currentMacdSet.MACD > currentMacdSet.signal) && // MACD must be above signal line
            (currentMacdSet.MACD > prevMacdSet.MACD); // MACD must be rising
        
        // Enhanced RSI conditions - look for RSI in ideal buy zone or showing bullish divergence
        const rsiBuy = currentRSI && currentRSI < RSI_BUY_THRESHOLD;
        const rsiIdealBuy = currentRSI && currentRSI > 30 && currentRSI < 45; // Sweet spot for buying
        const rsiRising = currentRSI && prevRSI && currentRSI > prevRSI; // RSI is rising
        
        // Enhanced stochastic condition with deeper oversold detection
        const stochBuy = currentStoch && currentStoch.k < STOCH_K_BUY_THRESHOLD;
        const stochDeepOversold = currentStoch && currentStoch.k < 10; // Deep oversold condition
        const stochExtremeOversold = currentStoch && currentStoch.k < 5; // Extreme oversold condition
        
        // Enhanced RSI conditions with deeper oversold detection
        const rsiDeepOversold = currentRSI && currentRSI < 25; // Deep oversold condition
        const rsiExtremeOversold = currentRSI && currentRSI < 20; // Extreme oversold condition
        
        // Price near Bollinger lower band (value zone)
        const priceNearBBLower = currentPrice && currentBB && currentPrice < currentBB.lower * 1.01;
        
        // Weighted scoring with more emphasis on trend confirmation and oversold conditions
        if (emaClose) buyScore += 2; 
        if (macdBuy) buyScore += 3; // Increased weight for proper MACD confirmation
        if (rsiBuy) buyScore += 1; 
        if (rsiIdealBuy) buyScore += 2; // Bonus for ideal RSI range
        if (rsiDeepOversold) buyScore += 2; // Extra points for deep oversold
        if (rsiExtremeOversold) buyScore += 1; // Extra point for extreme oversold
        if (stochBuy) buyScore += 1;
        if (stochDeepOversold) buyScore += 2; // Extra points for deep oversold
        if (stochExtremeOversold) buyScore += 1; // Extra point for extreme oversold
        if (priceNearBBLower) buyScore += 2; // Extra points for price near BB lower

        let sellScore = 0;
        const macdSell = currentMacdSet && (currentMacdSet.MACD - currentMacdSet.signal) < MACD_SELL_CONFIRMATION_OFFSET;
        
        // Enhanced RSI overbought conditions
        const rsiSell = currentRSI && currentRSI > RSI_SELL_THRESHOLD;
        const rsiHighOverbought = currentRSI && currentRSI > 75; // High overbought
        const rsiExtremeOverbought = currentRSI && currentRSI > 80; // Extreme overbought
        
        // Enhanced Stochastic overbought conditions
        const stochSell = currentStoch && currentStoch.k > STOCH_K_SELL_THRESHOLD;
        const stochHighOverbought = currentStoch && currentStoch.k > 85; // High overbought
        const stochExtremeOverbought = currentStoch && currentStoch.k > 90; // Extreme overbought
        
        // Price near or above Bollinger upper band
        const priceNearBBUpper = currentPrice && currentBB && currentPrice > currentBB.upper * 0.99;
        
        // Weighted scoring with more emphasis on overbought conditions
        if (emaClose) sellScore += 2; 
        if (macdSell) sellScore += 2; 
        if (rsiSell) sellScore += 1; 
        if (rsiHighOverbought) sellScore += 2; // Extra points for high overbought
        if (rsiExtremeOverbought) sellScore += 1; // Extra point for extreme overbought
        if (stochSell) sellScore += 1;
        if (stochHighOverbought) sellScore += 2; // Extra points for high overbought
        if (stochExtremeOverbought) sellScore += 1; // Extra point for extreme overbought
        if (priceNearBBUpper) sellScore += 2; // Extra points for price near BB upper
        
        // Enhanced Stochastic conditions with additional safeguards
        const stochCrossingUp = currentStoch && prevStoch && 
            currentStoch.k > currentStoch.d && prevStoch.k <= prevStoch.d; // K crosses above D
        const stochKConfirm = currentStoch && currentStoch.k > currentStoch.d; // K above D confirms uptrend
        
        // More stringent safe zone check to avoid buying when K is already high
        const stochInSafeZone = currentStoch && currentStoch.k < 65; // Lowered from 80 to 65 to avoid buying near overbought
        
        // Require K to be in a better position for entry (not already too high)
        const stochIdealEntry = currentStoch && currentStoch.k < 50; // Prefer buying when K is in the lower half of range
        
        const stochBullish = stochKConfirm && stochInSafeZone; // Combined bullish condition
        const stochOversold = currentStoch && currentStoch.k < STOCH_K_BUY_THRESHOLD; // K in oversold territory
        
        // More conservative buy condition that requires ideal entry point
        const stochBuyConditionMet = ((stochBullish && stochIdealEntry) || stochOversold) && stochInSafeZone;

        // Enhanced price action analysis
        const priceAboveEMA = currentPrice > currentEmaSlow;
        const priceAboveBBMiddle = currentPrice > currentBB?.middle;
        
        // Volume analysis - look for increasing volume as confirmation
        const recentCandles = cachedCandles.slice(-5); // Last 5 candles
        const avgVolume = recentCandles.reduce((sum, candle) => sum + parseFloat(candle.volume), 0) / 5;
        const currentVolume = parseFloat(cachedCandles[cachedCandles.length - 1].volume);
        const volumeConfirmation = currentVolume > avgVolume * 1.2; // Volume 20% above average
        
        // Detect potential reversal patterns
        const lastThreeCandles = cachedCandles.slice(-3);
        const hasReversalPattern = detectReversalPattern(lastThreeCandles);
        
        // Enhanced trend strength analysis
        const trendStrength = isUpTrend ? 1 : -1;
        const trendConsistency = checkTrendConsistency(cachedCandles, cachedCandles.length - 1, 10); // Check last 10 candles

// Enhanced hold conditions with more technical factors
const shouldHold = currentPosition && (
    (isUpTrend && currentRSI < 70) || // Hold in uptrend unless overbought
    (currentPrice > currentBB?.middle && volumeConfirmation) || // Hold if price above middle BB with volume
    (currentMacdSet?.MACD > currentMacdSet?.signal && priceAboveEMA) // Hold if MACD bullish and price above EMA
);

// Calculate ideal entry score based on multiple factors
let entryQualityScore = 0;

// Price action factors
if (currentPrice < currentBB?.lower * 1.01) entryQualityScore += 3; // Price near or below lower BB
if (currentPrice < currentEmaFast) entryQualityScore += 1; // Price below fast EMA
if (hasReversalPattern) entryQualityScore += 2; // Reversal pattern detected

// Technical indicator factors
if (stochOversold) entryQualityScore += 2; // Stochastic in oversold territory
if (rsiBuy) entryQualityScore += 2; // RSI in buy zone
if (rsiIdealBuy) entryQualityScore += 1; // RSI in ideal buy zone
if (macdBuy) entryQualityScore += 2; // MACD bullish

// Candle pattern analysis factors
if (patternAnalysis.patternSignal === 'BULLISH') {
    entryQualityScore += 3; // Strong bullish patterns detected
    console.log(`\x1b[32m[${cycleTimestamp}] Bullish candle patterns improving entry score by 3\x1b[0m`);
} else if (patternAnalysis.netPatternScore > 0) {
    entryQualityScore += 1; // Some bullish patterns detected
    console.log(`\x1b[32m[${cycleTimestamp}] Mild bullish candle patterns improving entry score by 1\x1b[0m`);
}

// If bearish patterns are detected, reduce entry quality score
if (patternAnalysis.patternSignal === 'BEARISH') {
    entryQualityScore -= 2; // Strong bearish patterns detected
    console.log(`\x1b[31m[${cycleTimestamp}] Bearish candle patterns reducing entry score by 2\x1b[0m`);
}

// Trend factors
if (trendConsistency > 5) entryQualityScore += 1; // Strong bullish trend
if (volumeConfirmation) entryQualityScore += 1; // Volume confirmation

// Log the entry quality assessment
console.log(`[${cycleTimestamp}] Entry Quality Score: ${entryQualityScore}/15 (Higher = Better Entry Point)`);

// Calculate short entry quality score for short positions
let shortEntryQualityScore = 0;

// Price action factors for shorts
if (currentPrice > currentBB?.upper * 0.99) shortEntryQualityScore += 3; // Price near or above upper BB
if (currentPrice > currentEmaFast) shortEntryQualityScore += 1; // Price above fast EMA
if (hasReversalPattern) shortEntryQualityScore += 2; // Reversal pattern detected

// Technical indicator factors for shorts
if (currentRSI > 70) shortEntryQualityScore += 2; // RSI in overbought territory
if (currentRSI > 80) shortEntryQualityScore += 1; // RSI in extreme overbought territory
if (currentStoch && currentStoch.k > 80) shortEntryQualityScore += 2; // Stochastic in overbought territory
if (currentMacdSet && currentMacdSet.MACD < currentMacdSet.signal) shortEntryQualityScore += 2; // MACD bearish

// Candle pattern analysis factors for shorts
if (patternAnalysis.patternSignal === 'BEARISH') {
    shortEntryQualityScore += 3; // Strong bearish patterns detected
    console.log(`\x1b[31m[${cycleTimestamp}] Bearish candle patterns improving short entry score by 3\x1b[0m`);
} else if (patternAnalysis.netPatternScore < 0) {
    shortEntryQualityScore += 1; // Some bearish patterns detected
    console.log(`\x1b[31m[${cycleTimestamp}] Mild bearish candle patterns improving short entry score by 1\x1b[0m`);
}

// If bullish patterns are detected, reduce short entry quality score
if (patternAnalysis.patternSignal === 'BULLISH') {
    shortEntryQualityScore -= 2; // Strong bullish patterns detected
    console.log(`\x1b[32m[${cycleTimestamp}] Bullish candle patterns reducing short entry score by 2\x1b[0m`);
}

// Trend factors for shorts
if (!isUpTrend) shortEntryQualityScore += 1; // Downtrend
if (volumeConfirmation) shortEntryQualityScore += 1; // Volume confirmation

// Log the short entry quality assessment
console.log(`[${cycleTimestamp}] Short Entry Quality Score: ${shortEntryQualityScore}/15 (Higher = Better Short Entry Point)`);

    // Check for low-conviction trading zones using the neutral pattern filter
    const neutralZoneAnalysis = neutralPatternFilter.detectLowConvictionZone({
        candles: cachedCandles,
        currentIndex: cachedCandles.length - 1,
        currentPrice,
        rsi: currentRSI,
        macd: currentMacdSet,
        ema: [currentEmaFast, currentEmaSlow],
        bb: currentBB,
        stoch: currentStoch
    });
    
    // Log the results of the neutral pattern filter
    if (neutralZoneAnalysis.isLowConviction) {
        console.log(`\x1b[33m[${cycleTimestamp}] LOW CONVICTION ZONE DETECTED (${neutralZoneAnalysis.confidence.toFixed(1)}% confidence)\x1b[0m`);
        neutralZoneAnalysis.reasons.forEach(reason => {
            console.log(`\x1b[33m[${cycleTimestamp}]   - ${reason}\x1b[0m`);
        });
        
        // Reduce entry quality scores in low-conviction zones
        const penaltyFactor = neutralZoneAnalysis.confidence / 100;
        const entryPenalty = Math.round(5 * penaltyFactor); // Up to 5 points penalty
        entryQualityScore = Math.max(0, entryQualityScore - entryPenalty);
        shortEntryQualityScore = Math.max(0, shortEntryQualityScore - entryPenalty);
        
        console.log(`\x1b[33m[${cycleTimestamp}] Adjusted Entry Quality Scores due to low conviction: Long=${entryQualityScore}/15, Short=${shortEntryQualityScore}/15\x1b[0m`);
    }

// Determine minimum required scores based on market conditions
const minimumBuyScore = 7; // Increased from 5 to be more selective
const minimumEntryQualityScore = 8; // Increased from 6 to require better entry quality
const minimumShortScore = 7; // Minimum score for short signals
const minimumShortEntryQualityScore = 8; // Minimum quality score for short entries

if (shouldHold) {
    identifiedSignal = "HOLD";
    signalReason = `Holding position: Trend=${isUpTrend}, RSI=${currentRSI?.toFixed(2)}, Above BB Mid=${currentPrice > currentBB?.middle}, MACD Bullish=${currentMacdSet?.MACD > currentMacdSet?.signal}`;
    console.log(`\x1b[33m[${cycleTimestamp}] ${identifiedSignal}: ${signalReason}\x1b[0m`);
} else if (buyScore >= minimumBuyScore && stochBuyConditionMet && entryQualityScore >= minimumEntryQualityScore) {
            // Check if current price is in a good position within the recent price range
            // Use 288 candles (24 hours) for lookback and 30% as the threshold for good entry
            const priceRangeCheck = recentLowPriceCheck.checkRecentLowPrice(cachedCandles, currentPrice, cycleTimestamp, 288, 30);
            
            if (!priceRangeCheck.isGoodEntry) {
                // Price is too high in the current range, suppress buy signal
                identifiedSignal = "NONE";
                signalReason = `Buy signal suppressed: ${priceRangeCheck.message}`;
                console.log(`\x1b[33m[${cycleTimestamp}] ${signalReason}\x1b[0m`);
                buyConfirmationCount = 0; // Reset buy confirmation count
                return;
            }
            
            // Increment buy confirmation count when conditions are met
            buyConfirmationCount++;
            
            // Check if we already have a position and if the current price is higher than our entry price
            if (currentPosition && currentPosition.type === 'LONG') {
                const entryPrice = parseFloat(currentPosition.entryPrice);
                if (currentPrice >= entryPrice) {
                    // Don't generate a buy signal if we already have a position at a lower price
                    identifiedSignal = "NONE";
                    signalReason = `Buy signal suppressed: Already have position at ${entryPrice.toFixed(2)} which is lower than current price ${currentPrice.toFixed(2)}`;
                    console.log(`\x1b[33m[${cycleTimestamp}] ${signalReason}\x1b[0m`);
                    buyConfirmationCount = 0; // Reset buy confirmation count
                } else {
                    // This would be an averaging down opportunity, handled by auto-averaging module
                    identifiedSignal = "NONE";
                    signalReason = `Buy signal converted to averaging opportunity: Current price ${currentPrice.toFixed(2)} is lower than entry ${entryPrice.toFixed(2)}`;
                    console.log(`\x1b[36m[${cycleTimestamp}] ${signalReason}\x1b[0m`);
                    buyConfirmationCount = 0; // Reset buy confirmation count
                }
            } else {
                // No existing position, check if we have enough confirmations
                console.log(`Buy signal confirmation count: ${buyConfirmationCount}/${buyConfirmationRequired}`);
                
                if (buyConfirmationCount >= buyConfirmationRequired) {
                    // We have enough confirmations, proceed with buy signal
                    identifiedSignal = "POTENTIAL_WEIGHTED_BUY";
                    signalReason = `Buy Score=${buyScore}, StochOK (Cross:${stochCrossingUp}, ConfirmK:${stochKConfirm}, SafeZone:${stochInSafeZone}). EMA=${emaClose}, MACD=${macdBuy}, RSI=${rsiBuy}, StochWeight=${stochBuy}. Confirmations: ${buyConfirmationCount}/${buyConfirmationRequired}`;
                    console.log(`\x1b[32m[${cycleTimestamp}] ${identifiedSignal}: ${signalReason}\x1b[0m`);
                } else {
                    // Not enough confirmations yet
                    identifiedSignal = "NONE";
                    signalReason = `Buy signal pending confirmation: ${buyConfirmationCount}/${buyConfirmationRequired} confirmations`;
                    console.log(`\x1b[36m[${cycleTimestamp}] ${signalReason}\x1b[0m`);
                }
            }
        } else if (sellScore >= 4) {
            // Reset buy confirmation count if conditions are not met
            buyConfirmationCount = 0;
            identifiedSignal = "POTENTIAL_WEIGHTED_SELL";
            signalReason = `Sell Score=${sellScore}. EMA=${emaClose}, MACD=${macdSell}, RSI=${rsiSell}, Stoch=${stochSell}.`;
            console.log(`\x1b[31m[${cycleTimestamp}] ${identifiedSignal}: ${signalReason}\x1b[0m`);
        } else if (!isUpTrend && shortEntryQualityScore >= minimumShortEntryQualityScore) {
            // Check if current price is close to recent highs before proceeding
            const recentHighCheck = recentHighPriceCheck.checkRecentHighPrice(cachedCandles, currentPrice, cycleTimestamp, 45, 0.5);
            
            if (!recentHighCheck.isGoodEntry) {
                // Price is too far from recent highs, suppress short signal
                identifiedSignal = "NONE";
                signalReason = `Short signal suppressed: ${recentHighCheck.message}`;
                console.log(`\x1b[33m[${cycleTimestamp}] ${signalReason}\x1b[0m`);
                shortConfirmationCount = 0; // Reset short confirmation count
                return;
            }
            
            // Increment short confirmation count when conditions are met
            shortConfirmationCount++;
            
            // Check if we already have a position
            if (currentPosition) {
                if (currentPosition.type === 'SHORT') {
                    const entryPrice = parseFloat(currentPosition.entryPrice);
                    if (currentPrice <= entryPrice) {
                        // Don't generate a short signal if we already have a position at a higher price
                        identifiedSignal = "NONE";
                        signalReason = `Short signal suppressed: Already have short position at ${entryPrice.toFixed(2)} which is higher than current price ${currentPrice.toFixed(2)}`;
                        console.log(`\x1b[33m[${cycleTimestamp}] ${signalReason}\x1b[0m`);
                        shortConfirmationCount = 0; // Reset short confirmation count
                    } else {
                        // This would be an averaging up opportunity for shorts
                        identifiedSignal = "NONE";
                        signalReason = `Short signal suppressed: Current price ${currentPrice.toFixed(2)} is higher than entry ${entryPrice.toFixed(2)}`;
                        console.log(`\x1b[36m[${cycleTimestamp}] ${signalReason}\x1b[0m`);
                        shortConfirmationCount = 0; // Reset short confirmation count
                    }
                } else if (currentPosition.type === 'LONG') {
                    // Don't allow shorting when we have a long position
                    identifiedSignal = "NONE";
                    signalReason = `Short signal suppressed: Already have long position`;
                    console.log(`\x1b[33m[${cycleTimestamp}] ${signalReason}\x1b[0m`);
                    shortConfirmationCount = 0; // Reset short confirmation count
                }
            } else {
                // No existing position, check if we have enough confirmations
                console.log(`Short signal confirmation count: ${shortConfirmationCount}/${shortConfirmationRequired}`);
                
                if (shortConfirmationCount >= shortConfirmationRequired) {
                    // We have enough confirmations, proceed with short signal
                    identifiedSignal = "POTENTIAL_WEIGHTED_SHORT";
                    signalReason = `Short Score=${shortEntryQualityScore}, RSI=${currentRSI?.toFixed(2)}, Above BB Upper=${currentPrice > currentBB?.upper}, MACD Bearish=${currentMacdSet?.MACD < currentMacdSet?.signal}. Confirmations: ${shortConfirmationCount}/${shortConfirmationRequired}`;
                    console.log(`\x1b[35m[${cycleTimestamp}] ${identifiedSignal}: ${signalReason}\x1b[0m`);
                } else {
                    // Not enough confirmations yet
                    identifiedSignal = "NONE";
                    signalReason = `Short signal pending confirmation: ${shortConfirmationCount}/${shortConfirmationRequired} confirmations`;
                    console.log(`\x1b[36m[${cycleTimestamp}] ${signalReason}\x1b[0m`);
                }
            }
        }

        let positionClosedThisCycle = false;
        if (currentPosition?.type === 'LONG') {
            // Calculate potential profit/loss before deciding to sell
            const entryPrice = parseFloat(currentPosition.entryPrice);
            
            // Calculate total investment across all transactions
            let totalInvested = 0;
            let totalXrp = 0;
            
            if (currentPosition.transactions && currentPosition.transactions.length > 0) {
                currentPosition.transactions.forEach(tx => {
                    // Only count buy transactions (initial buy, manual buy, auto-averaging)
                    if (tx.type === 'BUY' || tx.type === 'MANUAL_BUY' || tx.type === 'AUTO_AVERAGING_BUY') {
                        // Use usdcAmount if available, otherwise calculate from price and xrpAmount
                        const txUsdcAmount = tx.usdcAmount || (parseFloat(tx.price || entryPrice) * parseFloat(tx.xrpAmount || 0));
                        totalInvested += txUsdcAmount;
                        totalXrp += parseFloat(tx.xrpAmount || 0);
                    }
                    // Subtract any sold amounts from the total XRP
                    else if (tx.type === 'MANUAL_SELL') {
                        totalXrp -= parseFloat(tx.xrpAmount || 0);
                    }
                });
            } else {
                // Fallback if no transactions are recorded
                totalInvested = parseFloat(currentPosition.usdcSpentOrReceived || 0);
                totalXrp = parseFloat(currentPosition.xrpAmount || 0);
            }
            
            // Calculate current value and PnL with higher precision
            const currentValue = totalXrp * currentPrice;
            const potentialPnL = currentValue - totalInvested;
            
            // Calculate weighted average entry price based on all transactions
            // Add safety checks to prevent NaN values
            let weightedAvgEntryPrice = entryPrice; // Default to entryPrice
            if (totalXrp > 0 && totalInvested > 0) {
                weightedAvgEntryPrice = totalInvested / totalXrp;
                // Additional safety check
                if (isNaN(weightedAvgEntryPrice) || !isFinite(weightedAvgEntryPrice)) {
                    console.log(`\x1b[33m[${cycleTimestamp}] Warning: Invalid weighted average price calculated. Falling back to entry price.\x1b[0m`);
                    weightedAvgEntryPrice = entryPrice;
                }
            }
            
            // Calculate PnL percentage with higher precision - using both methods
            const potentialPnLPercent = totalInvested > 0 ? (potentialPnL / totalInvested) * 100 : 0;
            
            // Calculate PnL percentage based on weighted average price with safety checks
            let weightedPnLPercent = 0;
            if (weightedAvgEntryPrice > 0 && currentPrice > 0) {
                weightedPnLPercent = ((currentPrice - weightedAvgEntryPrice) / weightedAvgEntryPrice) * 100;
                // Safety check for valid PnL percentage
                if (isNaN(weightedPnLPercent) || !isFinite(weightedPnLPercent)) {
                    console.log(`\x1b[33m[${cycleTimestamp}] Warning: Invalid PnL percentage calculated. Using 0%.\x1b[0m`);
                    weightedPnLPercent = 0;
                }
            }
            
            // Use the weighted PnL percentage for decision making
            const isProfitable = weightedPnLPercent > 0;
            
            // Use a smaller threshold for significant profit detection (0.25% instead of 0.5%)
            const isSignificantProfit = weightedPnLPercent >= 0.25; // Reduced from 0.5% to 0.25%
            
            // Log the weighted average entry price for transparency
            console.log(`\x1b[36m[${cycleTimestamp}] Weighted Average Entry Price: $${weightedAvgEntryPrice.toFixed(8)} (Original Entry: $${entryPrice.toFixed(8)})\x1b[0m`);
            
            // Update trailing stop if position is profitable
            if (isProfitable && potentialPnLPercent > 1.0) { // Only activate trailing stop after 1% profit
                // Calculate trailing stop level (default to 1.5% below current price)
                const trailingStopPercentage = 0.015; // 1.5% trailing stop
                const newTrailingStopPrice = currentPrice * (1 - trailingStopPercentage);
                
                // Only update trailing stop if it's higher than the current one or none exists
                if (!currentPosition.currentTrailingStopPrice || 
                    newTrailingStopPrice > parseFloat(currentPosition.currentTrailingStopPrice)) {
                    
                    console.log(`\x1b[32m[${cycleTimestamp}] Updating trailing stop: ${currentPosition.currentTrailingStopPrice || 'None'} -> ${newTrailingStopPrice.toFixed(4)} (${trailingStopPercentage * 100}% below current price)\x1b[0m`);
                    
                    // Update the trailing stop in the position
                    currentPosition.currentTrailingStopPrice = newTrailingStopPrice.toFixed(4);
                    savePositionState();
                }
            }
            
            // Check for consecutive positive candles (patience)
            const hasConsecutivePositiveCandles = checkConsecutivePositiveCandles(cachedCandles, cachedCandles.length - 1);
            
            // Only sell if we have a sell signal AND it would be profitable
            const confirmSellResult = shouldConfirmSell(cachedCandles, cachedCandles.length - 1, entryPrice);
            
            // Check if position was recently loaded (after restart)
            const isRecentlyLoaded = currentPosition.recentlyLoaded === true;
            
            // Check if trailing stop has been hit
            let trailingStopHit = false;
            if (currentPosition.currentTrailingStopPrice && 
                currentPrice < parseFloat(currentPosition.currentTrailingStopPrice)) {
                trailingStopHit = true;
                console.log(`\x1b[41m[${cycleTimestamp}] TRAILING STOP HIT! Current price ${currentPrice.toFixed(8)} below trailing stop ${currentPosition.currentTrailingStopPrice}\x1b[0m`);
            }
            
            console.log(`\x1b[36m[${cycleTimestamp}] Position Analysis: Entry=${entryPrice.toFixed(8)}, WeightedAvg=${weightedAvgEntryPrice.toFixed(8)}, Current=${currentPrice.toFixed(8)}, PnL=${weightedPnLPercent.toFixed(4)}%, Profitable=${isProfitable}, SignificantProfit=${isSignificantProfit}, ConsecutivePositive=${JSON.stringify(hasConsecutivePositiveCandles)}, ShouldSell=${confirmSellResult}, TrailingStop=${currentPosition.currentTrailingStopPrice || 'None'}, TrailingStopHit=${trailingStopHit}, RecentlyLoaded=${isRecentlyLoaded}\x1b[0m`);
            
            // Check if we have an actual sell signal
            const hasSellSignal = identifiedSignal === "POTENTIAL_WEIGHTED_SELL" || identifiedSignal === "SELL" || identifiedSignal === "POTENTIAL_SELL";
            
            // Never sell immediately after restart unless it meets specific conditions
            if (isRecentlyLoaded && potentialPnLPercent < 5 && 
                !(hasSellSignal && confirmSellResult && sellConfirmationCount >= sellConfirmationRequired)) {
                console.log(`\x1b[33m[${cycleTimestamp}] Holding recently loaded position despite sell signal. Waiting for acclimation period.\x1b[0m`);
            }
            // Normal sell logic when not recently loaded
            else if ((hasSellSignal && confirmSellResult) || trailingStopHit) {
                console.log(`\x1b[41m[${cycleTimestamp}] Confirmed SELL signal or trailing stop hit. Evaluating partial selling opportunities...\x1b[0m`);
                

                
                try {
                    // First check the XRP balance
                    const accountsData = await coinbaseService.getAccounts();
                    const xrpAcc = accountsData.accounts.find(acc => acc.currency === "XRP");
                    const xrpBalance = xrpAcc?.available_balance?.value || "0";
                    let xrpToSell = parseFloat(currentPosition.xrpAmount);
                    const actualXrpBalance = parseFloat(xrpBalance);
                    
                    // Check if we have entry-based sell opportunities
                    let isEntrySell = false;
                    let entriesToSell = [];
                    
                    // Evaluate which entries should be sold based on profit thresholds
                    const entrySellOpportunities = evaluateEntrySellOpportunities(currentPosition, currentPrice);
                    
                    if (entrySellOpportunities.shouldSell && entrySellOpportunities.entriesToSell.length > 0) {
                        console.log(`\x1b[41m[${cycleTimestamp}] Entry SELL opportunity detected. Individual entries to sell: ${entrySellOpportunities.entriesToSell.length}\x1b[0m`);
                        
                        // Calculate total XRP amount to sell from the profitable entries
                        const totalXrpToSell = entrySellOpportunities.entriesToSell.reduce(
                            (sum, entry) => sum + entry.amountToSell, 0
                        );
                        
                        // Update the xrpToSell amount for entry-based sell
                        xrpToSell = totalXrpToSell;
                        entriesToSell = entrySellOpportunities.entriesToSell;
                        isEntrySell = true;
                        
                        console.log(`\x1b[41m[${cycleTimestamp}] Planning to sell ${entriesToSell.length} profitable entries with total of ${xrpToSell.toFixed(8)} XRP out of ${currentPosition.xrpAmount} total\x1b[0m`);
                    } else {
                        console.log(`\x1b[41m[${cycleTimestamp}] No profitable entries found for entry sell, selling entire position: ${xrpToSell} XRP\x1b[0m`);
                    }
                    
                    if (actualXrpBalance < xrpToSell) {
                        console.log(`\x1b[41m[${cycleTimestamp}] Cannot sell: Insufficient XRP balance. Required: ${xrpToSell.toFixed(8)} XRP, Available: ${actualXrpBalance.toFixed(8)} XRP\x1b[0m`);
                        const notificationData = {
                            type:'trade_notification', action:'SELL', pair:"XRP-USDC", amount:currentPosition.xrpAmount.toString(),
                            price: currentPrice.toFixed(2),
                            reason:`Insufficient XRP balance: Required ${xrpToSell.toFixed(8)} XRP, Available ${actualXrpBalance.toFixed(8)} XRP`,
                            rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                            macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                            stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                            balance: parseFloat(eurBalance).toFixed(2) // USDC balance
                        };
                        // Enhanced notification with retries
let notificationSent = false;
for (let i = 0; i < NOTIFICATION_RETRY_COUNT && !notificationSent; i++) {
    try {
        console.log(JSON.stringify(notificationData));
        notificationSent = true;
    } catch (e) {
        console.error(`Notification attempt ${i + 1} failed:`, e.message);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
    }
}
if (!notificationSent) {
    console.error(`Failed to send notification after ${NOTIFICATION_RETRY_COUNT} attempts`);
}
                        return; // Skip the sell order
                    }
                    
                    // Ensure BTC amount has proper precision (8 decimal places max)
                    const xrpAmountToSell = Math.floor(parseFloat(currentPosition.xrpAmount) * 100000000) / 100000000;
                    let order;
if (tradingConfig.postOnlySells) {
    // Use post-only limit order at current price
    order = await coinbaseService.submitOrder(
        "XRP-USDC",
        "SELL",
        xrpAmountToSell.toString(),
        'limit',
        currentPrice,
        true // postOnly
    );
} else {
    // Use market order (legacy behavior)
    order = await coinbaseService.submitOrder(
        "XRP-USDC",
        "SELL",
        xrpAmountToSell.toString(),
        'market'
    );
}
                    if (order && (order.success || order.success_response?.order_id)) {
                        const btc = currentPosition.xrpAmount.toString(), price = parseFloat(currentPrice);
                        const gbp = (parseFloat(btc) * price).toFixed(2);
                        const id = order.success_response?.order_id || order.order_id || order.client_order_id;
                        
                        // Calculate detailed profit/loss based on individual transactions with fee consideration
                        const pnlDetails = calculateGbpAccumulation(currentPosition, price, parseFloat(gbpBalance));
                        const pnl = pnlDetails.accumulation;
                        const pnlString = pnl.toFixed(2);
                        
                        // Log detailed transaction profits with improved formatting
                        if (pnlDetails.transactionDetails && pnlDetails.transactionDetails.length > 0) {
                            console.log(`\x1b[36m[${cycleTimestamp}] Transaction-based profit breakdown (including fees):\x1b[0m`);
                            pnlDetails.transactionDetails.forEach(tx => {
                                const profitColor = parseFloat(tx.profit) >= 0 ? '\x1b[32m' : '\x1b[31m';
                                console.log(`${profitColor}[${cycleTimestamp}] Transaction ${tx.id}: ${parseFloat(tx.xrpAmount).toFixed(8)} BTC @ $${tx.entryPrice} -> $${price.toFixed(8)}\x1b[0m`);
                                console.log(`${profitColor}[${cycleTimestamp}] Cost: $${tx.originalCost}, Value: $${tx.effectiveSellValue} | P&L: $${tx.profit} (${tx.profitPercent}%)\x1b[0m`);
                            });
                            
                            // Log summary
                            const totalProfit = pnlDetails.transactionDetails.reduce((sum, tx) => sum + parseFloat(tx.profit), 0).toFixed(2);
                            const profitColor = parseFloat(totalProfit) >= 0 ? '\x1b[32m' : '\x1b[31m';
                            console.log(`${profitColor}[${cycleTimestamp}] TOTAL P&L: $${totalProfit}\x1b[0m`);
                        }
                        const notificationData = {
                            type: 'trade_notification',
                            action: 'SELL',
                            pair: "XRP-USDC",
                            amount: parseFloat(btc).toFixed(8),
                            entryPrice: parseFloat(currentPosition.entryPrice).toFixed(2), // Fixed to use actual entry price
                            price: price.toFixed(2),
                            gbpValue: gbp,
                            reason: `Opposing: ${signalReason}`,
                            orderId: id,
                            rsi: currentRSI?.toFixed(2) || 'N/A',
                            macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                            macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                            stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                            stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                            balance: parseFloat(eurBalance).toFixed(2), // USDC balance
                            pnl: pnlString
                        };
                        // Enhanced notification with retries
let notificationSent = false;
for (let i = 0; i < NOTIFICATION_RETRY_COUNT && !notificationSent; i++) {
    try {
        console.log(JSON.stringify(notificationData));
        notificationSent = true;
    } catch (e) {
        console.error(`Notification attempt ${i + 1} failed:`, e.message);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
    }
}
if (!notificationSent) {
    console.error(`Failed to send notification after ${NOTIFICATION_RETRY_COUNT} attempts`);
}
                        // Check if this was an entry-based sell or full position sell
                        if (isEntrySell && parseFloat(currentPosition.xrpAmount) > xrpToSell) {
                            console.log(`\x1b[42m[${cycleTimestamp}] ✓ ENTRY SELL completed successfully. Sold ${entriesToSell.length} profitable entries (${xrpToSell.toFixed(8)} XRP) out of ${currentPosition.xrpAmount} total\x1b[0m`);
                            
                            // Update the position state using the entry sell logic
                            const entrySellResult = updatePositionAfterEntrySell(
                                currentPosition,
                                { id: id },
                                entriesToSell,
                                price
                            );
                            
                            // Update current position
                            if (entrySellResult.isFullySold) {
                                console.log(`\x1b[42m[${cycleTimestamp}] All XRP sold in this entry sell. Closing position.\x1b[0m`);
                                currentPosition = null;
                                positionClosedThisCycle = true;
                            } else {
                                currentPosition = entrySellResult.updatedPosition;
                                console.log(`\x1b[42m[${cycleTimestamp}] Updated position after entry sell: ${parseFloat(currentPosition.xrpAmount).toFixed(8)} XRP remaining\x1b[0m`);
                            }
                            
                            // Log the entry sell transaction
                            await logTradeEntry({ 
                                timestamp: formatTimestamp(new Date()), 
                                action: 'ENTRY_SELL', 
                                pair: "XRP-USDC", 
                                price: price.toFixed(2), 
                                amountBtc: xrpToSell.toFixed(8), 
                                amountGbp: (price * xrpToSell).toFixed(2), 
                                orderId: id, 
                                reason: `Partial profit taking: ${entriesToSell.length} entries sold`,
                                signalDetails: entriesToSell.map(e => `${e.profitPercent.toFixed(2)}% profit on entry at $${e.entryPrice}`).join(', '),
                                entryPrice: parseFloat(currentPosition.entryPrice).toFixed(2),
                                pnl: pnl
                            });
                        } else {
                            // Standard full position sell logic
                            console.log(`\x1b[42m[${cycleTimestamp}] ✓ Full position SELL completed successfully. Sold entire position of ${currentPosition.xrpAmount} XRP\x1b[0m`);
                            
                            await logTradeEntry({ 
                                timestamp: formatTimestamp(new Date()), 
                                action: 'SELL', 
                                pair: "XRP-USDC", 
                                price: price.toFixed(2), 
                                amountBtc: btc, 
                                amountGbp: gbp, 
                                orderId: id, 
                                reason: `Opposing: ${signalReason}`, 
                                signalDetails: signalReason, 
                                entryPrice: parseFloat(currentPosition.entryPrice).toFixed(2), 
                                pnl: pnl 
                            });
                            
                            // Full position closed
                            currentPosition = null;
                            positionClosedThisCycle = true;
                        }
                        
                        // Common actions for both partial and full sells
                        updateCumulativeProfit(pnl);
                        lastSellActionTime = Date.now();
                        lastSellPrice = price;
                        savePositionState();
                    } else {
                        console.log(`\x1b[41m[${cycleTimestamp}] Opposing SELL order failed: ${JSON.stringify(order)}\x1b[0m`);
                        const notificationData = {
                            type:'trade_notification', action:'SELL', pair:"XRP-USDC", amount:currentPosition.xrpAmount.toString(),
                            price: currentPrice.toFixed(2),
                            reason:`Opposing SELL failed: ${order.error_response?.message || 'Unknown error'}`,
                            rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                            macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                            stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                            balance: parseFloat(eurBalance).toFixed(2) // USDC balance
                        };
                        // Enhanced notification with retries
let notificationSent = false;
for (let i = 0; i < NOTIFICATION_RETRY_COUNT && !notificationSent; i++) {
    try {
        console.log(JSON.stringify(notificationData));
        notificationSent = true;
    } catch (e) {
        console.error(`Notification attempt ${i + 1} failed:`, e.message);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
    }
}
if (!notificationSent) {
    console.error(`Failed to send notification after ${NOTIFICATION_RETRY_COUNT} attempts`);
}
                    }
                } catch (e) { console.error(`\x1b[41m[${cycleTimestamp}] Error Opposing SELL: ${e.message}\x1b[0m`); }
            }

            if (!positionClosedThisCycle && currentPrice && currentPosition.entryPrice) {
                // Analyze market conditions
                const trend = calculateTrendStrength(cachedCandles, cachedCandles.length - 1);
                const isPeak = detectPeak(cachedCandles, cachedCandles.length - 1);
                const isConfirmedDowntrend = trend.isDowntrend && checkFalsePositive(cachedCandles, cachedCandles.length - 1, trend);
                const isRecovering = detectRecovery(cachedCandles, cachedCandles.length - 1);
                
                // Calculate how long we've held the position
                const entryTime = new Date(currentPosition.entryTime || Date.now() - MIN_HOLD_TIME * 2);
                const holdingTime = Date.now() - entryTime.getTime();
                
                // Calculate current drawdown and profit
                const drawdown = (parseFloat(currentPosition.entryPrice) - currentPrice) / parseFloat(currentPosition.entryPrice);
                const profit = (currentPrice - parseFloat(currentPosition.entryPrice)) / parseFloat(currentPosition.entryPrice);
                
                // Log position status
                if (drawdown > 0) {
                    console.log(`\x1b[33m[${cycleTimestamp}] HOLDING through ${(drawdown * 100).toFixed(2)}% dip. Position age: ${(holdingTime / 3600000).toFixed(1)}h\x1b[0m`);
                    if (isRecovering) {
                        console.log(`\x1b[32m[${cycleTimestamp}] Recovery detected: Price +${(RECOVERY_THRESHOLD * 100).toFixed(1)}%, RSI: ${currentRSI?.toFixed(1)}\x1b[0m`);
                    }
                }

                // Only consider selling if:
                // 1. We've held for minimum time AND
                // 2. We're not in a recovery AND
                // 3. Either:
                //    a. We have a very strong confirmed downtrend at a peak (>80% strength)
                //    b. We're in significant profit (>10%)
                if (holdingTime >= MIN_HOLD_TIME && !isRecovering && ((isPeak && isConfirmedDowntrend && trend.strength > 0.8) || profit > 0.1)) {
                    
                    console.log(`\x1b[33m[${cycleTimestamp}] SELLING: ${isConfirmedDowntrend ? 'Strong downtrend detected' : 'Profit target reached'} - P&L: ${(profit * 100).toFixed(2)}%\x1b[0m`);
                    try {
                        // First check the BTC balance
                        const accountsData = await coinbaseService.getAccounts();
                        const btcAcc = accountsData.accounts.find(acc => acc.currency === "BTC");
                        const btcBalance = btcAcc?.available_balance?.value || "0";
                        const btcToSell = parseFloat(currentPosition.xrpAmount);
                        const actualBtcBalance = parseFloat(btcBalance);
                        
                        if (actualBtcBalance < btcToSell) {
                            console.log(`\x1b[41m[${cycleTimestamp}] Cannot sell: Insufficient BTC balance. Required: ${btcToSell.toFixed(8)} BTC, Available: ${actualBtcBalance.toFixed(8)} BTC\x1b[0m`);
                            const notificationData = {
                                type:'trade_notification', action:'SELL', pair:"XRP-USDC", amount:currentPosition.xrpAmount.toString(),
                                price: currentPrice.toFixed(2),
                                reason:`Insufficient BTC balance: Required ${btcToSell.toFixed(8)} BTC, Available ${actualBtcBalance.toFixed(8)} BTC`,
                                rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: parseFloat(eurBalance).toFixed(2) // USDC balance
                            };
                            await sendTradeNotification(notificationData);
                            return; // Skip the sell order
                        }
                        
                        const order = await coinbaseService.submitOrder("XRP-USDC", "SELL", currentPosition.xrpAmount.toString());
                        if (order && (order.success || order.success_response?.order_id)) {
                            const btc = currentPosition.xrpAmount.toString(), price = parseFloat(currentPrice);
                            const gbp = (parseFloat(btc) * price).toFixed(2);
                            const id = order.success_response?.order_id || order.order_id || order.client_order_id;
                            const reason = isConfirmedDowntrend ? 'Strong downtrend confirmed' : `Take profit at ${profit.toFixed(2)}%`;
                            const pnl = (price - parseFloat(currentPosition.entryPrice)) * parseFloat(btc);
                            const pnlString = pnl.toFixed(2);
                            const notificationDataSL = {
                                type: 'trade_notification',
                                action: 'SELL',
                                pair: "XRP-USDC",
                                amount: btc,
                                entryPrice: parseFloat(currentPosition.entryPrice).toFixed(2),
                                price: price.toFixed(2),
                                gbpValue: gbp,
                                reason: reason,
                                orderId: id,
                                rsi: currentRSI?.toFixed(2) || 'N/A',
                                macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                                stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: parseFloat(eurBalance).toFixed(2), // USDC balance
                                pnl: pnlString
                            };
                            await sendTradeNotification(notificationDataSL);
                        } else {
                            console.log(`\x1b[41m[${cycleTimestamp}] SL SELL order failed: ${JSON.stringify(order)}\x1b[0m`);
                            const notificationData = {
                                type:'trade_notification', action:'SELL', pair:"XRP-USDC", amount:currentPosition.xrpAmount.toString(),
                                price: currentPrice.toFixed(2),
                                reason:`SL SELL failed: ${order.error_response?.message || 'Unknown error'}`,
                                rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: parseFloat(eurBalance).toFixed(2) // USDC balance
                            };
                            await sendTradeNotification(notificationData);
                        }
                    } catch (e) { console.error(`\x1b[41m[${cycleTimestamp}] Error SL SELL: ${e.message}\x1b[0m`); }
                } else if (!positionClosedThisCycle && currentPrice >= parseFloat(currentPosition.takeProfitPrice)) {
                    // Check if we should confirm the sell based on consecutive positive candles
                    const shouldSell = shouldConfirmSell(cachedCandles, cachedCandles.length - 1, currentPosition.takeProfitPrice);
                    
                    if (!shouldSell) {
                        console.log(`\x1b[33m[${cycleTimestamp}] TAKE-PROFIT HIT but waiting for confirmation (${sellConfirmationCount}/${sellConfirmationRequired})\x1b[0m`);
                        return; // Skip selling this cycle
                    }
                    
                    console.log(`\x1b[32m[${cycleTimestamp}] TAKE-PROFIT CONFIRMED after ${sellConfirmationCount} confirmations. Selling ${currentPosition.xrpAmount}\x1b[0m`);
                        try {
                            const accountsData = await coinbaseService.getAccounts();
                            const btcAcc = accountsData.accounts.find(acc => acc.currency === "BTC");
                            const btcBalance = btcAcc?.available_balance?.value || "0";
                            const btcToSell = parseFloat(currentPosition.xrpAmount);
                            const actualBtcBalance = parseFloat(btcBalance);
                            
                            if (actualBtcBalance < btcToSell) {
                                console.log(`\x1b[41m[${cycleTimestamp}] Cannot sell: Insufficient BTC balance. Required: ${btcToSell.toFixed(8)} BTC, Available: ${actualBtcBalance.toFixed(8)} BTC\x1b[0m`);
                                
                                // Define minimum BTC amount that can be traded (Reduced from 0.0001 BTC to allow smaller trades)
                                const MIN_BTC_THRESHOLD = 0.00001; // 10x smaller minimum
                                
                                // Synchronize position with actual balance
                                if (actualBtcBalance >= MIN_BTC_THRESHOLD) {
                                    console.log(`\x1b[33m[${cycleTimestamp}] Adjusting position size to match actual balance\x1b[0m`);
                                    currentPosition.xrpAmount = actualBtcBalance.toFixed(8);
                                    savePositionState();
                                    console.log(`\x1b[33m[${cycleTimestamp}] Position size adjusted to ${actualBtcBalance.toFixed(8)} BTC\x1b[0m`);
                                                                       // Calculate the GBP value for the adjusted position
                                    const adjustedGbpValue = (actualBtcBalance * parseFloat(currentPrice)).toFixed(2);
                                    
                                    // Only send notification if the adjustment is significant (more than 1% difference)
                                    const adjustmentPercentage = Math.abs((actualBtcBalance - btcToSell) / btcToSell * 100);
                                    if (adjustmentPercentage > 1) {
                                        // Send notification about position adjustment
                                        const adjustmentNotification = {
                                            type: 'trade_notification', 
                                            action: 'POSITION_ADJUSTED', 
                                            pair: "XRP-USDC", 
                                            amount: `${btcToSell.toFixed(8)} → ${actualBtcBalance.toFixed(8)}`,
                                            price: currentPrice.toFixed(2),
                                            gbpValue: adjustedGbpValue, // Add the GBP value
                                            reason: `Position size adjusted to match actual balance. Original: ${btcToSell.toFixed(8)} BTC, Adjusted: ${actualBtcBalance.toFixed(8)} BTC`,
                                            rsi: currentRSI?.toFixed(2) || 'N/A', 
                                            macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                            macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                            stochK: currentStoch?.k?.toFixed(2) || 'N/A', 
                                            stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                            balance: parseFloat(eurBalance).toFixed(2) // eurBalance holds USDC balance
                                        };
                                        await sendTradeNotification(adjustmentNotification);
                                    } else {
                                        console.log(`\x1b[33m[${cycleTimestamp}] Minor position adjustment (${adjustmentPercentage.toFixed(2)}%) - no notification sent\x1b[0m`);
                                    }
                                    
                                    // Continue with the sell using the adjusted amount - round to 8 decimal places
                                    // Coinbase requires proper precision for BTC amounts (8 decimal places max)
                                    const adjustedBtcToSell = Math.floor(actualBtcBalance * 100000000) / 100000000;
                                    
                                    // Use the adjusted amount for the sell order
                                    try {
                                        const order = await coinbaseService.submitOrder("XRP-USDC", "SELL", adjustedBtcToSell.toString());
                                        if (order && (order.success || order.success_response?.order_id)) {
                                            const btc = adjustedBtcToSell.toString(), price = parseFloat(currentPrice);
                                            const gbp = (parseFloat(btc) * price).toFixed(2);
                                            const id = order.success_response?.order_id || order.order_id || order.client_order_id;
                                            const pnl = (price - parseFloat(currentPosition.entryPrice)) * parseFloat(btc);
                                            const pnlString = pnl.toFixed(2);
                                            const notificationDataTS = {
                                                type: 'trade_notification',
                                                action: 'SELL',
                                                pair: "XRP-USDC",
                                                amount: btc,
                                                entryPrice: parseFloat(currentPosition.entryPrice).toFixed(2),
                                                price: price.toFixed(2),
                                                gbpValue: gbp,
                                                reason: `Trailing stop triggered at ${currentPosition.currentTrailingStopPrice}`,
                                                orderId: id,
                                                rsi: currentRSI?.toFixed(2) || 'N/A',
                                                macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                                stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                                                stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                                balance: parseFloat(eurBalance).toFixed(2), // eurBalance holds USDC balance
                                                pnl: pnlString
                                            };
                                            await sendTradeNotification(notificationDataTS);
                                        } else {
                                            console.log(`\x1b[41m[${cycleTimestamp}] Adjusted SELL order failed: ${JSON.stringify(order)}\x1b[0m`);
                                            const notificationData = {
                                                type:'trade_notification', 
                                                action:'SELL_FAILED', 
                                                pair:"XRP-USDC", 
                                                amount:adjustedBtcToSell.toString(),
                                                price: currentPrice.toFixed(2),
                                                reason:`Adjusted SELL failed: ${order.error_response?.message || 'Unknown error'}`,
                                                rsi: currentRSI?.toFixed(2) || 'N/A', 
                                                macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                                stochK: currentStoch?.k?.toFixed(2) || 'N/A', 
                                                stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                                balance: parseFloat(eurBalance).toFixed(2) // eurBalance holds USDC balance
                                            };
                                            await sendTradeNotification(notificationData);
                                        }
                                    } catch (e) { 
                                        console.error(`\x1b[41m[${cycleTimestamp}] Error Adjusted SELL: ${e.message}\x1b[0m`); 
                                    }
                                    
                                    return; // Skip the original sell order logic
                                } else {
                                    // BTC amount is below minimum threshold or zero
                                    console.log(`\x1b[41m[${cycleTimestamp}] BTC amount (${actualBtcBalance.toFixed(8)}) is below minimum tradable threshold (${MIN_BTC_THRESHOLD})\x1b[0m`);
                                    
                                    // Close the position without attempting to sell
                                    console.log(`\x1b[33m[${cycleTimestamp}] Closing position without selling due to insufficient BTC\x1b[0m`);
                                    
                                    // Calculate any remaining value (likely very small)
                                    const remainingValue = actualBtcBalance * parseFloat(currentPrice);
                                    
                                    // Send notification about position closure
                                    const notificationData = {
                                        type: 'trade_notification', 
                                        action: 'POSITION_CLOSED', 
                                        pair: "XRP-USDC", 
                                        amount: actualBtcBalance.toFixed(8),
                                        price: currentPrice.toFixed(2),
                                        gbpValue: remainingValue.toFixed(2),
                                        reason: `Position closed: BTC amount (${actualBtcBalance.toFixed(8)}) below minimum tradable threshold (${MIN_BTC_THRESHOLD})`,
                                        rsi: currentRSI?.toFixed(2) || 'N/A', 
                                        macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                        macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                        stochK: currentStoch?.k?.toFixed(2) || 'N/A', 
                                        stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                        balance: parseFloat(eurBalance).toFixed(2) // USDC balance
                                    };
                                    await sendTradeNotification(notificationData);
                                    
                                    // Update state to close the position
                                    lastSellActionTime = Date.now();
                                    lastSellPrice = parseFloat(currentPrice);
                                    currentPosition = null;
                                    savePositionState();
                                    positionClosedThisCycle = true;
                                    
                                    return; // Skip the sell order
                                }
                            }
                            
                            const order = await coinbaseService.submitOrder("XRP-USDC", "SELL", currentPosition.amount.toString());
                            if (order && (order.success || order.success_response?.order_id)) {
                                const btc = currentPosition.amount.toString(), price = parseFloat(currentPrice);
                                const gbp = (parseFloat(btc) * price).toFixed(2);
                                const id = order.success_response?.order_id || order.order_id || order.client_order_id;
                                const pnl = (price - parseFloat(currentPosition.entryPrice)) * parseFloat(btc);
                                const pnlString = pnl.toFixed(2);
                                const notificationDataPeak = {
                                    type: 'trade_notification',
                                    action: 'SELL',
                                    pair: "XRP-USDC",
                                    amount: btc,
                                    entryPrice: parseFloat(currentPosition.entryPrice).toFixed(2),
                                    price: price.toFixed(2),
                                    gbpValue: gbp,
                                    reason: `Peak detected with confirmed downtrend. Trend strength: ${trend.strength.toFixed(3)}`,
                                    orderId: id,
                                    rsi: currentRSI?.toFixed(2) || 'N/A',
                                    macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                    macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                    stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                                    stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                    balance: parseFloat(eurBalance).toFixed(2), // USDC balance
                                    pnl: pnlString
                                };
                                await sendTradeNotification(notificationDataPeak);
                            }
                        } catch (e) { console.error(`\x1b[41m[${cycleTimestamp}] Error PEAK SELL: ${e.message}\x1b[0m`); }
                    } else if (currentPrice >= parseFloat(currentPosition.takeProfitPrice)) {
                     console.log(`\x1b[32m[${cycleTimestamp}] TAKE-PROFIT HIT. Selling ${currentPosition.xrpAmount}\x1b[0m`);
                     try {
                         // First check the XRP balance
                         const accountsData = await coinbaseService.getAccounts();
                         const xrpAcc = accountsData.accounts.find(acc => acc.currency === "XRP");
                         const xrpBalance = xrpAcc?.available_balance?.value || "0";
                         const xrpToSell = parseFloat(currentPosition.xrpAmount);
                         const actualXrpBalance = parseFloat(xrpBalance);
                        
                        if (actualXrpBalance < xrpToSell) {
                            console.log(`\x1b[41m[${cycleTimestamp}] Cannot sell: Insufficient XRP balance. Required: ${xrpToSell.toFixed(8)} XRP, Available: ${actualXrpBalance.toFixed(8)} XRP\x1b[0m`);
                            const notificationData = {
                                type:'trade_notification', action:'SELL', pair:"XRP-USDC", amount:currentPosition.xrpAmount.toString(),
                                price: currentPrice.toFixed(2),
                                reason:`Insufficient BTC balance: Required ${btcToSell.toFixed(8)} BTC, Available ${actualBtcBalance.toFixed(8)} BTC`,
                                rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: parseFloat(eurBalance).toFixed(2) // USDC balance
                            };
                            await sendTradeNotification(notificationData);
                            return; // Skip the sell order
                        }
                        
                        const order = await coinbaseService.submitOrder("XRP-USDC", "SELL", currentPosition.xrpAmount.toString());
                        if (order && (order.success || order.success_response?.order_id)) {
                            const btc = currentPosition.xrpAmount.toString(), price = parseFloat(currentPrice);
                            const gbp = (parseFloat(btc) * price).toFixed(2);
                            const id = order.success_response?.order_id || order.order_id || order.client_order_id;
                            const pnl = (price - parseFloat(currentPosition.entryPrice)) * parseFloat(btc);
                            const pnlString = pnl.toFixed(2);
                            const notificationDataTP = {
                                type: 'trade_notification',
                                action: 'SELL',
                                pair: "XRP-USDC",
                                amount: btc,
                                entryPrice: parseFloat(currentPosition.entryPrice).toFixed(2),
                                price: price.toFixed(2),
                                gbpValue: gbp,
                                reason: `Take-profit hit at ${currentPosition.takeProfitPrice}`,
                                orderId: id,
                                rsi: currentRSI?.toFixed(2) || 'N/A',
                                macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                                stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: parseFloat(eurBalance).toFixed(2), // USDC balance
                                pnl: pnlString
                            };
                            await sendTradeNotification(notificationDataTP);
                        } else {
                            console.log(`\x1b[41m[${cycleTimestamp}] TP SELL order failed: ${JSON.stringify(order)}\x1b[0m`);
                            const notificationData = {
                                type:'trade_notification', action:'SELL', pair:"XRP-USDC", amount:currentPosition.xrpAmount.toString(),
                                price: currentPrice.toFixed(2),
                                reason:`TP SELL failed: ${order.error_response?.message || 'Unknown error'}`,
                                rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: parseFloat(eurBalance).toFixed(2) // USDC balance
                            };
                            await sendTradeNotification(notificationData);
                        }
                    } catch (e) { console.error(`\x1b[41m[${cycleTimestamp}] Error TP SELL: ${e.message}\x1b[0m`); }
                }
            }
        }

        if (!positionClosedThisCycle && identifiedSignal === "POTENTIAL_WEIGHTED_BUY") {
            const usdcAvailable = parseFloat(eurBalance); // eurBalance actually holds USDC balance
            const entry = currentPrice; 
            const initialSL = entry * (1 - STOP_LOSS_PERCENT / 100);
            
            const rePriceCond = lastSellPrice !== null && entry > lastSellPrice * (1 + PRICE_REENTRY_THRESHOLD);
            const reTimeCond = lastSellActionTime !== null && (Date.now() - lastSellActionTime > TIME_COOLDOWN_MS);

            if (lastSellActionTime === null || rePriceCond || reTimeCond) { // Allow buy if no recent sell or re-entry conditions met
                const xrpToBuy = calculatePositionSize(entry, initialSL, usdcAvailable, RISK_PERCENT_PER_TRADE);
                const usdcToSpendVal = xrpToBuy * entry;

                if (usdcToSpendVal >= MIN_USDC_TRADE_AMOUNT && xrpToBuy >= MIN_XRP_TRADE_AMOUNT && entry > 0 && currentBB?.middle) {
                    const xrpStr = xrpToBuy.toFixed(8); const usdcStr = usdcToSpendVal.toFixed(2);
                    // Use a fixed percentage profit target (2.5%) instead of Bollinger Band middle
                    const tpVal = entry * 1.025; // 2.5% profit target
                    console.log(`\x1b[42m[${cycleTimestamp}] BUY (Risk-Adj): Spend ~${usdcStr} USDC for ~${xrpStr} XRP. SL: ${initialSL.toFixed(4)}, TP: ${tpVal.toFixed(4)}.\x1b[0m`);
                    try {
                        const order = await coinbaseService.submitOrder("XRP-USDC", "BUY", usdcStr);
                        if (order && (order.success || order.success_response?.order_id)) {
                            // Create a transaction record for this buy
                            const orderId = order.success_response?.order_id || order.order_id || order.client_order_id;
                            const timestamp = new Date().toISOString();
                            
                            // Create the initial transaction
                            const initialTransaction = {
                                type: 'BUY',
                                price: entry,
                                xrpAmount: xrpStr,
                                usdcAmount: usdcStr,
                                timestamp: timestamp,
                                id: orderId,
                                reason: 'INITIAL_BUY'
                            };
                            
                            // Create position with transaction history
                            currentPosition = { 
                                type: 'LONG', 
                                entryPrice: entry, 
                                stopLossPrice: initialSL, 
                                takeProfitPrice: tpVal, 
                                xrpAmount: xrpStr, 
                                originalXrpAmount: xrpStr, 
                                usdcSpentOrReceived: usdcStr, 
                                halfSoldOrCovered: false, 
                                breakevenStopActive: false, 
                                currentTrailingStopPrice: null, 
                                orderId: orderId,
                                entryTime: timestamp,
                                transactions: [initialTransaction]
                            };
                            console.log(`\x1b[42m[${cycleTimestamp}] BUY order submitted. Position: \x1b[0m`, currentPosition);
                            const buyNotificationData = {
                                type: 'trade_notification',
                                action: 'BUY',
                                pair: "XRP-USDC",
                                amount: xrpStr,
                                entryPrice: entry.toFixed(2),
                                price: entry.toFixed(2),
                                usdcValue: parseFloat(usdcStr).toFixed(2),
                                reason: signalReason,
                                orderId: currentPosition.orderId,
                                rsi: currentRSI?.toFixed(2) || 'N/A',
                                macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                                stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: parseFloat(eurBalance).toFixed(2) // eurBalance holds USDC balance
                            };
                            await sendTradeNotification(buyNotificationData);
                            await logTradeEntry({ timestamp: formatTimestamp(new Date()), action: 'BUY', pair: "XRP-USDC", price: entry.toFixed(2), amountXrp: xrpStr, amountUsdc: usdcStr, orderId: currentPosition.orderId, reason: `Signal: ${signalReason}`, signalDetails: signalReason, pnl: 0 });
                            savePositionState();
                            lastSellActionTime = null;
                            lastSellPrice = null;
                        } else {
                            console.log(`\x1b[43m[${cycleTimestamp}] BUY order failed: ${JSON.stringify(order)}\x1b[0m`);
                            const notificationData = {
                                type: 'trade_notification',
                                action: 'BUY',
                                pair: "XRP-USDC",
                                amount: btcStr,
                                price: entry.toFixed(2),
                                reason: `BUY failed: ${order.error_response?.message || 'Unknown error'}`,
                                rsi: currentRSI?.toFixed(2) || 'N/A',
                                macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                                stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: parseFloat(eurBalance).toFixed(2) // USDC balance
                            };
                            // Enhanced notification with retries
let notificationSent = false;
for (let i = 0; i < NOTIFICATION_RETRY_COUNT && !notificationSent; i++) {
    try {
        console.log(JSON.stringify(notificationData));
        notificationSent = true;
    } catch (e) {
        console.error(`Notification attempt ${i + 1} failed:`, e.message);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
    }
}
if (!notificationSent) {
    console.error(`Failed to send notification after ${NOTIFICATION_RETRY_COUNT} attempts`);
}
                        }
                    } catch (e) {
                        console.error(`\x1b[43m[${cycleTimestamp}] Error during BUY: ${e.message}\x1b[0m`);
                        const notificationData = {
                            type: 'trade_notification',
                            action: 'BUY',
                            pair: "XRP-USDC",
                            amount: btcStr,
                            price: entry.toFixed(2),
                            reason: `BUY error: ${e.message}`,
                            rsi: currentRSI?.toFixed(2) || 'N/A',
                            macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                            macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                            stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                            stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                            balance: parseFloat(eurBalance).toFixed(2) // USDC balance
                        };
                        // Enhanced notification with retries
let notificationSent = false;
for (let i = 0; i < NOTIFICATION_RETRY_COUNT && !notificationSent; i++) {
    try {
        console.log(JSON.stringify(notificationData));
        notificationSent = true;
    } catch (e) {
        console.error(`Notification attempt ${i + 1} failed:`, e.message);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
    }
}
if (!notificationSent) {
    console.error(`Failed to send notification after ${NOTIFICATION_RETRY_COUNT} attempts`);
}
                    }
                } else {
                    
                    // Calculate the fee impact as a percentage of the trade amount
                    const fixedFeeAmount = 0.44; // $0.22 buy fee + $0.22 sell fee
                    const feeImpactPercent = (fixedFeeAmount / usdcToSpendVal) * 100;
                    console.log(`[${cycleTimestamp}] Fee impact on this trade: ${feeImpactPercent.toFixed(2)}% ($${fixedFeeAmount} / $${usdcToSpendVal.toFixed(2)})`);
                    
                    // Calculate minimum required price movement to break even
                    const breakEvenPriceMove = feeImpactPercent;
                    console.log(`[${cycleTimestamp}] Required price movement to break even: ${breakEvenPriceMove.toFixed(2)}%`);
                    
                    let noTrade = [];
                    if(usdcToSpendVal < MIN_USDC_TRADE_AMOUNT) noTrade.push(`Spend (${usdcToSpendVal.toFixed(2)}) < min (${MIN_USDC_TRADE_AMOUNT})`);
                    if(xrpToBuy < MIN_XRP_TRADE_AMOUNT) noTrade.push(`XRP (${xrpToBuy.toFixed(8)}) < min (${MIN_XRP_TRADE_AMOUNT})`);
                    console.log(`[${cycleTimestamp}] BUY signal, but no trade: ${noTrade.join(', ')}`);
                }
            } else {
                console.log(`[${cycleTimestamp}] BUY signal, but re-entry conditions not met. Last Sell: ${lastSellPrice?.toFixed(8)} at ${lastSellActionTime ? formatTimestamp(new Date(lastSellActionTime)) : 'N/A'}. Current Price: ${currentPrice?.toFixed(8)}`);
            }
        } else if (identifiedSignal === "POTENTIAL_WEIGHTED_SHORT" && !currentPosition && !positionClosedThisCycle) {
            // Check if we can enter a new short position
            const canEnterShort = shortPositionManagement.canEnterShortPosition(lastCoverActionTime, lastCoverPrice, currentPrice, cycleTimestamp);
            
            if (canEnterShort) {
                console.log(`\x1b[35m[${cycleTimestamp}] Attempting to enter SHORT position at ${currentPrice.toFixed(4)}\x1b[0m`);
                
                try {
                    // First check the USD balance to ensure we have enough for the short position
                    const accountsData = await coinbaseService.getAccounts();
                    const usdAcc = accountsData.accounts.find(acc => acc.currency === "USD");
                    const usdBalance = usdAcc?.available_balance?.value || "0";
                    const actualUsdBalance = parseFloat(usdBalance);
                    
                    // Calculate how much XRP to short based on USD balance
                    const usdToRisk = Math.min(actualUsdBalance * 0.1, MAX_USD_PER_TRADE); // Risk 10% of USD balance or max per trade
                    const xrpToShort = (usdToRisk / currentPrice).toFixed(8);
                    
                    // Check minimum trade requirements
                    if (usdToRisk < MIN_USD_TRADE_AMOUNT || parseFloat(xrpToShort) < MIN_XRP_TRADE_AMOUNT) {
                        console.log(`\x1b[33m[${cycleTimestamp}] SHORT signal, but no trade: USD to risk (${usdToRisk.toFixed(2)}) < min (${MIN_USD_TRADE_AMOUNT}) or XRP to short (${xrpToShort}) < min (${MIN_XRP_TRADE_AMOUNT})\x1b[0m`);
                        return;
                    }
                    
                    // Execute the short order (sell XRP that we don't own yet)
                    const order = await coinbaseService.createMarketOrder("XRP-USD", "sell", xrpToShort);
                    
                    if (order && (order.success || order.success_response?.order_id)) {
                        const price = parseFloat(currentPrice);
                        const usdValue = (parseFloat(xrpToShort) * price).toFixed(2);
                        const id = order.success_response?.order_id || order.order_id || order.client_order_id;
                        
                        // Calculate stop-loss and take-profit prices for short position
                        const stopLossPrice = price * 1.02; // 2% against us
                        const takeProfitPrice = price * 0.98; // 2% in our favor
                        
                        // Create and save the short position
                        currentPosition = {
                            type: 'SHORT',
                            xrpAmount: xrpToShort,
                            entryPrice: price.toString(),
                            entryTime: Date.now(),
                            stopLossPrice: stopLossPrice.toString(),
                            takeProfitPrice: takeProfitPrice.toString(),
                            recentlyLoaded: false
                        };
                        savePositionState();
                        
                        const notificationData = {
                            type: 'trade_notification',
                            action: 'SHORT',
                            pair: "XRP-USD",
                            amount: xrpToShort,
                            price: price.toFixed(2),
                            usdValue: usdValue,
                            reason: signalReason,
                            orderId: id,
                            stopLoss: stopLossPrice.toFixed(2),
                            takeProfit: takeProfitPrice.toFixed(2),
                            rsi: currentRSI?.toFixed(2) || 'N/A',
                            macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                            macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                            stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                            stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                            balance: actualUsdBalance.toFixed(2)
                        };
                        await sendTradeNotification(notificationData);
                        await logTradeEntry({ timestamp: formatTimestamp(new Date()), action:'SHORT', pair:"XRP-USD", price:price.toFixed(2), amountXrp:xrpToShort, amountUsd:usdValue, orderId:id, reason:signalReason, signalDetails:signalReason, stopLoss:stopLossPrice.toFixed(2), takeProfit:takeProfitPrice.toFixed(2) });
                    } else {
                        console.log(`\x1b[41m[${cycleTimestamp}] SHORT order failed: ${JSON.stringify(order)}\x1b[0m`);
                        const notificationData = {
                            type:'trade_notification', action:'SHORT', pair:"XRP-USD", amount:xrpToShort,
                            price: currentPrice.toFixed(2),
                            reason:`SHORT failed: ${order.error_response?.message || 'Unknown error'}`,
                            rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                            macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                            stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                            balance: actualUsdBalance.toFixed(2)
                        };
                        await sendTradeNotification(notificationData);
                    }
                } catch (e) {
                    console.error(`\x1b[41m[${cycleTimestamp}] Error creating short position: ${e.message}\x1b[0m`);
                }
            } else {
                console.log(`\x1b[35m[${cycleTimestamp}] SHORT signal, but re-entry conditions not met. Last Cover: ${lastCoverPrice?.toFixed(8)} at ${lastCoverActionTime ? formatTimestamp(new Date(lastCoverActionTime)) : 'N/A'}. Current Price: ${currentPrice?.toFixed(8)}\x1b[0m`);
            }
        } else if (currentPosition?.type === 'SHORT') {
            // Calculate total investment and XRP amount for shorts
            let totalInvested = 0;
            let totalXrp = 0;
            
            if (currentPosition.transactions && currentPosition.transactions.length > 0) {
                currentPosition.transactions.forEach(tx => {
                    // Only count short transactions 
                    if (tx.type === 'SHORT' || tx.type === 'MANUAL_SHORT') {
                        const txUsdcAmount = tx.usdcAmount || (parseFloat(tx.price || entryPrice) * parseFloat(tx.xrpAmount || 0));
                        totalInvested += txUsdcAmount;
                        totalXrp += parseFloat(tx.xrpAmount || 0);
                    }
                });
            } else {
                // Fallback if no transactions are recorded
                totalInvested = parseFloat(currentPosition.usdcSpentOrReceived || 0);
                totalXrp = parseFloat(currentPosition.xrpAmount || 0);
            }
            
            // Calculate weighted average entry price for shorts
            const weightedAvgEntryPrice = totalXrp > 0 ? (totalInvested / totalXrp) : entryPrice;
            
            // Calculate potential profit/loss for short position (reversed from long position)
            const potentialPnL = (weightedAvgEntryPrice - currentPrice) * parseFloat(currentPosition.xrpAmount);
            const potentialPnLPercent = weightedAvgEntryPrice > 0 ? ((weightedAvgEntryPrice - currentPrice) / weightedAvgEntryPrice) * 100 : 0;
            const isProfitable = potentialPnL > 0;
            const isSignificantProfit = potentialPnLPercent >= 0.25; // Reduced from 0.5% to 0.25%
            
            // Log the weighted average entry price for transparency
            console.log(`\x1b[36m[${cycleTimestamp}] Short Position Weighted Average Entry Price: $${weightedAvgEntryPrice.toFixed(8)} (Original Entry: $${entryPrice.toFixed(8)})\x1b[0m`);
            
            // Check for consecutive negative candles (patience for shorts)
            const hasConsecutiveNegativeCandles = checkConsecutiveNegativeCandles(cachedCandles, cachedCandles.length - 1);
            
            // Only cover short if we have a cover signal AND it would be profitable
            const confirmCoverResult = shouldConfirmCover(cachedCandles, cachedCandles.length - 1, entryPrice, currentPosition, coverConfirmationCount, coverConfirmationRequired);
            
            // Check if position was recently loaded (after restart)
            const isRecentlyLoaded = currentPosition.recentlyLoaded === true;
            
            console.log(`\x1b[36m[${cycleTimestamp}] Short Position Analysis: Entry=${entryPrice.toFixed(8)}, Current=${currentPrice.toFixed(8)}, PnL=${potentialPnLPercent.toFixed(4)}%, Profitable=${isProfitable}, SignificantProfit=${isSignificantProfit}, ConsecutiveNegative=${hasConsecutiveNegativeCandles}, ShouldCover=${confirmCoverResult}, RecentlyLoaded=${isRecentlyLoaded}\x1b[0m`);
            
            // Never cover immediately after restart unless it's a very significant profit (5%+)
            if (isRecentlyLoaded && potentialPnLPercent < 5) {
                console.log(`\x1b[33m[${cycleTimestamp}] Holding recently loaded short position despite cover signal. Waiting for acclimation period.\x1b[0m`);
            }
            // Automatic profit taking at 2% regardless of confirmation
            else if (potentialPnLPercent >= 2) {
                console.log(`\x1b[42m[${cycleTimestamp}] AUTO-PROFIT-TAKING for SHORT. Amount: ${currentPosition.xrpAmount}, PnL: ${potentialPnLPercent.toFixed(2)}%\x1b[0m`);
                try {
                    // First check the USD balance to ensure we have enough to cover
                    const accountsData = await coinbaseService.getAccounts();
                    const usdAcc = accountsData.accounts.find(acc => acc.currency === "USD");
                    const usdBalance = usdAcc?.available_balance?.value || "0";
                    const usdNeeded = parseFloat(currentPosition.xrpAmount) * currentPrice;
                    const actualUsdBalance = parseFloat(usdBalance);
                    
                    if (actualUsdBalance < usdNeeded) {
                        console.log(`\x1b[41m[${cycleTimestamp}] Cannot cover short: Insufficient USD balance. Required: $${usdNeeded.toFixed(2)}, Available: $${actualUsdBalance.toFixed(2)}\x1b[0m`);
                        const notificationData = {
                            type:'trade_notification', action:'COVER', pair:"XRP-USD", amount:currentPosition.xrpAmount.toString(),
                            price: currentPrice.toFixed(2),
                            reason:`Insufficient USD balance: Required $${usdNeeded.toFixed(2)}, Available $${actualUsdBalance.toFixed(2)}`,
                            rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                            macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                            stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                            balance: actualUsdBalance.toFixed(2)
                        };
                        await sendTradeNotification(notificationData);
                    } else {
                        // Execute the cover order (buy back XRP to close short position)
                        const order = await coinbaseService.createMarketOrder("XRP-USD", "buy", currentPosition.xrpAmount);
                        
                        if (order && (order.success || order.success_response?.order_id)) {
                            const xrpAmount = currentPosition.xrpAmount.toString();
                            const price = parseFloat(currentPrice);
                            const usdValue = (parseFloat(xrpAmount) * price).toFixed(2);
                            const id = order.success_response?.order_id || order.order_id || order.client_order_id;
                            const pnl = (entryPrice - price) * parseFloat(xrpAmount); // For shorts, profit when price goes down
                            const pnlString = pnl.toFixed(2);
                            
                            const notificationData = {
                                type: 'trade_notification',
                                action: 'COVER',
                                pair: "XRP-USD",
                                amount: xrpAmount,
                                entryPrice: entryPrice.toFixed(2),
                                price: price.toFixed(2),
                                usdValue: usdValue,
                                reason: `Auto profit-taking at ${potentialPnLPercent.toFixed(2)}% profit`,
                                orderId: id,
                                rsi: currentRSI?.toFixed(2) || 'N/A',
                                macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                                stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: actualUsdBalance.toFixed(2),
                                pnl: pnlString
                            };
                            await sendTradeNotification(notificationData);
                            await logTradeEntry({ timestamp: formatTimestamp(new Date()), action:'COVER', pair:"XRP-USD", price:price.toFixed(2), amountXrp:xrpAmount, amountUsd:usdValue, orderId:id, reason:`Auto profit-taking at ${potentialPnLPercent.toFixed(2)}% profit`, signalDetails:signalReason, entryPrice:entryPrice.toFixed(2), pnl:pnl });
                            updateCumulativeProfit(pnl);
                            lastCoverActionTime = Date.now();
                            lastCoverPrice = price;
                            currentPosition = null;
                            savePositionState();
                            positionClosedThisCycle = true;
                        } else {
                            console.log(`\x1b[41m[${cycleTimestamp}] COVER order failed: ${JSON.stringify(order)}\x1b[0m`);
                            const notificationData = {
                                type:'trade_notification', action:'COVER', pair:"XRP-USD", amount:currentPosition.xrpAmount.toString(),
                                price: currentPrice.toFixed(2),
                                reason:`COVER failed: ${order.error_response?.message || 'Unknown error'}`,
                                rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: actualUsdBalance.toFixed(2)
                            };
                            await sendTradeNotification(notificationData);
                        }
                    }
                } catch (e) {
                    console.error(`\x1b[41m[${cycleTimestamp}] Error covering short position: ${e.message}\x1b[0m`);
                }
            }
            // Normal cover logic when not recently loaded
            else if (identifiedSignal === "POTENTIAL_WEIGHTED_COVER" && confirmCoverResult) {
                console.log(`\x1b[45m[${cycleTimestamp}] Confirmed COVER. Amount: ${currentPosition.xrpAmount}, PnL: ${potentialPnLPercent.toFixed(2)}%\x1b[0m`);
                try {
                    // First check the USD balance
                    const accountsData = await coinbaseService.getAccounts();
                    const usdAcc = accountsData.accounts.find(acc => acc.currency === "USD");
                    const usdBalance = usdAcc?.available_balance?.value || "0";
                    const usdNeeded = parseFloat(currentPosition.xrpAmount) * currentPrice;
                    const actualUsdBalance = parseFloat(usdBalance);
                    
                    if (actualUsdBalance < usdNeeded) {
                        console.log(`\x1b[41m[${cycleTimestamp}] Cannot cover short: Insufficient USD balance. Required: $${usdNeeded.toFixed(2)}, Available: $${actualUsdBalance.toFixed(2)}\x1b[0m`);
                        const notificationData = {
                            type:'trade_notification', action:'COVER', pair:"XRP-USD", amount:currentPosition.xrpAmount.toString(),
                            price: currentPrice.toFixed(2),
                            reason:`Insufficient USD balance: Required $${usdNeeded.toFixed(2)}, Available $${actualUsdBalance.toFixed(2)}`,
                            rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                            macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                            stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                            balance: actualUsdBalance.toFixed(2)
                        };
                        await sendTradeNotification(notificationData);
                    } else {
                        // Execute the cover order (buy back XRP to close short position)
                        const order = await coinbaseService.createMarketOrder("XRP-USD", "buy", currentPosition.xrpAmount);
                        
                        if (order && (order.success || order.success_response?.order_id)) {
                            const xrpAmount = currentPosition.xrpAmount.toString();
                            const price = parseFloat(currentPrice);
                            const usdValue = (parseFloat(xrpAmount) * price).toFixed(2);
                            const id = order.success_response?.order_id || order.order_id || order.client_order_id;
                            const pnl = (entryPrice - price) * parseFloat(xrpAmount); // For shorts, profit when price goes down
                            const pnlString = pnl.toFixed(2);
                            
                            const notificationData = {
                                type: 'trade_notification',
                                action: 'COVER',
                                pair: "XRP-USD",
                                amount: xrpAmount,
                                entryPrice: entryPrice.toFixed(2),
                                price: price.toFixed(2),
                                usdValue: usdValue,
                                reason: signalReason,
                                orderId: id,
                                rsi: currentRSI?.toFixed(2) || 'N/A',
                                macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                                stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: actualUsdBalance.toFixed(2),
                                pnl: pnlString
                            };
                            await sendTradeNotification(notificationData);
                            await logTradeEntry({ timestamp: formatTimestamp(new Date()), action:'COVER', pair:"XRP-USD", price:price.toFixed(8), amountXrp:xrpAmount, amountUsd:usdValue, orderId:id, reason:signalReason, signalDetails:signalReason, entryPrice:entryPrice.toFixed(8), pnl:pnl });
                            updateCumulativeProfit(pnl);
                            lastCoverActionTime = Date.now();
                            lastCoverPrice = price;
                            currentPosition = null;
                            savePositionState();
                            positionClosedThisCycle = true;
                        } else {
                            console.log(`\x1b[41m[${cycleTimestamp}] COVER order failed: ${JSON.stringify(order)}\x1b[0m`);
                            const notificationData = {
                                type:'trade_notification', action:'COVER', pair:"XRP-USD", amount:currentPosition.xrpAmount.toString(),
                                price: currentPrice.toFixed(2),
                                reason:`COVER failed: ${order.error_response?.message || 'Unknown error'}`,
                                rsi: currentRSI?.toFixed(2) || 'N/A', macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                                stochK: currentStoch?.k?.toFixed(2) || 'N/A', stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                                balance: actualUsdBalance.toFixed(2)
                            };
                            await sendTradeNotification(notificationData);
                        }
                    }
                } catch (e) {
                    console.error(`\x1b[41m[${cycleTimestamp}] Error covering short position: ${e.message}\x1b[0m`);
                }
            }
        } else if (identifiedSignal === "NONE" && !currentPosition && !positionClosedThisCycle) {
            let detailedSkipReason = signalReason; // Default reason
            let skipSignature = "GeneralNoSignal"; // Default signature

            // Check if a BUY was considered but failed specific conditions
            if (buyScore >= 4) { // A buy was generally indicated by score
                if (!stochBuyConditionMet) {
                    detailedSkipReason = `Potential Buy (Score=${buyScore}) skipped. Stoch Condition Fail: Cross=${stochCrossingUp}, ConfirmK=${stochKConfirm}, SafeZone=${stochInSafeZone} (K=${currentStoch?.k?.toFixed(2)}).`;
                    if (!stochCrossingUp) skipSignature = "StochFail_NoCross";
                    else if (!stochKConfirm) skipSignature = "StochFail_NoKConfirm";
                    else if (!stochInSafeZone) skipSignature = "StochFail_NotInSafeZone";
                    else skipSignature = "StochFail_Unknown";
                }
                // This else implies stochBuyConditionMet was true, but other BUY conditions (like re-entry) failed
            } else if (buyScore < 4) { // Not even a score-based buy signal
                skipSignature = "LowBuyScore";
                detailedSkipReason = `Low Buy Score (${buyScore}). Conditions: EMA=${emaClose}, MACD=${macdBuy}, RSI=${rsiBuy}, StochWeight=${stochBuy}. Stoch Details: Bullish=${stochBullish}, Oversold=${stochOversold}, K=${currentStoch?.k?.toFixed(2)}, D=${currentStoch?.d?.toFixed(2)}.`;
            }

            // Check re-entry conditions if it was a potential buy but might have been blocked by cooldown
            // This check is relevant if identifiedSignal is NONE but buyScore was high and stoch was OK
            // Or if identifiedSignal was POTENTIAL_WEIGHTED_BUY but then re-entry blocked it (though that sets identifiedSignal to NONE earlier)
            // For simplicity, we'll assume if identifiedSignal is NONE, the primary reason is already captured above.
            // A more complex state machine might be needed for very fine-grained re-entry skip reasons if the above isn't enough.
            // The current `detailedSkipReason` from stoch/score failure is usually sufficient.

            console.log(`[${cycleTimestamp}] Conditions not met for new entry. ${detailedSkipReason}`);
            const skippedEntryInfo = {
                type: 'skipped_entry_review',
                timestamp: cycleTimestamp,
                price: currentPrice?.toFixed(2) || 'N/A',
                rsi: currentRSI?.toFixed(2) || 'N/A',
                macdLine: currentMacdSet?.MACD?.toFixed(2) || 'N/A',
                macdSignal: currentMacdSet?.signal?.toFixed(2) || 'N/A',
                stochK: currentStoch?.k?.toFixed(2) || 'N/A',
                stochD: currentStoch?.d?.toFixed(2) || 'N/A',
                usdcBalance: parseFloat(eurBalance).toFixed(2), // Format USDC balance with 2 decimal places
                reason: detailedSkipReason, // Full descriptive reason
                skipSignature: skipSignature // Concise signature for cooldown logic
            };
            console.log(`\x1b[33m[${cycleTimestamp}] TRADE SKIPPED: ${skipSignature} | Price: $${currentPrice?.toFixed(8) || 'N/A'} | USDC Balance: $${parseFloat(eurBalance).toFixed(2)}\x1b[0m`);
            console.log(JSON.stringify(skippedEntryInfo));
        }
        // Save cycle information for monitoring with higher precision
        const cycleData = {
            timestamp: cycleTimestamp, 
            price: currentPrice?.toFixed(8) || 'N/A', // Increased from 2 to 8 decimal places
            bb_lower: currentBB?.lower?.toFixed(8) || 'N/A', // Increased from 2 to 8 decimal places
            bb_middle: currentBB?.middle?.toFixed(8) || 'N/A', // Increased from 2 to 8 decimal places
            bb_upper: currentBB?.upper?.toFixed(8) || 'N/A', // Increased from 2 to 8 decimal places
            rsi: currentRSI?.toFixed(4) || 'N/A', // Increased from 2 to 4 decimal places
            ema_fast: currentEmaFast?.toFixed(8) || 'N/A', // Increased from 2 to 8 decimal places
            ema_slow: currentEmaSlow?.toFixed(8) || 'N/A', // Increased from 2 to 8 decimal places
            macd_line: currentMacdSet?.MACD?.toFixed(8) || 'N/A', // Increased from 4 to 8 decimal places
            macd_signal: currentMacdSet?.signal?.toFixed(8) || 'N/A', // Increased from 4 to 8 decimal places
            stoch_k: currentStoch?.k?.toFixed(4) || 'N/A', // Increased from 2 to 4 decimal places
            stoch_d: currentStoch?.d?.toFixed(4) || 'N/A', // Increased from 2 to 4 decimal places
            is_uptrend: isUpTrend, 
            identified_signal: identifiedSignal, 
            signal_reason: signalReason,
            active_position: currentPosition ? { 
                type: currentPosition.type, 
                entry_price: parseFloat(currentPosition.entryPrice || 0).toFixed(8), // Increased from 4 to 8 decimal places
                stop_loss: parseFloat(currentPosition.stopLoss || 0).toFixed(8), // Increased from 4 to 8 decimal places
                take_profit: parseFloat(currentPosition.takeProfit || 0).toFixed(8), // Increased from 4 to 8 decimal places
                xrp_amount: currentPosition.xrpAmount || currentPosition.amount, 
                entry_time: new Date(currentPosition.timestamp).toLocaleString(), 
                usdc_value: (parseFloat(currentPosition.xrpAmount || currentPosition.amount || 0) * currentPrice).toFixed(8) // Increased from 2 to 8 decimal places
            } : 'None',
            usdc_balance: eurBalance,
            usd_balance: eurBalance, // Add this for backward compatibility
            cumulative_profit: cumulativeProfit.toFixed(2)
        };

        try {
            // Save cycle information
            fs.writeFileSync(CYCLE_INFO_FILE_PATH, JSON.stringify(cycleData, null, 2), 'utf8');
            
            // Update and save price history
            updatePriceHistory(currentPrice, cycleTimestamp);
            
            // Process auto-averaging after saving cycle info
            if (currentPosition) {
                console.log(`[${cycleTimestamp}] Checking auto-averaging conditions...`);
                const averagingResult = await averagingIntegration.processAutoAveraging(
                    cycleData,
                    coinbaseService,
                    async (message) => {
                        // Use the same notification function as other trade notifications
                        await sendTradeNotification({
                            type: 'auto_averaging',
                            message: message
                        });
                    }
                );
                
                if (averagingResult && averagingResult.success) {
                    console.log(`[${cycleTimestamp}] Auto-averaging executed successfully!`);
                    console.log(`[${cycleTimestamp}] New entry price: $${parseFloat(averagingResult.updatedPosition.entryPrice).toFixed(8)}`);
                    console.log(`[${cycleTimestamp}] New XRP amount: ${averagingResult.updatedPosition.xrpAmount}`);
                    
                    // Log the transaction details for transparency
                    const lastTransaction = averagingResult.updatedPosition.transactions[averagingResult.updatedPosition.transactions.length - 1];
                    console.log(`[${cycleTimestamp}] Auto-averaging transaction details:`);
                    console.log(JSON.stringify(lastTransaction, null, 2));
                    
                    // Update the current position with the averaged position
                    currentPosition = averagingResult.updatedPosition;
                    
                    // Add a flag to indicate auto-averaging occurred in this cycle
                    // This will prevent the manual transaction detection from triggering in the next cycle
                    currentPosition.autoAveragingOccurred = true;
                    
                    savePositionState();
                    
                    // Log the full updated position for debugging
                    console.log(`[${cycleTimestamp}] Updated position after auto-averaging:`);
                    console.log(JSON.stringify({
                        type: currentPosition.type,
                        entryPrice: currentPosition.entryPrice,
                        xrpAmount: currentPosition.xrpAmount,
                        transactionCount: currentPosition.transactions.length,
                        autoAveragingOccurred: currentPosition.autoAveragingOccurred
                    }, null, 2));
                }
            }
        } catch (e) { 
            console.error(`[${cycleTimestamp}] Error in cycle processing:`, e.message);
        }
        
        console.log(`[${cycleTimestamp}] --- Trading Logic Cycle Complete ---`);
    } catch (error) {
        console.error(`[${cycleTimestamp}] Error in trading logic:`, error.message, error.stack);
    }
}

// Initialize and start the trading bot
function calculateNextCandleTime() {
    const now = new Date();
    const secondsUntilNextMinute = 60 - now.getSeconds();
    return secondsUntilNextMinute * 1000 + 500; // Add 500ms buffer
}

async function startTradingBot() {
    if (isTrading) return;
    
    try {
        // Load all state data
        loadPositionState();
        loadTradeLog();
        loadCumulativeProfit();
        loadCandleCache();
        
        // Initialize auto-averaging integration
        averagingIntegration.initAveragingIntegration();
        
        // If we have a position, log it clearly
        if (currentPosition) {
            console.log('\n==================================================');
            console.log('EXISTING POSITION DETECTED ON STARTUP:');
            console.log(`XRP Amount: ${currentPosition.xrpAmount}`);
            console.log(`Entry Price: $${parseFloat(currentPosition.entryPrice).toFixed(8)}`);
            console.log(`Entry Time: ${new Date(currentPosition.entryTime).toLocaleString()}`);
            console.log(`Position Age: ${Math.floor((Date.now() - new Date(currentPosition.entryTime).getTime()) / (1000 * 60 * 60))} hours`);
            console.log('==================================================\n');
            
            // Set a flag to prevent immediate selling after restart
            currentPosition.recentlyLoaded = true;
            
            // After 5 minutes, remove the recently loaded flag
            setTimeout(() => {
                if (currentPosition) {
                    delete currentPosition.recentlyLoaded;
                    console.log('Position is no longer marked as recently loaded - normal trading rules now apply');
                }
            }, 5 * 60 * 1000); // 5 minutes
        }

        // Initial run with error handling
        try {
            await runTradingLogic();
        } catch (error) {
            console.error('[TradingBot] Error in initial run:', error.message);
        }

        // Calculate time until next candle
        const nextRunDelay = calculateNextCandleTime();
        console.log(`Syncing with Coinbase candles. First run in ${(nextRunDelay / 1000).toFixed(1)} seconds...`);

        // Schedule first run with error handling
        setTimeout(async () => {
            try {
                await runTradingLogic();
            } catch (error) {
                console.error('[TradingBot] Error in scheduled run:', error.message);
            }

            // Then start the regular interval with error handling wrapper
            tradingInterval = setInterval(async () => {
                try {
                    await runTradingLogic();
                } catch (error) {
                    console.error('[TradingBot] Error in interval run:', error.message);
                    // Don't let errors stop the bot, just log them
                }
            }, TRADING_INTERVAL_MS);
        }, nextRunDelay);

        isTrading = true;
        console.log('[TradingBot] Trading bot started successfully');
    } catch (error) {
        console.error('[TradingBot] Critical error starting bot:', error.message);
        // Try to recover
        stopTradingBot();
        setTimeout(() => startTradingBot(), 5000); // Retry after 5 seconds
    }
}

// Control variables
let isTrading = false;
let tradingInterval = null;

// Control functions
function stopTradingBot() {
    if (!isTrading) return false;
    console.log('Stopping trader bot...');
    if (tradingInterval) {
        clearInterval(tradingInterval);
        tradingInterval = null;
    }
    isTrading = false;
    return true;
}

function startTradingBotIfNotRunning() {
    if (isTrading) return false;
    console.log('Starting trader bot...');
    startTradingBot();
    return true;
}

/**
 * Stop the trading bot
 * @returns {boolean} True if the bot was stopped successfully
 */
function stopTradingBot() {
    try {
        if (!isTrading) {
            console.log('Trading bot is not running.');
            return false;
        }
        
        // Clear the trading interval
        if (tradingInterval) {
            clearInterval(tradingInterval);
            tradingInterval = null;
        }
        
        // Save any current state
        if (currentPosition) {
            savePositionState();
        }
        saveCandleCache();
        
        isTrading = false;
        console.log('Trading bot stopped successfully.');
        return true;
    } catch (error) {
        console.error('Error stopping trading bot:', error);
        return false;
    }
}

/**
 * Restart the trading bot
 * @returns {boolean} True if the bot was restarted successfully
 */
function restartTradingBot() {
    console.log('Restarting trader bot...');
    
    try {
        // Stop the bot if it's running
        if (isTrading) {
            stopTradingBot();
        }
        
        // Small delay to ensure clean restart
        setTimeout(() => {
            startTradingBot();
        }, 1000);
        
        return true;
    } catch (error) {
        console.error('Error restarting trading bot:', error);
        return false;
    }
}

// Export control functions and data access functions
module.exports = {
startTradingBotIfNotRunning,
stopTradingBot,
restartTradingBot,
loadPositionState,
loadCumulativeProfit
};

// Only start the bot when this file is run directly, not when imported
if (require.main === module) {
    console.log('Starting bot automatically (direct execution)...');
    startTradingBot();
}