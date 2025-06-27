import { TechnicalIndicators } from './technicalIndicators.js';
import { trailingStopConfig as config } from './trailingStopConfig.js';

/**
 * Enhanced TrailingStopManager with improved position tracking and exit strategies
 * Features:
 * - Multiple exit conditions (momentum, volume, time-based)
 * - Volatility-adjusted trailing
 * - Improved position state tracking
 * - Rate limiting and error handling
 */
class TrailingStopManager {
  constructor(coinbaseService, logger, configOverrides = {}) {
    this.coinbaseService = coinbaseService;
    this.logger = logger || console;
    
    // Merge configurations with defaults
    this.config = { 
      ...config, 
      ...configOverrides 
    };
    
    // Rate limiting and request management
    this.rateLimits = {
      lastRequestTime: 0,
      remainingRequests: 30, // Default Coinbase rate limit
      resetTime: Date.now() + 60000, // Default reset to 1 minute from now
      minRequestInterval: 1000 / (10 / 60), // 10 requests per minute = 1 request every 6 seconds
      consecutiveErrors: 0,
      maxConsecutiveErrors: 5,
      baseRetryDelay: 1000, // 1 second
      maxRetryDelay: 30000, // 30 seconds
    };
    
    // Position tracking
    this.position = {
      id: null,                     // Unique ID for this position
      status: 'inactive',           // inactive | active | trailing | closed
      entryPrice: 0,                // Entry price of the position
      size: 0,                      // Position size in base currency
      entryTime: null,              // When the position was opened
      currentValue: 0,              // Current market value
      highestPrice: 0,              // Highest price seen since entry
      highestValue: 0,              // Highest value achieved
      currentProfitPct: 0,          // Current profit percentage
      maxDrawdownPct: 0,            // Maximum drawdown from highest point
      trailStartPrice: 0,           // Price when trailing was activated
      trailStartTime: null,         // When trailing was activated
      trailHighPrice: 0,            // Highest price during trailing
      trailHighTime: null,          // When the trail high was set
      initialVolume: 0,             // Volume at position entry
      currentVolume: 0,             // Current volume
      consecutiveDownMoves: 0,      // Number of consecutive down moves
      lastUpdateTime: null,         // Last update time
      orderIds: [],                 // Array of related order IDs
      indicators: {                  // Technical indicators snapshot
        rsi: 0,
        macd: 0,
        bbWidth: 0,
        atr: 0,
        volumeMA: 0
      },
      exitReason: null,            // Reason for exit (if closed)
      exitTime: null,              // When the position was closed
      exitPrice: 0,                // Exit price (if closed)
      profitPct: 0                 // Final profit percentage (if closed)
    };
    
    // Active orders tracking
    this.activeOrders = new Map();  // orderId -> orderInfo
    this.orderHistory = [];         // History of all orders
    this.priceHistory = [];         // Historical price data
    this.volumeHistory = [];        // Historical volume data
    
    // State flags
    this.isRunning = false;
    this.isMonitoring = false;
    this.lastCheckTime = null;
    this.lastUpdateTime = null;
    this.errorCount = 0;
    this.maxErrorCount = 5;
    
    // Bind methods that need 'this' context
    this.initialize = this.initialize.bind(this);
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);
    this.startTrailing = this.startTrailing.bind(this);
    this.stopTrailing = this.stopTrailing.bind(this);
    this.monitorAndUpdateLimitOrders = this.monitorAndUpdateLimitOrders.bind(this);
    this.updatePosition = this.updatePosition.bind(this);
    this.evaluateExitConditions = this.evaluateExitConditions.bind(this);
    this.calculateVolatility = this.calculateVolatility.bind(this);
    this.calculateMomentum = this.calculateMomentum.bind(this);
    this.updateIndicators = this.updateIndicators.bind(this);
    this.makeRateLimitedCall = this.makeRateLimitedCall.bind(this);
  }
  
  /**
   * Initialize the TrailingStopManager
   * @returns {Promise<boolean>} True if initialization was successful
   */
  async initialize() {
    try {
      this.logger.info('🔄 Initializing TrailingStopManager...');
      
      // Reset state
      this.isRunning = false;
      this.isMonitoring = false;
      this.errorCount = 0;
      
      // Initialize indicators
      await this.updateIndicators();
      
      this.logger.info('✅ TrailingStopManager initialized successfully');
      return true;
      
    } catch (error) {
      this.logger.error('❌ Error initializing TrailingStopManager:', error);
      this.errorCount++;
      return false;
    }
  }
  
  /**
   * Start the trailing stop manager
   * @returns {Promise<boolean>} True if started successfully
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn('⚠️ TrailingStopManager is already running');
      return false;
    }
    
    try {
      this.logger.info('🚀 Starting TrailingStopManager...');
      
      // Initialize if not already done
      if (!this.isInitialized) {
        await this.initialize();
      }
      
      // Start monitoring
      this.isRunning = true;
      this.startMonitoring();
      
      this.logger.info('✅ TrailingStopManager started successfully');
      return true;
      
    } catch (error) {
      this.logger.error('❌ Error starting TrailingStopManager:', error);
      this.errorCount++;
      return false;
    }
  }
  
  /**
   * Stop the trailing stop manager
   * @returns {Promise<boolean>} True if stopped successfully
   */
  async stop() {
    if (!this.isRunning) {
      this.logger.warn('⚠️ TrailingStopManager is not running');
      return false;
    }
    
    try {
      this.logger.info('🛑 Stopping TrailingStopManager...');
      
      // Stop monitoring
      this.stopMonitoring();
      
      // Clean up
      this.isRunning = false;
      
      this.logger.info('✅ TrailingStopManager stopped successfully');
      return true;
      
    } catch (error) {
      this.logger.error('❌ Error stopping TrailingStopManager:', error);
      return false;
    }
  }
  
  /**
   * Start monitoring for position updates and order management
   * @private
   */
  startMonitoring() {
    if (this.isMonitoring) {
      this.logger.debug('Monitoring already active');
      return;
    }
    
    const intervalMs = this.config.orderCheckIntervalMs || 30000; // Default 30 seconds
    
    // Initial check
    this.monitorAndUpdateLimitOrders();
    
    // Set up interval for periodic checks
    this.monitorInterval = setInterval(() => {
      this.monitorAndUpdateLimitOrders().catch(error => {
        this.logger.error('Error in monitoring interval:', error);
        this.errorCount++;
        
        // Stop monitoring if we hit max errors
        if (this.errorCount >= this.maxErrorCount) {
          this.logger.error(`Max error count (${this.maxErrorCount}) reached, stopping monitoring`);
          this.stopMonitoring();
        }
      });
    }, intervalMs);
    
    this.isMonitoring = true;
    this.logger.info(`🔍 Started monitoring (checking every ${intervalMs/1000}s)`);
  }
  
  /**
   * Stop monitoring for position updates
   * @private
   */
  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isMonitoring = false;
    this.logger.info('⏹️ Stopped monitoring');
  }
  
  /**
   * Update the current position with latest market data
   * @param {number} currentPrice - Current market price
   * @param {number} [currentVolume=0] - Current volume
   * @returns {Object} Updated position
   */
  updatePosition(currentPrice, currentVolume = 0) {
    if (!this.position.entryPrice || this.position.status === 'closed') {
      return this.position;
    }
    
    const now = new Date();
    const isNewHigh = currentPrice > this.position.highestPrice;
    
    // Update position state
    this.position.currentValue = currentPrice * this.position.size;
    this.position.currentProfitPct = ((currentPrice / this.position.entryPrice) - 1) * 100;
    this.position.currentVolume = currentVolume;
    this.position.lastUpdateTime = now;
    
    // Update highest price/values
    if (isNewHigh) {
      this.position.highestPrice = currentPrice;
      this.position.highestValue = this.position.currentValue;
      this.position.consecutiveDownMoves = 0;
    } else {
      this.position.consecutiveDownMoves++;
    }
    
    // Calculate max drawdown from highest point
    if (this.position.highestPrice > 0) {
      const drawdown = ((this.position.highestPrice - currentPrice) / this.position.highestPrice) * 100;
      this.position.maxDrawdownPct = Math.max(this.position.maxDrawdownPct, drawdown);
    }
    
    // Update indicators
    this.updateIndicators();
    
    return this.position;
  }
  
  /**
   * Evaluate if exit conditions are met based on current market state
   * @returns {Object} Exit decision and reason
   */
  evaluateExitConditions() {
    const position = this.position;
    const now = new Date();
    
    // Check if position is not active or already closed
    if (position.status === 'inactive' || position.status === 'closed') {
      return { shouldExit: false, reason: 'No active position' };
    }
    
    // 1. Check max drawdown
    if (position.maxDrawdownPct > this.config.maxDrawdownPct) {
      return { 
        shouldExit: true, 
        reason: `Max drawdown (${position.maxDrawdownPct.toFixed(2)}%) exceeded ${this.config.maxDrawdownPct}%` 
      };
    }
    
    // 2. Check max trail duration
    if (position.trailStartTime && 
        (now - position.trailStartTime) > this.config.maxTrailDurationMs) {
      return { 
        shouldExit: true, 
        reason: `Max trail duration (${this.config.maxTrailDurationMs/60000} minutes) reached` 
      };
    }
    
    // 3. Check consecutive down moves
    if (position.consecutiveDownMoves >= this.config.consecutiveDownMoves) {
      return { 
        shouldExit: true, 
        reason: `${position.consecutiveDownMoves} consecutive down moves` 
      };
    }
    
    // 4. Check volume drop
    if (position.initialVolume > 0 && 
        position.currentVolume < (position.initialVolume * (1 - this.config.volumeDropThreshold))) {
      return { 
        shouldExit: true, 
        reason: `Volume dropped below ${(1 - this.config.volumeDropThreshold) * 100}% of initial volume` 
      };
    }
    
    // 5. Check momentum
    if (position.indicators.rsi < this.config.momentumExitThreshold) {
      return { 
        shouldExit: true, 
        reason: `Momentum (RSI: ${position.indicators.rsi.toFixed(2)}) below threshold (${this.config.momentumExitThreshold})` 
      };
    }
    
    return { shouldExit: false, reason: 'No exit conditions met' };
  }
  
  /**
   * Calculate current market volatility
   * @returns {number} Volatility score (0-1)
   */
  calculateVolatility() {
    if (this.priceHistory.length < this.config.volatilityLookback) {
      return 0; // Not enough data
    }
    
    // Simple ATR-based volatility calculation
    const prices = this.priceHistory.slice(-this.config.volatilityLookback);
    let sumRanges = 0;
    
    for (let i = 1; i < prices.length; i++) {
      const range = Math.abs(prices[i].close - prices[i-1].close);
      sumRanges += range;
    }
    
    const atr = sumRanges / (prices.length - 1);
    const avgPrice = prices.reduce((sum, p) => sum + p.close, 0) / prices.length;
    
    // Return as a percentage of average price
    return atr / avgPrice;
  }
  
  /**
   * Calculate current market momentum
   * @returns {number} Momentum score (-1 to 1)
   */
  calculateMomentum() {
    // Simple RSI-based momentum
    const rsi = this.position.indicators.rsi;
    
    // Normalize RSI to -1 to 1 range
    // 30-70 RSI range maps to -1 to 1
    if (rsi <= 30) return -1;
    if (rsi >= 70) return 1;
    return (rsi - 50) / 20; // Scale 30-70 to -1 to 1
  }
  
  /**
   * Update technical indicators based on current price/volume data
   */
  updateIndicators() {
    if (this.priceHistory.length < 14) {
      return; // Not enough data
    }
    
    try {
      const prices = this.priceHistory.map(p => p.close);
      const volumes = this.volumeHistory.length > 0 ? this.volumeHistory : Array(prices.length).fill(0);
      
      // Simple RSI (14-period)
      const rsiPeriod = 14;
      if (prices.length >= rsiPeriod) {
        const rsiValues = TechnicalIndicators.RSI(prices, rsiPeriod);
        this.position.indicators.rsi = rsiValues[rsiValues.length - 1] || 50;
      }
      
      // Simple MACD (12,26,9)
      if (prices.length >= 26) {
        const macd = TechnicalIndicators.MACD(prices, 12, 26, 9);
        this.position.indicators.macd = macd.MACD[macd.MACD.length - 1] || 0;
      }
      
      // Volume moving average (20-period)
      if (volumes.length >= 20) {
        const volumeSum = volumes.slice(-20).reduce((sum, v) => sum + v, 0);
        this.position.indicators.volumeMA = volumeSum / 20;
      }
      
      // Update position with latest indicators
      this.position.lastIndicatorUpdate = new Date();
      
    } catch (error) {
      this.logger.error('Error updating indicators:', error);
    }
  }
  
  /**
   * Start trailing a position
   * @param {string} orderId - The ID of the buy order that was filled
   * @param {number} entryPrice - The entry price of the position
   * @param {number} size - The size of the position in base currency
   * @param {number} [currentPrice] - Optional current market price
   * @returns {Promise<boolean>} True if trailing was started successfully
   */
  async startTrailing(orderId, entryPrice, size, currentPrice) {
    try {
      if (this.position.status !== 'inactive') {
        this.logger.warn(`Cannot start trailing - position is already ${this.position.status}`);
        return false;
      }
      
      // Initialize position
      const now = new Date();
      this.position = {
        ...this.position,
        id: orderId,
        status: 'active',
        entryPrice,
        size,
        entryTime: now,
        currentPrice: currentPrice || entryPrice,
        highestPrice: entryPrice,
        highestValue: entryPrice * size,
        currentValue: entryPrice * size,
        currentProfitPct: 0,
        maxDrawdownPct: 0,
        trailStartPrice: 0,
        trailStartTime: null,
        trailHighPrice: 0,
        trailHighTime: null,
        initialVolume: this.position.indicators.volumeMA || 0,
        currentVolume: this.position.indicators.volumeMA || 0,
        consecutiveDownMoves: 0,
        lastUpdateTime: now,
        orderIds: [orderId],
        exitReason: null,
        exitTime: null,
        exitPrice: 0,
        profitPct: 0
      };
      
      this.logger.info(`🚀 Started trailing position: ${size} @ $${entryPrice} (Order: ${orderId})`);
      return true;
      
    } catch (error) {
      this.logger.error('Error starting trailing:', error);
      return false;
    }
  }
  
  /**
   * Stop trailing a position
   * @param {string} [reason] - Optional reason for stopping
   * @returns {Promise<boolean>} True if trailing was stopped successfully
   */
  async stopTrailing(reason = 'Manual stop') {
    try {
      if (this.position.status === 'inactive' || this.position.status === 'closed') {
        this.logger.warn(`No active position to stop (status: ${this.position.status})`);
        return false;
      }
      
      // Close the position
      this.position.status = 'closed';
      this.position.exitTime = new Date();
      this.position.exitReason = reason;
      this.position.exitPrice = this.position.currentPrice;
      this.position.profitPct = this.position.currentProfitPct;
      
      // Cancel any open orders
      await this.cancelAllOrders();
      
      this.logger.info(`🛑 Stopped trailing position: ${reason}`);
      this.logger.info(`   Entry: $${this.position.entryPrice} | Exit: $${this.position.exitPrice} | PnL: ${this.position.profitPct.toFixed(2)}%`);
      
      return true;
      
    } catch (error) {
      this.logger.error('Error stopping trailing:', error);
      return false;
    }
  }
  
  /**
   * Monitor and update limit orders based on current market conditions
   * @returns {Promise<void>}
   */
  async monitorAndUpdateLimitOrders() {
    if (!this.isRunning) {
      return;
    }
    
    try {
      this.lastCheckTime = new Date();
      
      // 1. Update market data
      const marketData = await this.getMarketData();
      if (!marketData) {
        this.logger.warn('Failed to get market data');
        return;
      }
      
      const { currentPrice, currentVolume } = marketData;
      
      // 2. Update position with latest data
      this.updatePosition(currentPrice, currentVolume);
      
      // 3. Check exit conditions if we have an active position
      if (this.position.status === 'active' || this.position.status === 'trailing') {
        const { shouldExit, reason } = this.evaluateExitConditions();
        
        if (shouldExit) {
          this.logger.warn(`Exit condition met: ${reason}`);
          await this.stopTrailing(reason);
          return;
        }
        
        // 4. Check if we should start/update trailing
        await this.updateTrailingStop(currentPrice);
      }
      
      // 5. Update any open orders
      await this.updateOpenOrders(currentPrice);
      
    } catch (error) {
      this.logger.error('Error in monitorAndUpdateLimitOrders:', error);
      this.errorCount++;
      
      if (this.errorCount >= this.maxErrorCount) {
        this.logger.error(`Max error count (${this.maxErrorCount}) reached, stopping monitoring`);
        this.stopMonitoring();
      }
    }
  }
  
  /**
   * Update the trailing stop based on current price
   * @param {number} currentPrice - Current market price
   * @returns {Promise<boolean>} True if trailing stop was updated
   */
  async updateTrailingStop(currentPrice) {
    if (this.position.status === 'inactive' || this.position.status === 'closed') {
      return false;
    }
    
    const {
      entryPrice,
      highestPrice,
      trailStartPrice,
      trailHighPrice
    } = this.position;
    
    const {
      initialTargetPct,
      trailTriggerPct,
      trailStepPct,
      maxTrailPct,
      minHoldTimeMs
    } = this.config;
    
    const now = new Date();
    const timeSinceEntry = now - this.position.entryTime;
    
    // Check if we should start trailing
    if (this.position.status === 'active') {
      const targetPrice = entryPrice * (1 + initialTargetPct / 100);
      
      if (currentPrice >= targetPrice && timeSinceEntry >= minHoldTimeMs) {
        // Start trailing
        this.position.status = 'trailing';
        this.position.trailStartPrice = currentPrice;
        this.position.trailStartTime = now;
        this.position.trailHighPrice = currentPrice;
        this.position.trailHighTime = now;
        
        this.logger.info(`🎯 Reached initial target (${initialTargetPct}%): $${currentPrice.toFixed(8)}`);
        this.logger.info('🔄 Starting trailing stop...');
      }
      return false;
    }
    
    // Update trailing stop logic
    if (this.position.status === 'trailing') {
      const isNewHigh = currentPrice > trailHighPrice;
      
      // Update trail high if we have a new high
      if (isNewHigh) {
        this.position.trailHighPrice = currentPrice;
        this.position.trailHighTime = now;
        this.position.consecutiveDownMoves = 0;
      } else {
        this.position.consecutiveDownMoves++;
      }
      
      // Calculate new stop price based on trail step and volatility
      const volatility = this.calculateVolatility();
      const dynamicStep = trailStepPct * (1 + volatility); // Adjust step based on volatility
      
      const newStopPrice = currentPrice * (1 - (dynamicStep / 100));
      
      // Only update if we have a valid new stop price that's better than current
      if (newStopPrice > this.position.currentStopPrice) {
        this.position.currentStopPrice = newStopPrice;
        this.logger.debug(`🔼 Updated trailing stop: $${newStopPrice.toFixed(8)} (${(volatility * 100).toFixed(2)}% vol)`);
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Get current market data (price, volume, etc.)
   * @returns {Promise<Object>} Market data object
   */
  async getMarketData() {
    try {
      // Get current ticker data
      const ticker = await this.makeRateLimitedCall(
        () => this.coinbaseService.getTicker(this.config.productId),
        'getTicker',
        2, // Medium priority
        true // Critical
      );
      
      if (!ticker) {
        throw new Error('No ticker data received');
      }
      
      // Add to price history
      this.priceHistory.push({
        time: new Date(),
        open: parseFloat(ticker.bid) || 0,
        high: parseFloat(ticker.high) || 0,
        low: parseFloat(ticker.low) || 0,
        close: parseFloat(ticker.price) || 0,
        volume: parseFloat(ticker.volume) || 0
      });
      
      // Keep history size manageable
      if (this.priceHistory.length > 100) {
        this.priceHistory.shift();
      }
      
      return {
        currentPrice: parseFloat(ticker.price) || 0,
        currentVolume: parseFloat(ticker.volume) || 0,
        bid: parseFloat(ticker.bid) || 0,
        ask: parseFloat(ticker.ask) || 0,
        timestamp: new Date()
      };
      
    } catch (error) {
      this.logger.error('Error getting market data:', error);
      return null;
    }
  }
  
  /**
   * Update any open orders based on current market conditions
   * @param {number} currentPrice - Current market price
   * @returns {Promise<boolean>} True if orders were updated
   */
  async updateOpenOrders(currentPrice) {
    try {
      // Get current open orders
      const openOrders = await this.makeRateLimitedCall(
        () => this.coinbaseService.getOpenOrders(this.config.productId),
        'getOpenOrders',
        2 // Medium priority
      );
      
      if (!openOrders || openOrders.length === 0) {
        return false;
      }
      
      let ordersUpdated = false;
      
      // Process each open order
      for (const order of openOrders) {
        // Check if order needs to be updated based on current trailing stop
        const shouldUpdate = this.shouldUpdateOrder(order, currentPrice);
        
        if (shouldUpdate) {
          const success = await this.updateOrderPrice(order, currentPrice);
          ordersUpdated = ordersUpdated || success;
        }
      }
      
      return ordersUpdated;
      
    } catch (error) {
      this.logger.error('Error updating open orders:', error);
      return false;
    }
  }
  
  /**
   * Check if an order should be updated based on current price
   * @param {Object} order - The order to check
   * @param {number} currentPrice - Current market price
   * @returns {boolean} True if the order should be updated
   */
  shouldUpdateOrder(order, currentPrice) {
    // Implement order update logic based on current trailing stop settings
    // This is a simplified example - adjust based on your specific needs
    
    if (order.side !== 'sell') {
      return false; // Only update sell orders
    }
    
    const orderPrice = parseFloat(order.price);
    const priceDiff = Math.abs(orderPrice - currentPrice) / currentPrice;
    
    // Update if price difference is significant enough to warrant an update
    return priceDiff > (this.config.minPriceDiffToUpdate / 100);
  }
  
  /**
   * Update an order's price
   * @param {Object} order - The order to update
   * @param {number} currentPrice - Current market price
   * @returns {Promise<boolean>} True if the order was updated successfully
   */
  async updateOrderPrice(order, currentPrice) {
    try {
      const newPrice = this.calculateNewOrderPrice(order, currentPrice);
      
      if (!newPrice || newPrice === parseFloat(order.price)) {
        return false; // No update needed
      }
      
      // Cancel the old order
      await this.makeRateLimitedCall(
        () => this.coinbaseService.cancelOrder(order.id),
        'cancelOrder',
        1, // High priority
        true // Critical
      );
      
      // Create a new order at the updated price
      const newOrder = await this.makeRateLimitedCall(
        () => this.coinbaseService.placeLimitOrder({
          product_id: this.config.productId,
          side: 'sell',
          price: newPrice.toFixed(8),
          size: order.size,
          post_only: this.config.postOnly,
          time_in_force: this.config.timeInForce || 'GTC'
        }),
        'placeLimitOrder',
        1, // High priority
        true // Critical
      );
      
      if (newOrder && newOrder.id) {
        this.logger.info(`🔄 Updated order: ${order.id} -> ${newOrder.id} ($${order.price} -> $${newPrice.toFixed(8)})`);
        return true;
      }
      
      return false;
      
    } catch (error) {
      this.logger.error('Error updating order price:', error);
      return false;
    }
  }
  
  /**
   * Calculate the new price for an order
   * @param {Object} order - The order to update
   * @param {number} currentPrice - Current market price
   * @returns {number|undefined} New price or undefined if no update needed
   */
  calculateNewOrderPrice(order, currentPrice) {
    // Implement your specific price calculation logic here
    // This is a simplified example - adjust based on your strategy
    
    const orderPrice = parseFloat(order.price);
    const priceDiff = currentPrice - orderPrice;
    const pctDiff = (priceDiff / currentPrice) * 100;
    
    // Only update if the price difference is significant
    if (Math.abs(pctDiff) < this.config.minPriceDiffToUpdate) {
      return undefined;
    }
    
    // Calculate new price (e.g., trail by a percentage)
    const newPrice = currentPrice * (1 - (this.config.trailStepPct / 100));
    
    // Ensure we don't set a price below the minimum
    const minPrice = this.position.entryPrice * (1 + (this.config.initialTargetPct / 100));
    return Math.max(newPrice, minPrice);
  }
  
  /**
   * Cancel all open orders
   * @returns {Promise<boolean>} True if all orders were canceled successfully
   */
  async cancelAllOrders() {
    try {
      const orders = await this.makeRateLimitedCall(
        () => this.coinbaseService.getOpenOrders(this.config.productId),
        'getOpenOrders',
        2 // Medium priority
      );
      
      if (!orders || orders.length === 0) {
        return true; // No orders to cancel
      }
      
      let success = true;
      
      for (const order of orders) {
        try {
          await this.makeRateLimitedCall(
            () => this.coinbaseService.cancelOrder(order.id),
            'cancelOrder',
            1, // High priority
            true // Critical
          );
          this.logger.info(`❌ Canceled order: ${order.id}`);
        } catch (error) {
          this.logger.error(`Failed to cancel order ${order.id}:`, error);
          success = false;
        }
      }
      
      return success;
      
    } catch (error) {
      this.logger.error('Error canceling orders:', error);
      return false;
    }
  }

  /**
   * Makes an API call with rate limiting and retry logic
   * @param {Function} apiCall - The API call function to execute
   * @param {string} operationName - Name of the operation for logging
   * @param {number} [priority=1] - Priority level (1-3, 1 being highest)
   * @param {boolean} [isCritical=false] - Whether the operation is critical and should retry on failure
   * @returns {Promise<*>} The result of the API call
   */
  async makeRateLimitedCall(apiCall, operationName, priority = 1, isCritical = false) {
    const { minRequestInterval, maxConsecutiveErrors, baseRetryDelay, maxRetryDelay } = this.rateLimits;
    let attempt = 0;
    const maxAttempts = isCritical ? 3 : 1;

    while (attempt < maxAttempts) {
      try {
        // Check rate limits
        const now = Date.now();
        const timeSinceLastRequest = now - this.rateLimits.lastRequestTime;
        
        // Enforce minimum time between requests based on priority
        const minWaitTime = minRequestInterval * (4 - priority); // Higher priority = shorter wait
        if (timeSinceLastRequest < minWaitTime) {
          const waitTime = minWaitTime - timeSinceLastRequest;
          if (waitTime > 0) {
            this.logger.debug(`[RATE LIMIT] Waiting ${waitTime}ms before ${operationName}`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }

        // Make the API call
        this.rateLimits.lastRequestTime = Date.now();
        const result = await apiCall();
        
        // Reset error counter on success
        this.rateLimits.consecutiveErrors = 0;
        return result;
        
      } catch (error) {
        attempt++;
        this.rateLimits.consecutiveErrors++;
        
        // Handle rate limit errors specifically
        if (error.response && error.response.status === 429) {
          const retryAfter = parseInt(error.response.headers['retry-after'] || '1', 10) * 1000;
          this.logger.warn(`[RATE LIMIT] Rate limited. Retrying after ${retryAfter}ms`);
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          continue;
        }
        
        // For other errors, use exponential backoff
        if (attempt < maxAttempts && isCritical) {
          const delay = Math.min(baseRetryDelay * Math.pow(2, attempt - 1), maxRetryDelay);
          this.logger.warn(`[RETRY] Attempt ${attempt}/${maxAttempts} failed for ${operationName}. Retrying in ${delay}ms:`, error.message);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // If we've exhausted retries, throw the error
        throw error;
      }
    }
  }

  async start() {
    try {
      this.logger.info('🔍 [TRAILING STOP] Checking if already running...');
      if (this.activeTrailingStop) {
        this.logger.warn('⚠️ [TRAILING STOP] Trailing stop already running');
        return false;
      }
      
      // Reset rate limiting state
      this.rateLimits = {
        ...this.rateLimits,
        lastRequestTime: 0,
        remainingRequests: 30,
        resetTime: Date.now() + 60000,
        consecutiveErrors: 0
      };

      this.activeTrailingStop = true;
      this.logger.info('🚀 [TRAILING STOP] Starting trailing stop manager...');
      
      // Verify logger is working
      this.logger.debug('[TRAILING STOP] Debug logging is working');
      
      // Bind the method to maintain 'this' context
      this.logger.debug('[TRAILING STOP] Binding monitorAndUpdateLimitOrders...');
      this.boundMonitorAndUpdate = this.monitorAndUpdateLimitOrders.bind(this);
      
      // Use configured check interval (default 30s from config)
      const checkInterval = this.config.orderCheckIntervalMs || 30000;
      this.logger.info(`🔄 [TRAILING STOP] Starting order monitoring loop (checking every ${checkInterval/1000} seconds)...`);
      
      // Initial check before starting the interval
      this.logger.info('🔍 [TRAILING STOP] Performing initial open orders check...');
      try {
        await this.listAllOpenOrders();
        this.logger.info('✅ [TRAILING STOP] Initial open orders check completed');
      } catch (error) {
        this.logger.error('❌ [TRAILING STOP] Error during initial open orders check:', error);
        throw error; // Re-throw to be caught by outer try-catch
      }
      
      // Start the monitoring interval
      this.logger.debug('[TRAILING STOP] Setting up monitoring interval...');
      this.monitorInterval = setInterval(
        this.boundMonitorAndUpdate,
        checkInterval
      );
      
      // Perform the first monitoring check
      this.logger.debug('[TRAILING STOP] Performing initial order check...');
      try {
        await this.boundMonitorAndUpdate();
        this.logger.debug('[TRAILING STOP] Initial order check completed');
      } catch (error) {
        this.logger.error('❌ [TRAILING STOP] Error during initial order check:', error);
        // Don't throw here, we'll continue with the interval
      }
      
      this.logger.info('✅ [TRAILING STOP] Trailing stop manager started successfully');
      return true;
    } catch (error) {
      this.logger.error('❌ Error in trailing stop manager:', error);
      await this.stopTrailing();
      return false;
    }
  }
  
  /**
   * List all open limit sell orders for the trading pair
   * @returns {Promise<Array>} Array of valid order objects with id, price, and size
   */
  async listAllOpenOrders() {
    try {
      this.logger.info('\n=== [TRAILING STOP] FETCHING OPEN LIMIT SELL ORDERS ===');
      
      const startTime = Date.now();
      const timestamp = new Date().toISOString();
      
      this.logger.debug(`[TRAILING STOP] [${timestamp}] Starting to fetch open limit sell orders...`);
      
      // Log before making the API call
      this.logger.debug(`[TRAILING STOP] Calling coinbaseService.getOpenLimitSellOrders('SYRUP-USDC')`);
      
      // Get all open limit sell orders with rate limiting
      const openOrders = await this.makeRateLimitedCall(
        () => this.coinbaseService.getOpenLimitSellOrders('SYRUP-USDC'),
        'getOpenLimitSellOrders',
        2, // Medium priority
        true // Critical - we need this data
      );
      const fetchDuration = Date.now() - startTime;
      
      // Log the result of the API call
      this.logger.info(`[TRAILING STOP] [${timestamp}] API call completed in ${fetchDuration}ms`);
      this.logger.debug(`[TRAILING STOP] Received ${openOrders.length} orders from API`);
      
      if (openOrders.length === 0) {
        this.logger.warn('[TRAILING STOP] No open limit sell orders found. This could be expected if no orders exist.');
        return [];
      }
      
      // Log order details for debugging
      this.logger.debug('[TRAILING STOP] Raw open limit sell orders from API:', JSON.stringify(openOrders, null, 2));
      
      // Track valid orders for trailing stops
      const validOrders = [];
      
      this.logger.info(`[TRAILING STOP] Processing ${openOrders.length} orders...`);
      
      // Process each order
      for (const [index, order] of openOrders.entries()) {
        const orderLogPrefix = `[TRAILING STOP] [Order ${index + 1}/${openOrders.length}]`;
        
        try {
          // Log detailed order information
          this.logger.debug(`${orderLogPrefix} Processing order:`, {
            id: order.id,
            price: order.price,
            size: order.size,
            side: order.side,
            type: order.type,
            status: order.status,
            product_id: order.product_id
          });
          
          // Validate required fields
          if (!order.id) {
            this.logger.warn(`${orderLogPrefix} Order missing ID field, skipping`);
            continue;
          }
          
          if (!order.price || isNaN(parseFloat(order.price))) {
            this.logger.warn(`${orderLogPrefix} Invalid price (${order.price}), skipping`);
            continue;
          }
          
          if (!order.size || isNaN(parseFloat(order.size))) {
            this.logger.warn(`${orderLogPrefix} Invalid size (${order.size}), skipping`);
            continue;
          }
          
          // Add to valid orders with standardized format
          const validOrder = {
            id: order.id,
            price: parseFloat(order.price),
            size: parseFloat(order.size),
            product_id: order.product_id || 'SYRUP-USDC',
            side: order.side || 'sell',
            type: order.type || 'limit',
            status: order.status || 'open',
            created_at: order.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          
          validOrders.push(validOrder);
          this.logger.debug(`${orderLogPrefix} Successfully processed order ${order.id}`);
          
        } catch (error) {
          this.logger.error(`${orderLogPrefix} Error processing order:`, {
            error: error.message,
            stack: error.stack,
            orderData: JSON.stringify(order, null, 2).substring(0, 500) // Limit log size
          });
          continue;
        }
      }
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      
      // Log detailed summary
      this.logger.info('\n=== [TRAILING STOP] ORDER PROCESSING SUMMARY ===');
      this.logger.info(`Total orders processed: ${openOrders.length}`);
      this.logger.info(`Valid orders found: ${validOrders.length}`);
      this.logger.info(`Total processing time: ${totalDuration}ms`);
      
      // Log each valid order for verification
      if (validOrders.length > 0) {
        this.logger.info('\n=== VALID ORDERS ===');
        validOrders.forEach((order, idx) => {
          this.logger.info(`Order ${idx + 1}:`);
          this.logger.info(`  ID: ${order.id}`);
          this.logger.info(`  Price: ${order.price} ${this.config.quoteCurrency || 'USDC'}`);
          this.logger.info(`  Size: ${order.size} ${this.config.baseCurrency || 'SYRUP'}`);
          this.logger.info(`  Side: ${order.side}, Type: ${order.type}, Status: ${order.status}`);
        });
      } else {
        this.logger.warn('No valid orders found. This could be due to:');
        this.logger.warn('1. No open limit sell orders exist for the trading pair');
        this.logger.warn('2. API authentication issues');
        this.logger.warn('3. Incorrect trading pair specified');
        this.logger.warn('4. Network or API connectivity issues');
      }
      
      this.logger.info('==========================================\n');
      
      return validOrders;
      
    } catch (error) {
      this.logger.error('[TRAILING STOP] Critical error in listAllOpenOrders:', {
        message: error.message,
        stack: error.stack,
        errorDetails: error.response?.data || 'No additional error details'
      });
      return [];
    }
  }

  /**
   * Monitors and updates trailing stop limit orders
   * @private
   */
  async monitorAndUpdateLimitOrders() {
    try {
      // Log start of order monitoring
      this.logger.debug('[TRAILING STOP] Checking for open sell limit orders...');
      
      // Get all open orders with rate limiting
      let openOrders = [];
      try {
        openOrders = await this.makeRateLimitedCall(
          () => this.coinbaseService.getOpenOrders('SYRUP-USDC'),
          'getOpenOrders',
          2, // Medium priority
          false // Not critical, can fail silently
        ) || [];
        if (!Array.isArray(openOrders)) {
          this.logger.error('[TRAILING STOP] getOpenOrders did not return an array:', {
            type: typeof openOrders,
            value: openOrders
          });
          openOrders = [];
        }
      } catch (error) {
        this.logger.error('[TRAILING STOP] Error fetching open orders:', {
          message: error.message,
          stack: error.stack,
          response: error.response?.data
        });
        openOrders = [];
      }
      
      // Log all orders on first run for verification
      if (!this.hasShownInitialOrders) {
        this.logger.info('\n=== [TRAILING STOP] INITIAL ORDER SCAN ===');
        
        if (openOrders.length === 0) {
          this.logger.info('[TRAILING STOP] No open orders found in the account.');
        } else {
          this.logger.info(`[TRAILING STOP] Found ${openOrders.length} total orders in account`);
          
          // Log detailed information about each order
          openOrders.forEach((order, idx) => {
            try {
              this.logger.info(`\n[ORDER ${idx + 1}/${openOrders.length}]`);
              this.logger.info(`ID: ${order.id || 'N/A'}`);
              this.logger.info(`Type: ${order.type || 'N/A'}, Side: ${order.side || 'N/A'}, Status: ${order.status || 'N/A'}`);
              this.logger.info(`Price: ${order.price || 'N/A'} ${this.config.quoteCurrency || 'USDC'}`);
              this.logger.info(`Size: ${order.size || 'N/A'} ${this.config.baseCurrency || 'SYRUP'}`);
              this.logger.info(`Filled: ${order.filled || '0.00'}, Remaining: ${order.remaining || '0.00'}`);
              this.logger.info(`Created: ${order.created_at || 'N/A'}`);
              
              // Log metadata if available
              if (order.metadata) {
                const meta = [];
                if (order.metadata.is_limit) meta.push('LIMIT');
                if (order.metadata.is_market) meta.push('MARKET');
                if (order.metadata.is_gtc) meta.push('GTC');
                if (order.metadata.is_ioc) meta.push('IOC');
                if (order.metadata.is_fok) meta.push('FOK');
                if (meta.length > 0) {
                  this.logger.info(`Flags: ${meta.join(', ')}`);
                }
              }
              
              // Log any other relevant fields
              const ignoredFields = ['id', 'type', 'side', 'status', 'price', 'size', 'filled', 'remaining', 'created_at', 'metadata'];
              const extraFields = Object.entries(order)
                .filter(([key]) => !ignoredFields.includes(key) && !key.includes('_at') && !key.endsWith('_time'))
                .filter(([_, value]) => value !== undefined && value !== null && value !== '');
                
              if (extraFields.length > 0) {
                this.logger.info('Additional fields:', 
                  extraFields.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')
                );
              }
            } catch (error) {
              this.logger.error(`Error logging order ${order?.id || 'unknown'}:`, error);
            }
          });
          
          // Log raw orders for debugging
          this.logger.debug('[TRAILING STOP] Raw orders data:', JSON.stringify(openOrders, null, 2));
          
          // Group orders by type and side for better readability
          const orderGroups = {};
          let validOrders = 0;
          
          openOrders.forEach((order, index) => {
            try {
              if (!order || typeof order !== 'object') {
                this.logger.warn(`[TRAILING STOP] Invalid order at index ${index}:`, order);
                return;
              }
              
              // Extract order details from either root or nested order object for Advanced Trade API
              const orderObj = order.order || order;
              const orderId = orderObj.id || orderObj.order_id;
              
              if (!orderId) {
                this.logger.warn(`[TRAILING STOP] Order at index ${index} has no ID in expected locations:`, order);
                return;
              }
              
              // Extract order configuration for Advanced Trade API
              const orderConfig = orderObj.order_configuration?.limit_limit_gtc || {};
              
              // Determine order type and side
              const type = orderObj.order_type || 'UNKNOWN';
              const side = orderObj.side || 'UNKNOWN';
              const status = orderObj.status || 'UNKNOWN';
              
              // Format the order for consistent internal use
              const formattedOrder = {
                id: orderId,
                order_id: orderId, // Add both id and order_id for compatibility
                type: type,
                side: side,
                status: status,
                price: parseFloat(orderConfig.limit_price || '0'),
                size: parseFloat(orderConfig.base_size || '0'),
                filled: 0, // Will be updated from orderObj.filled_size if available
                remaining: parseFloat(orderConfig.base_size || '0'), // Will be updated if filled_size is available
                created_at: orderObj.created_time || new Date().toISOString(),
                // Include the full order object for reference
                _raw: orderObj
              };
              
              // Update filled and remaining quantities if available
              if (orderObj.filled_size !== undefined) {
                formattedOrder.filled = parseFloat(orderObj.filled_size);
                formattedOrder.remaining = Math.max(0, formattedOrder.size - formattedOrder.filled);
              }
              
              // Group by type and side for display
              const key = `${side}_${type}`;
              if (!orderGroups[key]) {
                orderGroups[key] = [];
              }
              
              orderGroups[key].push(formattedOrder);
              validOrders++;
              
            } catch (error) {
              this.logger.error(`[TRAILING STOP] Error processing order at index ${index}:`, error);
            }
          });
          
          // Log summary by order type
          Object.entries(orderGroups).forEach(([group, orders]) => {
            if (!orders || orders.length === 0) return;
            
            const [side, type] = group.split('_');
            this.logger.info(`\n=== ${side} ${type} ORDERS (${orders.length}) ===`);
            
            orders.forEach((order, idx) => {
              try {
                const status = (order.status || 'UNKNOWN').toUpperCase();
                const price = order.price ? parseFloat(order.price).toFixed(4) : 'N/A';
                const size = order.size ? parseFloat(order.size).toFixed(2) : 'N/A';
                const filled = order.filled || order.filled_size ? 
                  parseFloat(order.filled || order.filled_size).toFixed(2) : '0.00';
                const remaining = order.remaining || order.size ? 
                  (parseFloat(order.remaining || order.size) - parseFloat(filled || '0')).toFixed(2) : '0.00';
                const created = order.created_at || order.created_time || 'N/A';
                
                this.logger.info(`\nOrder ${idx + 1}: ${order.id}`);
                this.logger.info(`Type: ${type}, Side: ${side}, Status: ${status}`);
                this.logger.info(`Price: ${price} ${this.config.quoteCurrency || 'USDC'}`);
                this.logger.info(`Size: ${size} ${this.config.baseCurrency || 'SYRUP'}`);
                this.logger.info(`Filled: ${filled}, Remaining: ${remaining}`);
                this.logger.info(`Created: ${created}`);
                
                // Log additional metadata if available
                if (order.metadata) {
                  const meta = [];
                  if (order.metadata.is_limit) meta.push('LIMIT');
                  if (order.metadata.is_market) meta.push('MARKET');
                  if (order.metadata.is_gtc) meta.push('GTC');
                  if (order.metadata.is_ioc) meta.push('IOC');
                  if (order.metadata.is_fok) meta.push('FOK');
                  
                  if (meta.length > 0) {
                    this.logger.info(`Flags: ${meta.join(', ')}`);
                  }
                }
                
                // Log any other relevant fields
                const ignoredFields = ['id', 'type', 'side', 'status', 'price', 'size', 'filled', 'remaining', 'created_at', 'metadata'];
                const extraFields = Object.entries(order)
                  .filter(([key]) => !ignoredFields.includes(key) && !key.includes('_at') && !key.endsWith('_time'))
                  .filter(([_, value]) => value !== undefined && value !== null && value !== '');
                  
                if (extraFields.length > 0) {
                  this.logger.info('Additional fields:', 
                    extraFields.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')
                  );
                }
                
              } catch (error) {
                this.logger.error(`[TRAILING STOP] Error displaying order ${order?.id || 'unknown'}:`, error);
              }
            });
          });
          
          this.logger.info(`\n[VALIDATION] Found ${validOrders} valid orders (${openOrders.length - validOrders} invalid/ignored)`);
        }
        
        this.logger.info('=== [TRAILING STOP] END INITIAL SCAN ===\n');
        this.hasShownInitialOrders = true;
      }
      
      // Filter for active sell limit orders
      this.logger.info('\n=== [TRAILING STOP] FILTERING FOR ACTIVE SELL LIMIT ORDERS ===');
            
      const sellLimitOrders = openOrders.filter(order => {
        // Handle both direct and nested order objects
        const orderObj = order.order || order;
        const orderId = orderObj.order_id || orderObj.id || 'unknown';
        
        // Extract order configuration for limit orders
        const orderConfig = orderObj.order_configuration?.limit_limit_gtc || {};
        const orderType = (orderObj.order_type || orderObj.type || '').toUpperCase();
        const orderSide = (orderObj.side || '').toUpperCase();
        const orderStatus = (orderObj.status || '').toUpperCase();
        
        // Extract size and filled amount
        const size = parseFloat(orderConfig.base_size || orderObj.size || '0');
        const filled = parseFloat(orderObj.filled_size || orderObj.filled || '0');
        const remaining = size - filled;
        const limitPrice = parseFloat(orderConfig.limit_price || orderObj.limit_price || '0');
        
        // Log order details for debugging
        this.logger.info(`\n[FILTERING] Order ${orderId}:`);
        this.logger.info(`- Type: ${orderType} (${JSON.stringify(orderConfig)})`);
        this.logger.info(`- Side: ${orderSide}`);
        this.logger.info(`- Status: ${orderStatus}`);
        this.logger.info(`- Limit Price: ${limitPrice}`);
        this.logger.info(`- Size: ${size}`);
        this.logger.info(`- Filled: ${filled}`);
        this.logger.info(`- Remaining: ${remaining}`);
        
        // Skip if order is not a sell order
        if (orderSide !== 'SELL') {
          this.logger.info(`[FILTERING] Skipping - Not a sell order (side: ${orderSide})`);
          return false;
        }
        
        // Check if it's a limit order
        const isLimitOrder = 
          orderType === 'LIMIT' || 
          (orderConfig.limit_price !== undefined) ||
          (orderObj.order_configuration?.limit_limit_gtc !== undefined);
          
        if (!isLimitOrder) {
          this.logger.info(`[FILTERING] Skipping - Not a limit order (type: ${orderType})`);
          return false;
        }
        
        // Check if order is active
        const activeStatuses = ['OPEN', 'PENDING', 'ACTIVE', 'LIVE', 'NEW', 'ACCEPTED'];
        const isActive = activeStatuses.includes(orderStatus);
        
        if (!isActive) {
          this.logger.info(`[FILTERING] Skipping - Inactive status: ${orderStatus}`);
          return false;
        }
        
        if (isNaN(remaining) || remaining <= 0) {
          this.logger.info(`[FILTERING] Skipping - Invalid or no remaining quantity (size: ${size}, filled: ${filled}, remaining: ${remaining})`);
          return false;
        }
        
        // Add the extracted values to the order object for later use
        orderObj._extracted = {
          size,
          filled,
          remaining,
          limitPrice,
          isLimitOrder: true
        };
        
        this.logger.info(`[FILTERING] ✅ Valid active sell limit order found`);
        return true;
      });
      
      // If we have an active order but it's not in the list of sell limit orders, clear tracking state
      if (this.activeOrderId) {
        const activeOrderStillExists = sellLimitOrders.some(order => {
          const orderObj = order.order || order;
          const orderId = orderObj.order_id || orderObj.id;
          return orderId === this.activeOrderId;
        });
        
        if (!activeOrderStillExists) {
          this.logger.warn(`Tracked order ${this.activeOrderId} not found in open orders list. Will verify status directly...`);
          
          // Add direct order verification before clearing state
          this.makeRateLimitedCall(
            () => this.coinbaseService.getOrder(this.activeOrderId),
            'getOrder',
            2, // Medium priority
            false // Not critical
          ).then(orderDetails => {
            if (!orderDetails) {
              this.logger.warn(`Order ${this.activeOrderId} not found after direct verification. It may have been filled or canceled.`);
              this.clearOrderState();
            } else {
              const status = (orderDetails.status || '').toUpperCase();
              if (['FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'DONE'].includes(status)) {
                this.logger.info(`Order ${this.activeOrderId} has status: ${status}. Clearing tracking state.`);
                this.clearOrderState();
              } else {
                this.logger.info(`Order ${this.activeOrderId} is still active (status: ${status}). Keeping tracking state.`);
                // The order is still active but wasn't in our list - could be pagination or API issue
              }
            }
          }).catch(error => {
            // Log the full error object for complete debugging
            this.logger.error(`Error verifying order ${this.activeOrderId} status:`, {
              message: error.message || 'Unknown error',
              code: error.code || 'No code',
              statusCode: error.statusCode || 'No status code',
              name: error.name || 'No name',
              stack: error.stack ? error.stack.split('\n').slice(0, 3).join('\n') : 'No stack trace',
              errorType: typeof error,
              errorJson: JSON.stringify(error, Object.getOwnPropertyNames(error), 2).substring(0, 500),
              timestamp: new Date().toISOString()
            });
            
            // Also log the raw error for complete visibility
            console.error('Raw verification error:', error);
            
            // Don't clear state on error - we'll try again next time
          });
        } else {
          this.logger.debug(`Tracked order ${this.activeOrderId} is still active`);
        }
      }
      this.logger.info(`\n=== [TRAILING STOP] ACTIVE SELL LIMIT ORDERS ===`);
      this.logger.info(`Found ${sellLimitOrders.length} active sell limit orders`);
      
      // Log details of each active sell limit order
      sellLimitOrders.forEach((order, idx) => {
        // Handle both direct and nested order objects
        const orderObj = order.order || order;
        const orderId = orderObj.order_id || orderObj.id || 'unknown';
        
        // Extract order configuration for limit orders
        const orderConfig = orderObj.order_configuration?.limit_limit_gtc || {};
        
        // Extract size and filled amount
        const size = parseFloat(orderConfig.base_size || orderObj.size || '0');
        const filled = parseFloat(orderObj.filled_size || orderObj.filled || '0');
        const remaining = size - filled;
        const limitPrice = parseFloat(orderConfig.limit_price || orderObj.limit_price || '0');
        const orderType = orderObj.order_type || orderObj.type || 'N/A';
        const orderStatus = orderObj.status || 'N/A';
        const createdAt = orderObj.created_time || orderObj.created_at || 'N/A';
        
        this.logger.info(`\n[ACTIVE ORDER ${idx + 1}/${sellLimitOrders.length}]`);
        this.logger.info(`ID: ${orderId}`);
        this.logger.info(`Type: ${orderType}, Status: ${orderStatus}`);
        this.logger.info(`Price: ${limitPrice.toFixed(4)} ${this.config.quoteCurrency || 'USDC'}`);
        this.logger.info(`Size: ${size.toFixed(2)} ${this.config.baseCurrency || 'SYRUP'}`);
        this.logger.info(`Filled: ${filled.toFixed(2)}, Remaining: ${remaining.toFixed(2)}`);
        this.logger.info(`Created: ${createdAt}`);
        
        // Log if this is the currently tracked order
        if (this.activeOrderId === orderId) {
          this.logger.info('🔵 CURRENTLY TRACKED BY TRAILING STOP');
        }
      });
      
      if (sellLimitOrders.length === 0) {
        this.logger.info('No active sell limit orders found.');
      }
      
      // Process each sell limit order
      for (const order of sellLimitOrders) {
        try {
          // Handle both direct and nested order objects
          const orderObj = order.order || order;
          const orderId = orderObj.order_id || orderObj.id;
          
          if (!orderId) {
            this.logger.warn('Skipping order with no ID:', order);
            continue;
          }
          
          // Extract order configuration for limit orders
          const orderConfig = orderObj.order_configuration?.limit_limit_gtc || {};
          
          // Extract size and filled amount
          const orderSize = parseFloat(orderConfig.base_size || orderObj.size || '0');
          const filledSize = parseFloat(orderObj.filled_size || orderObj.filled || '0');
          const remainingSize = orderSize - filledSize;
          const orderPrice = parseFloat(orderConfig.limit_price || orderObj.limit_price || '0');
          
          // Skip if order is already being tracked
          if (this.activeOrderId === orderId) {
            this.logger.debug(`Order ${orderId} is already being tracked`);
            continue;
          }
          
          // Track this order
          this.activeOrderId = orderId;
          this.initialLimitPrice = orderPrice;
          this.currentLimitPrice = orderPrice;
          this.positionSize = remainingSize;
          this.entryPrice = 0; // Will be updated from position data
          this.consecutiveTrails = 0;
          this.lastTrailTime = Date.now();
          
          this.logger.info(`Tracking new limit sell order ${orderId}:`, {
            price: orderPrice,
            size: orderSize,
            filled: filledSize,
            remaining: remainingSize,
            timeInForce: orderObj.time_in_force || 'GTC'
          });
          
          // Only track one order at a time
          break;
          
        } catch (error) {
          this.logger.error('Error processing sell limit order:', {
            error: error.message,
            orderId: order?.id,
            stack: error.stack
          });
        }
      }
      
      // If we have an active order, check if we should update it
      if (this.activeOrderId) {
        try {
          // Find our tracked order in the list of active orders
          const trackedOrder = sellLimitOrders.find(o => o.id === this.activeOrderId);
          
          // If order is not found, don't immediately clear state - it might be a temporary API issue
          if (!trackedOrder) {
            // Only log a warning and keep the state for now
            // We'll verify the order status directly in the next check
            this.logger.warn(`Tracked order ${this.activeOrderId} not found in open orders list. Will verify status directly...`);
            
            try {
              // Try to get the order directly to verify its status
              const orderDetails = await this.makeRateLimitedCall(
                () => this.coinbaseService.getOrder(this.activeOrderId),
                'getOrder',
                2, // Medium priority
                false // Not critical
              );
              
              if (!orderDetails) {
                this.logger.warn(`Order ${this.activeOrderId} not found. It may have been filled or canceled.`);
                this.clearOrderState();
              } else {
                const status = (orderDetails.status || '').toUpperCase();
                if (['FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'DONE'].includes(status)) {
                  this.logger.info(`Order ${this.activeOrderId} has status: ${status}. Clearing tracking state.`);
                  this.clearOrderState();
                } else {
                  this.logger.info(`Order ${this.activeOrderId} is still active (status: ${status}). Keeping tracking state.`);
                  // Update our local state with the latest order details
                  this.updateOrderFromApiResponse(orderDetails);
                }
              }
            } catch (error) {
              this.logger.error(`Error verifying order ${this.activeOrderId} status:`, error.message);
              // Don't clear state on error - we'll try again next time
            }
            return;
          }
        } catch (error) {
          this.logger.error('Error checking tracked order status:', error);
        }
      }
    } catch (error) {
      this.logger.error('Error in monitorAndUpdateLimitOrders:', error);
    }
  }

  /**
   * Checks and updates the trailing stop for the active order
   * @returns {Promise<boolean>} True if the order was updated, false otherwise
   */
  async checkAndUpdateTrailingStop() {
    this.logger.info('\n=== [TRAILING STOP] CHECKING FOR UPDATES ===');
    
    if (!this.activeOrderId) {
      this.logger.warn('No active order ID set. Checking for open orders...');
      
      // Try to find an active order if we don't have one
      const openOrders = await this.listAllOpenOrders();
      const sellLimitOrders = openOrders.filter(o => o.side === 'sell' && o.type === 'limit');
      
      if (sellLimitOrders.length > 0) {
        const order = sellLimitOrders[0];
        this.activeOrderId = order.id;
        this.currentLimitPrice = parseFloat(order.price);
        this.positionSize = parseFloat(order.size);
        this.logger.info(`Found active sell limit order: ${order.id} @ ${order.price}`);
      } else {
        this.logger.warn('No active sell limit orders found');
        return false;
      }
    }

    try {
      // Get current market price with rate limiting
      this.logger.debug('Fetching current market price...');
      const ticker = await this.makeRateLimitedCall(
        () => this.coinbaseService.getTicker('SYRUP-USDC'),
        'getTicker',
        2, // Medium priority for price checks
        true // Critical - we need this data
      );
      
      if (!ticker || isNaN(parseFloat(ticker?.price))) {
        this.logger.error('❌ Invalid market price received');
        return false;
      }
      
      const marketPrice = parseFloat(ticker.price);
      this.logger.info(`📈 Current Market Price: ${marketPrice.toFixed(4)}`);
      
      // Update price history for indicators
      this.priceHistory.push(marketPrice);
      if (this.priceHistory.length > this.config.priceHistoryLength) {
        this.priceHistory.shift();
      }
      
      // Ensure we have enough data points before updating indicators
      const minDataPoints = 20; // Minimum required for most indicators
      if (this.priceHistory.length < minDataPoints) {
        this.logger.warn(`Not enough price history (${this.priceHistory.length}/${minDataPoints}) for indicators. Need more data...`);
        return false;
      }
      
      // Update indicators with latest market data
      this.logger.debug('Updating technical indicators...');
      const indicatorsUpdated = await this.updateIndicators();
      
      if (!indicatorsUpdated) {
        this.logger.warn('Failed to update indicators. Skipping this cycle.');
        return false;
      }
      
      // Calculate momentum score and details
      this.logger.debug('Calculating momentum score...');
      const momentumScore = await this.calculateMomentumScore();
      const scoreDetails = this.getMomentumScoreDetails ? await this.getMomentumScoreDetails() : {};
      
      // Log indicator values for debugging
      this.logger.info('📊 INDICATOR VALUES', {
        rsi: this.indicators.rsi?.toFixed(2) || 'N/A',
        macd: this.indicators.macd ? {
          histogram: this.indicators.macd.histogram?.toFixed(4) || 'N/A',
          signal: this.indicators.macd.signal?.toFixed(4) || 'N/A',
          value: this.indicators.macd.value?.toFixed(4) || 'N/A'
        } : 'N/A',
        bollingerBands: this.indicators.bollingerBands ? {
          upper: this.indicators.bollingerBands.upper?.toFixed(4) || 'N/A',
          middle: this.indicators.bollingerBands.middle?.toFixed(4) || 'N/A',
          lower: this.indicators.bollingerBands.lower?.toFixed(4) || 'N/A',
          bandwidth: this.indicators.bollingerBands.bandwidth?.toFixed(2) + '%' || 'N/A'
        } : 'N/A',
        momentumScore: (momentumScore * 100).toFixed(1) + '%',
        momentumThreshold: (this.config.momentumThreshold * 100).toFixed(1) + '%'
      });
      
      // Log detailed order info
      try {
        // Get order details with rate limiting and enhanced error handling
        this.logger.debug('Fetching current order details...');
        const order = await this.makeRateLimitedCall(
          () => this.coinbaseService.getOrder(this.activeOrderId),
          'getOrder',
          2, // Medium priority
          false // Not critical - we can continue without this data
        );
        
        if (order) {
          // Handle both direct and nested order objects
          const orderObj = order.order || order;
          const filled = orderObj.filled_size || orderObj.filled || '0';
          const size = orderObj.size || (orderObj.order_configuration?.limit_limit_gtc?.base_size) || '0';
          const filledPct = size > 0 ? (parseFloat(filled) / parseFloat(size)) * 100 : 0;
          
          this.logger.info('📊 ORDER STATUS', {
            orderId: this.activeOrderId,
            status: (orderObj.status || 'UNKNOWN').toUpperCase(),
            price: parseFloat(orderObj.price || orderObj.limit_price || '0').toFixed(4),
            size: parseFloat(size).toFixed(2),
            filled: parseFloat(filled).toFixed(2),
            filledPct: `${filledPct.toFixed(1)}%`,
            created: orderObj.created_time || orderObj.created_at || 'N/A'
          });
          
          // Update current limit price from the order if different
          const orderConfig = orderObj.order_configuration?.limit_limit_gtc || {};
          const orderPrice = parseFloat(orderConfig.limit_price || orderObj.price || orderObj.limit_price || '0');
          if (orderPrice && orderPrice !== this.currentLimitPrice) {
            this.logger.info(`Updating current limit price from ${this.currentLimitPrice} to ${orderPrice}`);
            this.currentLimitPrice = orderPrice;
          }
        } else {
          this.logger.warn('Received empty response when fetching order details');
        }
      } catch (error) {
        // Handle rate limiting specifically
        if (error.message?.includes('rate limit') || error.status === 429) {
          this.logger.warn('Rate limited when fetching order details. Will retry on next check.');
        } else {
          this.logger.error('Error fetching order details:', error.message);
        }
        // Continue with existing values if we can't fetch the latest
      }
      
      // Log current status and indicators
      this.logStatus(marketPrice, {
        momentumScore,
        scoreDetails,
        currentLimitPrice: this.currentLimitPrice,
        priceDifference: marketPrice - this.currentLimitPrice,
        priceDifferencePct: ((marketPrice / this.currentLimitPrice) - 1) * 100
      });
      
      // Log indicator details
      this.logger.info('📊 INDICATORS', {
        rsi: this.indicators.rsi ? this.indicators.rsi.toFixed(2) : 'N/A',
        macd: this.indicators.macd ? {
          histogram: this.indicators.macd.histogram?.toFixed(4) || 'N/A',
          signal: this.indicators.macd.signal?.toFixed(4) || 'N/A',
          value: this.indicators.macd.value?.toFixed(4) || 'N/A'
        } : 'N/A',
        bollingerBands: this.indicators.bollingerBands ? {
          upper: this.indicators.bollingerBands.upper?.toFixed(4) || 'N/A',
          middle: this.indicators.bollingerBands.middle?.toFixed(4) || 'N/A',
          lower: this.indicators.bollingerBands.lower?.toFixed(4) || 'N/A',
          bandwidth: this.indicators.bollingerBands.bandwidth?.toFixed(2) + '%' || 'N/A'
        } : 'N/A',
        momentumScore: (momentumScore * 100).toFixed(1) + '%',
        momentumThreshold: (this.config.momentumThreshold * 100).toFixed(1) + '%',
        minProfitPercent: this.config.minProfitPercent + '%',
        trailingStepPct: this.config.trailingStepPct * 100 + '%'
      });
      
      // Log trailing stop analysis
      this.logger.debug('📊 Trailing Stop Analysis', {
        marketPrice: marketPrice.toFixed(6),
        momentumScore: (momentumScore * 100).toFixed(2) + '%',
        momentumThreshold: (this.config.momentumThreshold * 100).toFixed(2) + '%',
        shouldTrail: false, // Will be determined next
        indicators: {
          rsi: this.indicators.rsi?.toFixed(2) || 'N/A',
          macdHistogram: this.indicators.macd?.histogram?.toFixed(6) || 'N/A',
          bbPercentB: this.indicators.bollingerBands?.percentB?.toFixed(4) || 'N/A'
        }
      });
      
      // Check if we should trail the stop using marketPrice
      const shouldTrail = await this.shouldTrail(marketPrice);
      this.logger.debug(`Trailing decision: ${shouldTrail ? 'YES' : 'NO'}`);
      
      if (shouldTrail) {
        await this.updateLimitOrder(marketPrice);
      }
      
      // Log status periodically (every minute)
      const now = Date.now();
      if (now - (this.lastLogTime || 0) > 60000) {
        this.logStatus(marketPrice);
        this.lastLogTime = now;
      }
      
      return shouldTrail;
      
    } catch (error) {
      this.logger.error('Error in trailing stop check:', error);
      return false;
    }
  }
  
  /**
   * Update technical indicators with current price history
   * @private
   */
  async updateIndicators() {
    const minDataPoints = 20; // Minimum data points needed for most indicators
    
    if (!this.priceHistory || this.priceHistory.length < minDataPoints) {
      this.logger.warn(`Not enough price history to update indicators. Have ${this.priceHistory?.length || 0}, need at least ${minDataPoints}`);
      return false;
    }

    try {
      this.logger.debug(`Updating indicators with ${this.priceHistory.length} price points...`);
      
      // Log sample of price history for debugging
      const sampleSize = Math.min(5, this.priceHistory.length);
      const sample = this.priceHistory.slice(-sampleSize);
      this.logger.debug(`Price history sample (last ${sampleSize} points):`, sample);
      
      // Calculate MACD
      this.indicators.macd = TechnicalIndicators.calculateMACD(this.priceHistory);
      this.logger.debug('MACD calculated:', {
        histogram: this.indicators.macd?.histogram?.toFixed(4),
        signal: this.indicators.macd?.signal?.toFixed(4),
        value: this.indicators.macd?.value?.toFixed(4)
      });
      
      // Calculate RSI
      this.indicators.rsi = TechnicalIndicators.calculateRSI(this.priceHistory);
      this.logger.debug(`RSI: ${this.indicators.rsi?.toFixed(2) || 'N/A'}`);
      
      // Calculate Bollinger Bands
      this.indicators.bollingerBands = TechnicalIndicators.calculateBollingerBands(this.priceHistory);
      if (this.indicators.bollingerBands) {
        this.logger.debug('Bollinger Bands:', {
          upper: this.indicators.bollingerBands.upper?.toFixed(4),
          middle: this.indicators.bollingerBands.middle?.toFixed(4),
          lower: this.indicators.bollingerBands.lower?.toFixed(4),
          bandwidth: this.indicators.bollingerBands.bandwidth?.toFixed(2) + '%'
        });
      }
      
      this.logger.info('✅ Indicators updated successfully');
      return true;
      
    } catch (error) {
      this.logger.error(`❌ Error updating indicators: ${error.message}`, {
        error: error.stack,
        priceHistoryLength: this.priceHistory?.length,
        priceHistorySample: this.priceHistory?.slice(-5)
      });
      return false;
    }
  }

  /**
   * Calculate the momentum score based on technical indicators
   * @returns {Promise<number>} Momentum score between 0 and 1
   */
  async calculateMomentumScore() {
    if (!this.indicators.macd || !this.indicators.rsi || !this.indicators.bollingerBands) {
      this.logger.debug('[TRAILING STOP] Missing required indicators for momentum calculation');
      return 0;
    }
    
    let score = 0;
    const indicators = this.indicators;
    const scoreBreakdown = {};
    
    try {
      // MACD components (0-35 points)
      if (indicators.macd.histogram > 0) {
        // More sensitive to positive histogram values
        const macdStrength = Math.min(1, indicators.macd.histogram * 200); // Increased sensitivity
        const macdPoints = 15 + (10 * macdStrength); // More weight on histogram
        score += macdPoints;
        scoreBreakdown.macdHistogram = macdPoints.toFixed(2);
      }
      
      if (indicators.macd.trend === 'up') {
        score += 15; // Increased from 10
        scoreBreakdown.macdTrend = 15;
      }
      
      if (indicators.macd.bullishCross) {
        score += 5;
        scoreBreakdown.macdCross = 5;
      }
      
      // RSI components (0-40 points) - More weight on RSI
      if (indicators.rsi > 50) {  // Changed from indicators.rsi.value to indicators.rsi
        // More aggressive scaling - reaches max at 70 RSI instead of 80
        const rsiScore = Math.min(40, (indicators.rsi - 50) * 2);
        score += rsiScore;
        scoreBreakdown.rsi = rsiScore.toFixed(2);
      }
      
      // Bollinger Bands (0-25 points) - More weight on price position
      if (indicators.bollingerBands.upper && this.priceHistory.length > 0) {
        const currentPrice = this.priceHistory[this.priceHistory.length - 1];
        const upperBand = indicators.bollingerBands.upper;
        const lowerBand = indicators.bollingerBands.lower;
        
        // Calculate how close price is to upper band (0-1)
        const distanceToUpper = (currentPrice - lowerBand) / (upperBand - lowerBand);
        
        // More points the closer price is to upper band
        const bbScore = Math.min(25, distanceToUpper * 30); // Up to 25 points
        score += bbScore;
        scoreBreakdown.bbPosition = bbScore.toFixed(2);
        
        // Additional points if price is above middle band
        if (currentPrice > indicators.bollingerBands.middle) {
          score += 5;
          scoreBreakdown.bbAboveMiddle = 5;
        }
      }
      
      // Volume spike (0-20 points) - Keep existing logic but add to breakdown
      if (indicators.volumeSpike && indicators.volumeSpike.withPriceIncrease) {
        const volumePoints = indicators.volumeSpike.intensity === 'high' ? 20 : 
                          indicators.volumeSpike.intensity === 'medium' ? 15 : 8;
        score += volumePoints;
        scoreBreakdown.volumeSpike = volumePoints;
      }
      
      // Log detailed score breakdown for debugging
      this.logger.debug('[TRAILING STOP] Momentum score breakdown:', {
        totalScore: score,
        normalizedScore: (score / 100).toFixed(4),
        ...scoreBreakdown,
        indicators: {
          rsi: indicators.rsi?.toFixed(2),
          macdHistogram: indicators.macd?.histogram?.toFixed(6),
          macdSignal: indicators.macd?.signal?.toFixed(6),
          macdValue: indicators.macd?.value?.toFixed(6),
          bbUpper: indicators.bollingerBands?.upper?.toFixed(6),
          bbMiddle: indicators.bollingerBands?.middle?.toFixed(6),
          bbLower: indicators.bollingerBands?.lower?.toFixed(6)
        }
      });
      
    } catch (error) {
      this.logger.error('[TRAILING STOP] Error calculating momentum score:', error);
      return 0;
    }
    
    // Recent highs (0-10 points)
    if (indicators.recentHighs && indicators.recentHighs.newHigh) {
      score += 5;
      // More weight for consecutive highs
      score += Math.min(indicators.recentHighs.consecutiveHighs * 3, 5);
    }
    
    // Add some randomness to prevent exact scores (0-2 points)
    const randomFactor = Math.random() * 2;
    score += randomFactor;
    
    // Normalize to 0-1 range and ensure it doesn't exceed 1
    return Math.min(1, Math.max(0, score / 100));
  }
  
  async shouldTrail(currentPrice) {
    try {
      // Check if we have an active order to trail
      if (!this.activeOrderId) {
        this.logger.debug('[TRAILING STOP] No active order to trail');
        return false;
      }
      
      // Check cooldown period (default 30 seconds if not set)
      const cooldownMs = this.config.cooldownPeriodMs || 30000;
      const timeSinceLastTrail = Date.now() - this.lastTrailTime;
      if (timeSinceLastTrail < cooldownMs) {
        const remainingCooldown = Math.ceil((cooldownMs - timeSinceLastTrail) / 1000);
        this.logger.debug(`[TRAILING STOP] Cooldown active: ${remainingCooldown}s remaining`);
        return false;
      }
      
      // Check max consecutive trails
      if (this.consecutiveTrails >= this.config.maxConsecutiveTrails) {
        this.logger.warn(`[TRAILING STOP] Max consecutive trails reached (${this.consecutiveTrails}/${this.config.maxConsecutiveTrails}), waiting for cooldown`);
        return false;
      }
      
      // Check if price is above current limit (already moved in our favor)
      if (currentPrice <= this.currentLimitPrice) {
        this.logger.debug(`[TRAILING STOP] Current price ${currentPrice} not above current limit ${this.currentLimitPrice}`);
        return false;
      }
      
      // Ensure we have valid indicators
      if (!this.indicators || !this.indicators.rsi || !this.indicators.macd || !this.indicators.bollingerBands) {
        this.logger.warn('[TRAILING STOP] Missing indicator data, cannot calculate momentum score');
        return false;
      }
      
      // Calculate momentum score
      const momentumScore = await this.calculateMomentumScore();
      
      // Log detailed momentum analysis
      this.logger.info('[TRAILING STOP] Momentum Analysis:', {
        currentPrice: currentPrice.toFixed(8),
        currentLimit: this.currentLimitPrice.toFixed(8),
        momentumScore: momentumScore.toFixed(4),
        momentumThreshold: this.config.momentumThreshold,
        rsi: this.indicators.rsi?.toFixed(2) || 'N/A',
        macdHistogram: this.indicators.macd?.histogram?.toFixed(6) || 'N/A',
        macdSignal: this.indicators.macd?.signal?.toFixed(6) || 'N/A',
        bbUpper: this.indicators.bollingerBands?.upper?.toFixed(6) || 'N/A',
        bbLower: this.indicators.bollingerBands?.lower?.toFixed(6) || 'N/A',
        priceAboveBBUpper: currentPrice > (this.indicators.bollingerBands?.upper || 0) ? 'YES' : 'NO'
      });
      
      // Check if momentum is strong enough
      if (momentumScore < this.config.momentumThreshold) {
        this.logger.debug(`[TRAILING STOP] Insufficient momentum for trailing: ${momentumScore.toFixed(4)} < ${this.config.momentumThreshold}`);
        return false;
      }
      
      // Calculate potential new limit price
      const potentialNewLimit = currentPrice * (1 - this.config.trailingStepPct);
      
      // Ensure we maintain minimum profit
      const minLimitPrice = this.entryPrice * (1 + (this.config.minProfitPercent / 100));
      if (potentialNewLimit < minLimitPrice) {
        this.logger.debug(`New limit ${potentialNewLimit.toFixed(4)} would be below minimum profit limit ${minLimitPrice.toFixed(4)}`);
        return false;
      }
      
      // Check max limit multiplier
      const maxLimitPrice = this.entryPrice * this.config.maxLimitMultiplier;
      if (potentialNewLimit > maxLimitPrice) {
        this.logger.info(`New limit ${potentialNewLimit.toFixed(4)} exceeds max limit price ${maxLimitPrice.toFixed(4)}`);
        return false;
      }
      
      // Calculate minimum price increment (default 0.1% of current price, configurable)
      const minIncrementPct = this.config.minIncrementPct || 0.001;
      let minIncrement = currentPrice * minIncrementPct;
      
      // Adjust increment based on volatility (wider stops in volatile markets)
      if (this.indicators.bollingerBands) {
        const bbWidth = this.indicators.bollingerBands.upper - this.indicators.bollingerBands.lower;
        const bbWidthPct = bbWidth / this.indicators.bollingerBands.middle;
        
        // Increase minimum increment by up to 2x in high volatility
        const volatilityMultiplier = 1 + Math.min(1, bbWidthPct * 10);
        minIncrement *= volatilityMultiplier;
        
        this.logger.debug(`Volatility adjustment: BB width ${(bbWidthPct * 100).toFixed(2)}% -> ${volatilityMultiplier.toFixed(2)}x increment`);
      }
      
      // Ensure the price movement is significant enough to warrant an update
      const priceDifference = potentialNewLimit - this.currentLimitPrice;
      if (priceDifference < minIncrement) {
        this.logger.debug(`Price change too small to update (${priceDifference.toFixed(8)} < ${minIncrement.toFixed(8)})`);
        return false;
      }
      
      this.logger.debug(`Trailing conditions met: price=${currentPrice.toFixed(4)}, ` +
                       `currentLimit=${this.currentLimitPrice.toFixed(4)}, ` +
                       `newLimit=${potentialNewLimit.toFixed(4)}`);
      
      return true;
      
    } catch (error) {
      this.logger.error('Error in shouldTrail:', error);
      return false;
    }
  }
  
  async updateLimitOrder(currentPrice) {
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        // Calculate new limit price with trailing step
        let newLimitPrice = currentPrice * (1 - this.config.trailingStepPct);
        
        // Round to appropriate decimal places (4 for most crypto pairs)
        newLimitPrice = parseFloat(newLimitPrice.toFixed(8));
        
        // Only update if the new limit is higher than current by at least 0.1%
        const minPriceIncrement = this.currentLimitPrice * 0.001;
        if (newLimitPrice - this.currentLimitPrice < minPriceIncrement) {
          this.logger.debug(`Price change too small to update (${(newLimitPrice - this.currentLimitPrice).toFixed(8)} < ${minPriceIncrement.toFixed(8)})`);
          return false;
        }
        
        // Store the old order ID before attempting to cancel
        const oldOrderId = this.activeOrderId;
        
        // Cancel existing order if any
        if (oldOrderId) {
          this.logger.info(`🔄 Cancelling existing order ${oldOrderId} to update price from ${this.currentLimitPrice} to ${newLimitPrice}`);
          const cancelSuccess = await this.cancelCurrentOrder();
          
          if (!cancelSuccess) {
            // If cancellation fails, verify if the order still exists
            try {
              const orderStatus = await this.makeRateLimitedCall(
                () => this.coinbaseService.getOrder(oldOrderId),
                'getOrder',
                1,
                false
              );
              
              if (orderStatus && orderStatus.status === 'open') {
                throw new Error(`Failed to cancel order ${oldOrderId} and it's still open`);
              } else {
                // Order was already filled or doesn't exist
                this.logger.info(`Order ${oldOrderId} was already filled or doesn't exist, proceeding with new order`);
                this.activeOrderId = null; // Clear the order ID
              }
            } catch (error) {
              this.logger.error(`Error verifying order ${oldOrderId} status:`, error);
              throw new Error(`Failed to verify order status: ${error.message}`);
            }
          } else {
            this.logger.info(`✅ Successfully cancelled order ${oldOrderId}`);
          }
        }
        
        // Ensure position size is valid
        if (this.positionSize <= 0) {
          throw new Error(`Invalid position size: ${this.positionSize}`);
        }
        
        // Format size according to market requirements (1 decimal for SYRUP)
        const formattedSize = parseFloat(this.positionSize.toFixed(1));
        
        // Place new limit order with rate limiting
        const orderParams = {
          product_id: 'SYRUP-USDC',
          side: 'sell',
          type: 'limit',
          price: newLimitPrice.toFixed(8), // Use max precision for the API
          size: formattedSize,
          time_in_force: 'GTC',
          post_only: true,
          client_oid: `trail-${Date.now()}-${retryCount}` // Add unique client order ID
        };
        
        this.logger.debug('Placing new limit order:', orderParams);
        
        // Use rate limited call for placing orders
        const order = await this.makeRateLimitedCall(
          () => this.coinbaseService.placeOrder(orderParams),
          'placeOrder',
          1, // High priority for placing orders
          true // Critical operation
        );
        
        if (!order || !order.id) {
          throw new Error('Invalid order response from exchange');
        }
        
        // Update tracking variables
        const oldLimit = this.currentLimitPrice;
        this.activeOrderId = order.id;
        this.currentLimitPrice = newLimitPrice;
        this.consecutiveTrails++;
        this.lastTrailTime = Date.now();
        
        const priceIncreasePct = ((newLimitPrice / oldLimit - 1) * 100).toFixed(2);
        
        this.logger.info(`🔄 Updated limit order: ${oldLimit.toFixed(4)} → ${newLimitPrice.toFixed(4)} ` +
                        `(+${priceIncreasePct}%) | Trail #${this.consecutiveTrails}`);
        
        // Log order details
        this.logger.debug('Order update details:', {
          orderId: order.id,
          oldPrice: oldLimit,
          newPrice: newLimitPrice,
          priceChange: (newLimitPrice - oldLimit).toFixed(4),
          priceChangePct: priceIncreasePct,
          size: formattedSize,
          timestamp: new Date().toISOString()
        });
        
        return true;
        
      } catch (error) {
        retryCount++;
        
        if (retryCount >= maxRetries) {
          this.logger.error(`Failed to update limit order after ${maxRetries} attempts:`, error);
          
          // Reset tracking state to prevent getting stuck
          if (error.message.includes('insufficient_funds') || 
              error.message.includes('order_immediately_filled') ||
              error.message.includes('not_found')) {
            this.logger.warn('Resetting order tracking due to unrecoverable error');
            this.activeOrderId = null;
            this.currentLimitPrice = 0;
            this.consecutiveTrails = 0;
          }
          
          return false;
        }
        
        // Exponential backoff before retry
        const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 10000);
        this.logger.warn(`Attempt ${retryCount}/${maxRetries} failed, retrying in ${backoffTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }
    
    return false;
  }
  
  async cancelCurrentOrder() {
    if (!this.activeOrderId) return true;
    
    try {
      await this.makeRateLimitedCall(
        () => this.coinbaseService.cancelOrder(this.activeOrderId),
        'cancelOrder',
        1, // High priority for cancels
        true // Critical operation
      );
      this.activeOrderId = null;
      return true;
    } catch (error) {
      // If order was already filled or doesn't exist, continue
      if (error.message.includes('not found') || error.message.includes('already done')) {
        this.activeOrderId = null;
        return true;
      }
      this.logger.error('Error canceling order:', error);
      return false;
    }
  }
  
  /**
   * Clear all order tracking state
   * @private
   */
  clearOrderState() {
    this.logger.info(`Clearing order tracking state for order ${this.activeOrderId || 'none'}`);
    this.activeOrderId = null;
    this.initialLimitPrice = 0;
    this.currentLimitPrice = 0;
    this.positionSize = 0;
    this.entryPrice = 0;
    this.consecutiveTrails = 0;
    this.lastTrailTime = 0;
    
    // Also clear any position tracking
    if (this.position) {
      this.position.status = 'inactive';
      this.position.exitTime = new Date();
      this.position.exitReason = 'order_cleared';
    }
  }
  
  /**
   * Update local order state from API response
   * @param {Object} orderResponse - The order response from the API
   * @private
   */
  updateOrderFromApiResponse(orderResponse) {
    if (!orderResponse) return;
    
    // Handle both direct and nested order objects
    const order = orderResponse.order || orderResponse;
    const orderConfig = order.order_configuration?.limit_limit_gtc || {};
    
    // Update our local state with the latest order details
    this.activeOrderId = order.id || order.order_id || this.activeOrderId;
    this.currentLimitPrice = parseFloat(orderConfig.limit_price || order.limit_price || this.currentLimitPrice);
    
    // Update position size if available
    if (order.size) {
      this.positionSize = parseFloat(order.size);
    } else if (orderConfig.base_size) {
      this.positionSize = parseFloat(orderConfig.base_size);
    }
    
    // Log the update
    this.logger.info(`Updated local order state for ${this.activeOrderId}:`, {
      price: this.currentLimitPrice,
      size: this.positionSize,
      status: order.status || 'unknown'
    });
  }

  logStatus(currentPrice, additionalInfo = {}) {
    if (!this.activeTrailingStop) return;
    
    const currentProfitPct = ((currentPrice / this.entryPrice) - 1) * 100;
    const currentLimitProfitPct = ((this.currentLimitPrice / this.entryPrice) - 1) * 100;
    const {
      momentumScore = 0,
      scoreDetails = {},
      priceDifference = 0,
      priceDifferencePct = 0
    } = additionalInfo;
    
    const divider = '='.repeat(60);
    let status = `\n${divider}\n`;
    status += `📊 TRAILING STOP STATUS (${new Date().toISOString()})\n`;
    status += `${divider}\n`;
    
    // Price Information
    status += `💰 PRICE INFO\n`;
    status += `Current: ${currentPrice.toFixed(4)} (${currentProfitPct >= 0 ? '+' : ''}${currentProfitPct.toFixed(2)}% from entry)\n`;
    status += `Limit:   ${this.currentLimitPrice.toFixed(4)} (${currentLimitProfitPct >= 0 ? '+' : ''}${currentLimitProfitPct.toFixed(2)}% from entry)\n`;
    status += `Diff:    ${priceDifference >= 0 ? '+' : ''}${priceDifference.toFixed(4)} (${priceDifferencePct >= 0 ? '+' : ''}${priceDifferencePct.toFixed(2)}%)\n\n`;
    
    // Momentum Score
    status += `📈 MOMENTUM SCORE: ${(momentumScore * 100).toFixed(1)}/100\n`;
    status += `Threshold: ${(this.config.momentumThreshold * 100).toFixed(1)}\n\n`;
    
    // Order Information
    if (this.activeOrderId) {
      status += `🛒 ACTIVE ORDER\n`;
      status += `ID: ${this.activeOrderId}\n`;
      status += `Trail Count: ${this.consecutiveTrails}/${this.config.maxConsecutiveTrails}\n`;
      status += `Next Trail: In ${Math.max(0, this.config.cooldownPeriodMs - (Date.now() - this.lastTrailTime)) / 1000}s\n\n`;
    }
    
    // Indicator Details
    if (Object.keys(scoreDetails).length > 0) {
      status += `📊 INDICATOR DETAILS\n`;
      
      // MACD
      if (scoreDetails.macd) {
        const macd = scoreDetails.macd;
        status += `MACD: ${macd.histogram > 0 ? '↑' : '↓'} ${macd.histogram.toFixed(6)} `;
        status += `(Signal: ${macd.signal.toFixed(4)}, Value: ${macd.value.toFixed(4)})\n`;
      }
      
      // RSI
      if (scoreDetails.rsi) {
        const rsi = scoreDetails.rsi;
        status += `RSI: ${rsi.value.toFixed(2)} (${rsi.momentum})\n`;
      }
      
      // Bollinger Bands
      if (scoreDetails.bollinger) {
        const bb = scoreDetails.bollinger;
        status += `Bollinger: ${bb.upper.toFixed(4)} / ${bb.middle.toFixed(4)} / ${bb.lower.toFixed(4)} `;
        status += `(BW: ${bb.bandwidth.toFixed(2)}%)\n`;
      }
      
      // Volume
      if (scoreDetails.volume) {
        const vol = scoreDetails.volume;
        status += `Volume: ${vol.intensity.toUpperCase()} (${vol.ratio.toFixed(1)}x) `;
        status += `[${vol.current.toFixed(2)} vs ${vol.average.toFixed(2)} avg]\n`;
      }
      
      // Recent Highs
      if (scoreDetails.recentHighs) {
        const rh = scoreDetails.recentHighs;
        status += `Highs: ${rh.newHigh ? 'NEW HIGH ' : ''}${rh.consecutiveHighs} consecutive\n`;
      }
    }
    
    status += divider;
    this.logger.info(status);
  }
}

export default TrailingStopManager;