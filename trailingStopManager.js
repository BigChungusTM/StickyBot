import { TechnicalIndicators } from './technicalIndicators.js';
import { trailingStopConfig as config } from './trailingStopConfig.js';

class TrailingStopManager {
  constructor(coinbaseService, logger, configOverrides = {}) {
    this.coinbaseService = coinbaseService;
    this.logger = logger || console;
    this.config = { ...config, ...configOverrides };
    
    // Rate limiting state
    this.rateLimits = {
      lastRequestTime: 0,
      remainingRequests: 30, // Default Coinbase rate limit
      resetTime: Date.now() + 60000, // Default reset to 1 minute from now
      minRequestInterval: 1000 / (30 / 60), // 30 requests per minute = 1 request every 2 seconds
      consecutiveErrors: 0,
      maxConsecutiveErrors: 5,
      baseRetryDelay: 1000, // 1 second
      maxRetryDelay: 30000, // 30 seconds
    };
    
    // State tracking
    this.activeTrailingStop = false;
    this.initialLimitPrice = 0;
    this.currentLimitPrice = 0;
    this.entryPrice = 0;
    this.positionSize = 0;
    this.consecutiveTrails = 0;
    this.lastTrailTime = 0;
    this.activeOrderId = null;
    this.priceHistory = [];
    this.volumeHistory = [];
    this.orderUpdateCounts = new Map(); // Track number of updates per order
    this.hasShownInitialOrders = false; // Track if we've shown initial orders
    this.monitorInterval = null; // Store interval reference
    
    // Initialize indicators
    this.indicators = {
      macd: null,
      rsi: null,
      bollingerBands: null,
      volumeSpike: null,
      recentHighs: null
    };
    
    // Bind methods that need 'this' context
    const methodsToBind = [
      'initialize',
      'start',
      'stop',
      'startTrailing',
      'stopTrailing',
      'checkAndUpdateTrailingStop',
      'calculateMomentumScore',
      'shouldTrail',
      'updateLimitOrder',
      'cancelCurrentOrder',
      'logStatus',
      'monitorAndUpdateLimitOrders',
      'listAllOpenOrders',
      'updateIndicators'
    ];
    
    // Only bind methods that exist on the instance
    methodsToBind.forEach(method => {
      if (typeof this[method] === 'function') {
        this[method] = this[method].bind(this);
      }
    });
  }
  
  async initialize() {
    try {
      this.logger.debug('🔄 Initializing TrailingStopManager...');
      // Load any saved state if needed
      this.logger.info('✅ TrailingStopManager initialized successfully');
      return true;
    } catch (error) {
      this.logger.error('❌ Error initializing TrailingStopManager:', error);
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
              
              const type = (order.type || 'UNKNOWN').toUpperCase();
              const side = (order.side || 'UNKNOWN').toUpperCase();
              const key = `${side}_${type}`;
              
              if (!orderGroups[key]) {
                orderGroups[key] = [];
              }
              
              // Extract order details from either root or nested order object
              const orderObj = order.order || order;
              const orderId = orderObj.id || orderObj.order_id;
              
              if (!orderId) {
                this.logger.warn(`[TRAILING STOP] Order at index ${index} has no ID in expected locations:`, order);
                return;
              }
              
              // Add the ID to the root object if it's not there
              if (!order.id) order.id = orderId;
              
              orderGroups[key].push(order);
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
      
      // Log all order fields for debugging
      if (openOrders.length > 0) {
        this.logger.info('=== RAW ORDER DATA ===');
        openOrders.forEach((order, index) => {
          this.logger.info(`\n[ORDER ${index + 1}/${openOrders.length}] ID: ${order.order_id || order.id || 'unknown'}`);
          this.logger.info(JSON.stringify(order, null, 2));
        });
        this.logger.info('=== END RAW ORDER DATA ===\n');
      }
      
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
      
      // If no active sell limit orders, clear tracking state
      if (sellLimitOrders.length === 0 && this.activeOrderId) {
        this.logger.info(`No active sell limit orders found, clearing tracked order ${this.activeOrderId}`);
        this.activeOrderId = null;
        this.initialLimitPrice = 0;
        this.currentLimitPrice = 0;
        this.positionSize = 0;
        this.entryPrice = 0;
        this.consecutiveTrails = 0;
        this.lastTrailTime = 0;
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
          const orderId = order.id;
          const orderPrice = parseFloat(order.price);
          const orderSize = parseFloat(order.size);
          const filledSize = parseFloat(order.filled || '0');
          const remainingSize = parseFloat(order.remaining || '0');
          
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
            timeInForce: order.time_in_force
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
          
          // If order is no longer active, clear tracking state
          if (!trackedOrder) {
            this.logger.info(`Tracked order ${this.activeOrderId} no longer exists, clearing state`);
            this.activeOrderId = null;
            this.initialLimitPrice = 0;
            this.currentLimitPrice = 0;
            this.positionSize = 0;
            this.entryPrice = 0;
            this.consecutiveTrails = 0;
            this.lastTrailTime = 0;
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
      
      // Update indicators with latest market data
      this.logger.debug('Updating technical indicators...');
      await this.updateIndicators();
      
      // Calculate momentum score and details
      this.logger.debug('Calculating momentum score...');
      const momentumScore = await this.calculateMomentumScore();
      const scoreDetails = this.getMomentumScoreDetails ? await this.getMomentumScoreDetails() : {};
      
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
    if (!this.priceHistory || this.priceHistory.length < 20) {
      this.logger.debug('Not enough price history to update indicators');
      return;
    }

    try {
      // Calculate MACD
      this.indicators.macd = TechnicalIndicators.calculateMACD(this.priceHistory);
      
      // Calculate RSI
      this.indicators.rsi = TechnicalIndicators.calculateRSI(this.priceHistory);
      
      // Calculate Bollinger Bands if we have enough data
      if (this.priceHistory.length >= 20) {
        this.indicators.bollingerBands = TechnicalIndicators.calculateBollingerBands(this.priceHistory);
      }
      
      this.logger.debug('Indicators updated successfully');
    } catch (error) {
      this.logger.error(`Error updating indicators: ${error.message}`, { error });
    }
  }

  /**
   * Calculate the momentum score based on technical indicators
   * @returns {Promise<number>} Momentum score between 0 and 1
   */
  async calculateMomentumScore() {
    if (!this.indicators.macd || !this.indicators.rsi || !this.indicators.bollingerBands) {
      this.logger.debug('Missing required indicators for momentum calculation');
      return 0;
    }
    
    let score = 0;
    const indicators = this.indicators;
    
    // MACD components (0-30 points)
    if (indicators.macd.histogram > 0) {
      // Scale MACD histogram score based on its relative size
      const macdStrength = Math.min(1, Math.abs(indicators.macd.histogram) * 100);
      score += 10 + (5 * macdStrength);
    }
    if (indicators.macd.trend === 'up') score += 10;
    if (indicators.macd.bullishCross) score += 5;
    
    // RSI components (0-30 points)
    // More dynamic RSI scoring that scales with the RSI value
    if (indicators.rsi.value > 50) {
      // Scale from 0 to 30 points as RSI goes from 50 to 80
      const rsiScore = Math.min(30, (indicators.rsi.value - 50) * 1.5);
      score += rsiScore;
    }
    
    // Bollinger Bands (0-20 points)
    if (indicators.bollingerBands.priceNearUpperBand) {
      // Give more points the closer price is to the upper band
      const bbScore = indicators.bollingerBands.percentB > 0.7 ? 15 : 10;
      score += bbScore;
    }
    if (indicators.bollingerBands.expansion) score += 5;
    
    // Volume spike (0-20 points)
    if (indicators.volumeSpike && indicators.volumeSpike.withPriceIncrease) {
      // More aggressive scoring for volume spikes
      score += indicators.volumeSpike.intensity === 'high' ? 20 : 
              indicators.volumeSpike.intensity === 'medium' ? 15 : 8;
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
        this.logger.debug('No active order to trail');
        return false;
      }
      
      // Check cooldown period
      const timeSinceLastTrail = Date.now() - this.lastTrailTime;
      if (timeSinceLastTrail < this.config.cooldownPeriodMs) {
        this.logger.debug(`Cooldown active: ${timeSinceLastTrail}ms < ${this.config.cooldownPeriodMs}ms`);
        return false;
      }
      
      // Check max consecutive trails
      if (this.consecutiveTrails >= this.config.maxConsecutiveTrails) {
        this.logger.warn(`Max consecutive trails reached (${this.consecutiveTrails}/${this.config.maxConsecutiveTrails}), waiting for cooldown`);
        return false;
      }
      
      // Check if price is above current limit (already moved in our favor)
      if (currentPrice <= this.currentLimitPrice) {
        this.logger.debug(`Current price ${currentPrice} not above current limit ${this.currentLimitPrice}`);
        return false;
      }
      
      // Calculate momentum score
      const momentumScore = await this.calculateMomentumScore();
      const scoreDetails = this.getMomentumScoreDetails ? await this.getMomentumScoreDetails() : {};
      
      this.logger.debug('Trailing Stop - Momentum Analysis:', {
        momentumScore: momentumScore.toFixed(4),
        momentumThreshold: this.config.momentumThreshold,
        rsi: this.indicators.rsi,
        macd: this.indicators.macd,
        bollingerBands: this.indicators.bollingerBands,
        volumeSpike: this.indicators.volumeSpike,
        recentHighs: this.indicators.recentHighs,
        scoreDetails: scoreDetails || 'N/A'
      });
      
      // Check if momentum is strong enough
      if (momentumScore < this.config.momentumThreshold) {
        this.logger.debug(`Insufficient momentum for trailing: ${momentumScore.toFixed(4)} < ${this.config.momentumThreshold}`);
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
      
      // Calculate minimum price increment (0.1% of current price)
      const minIncrement = currentPrice * 0.001;
      
      // Ensure the price movement is significant enough to warrant an update
      if (potentialNewLimit - this.currentLimitPrice < minIncrement) {
        this.logger.debug(`Price change too small to update (${(potentialNewLimit - this.currentLimitPrice).toFixed(6)} < ${minIncrement.toFixed(6)})`);
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
        
        // Cancel existing order if any
        if (this.activeOrderId) {
          this.logger.debug(`Cancelling existing order ${this.activeOrderId}`);
          const cancelSuccess = await this.cancelCurrentOrder();
          if (!cancelSuccess) {
            throw new Error('Failed to cancel existing order');
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
