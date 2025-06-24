// Use dynamic import for CommonJS modules
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const CoinbaseApi = require('coinbase-api');
import { coinbaseConfig } from './config.js';
import winston from 'winston';

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug', // Default to debug level
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      level: process.env.LOG_LEVEL || 'debug', // Show debug logs by default
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

class CoinbaseService {
  constructor() {
    this.logger = logger;
    
    // Log API key details (masked for security)
    this.logger.debug('Initializing Coinbase API client with:', {
      apiKeyPrefix: coinbaseConfig.apiKeyId ? `${coinbaseConfig.apiKeyId.substring(0, 5)}...${coinbaseConfig.apiKeyId.substring(coinbaseConfig.apiKeyId.length - 3)}` : 'missing',
      apiSecretPrefix: coinbaseConfig.apiSecret ? '*** (set)' : 'missing',
      hasLogger: !!logger
    });
    
    try {
      // Create Advanced Trade client for most operations
      this.client = new CoinbaseApi.CBAdvancedTradeClient({
        apiKey: coinbaseConfig.apiKeyId,
        apiSecret: coinbaseConfig.apiSecret,
        // timeout: 5000, // Default is 5000 ms
      });
      
      // Create International client for additional API access
      this.intlClient = new CoinbaseApi.CBInternationalClient({
        apiKey: coinbaseConfig.apiKeyId,
        apiSecret: coinbaseConfig.apiSecret,
        // timeout: 5000, // Default is 5000 ms
      });
      
      this.logger.debug('Coinbase API clients initialized successfully', {
        clientType: this.client ? 'initialized' : 'failed',
        intlClientType: this.intlClient ? 'initialized' : 'failed'
      });
      
      // Track filled orders to avoid duplicate notifications
      this.filledOrders = new Set();
      
    } catch (error) {
      this.logger.error('Failed to initialize Coinbase API clients:', error);
      throw error;
    }
  }

  /**
   * Get account balances for all currencies
   * @returns {Promise<Object>} Object with currency balances
   */
  async getAccountBalances() {
    try {
      const accounts = await this.client.getAccounts();
      const balances = {};
      
      if (accounts && Array.isArray(accounts.accounts)) {
        accounts.accounts.forEach(account => {
          const currency = account.currency;
          balances[currency] = {
            balance: account.available_balance?.value || '0',
            available: account.available_balance?.value || '0',
            hold: account.hold?.value || '0'
          };
        });
      }
      
      return balances;
    } catch (error) {
      console.error('Error getting account balances:', error);
      return {};
    }
  }

  /**
   * Get current ticker price for a product
   * @param {string} productId - The trading pair (e.g., 'SYRUP-USDC')
   * @returns {Promise<Object>} Ticker data including price
   */
  async getTicker(productId = 'SYRUP-USDC') {
    try {
      console.log(`[DEBUG] Fetching ticker for ${productId}`);
      
      // First try to get the ticker using the Public Market Trades endpoint
      try {
        const response = await this.client.getPublicMarketTrades({
          product_id: productId,
          limit: 1 // Only need the most recent trade
        });
        
        console.log(`[DEBUG] Public Market Trades response for ${productId}:`, JSON.stringify(response, null, 2));
        
        // If we have trades, use the most recent one for the price
        if (response && response.trades && response.trades.length > 0) {
          const latestTrade = response.trades[0];
          return {
            price: latestTrade.price,
            time: latestTrade.time,
            bid: response.best_bid || latestTrade.price,
            ask: response.best_ask || latestTrade.price,
            volume_24h: '0', // Volume not available in this response
            price_24h_change: '0' // 24h change not available
          };
        }
      } catch (error) {
        console.error(`[DEBUG] Public Market Trades error for ${productId}:`, error);
      }
      
      // Fallback to private API if public fails
      try {
        const response = await this.client.getMarketTrades({
          product_id: productId,
          limit: 1 // Only need the most recent trade
        });
        
        console.log(`[DEBUG] Private Market Trades response for ${productId}:`, JSON.stringify(response, null, 2));
        
        if (response && response.trades && response.trades.length > 0) {
          const latestTrade = response.trades[0];
          return {
            price: latestTrade.price,
            time: latestTrade.time,
            bid: response.best_bid || latestTrade.price,
            ask: response.best_ask || latestTrade.price,
            volume_24h: '0', // Volume not available in this response
            price_24h_change: '0' // 24h change not available
          };
        }
      } catch (fallbackError) {
        console.error(`[DEBUG] Private Market Trades error for ${productId}:`, fallbackError);
      }
      
      // If we get here, all methods failed
      console.error(`[DEBUG] All ticker fetch methods failed for ${productId}`);
      return this._getDefaultTicker();
      
    } catch (error) {
      console.error(`[ERROR] Unexpected error in getTicker for ${productId}:`, error);
      return this._getDefaultTicker();
    }  
  }

  /**
   * Returns a default ticker object
   * @private
   * @returns {Object} Default ticker data
   */
  _getDefaultTicker() {
    return {
      price: '0',
      time: new Date().toISOString(),
      bid: '0',
      ask: '0',
      volume: '0'
    };
  }

  /**
   * Get all open limit sell orders for the trading pair
   * @param {string} productId - The trading pair (e.g., 'SYRUP-USDC')
   * @returns {Promise<Array>} Array of open limit sell order IDs
   */
  async getOpenLimitSellOrders(productId = 'SYRUP-USDC') {
    try {
      // Validate productId format
      if (!productId || !productId.includes('-')) {
        throw new Error(`Invalid productId: ${productId}. Expected format: 'BASE-QUOTE'`);
      }
      
      // Prepare request parameters
      const requestParams = {
        product_id: productId,
        order_status: 'OPEN',
        order_type: 'LIMIT',
        order_side: 'SELL',
        limit: 100
      };
      
      this.logger.debug('Fetching open limit sell orders with params:', JSON.stringify(requestParams, null, 2));
      
      try {
        // Make the API request with enhanced error handling
        this.logger.debug('Making API request to getOrders with params:', JSON.stringify(requestParams, null, 2));
        const response = await this.client.getOrders(requestParams);
        
        // Log the raw response for debugging
        this.logger.debug('=== RAW API RESPONSE ===');
        this.logger.debug('Raw response type:', typeof response);
        this.logger.debug('Raw response keys (if object):', response ? Object.keys(response) : 'N/A');
        this.logger.debug('Raw response stringified:', JSON.stringify(response, null, 2));
        
        if (response) {
          this.logger.debug('Response keys:', Object.keys(response));
          this.logger.debug('Response type:', typeof response);
          
          // Check if orders exist and log their structure
          const hasOrders = !!response.orders;
          this.logger.debug('Has orders:', hasOrders);
          
          if (hasOrders) {
            const orders = response.orders;
            this.logger.debug('Orders type:', typeof orders);
            this.logger.debug('Is orders array:', Array.isArray(orders));
            this.logger.debug('Number of orders:', orders.length);
            
            if (orders.length > 0) {
              this.logger.debug('=== FIRST ORDER SAMPLE ===');
              this.logger.debug('Order keys:', Object.keys(orders[0]));
              this.logger.debug('Order type:', typeof orders[0]);
              this.logger.debug('Full order data:', JSON.stringify(orders[0], null, 2));
              
              // Log all fields in the order for debugging
              this.logger.debug('=== ORDER FIELDS ===');
              Object.entries(orders[0]).forEach(([key, value]) => {
                this.logger.debug(`${key}:`, JSON.stringify(value, null, 2));
              });
              
              // Log specific fields we're interested in
              const order = orders[0];
              this.logger.debug('=== ORDER DETAILS ===');
              this.logger.debug('Order ID:', order.id || order.order_id);
              this.logger.debug('Possible price fields:', {
                price: order.price,
                limit_price: order.limit_price,
                execution_price: order.execution_price,
                average_filled_price: order.average_filled_price,
                price_level: order.price_level,
                stop_price: order.stop_price
              });
              this.logger.debug('Possible size fields:', {
                size: order.size,
                quantity: order.quantity,
                base_size: order.base_size,
                executed_value: order.executed_value
              });
              this.logger.debug('Order side:', order.side);
              this.logger.debug('Order type:', order.type);
              this.logger.debug('Order status:', order.status);
              this.logger.debug('Order product_id:', order.product_id);
            } else {
              this.logger.debug('Orders array is empty');
            }
          } else {
            this.logger.debug('No orders found in response');
          }
        }
        
        // Extract order IDs from the response
        const orderIds = [];
        
        if (response?.orders && Array.isArray(response.orders)) {
          for (const [index, order] of response.orders.entries()) {
            this.logger.debug(`Processing order ${index + 1}/${response.orders.length}:`, {
              orderId: order.id,
              orderSide: order.side,
              orderType: order.type,
              orderStatus: order.status,
              productId: order.product_id,
              price: order.price,
              size: order.size || order.quantity
            });
            
            // Use either order_id or id, whichever is available
            const orderId = order.order_id || order.id;
            if (orderId) {
              // Try to find the price in various possible fields
              const price = order.price || 
                           order.limit_price || 
                           order.execution_price || 
                           order.average_filled_price ||
                           order.price_level ||
                           order.stop_price ||
                           '0';
                            
              // Try to find the size in various possible fields
              const size = order.size || 
                         order.quantity || 
                         order.base_size || 
                         order.executed_value ||
                         '0';
              
              const orderData = {
                id: orderId,
                price: price,
                size: size,
                side: order.side,
                type: order.type,
                status: order.status,
                product_id: order.product_id,
                created_at: order.created_at || order.created_time || new Date().toISOString(),
                // Include all fields for debugging
                _raw: order
              };
              
              this.logger.debug(`Processed order ${orderId}:`, {
                price: orderData.price,
                size: orderData.size,
                side: orderData.side,
                type: orderData.type
              });
              
              orderIds.push(orderData);
            } else {
              this.logger.warn('Order has no valid ID field:', order);
            }
          }
        }
        
        this.logger.info(`Found ${orderIds.length} open limit sell orders for ${productId}`);
        return orderIds;
        
      } catch (apiError) {
        this.logger.error('API Error in getOpenLimitSellOrders:', {
          message: apiError.message,
          code: apiError.code,
          response: apiError.response?.data,
          stack: apiError.stack
        });
        return [];
      }
      
    } catch (error) {
      this.logger.error('Error fetching open limit sell orders:', {
        message: error.message,
        code: error.code,
        stack: error.stack
      });
      return [];
    }
  }
  
  /**
   * Get all open orders for the trading pair (legacy method, consider using getOpenLimitSellOrders instead)
   * @param {string} productId - The trading pair (e.g., 'SYRUP-USDC')
   * @returns {Promise<Array>} Array of open orders
   */
  async getOpenOrders(productId = 'SYRUP-USDC') {
    // For backward compatibility, call getOpenLimitSellOrders
    return this.getOpenLimitSellOrders(productId);
  }

  async getAccounts() { // Renamed from listAccounts to getAccounts
    try {
      // Corrected method name based on provided list
      const response = await this.client.getAccounts();
      return response;
    } catch (error) {
      console.error('Error listing accounts:', error.message || error);
      if (error.response && error.response.data) {
        console.error('Error details:', error.response.data);
      }
      throw error;
    }
  }

  async getProductCandles(productId, granularity, start, end) {
    try {
      // Convert string granularity to numeric if needed
      let granularityValue = granularity;
      let granularityString = granularity;
      
      // Map for numeric to string conversion
      const granularityMap = {
        '60': 'ONE_MINUTE',
        '300': 'FIVE_MINUTE',
        '900': 'FIFTEEN_MINUTE',
        '1800': 'THIRTY_MINUTE',
        '3600': 'ONE_HOUR',
        '7200': 'TWO_HOUR',
        '21600': 'SIX_HOUR',
        '86400': 'ONE_DAY'
      };
      
      // Map for string to numeric conversion
      const reverseGranularityMap = {
        'ONE_MINUTE': 60,
        'FIVE_MINUTE': 300,
        'FIFTEEN_MINUTE': 900,
        'THIRTY_MINUTE': 1800,
        'ONE_HOUR': 3600,
        'TWO_HOUR': 7200,
        'SIX_HOUR': 21600,
        'ONE_DAY': 86400
      };
      
      // Convert between formats as needed
      if (typeof granularity === 'string') {
        if (reverseGranularityMap[granularity]) {
          granularityValue = reverseGranularityMap[granularity];
          granularityString = granularity;
        } else if (!isNaN(parseInt(granularity))) {
          granularityValue = parseInt(granularity);
          granularityString = granularityMap[granularityValue.toString()] || 'ONE_MINUTE';
        } else {
          granularityValue = 60; // Default
          granularityString = 'ONE_MINUTE';
        }
      } else if (typeof granularity === 'number') {
        granularityValue = granularity;
        granularityString = granularityMap[granularityValue.toString()] || 'ONE_MINUTE';
      }
      
      // Log the request details at debug level
      logger.debug(`Fetching candles for ${productId} with granularity ${granularityValue}s (${granularityString})`);
      
      // Format dates for ISO string if needed
      let startDate = start;
      let endDate = end;
      
      if (start && !start.includes('T') && !isNaN(parseInt(start))) {
        startDate = new Date(parseInt(start) * 1000).toISOString();
      }
      
      if (end && !end.includes('T') && !isNaN(parseInt(end))) {
        endDate = new Date(parseInt(end) * 1000).toISOString();
      }
      
      // Try each API method in sequence until one works
      try {
        // 1. First try Advanced Trade API
        logger.debug(`Trying Advanced Trade API for ${productId}...`);
        
        const advancedParams = {
          product_id: productId,
          granularity: granularityString,
        };
        
        if (start) advancedParams.start = start;
        if (end) advancedParams.end = end;
        
        logger.debug('Advanced Trade API Params:', JSON.stringify(advancedParams, null, 2));
        
        if (typeof this.client.getPublicProductCandles === 'function') {
          const advancedResponse = await this.client.getPublicProductCandles(advancedParams);
          logger.debug(`Got ${advancedResponse?.candles?.length || 0} candles from Advanced Trade API`);
          
          if (advancedResponse && advancedResponse.candles) {
            return { candles: advancedResponse.candles };
          } else if (advancedResponse && Array.isArray(advancedResponse)) {
            return { candles: advancedResponse };
          }
          
          console.log('Unexpected response format from Advanced Trade API');
        } else {
          console.log('getPublicProductCandles method not available on client');
        }
      } catch (advancedError) {
        console.log(`Advanced Trade API failed: ${advancedError.message}`);
      }
      
      // 2. Try International API if Advanced Trade API failed
      try {
        console.log(`Trying International API for ${productId}...`);
        
        // Map the product ID to the instrument format expected by the International API
        const instrument = productId.replace('-', '_').toLowerCase();
        
        // Convert granularity to the format expected by the International API
        const intlGranularityMap = {
          'ONE_MINUTE': '1m',
          'FIVE_MINUTE': '5m',
          'FIFTEEN_MINUTE': '15m',
          'THIRTY_MINUTE': '30m',
          'ONE_HOUR': '1h',
          'TWO_HOUR': '2h',
          'SIX_HOUR': '6h',
          'ONE_DAY': '1d'
        };
        
        const intlGranularity = intlGranularityMap[granularityString] || '1m';
        
        // Prepare the parameters for the International API
        const intlParams = {
          instrument: instrument,
          granularity: intlGranularity
        };
        
        if (start) intlParams.start_time = new Date(parseInt(start) * 1000).toISOString();
        if (end) intlParams.end_time = new Date(parseInt(end) * 1000).toISOString();
        
        console.log('International API Params:', JSON.stringify(intlParams, null, 2));
        
        if (typeof this.intlClient.getAggregatedCandlesData === 'function') {
          const intlResponse = await this.intlClient.getAggregatedCandlesData(intlParams);
          console.log(`Got candles using International API: ${JSON.stringify(intlResponse).substring(0, 100)}...`);
          
          if (intlResponse && intlResponse.candles) {
            // Transform the candles to match the expected format
            const transformedCandles = intlResponse.candles.map(candle => ({
              start: Math.floor(new Date(candle.time).getTime() / 1000),
              low: parseFloat(candle.low),
              high: parseFloat(candle.high),
              open: parseFloat(candle.open),
              close: parseFloat(candle.close),
              volume: parseFloat(candle.volume)
            }));
            
            return { candles: transformedCandles };
          }
          
          console.log('Unexpected response format from International API');
        } else {
          console.log('getAggregatedCandlesData method not available on intlClient');
        }
      } catch (intlError) {
        console.log(`International API failed: ${intlError.message}`);
      }
      
      // 3. Try original method if International API failed
      try {
        console.log(`Trying original method for ${productId}...`);
        
        const apiParams = {
          product_id: productId,
          granularity: granularityValue
        };

        if (start) apiParams.start = start;
        if (end) apiParams.end = end;
        
        console.log('Original API Params:', JSON.stringify(apiParams, null, 2));
        
        const response = await this.client.getProductCandles(apiParams);
        return response;
      } catch (originalError) {
        console.log(`Original method failed: ${originalError.message}`);
      }
      
      // Mock candle generation has been removed as requested
      // When all API methods fail, we'll return empty candles and let the system populate them next time
      
      // If all methods fail, return empty candles
      console.log(`All methods failed for ${productId}. Returning empty candles.`);
      return { candles: [] };

    } catch (error) {
      console.error(`Error fetching candles for ${productId}:`, error.message || error);
      if (error.response) {
        console.error('Error response status:', error.response.status);
        console.error('Error response data:', JSON.stringify(error.response.data, null, 2));
      }
      
      // Return empty candles instead of throwing to prevent crashes
      return { candles: [] };
    }
  }

  /**
   * Get current price and other data for a specific product
   * @param {string} productId - The product ID (e.g., 'BTC-GBP' or 'XRP-USDC')
   * @returns {Promise<Object>} - Product data including current price
   */
  async getProductData(productId) {
    try {
      // Use candles to get the most recent price since getProductTicker isn't available
      console.log(`Getting product data for ${productId} using candles...`);
      
      // Let's try to get the product info first to check if it exists
      try {
        console.log(`Checking if product ${productId} exists...`);
        const products = await this.client.getProducts();
        console.log(`Got ${products.products.length} products from Coinbase`);
        
        const product = products.products.find(p => p.product_id === productId);
        if (!product) {
          console.error(`Product ${productId} not found in available products!`);
          console.log(`Available products include: ${products.products.slice(0, 10).map(p => p.product_id).join(', ')}...`);
          throw new Error(`Product ${productId} not available on Coinbase`);
        }
        console.log(`Product ${productId} found, status: ${product.status}, trading_disabled: ${product.trading_disabled}`);
      } catch (productError) {
        console.error(`Error checking product availability: ${productError.message}`);
      }
      
      const now = Math.floor(Date.now() / 1000);
      const fiveMinutesAgo = now - 300; // 5 minutes ago
      
      const candlesResponse = await this.getProductCandles(productId, 60, fiveMinutesAgo.toString(), now.toString());
      if (candlesResponse && candlesResponse.candles && candlesResponse.candles.length > 0) {
        // Get the most recent candle
        const latestCandle = candlesResponse.candles[candlesResponse.candles.length - 1];
        // Determine currency symbol based on the product ID
        const currencySymbol = productId.includes('GBP') ? '£' : 
                              productId.includes('USDC') ? '$' : 
                              productId.includes('USD') ? '$' :
                              productId.includes('EUR') ? '€' : '';
        console.log(`Using latest candle price as fallback: ${currencySymbol}${latestCandle.close}`);
        return {
          price: latestCandle.close,
          product_id: productId,
          source: 'candle_data'
        };
      } else {
        // If we can't get candles, use a fallback price
        console.log(`No candles available for ${productId}. Using fallback price.`);
        
        // For XRP-USDC, use a reasonable fallback price based on recent market data
        // Updated with current market prices as of May 29, 2025
        const fallbackPrices = {
          'XRP-USDC': 2.28, // Current market price for XRP-USDC
          'XRP-USD': 2.28,  // Estimated price for XRP-USD
          'XRP-EUR': 2.10,  // Estimated price for XRP-EUR
          'XRP-USDT': 2.28  // Estimated price for XRP-USDT
        };
        
        const fallbackPrice = fallbackPrices[productId] || 0.5; // Default to 0.5 if no specific fallback
        
        // Determine currency symbol based on the product ID
        const currencySymbol = productId.includes('GBP') ? '£' : 
                              productId.includes('USDC') ? '$' : 
                              productId.includes('USD') ? '$' :
                              productId.includes('EUR') ? '€' : '';
                              
        console.log(`Using fallback price for ${productId}: ${currencySymbol}${fallbackPrice}`);
        
        return {
          price: fallbackPrice.toString(),
          product_id: productId,
          source: 'fallback_price'
        };
      }
    } catch (error) {
      console.error(`Error getting product data: ${error.message}`);
      if (error.response) {
        console.error('Error response status:', error.response.status);
        console.error('Error response data:', JSON.stringify(error.response.data, null, 2));
      }
      
      // Even if there's an error, return a fallback price
      const fallbackPrice = 0.5; // Default fallback price
      console.log(`Error getting product data. Using default fallback price: $${fallbackPrice}`);
      
      return {
        price: fallbackPrice.toString(),
        product_id: productId,
        source: 'error_fallback_price'
      };
    }
  }

  /**
   * Submit an order to Coinbase Advanced Trade API
   * @param {string} productId - e.g., 'XRP-USD'
   * @param {string} side - 'BUY' or 'SELL'
   * @param {string|number} size - amount to buy/sell (base or quote depending on type)
   * @param {string} orderType - 'market' or 'limit'
   * @param {number} [price] - price for limit order
   * @param {boolean} [postOnly] - whether to use post-only (maker) mode
   */
  async submitOrder(productId, side, size, orderType = 'market', price = null, postOnly = false) {
    // Input validation
    if (typeof productId !== 'string' || !productId.includes('-')) {
      throw new Error('Invalid productId. Must be in format "BASE-QUOTE" (e.g., "SYRUP-USDC")');
    }

    const upperSide = side?.toUpperCase();
    if (upperSide !== 'BUY' && upperSide !== 'SELL') {
      throw new Error('Invalid side. Must be "BUY" or "SELL"');
    }

    const numericSize = parseFloat(size);
    if (isNaN(numericSize) || numericSize <= 0) {
      throw new Error('Size must be a positive number');
    }

    const lowerOrderType = orderType?.toLowerCase();
    if (lowerOrderType !== 'market' && lowerOrderType !== 'limit') {
      throw new Error('Invalid orderType. Must be "market" or "limit"');
    }

    if (lowerOrderType === 'limit') {
      const numericPrice = parseFloat(price);
      if (isNaN(numericPrice) || numericPrice <= 0) {
        throw new Error('Price is required and must be a positive number for limit orders');
      }
    }

    // Generate client order ID
    const clientOrderId = (this.client && typeof this.client.generateNewOrderId === 'function')
      ? this.client.generateNewOrderId()
      : require('uuid').v4();
      
    try {
      // First, verify the product exists and is tradable
      const products = await this.client.getProducts();
      const product = products.products.find(p => p.product_id === productId);
      if (!product) {
        throw new Error(`Product ${productId} not found. Available products: ${products.products.slice(0, 5).map(p => p.product_id).join(', ')}...`);
      }
      if (product.trading_disabled) {
        throw new Error(`Trading is disabled for ${productId}. Status: ${product.status}`);
      }
      console.log(`Product ${productId} is available for trading.`);
      
      let orderConfiguration;
      const orderTypeLower = orderType.toLowerCase();
      const sideUpper = side.toUpperCase();
      const sizeStr = size.toString();
      
      if (orderTypeLower === 'market') {
        orderConfiguration = {
          market_market_ioc: {}
        };
        
        if (sideUpper === 'BUY') {
          // For market buy, size is the amount of base currency to buy (e.g., SYRUP)
          orderConfiguration.market_market_ioc.base_size = sizeStr;
        } else if (sideUpper === 'SELL') {
          // For market sell, size is the amount of base currency to sell (e.g., SYRUP)
          orderConfiguration.market_market_ioc.base_size = sizeStr;
        } else {
          throw new Error('Invalid side for market order. Must be BUY or SELL.');
        }
      } else if (orderTypeLower === 'limit') {
        if (!price) throw new Error('Limit orders require a price');
        
        if (sideUpper === 'BUY' || sideUpper === 'SELL') {
          // For limit orders, we need to use limit_limit_gtc configuration
          // Format price and size with correct decimal places
          const [base, quote] = productId.split('-').map(c => c.toUpperCase());
          const baseDecimals = base === 'SYRUP' ? 1 : 4;  // SYRUP uses 1 decimal, others use 4
          const quoteDecimals = 4;  // USDC uses 4 decimals
          
          // Format the price and size with correct decimal places
          const formattedPrice = parseFloat(price).toFixed(quoteDecimals);
          const baseSize = parseFloat(sizeStr).toFixed(baseDecimals);
          
          // Calculate quote size (price * size) with proper decimal places
          const quoteSize = (parseFloat(price) * parseFloat(sizeStr)).toFixed(quoteDecimals);
          
          // For limit orders, we only need to specify the base_size and limit_price
          // The API will calculate the quote_size automatically
          orderConfiguration = {
            limit_limit_gtc: {
              base_size: baseSize,      // Amount of base currency to buy/sell (e.g., SYRUP)
              limit_price: formattedPrice, // Price per unit in quote currency
              post_only: !!postOnly,     // Whether to be a maker order only
              rfq_disabled: true        // Route to exchange CLOB
            }
          };
          
          // Remove quote_size as it's not needed and might be causing issues
          delete orderConfiguration.limit_limit_gtc.quote_size;
          
          console.log('Limit order configuration:', JSON.stringify(orderConfiguration, null, 2));
        } else {
          throw new Error('Invalid side for limit order. Must be BUY or SELL.');
        }
      } else {
        throw new Error(`Order type "${orderType}" is not yet implemented.`);
      }
      
      const params = {
        client_order_id: clientOrderId,
        product_id: productId,
        side: sideUpper,
        order_configuration: orderConfiguration,
      };
      
      console.log('Submitting order with params:', JSON.stringify(params, null, 2));
      
      // Submit the order
      const response = await this.client.submitOrder(params);
      console.log('Order submission successful:', JSON.stringify(response, null, 2));
      return response;
    } catch (error) {
      let errorMessage = `Error submitting ${orderType} ${side} order for ${productId}: `;
      
      // Extract detailed error information
      if (error.response) {
        const { status, statusText, data } = error.response;
        errorMessage += `[${status}] ${statusText}`;
        
        console.error('Error response:', {
          status,
          statusText,
          url: error.response.config?.url,
          method: error.response.config?.method,
          requestData: error.response.config?.data ? JSON.parse(error.response.config.data) : null,
          responseData: data
        });
        
        if (data && data.error) {
          errorMessage += ` - ${data.error}`;
          if (data.message) errorMessage += `: ${data.message}`;
          if (data.error_details) errorMessage += ` (${JSON.stringify(data.error_details)})`;
        }
      } else {
        errorMessage += error.message || 'Unknown error';
      }
      
      console.error(errorMessage);
      
    }
    
    const params = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: sideUpper,
      order_configuration: orderConfiguration,
    };
    
    console.log('Submitting order with params:', JSON.stringify(params, null, 2));
    
    // Submit the order
    const response = await this.client.submitOrder(params);
    console.log('Order submission successful:', JSON.stringify(response, null, 2));
    return response;
  } catch (error) {
    let errorMessage = `Error submitting ${orderType} ${side} order for ${productId}: `;
    
    // Extract detailed error information
    if (error.response) {
      const { status, statusText, data } = error.response;
      errorMessage += `[${status}] ${statusText}`;
      
      console.error('Error response:', {
        status,
        statusText,
        url: error.response.config?.url,
        method: error.response.config?.method,
        requestData: error.response.config?.data ? JSON.parse(error.response.config.data) : null,
        responseData: data
      });
      
      if (data && data.error) {
        errorMessage += ` - ${data.error}`;
        if (data.message) errorMessage += `: ${data.message}`;
        if (data.error_details) errorMessage += ` (${JSON.stringify(data.error_details)})`;
      }
    } else {
      errorMessage += error.message || 'Unknown error';
    }
    
    console.error(errorMessage);
    
    // Re-throw with the detailed error message
    const detailedError = new Error(errorMessage);
    detailedError.originalError = error;
    throw detailedError;
  }

  /**
   * Cancel an order by ID
   * @param {string} orderId - The ID of the order to cancel
   * @returns {Promise<Object>} - The cancellation response
   */
  async cancelOrder(orderId) {
    if (!orderId) {
      throw new Error('Order ID is required to cancel an order');
    }

    try {
      logger.info(`Attempting to cancel order ${orderId}...`);
      
      // First try to cancel using the Advanced Trade client
      try {
        const response = await this.client.cancelOrder({
          order_id: orderId
        });
        
        logger.info(`Successfully cancelled order ${orderId}`);
        return response;
      } catch (advancedError) {
        logger.warn(`Advanced Trade cancelOrder failed: ${advancedError.message}`);
        
        // If Advanced Trade fails, try with the International client as fallback
        try {
          const response = await this.intlClient.cancelOrder({
            id: orderId,
            portfolio: coinbaseConfig.portfolioName || 'default'
          });
          
          logger.info(`Successfully cancelled order ${orderId} using International API`);
          return response;
        } catch (intlError) {
          logger.error(`International API cancelOrder also failed: ${intlError.message}`);
          
          // If both fail, try the raw API call as last resort
          try {
            const response = await this.client.post(`/orders/${orderId}/cancel`);
            logger.info(`Successfully cancelled order ${orderId} using direct API call`);
            return response;
          } catch (rawError) {
            logger.error(`All cancellation attempts failed for order ${orderId}`);
            throw new Error(`Failed to cancel order ${orderId}: ${rawError.message}`);
          }
        }
      }
    } catch (error) {
      logger.error(`Error in cancelOrder for ${orderId}:`, {
        message: error.message,
        stack: error.stack,
        response: error.response?.data
      });
      
      // Special handling for already cancelled or filled orders
      if (error.message.includes('not found') || 
          error.message.includes('not found') || 
          error.message.includes('already done') ||
          error.message.includes('not open') ||
          error.response?.status === 404) {
        logger.warn(`Order ${orderId} may already be filled or cancelled`);
        return { success: true, message: 'Order already filled or cancelled' };
      }
      
      throw error;
    }
  }

  /**
   * Get all open orders for the account
   * @returns {Promise<Array>} - Array of open orders with detailed information
   */
  async getOpenOrders() {
    try {
      logger.info('Fetching open orders from Coinbase...');
      
      // Get all orders with status 'OPEN' for SYRUP-USDC
      const response = await this.client.getOrders({
        order_status: 'OPEN',
        product_id: 'SYRUP-USDC',
        limit: 100, // Maximum allowed by the API
        order_side: 'SELL' // Only get sell orders for now
      });
      
      if (response?.orders?.length) {
        logger.info(`Found ${response.orders.length} open orders`);
        
        // Enrich order data with additional details
        const enrichedOrders = await Promise.all(
          response.orders
            .filter(order => order?.product_id === 'SYRUP-USDC')
            .map(async (order) => {
              try {
                // Get order details including fills
                const orderDetails = await this.client.getOrder({
                  order_id: order.order_id
                });
                
                return {
                  ...order,
                  ...(orderDetails || {}),
                  // Add human-readable timestamps
                  created_at: order.created_time ? new Date(order.created_time).toISOString() : null,
                  updated_at: order.last_updated_time ? new Date(order.last_updated_time).toISOString() : null
                };
              } catch (err) {
                logger.error(`Error fetching details for order ${order.order_id}:`, err);
                return order; // Return basic order info if details fetch fails
              }
            })
        );
        
        return enrichedOrders;
      }
      
      logger.info('No open orders found');
      return [];
      
    } catch (error) {
      logger.error('Error in getOpenOrders:', {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        data: error.response?.data
      });
      
      // Return empty array instead of throwing to prevent command failure
      return [];
    }
  }
}

// Create and export a single instance of the service
const coinbaseService = new CoinbaseService();

export { coinbaseService };
export default coinbaseService;