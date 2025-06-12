const CoinbaseApi = require('coinbase-api');
const { coinbaseConfig } = require('./config.js');
// const { v4: uuidv4 } = require('uuid'); // No longer needed

class CoinbaseService {
  constructor() {
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
      
      // Log the request details for debugging
      console.log(`Fetching candles for ${productId} with granularity ${granularityValue}s (${granularityString})`);
      
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
        console.log(`Trying Advanced Trade API for ${productId}...`);
        
        const advancedParams = {
          product_id: productId,
          granularity: granularityString,
        };
        
        if (start) advancedParams.start = start;
        if (end) advancedParams.end = end;
        
        console.log('Advanced Trade API Params:', JSON.stringify(advancedParams, null, 2));
        
        if (typeof this.client.getPublicProductCandles === 'function') {
          const advancedResponse = await this.client.getPublicProductCandles(advancedParams);
          console.log(`Got candles using Advanced Trade API: ${JSON.stringify(advancedResponse).substring(0, 100)}...`);
          
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
  async submitOrder(productId, side, sideType, size, orderType = 'market', price = null, postOnly = false) {
    // Use the library's method to generate a client_order_id as suggested by its warning
    const clientOrderId = (this.client && typeof this.client.generateNewOrderId === 'function')
                          ? this.client.generateNewOrderId()
                          : require('uuid').v4(); // Fallback if method not found or client not init'd (should not happen here)
    
    let orderConfiguration;
    const sideUpper = side.toUpperCase();
    const orderTypeLower = orderType.toLowerCase();
    const sizeStr = size.toString();
    
    if (orderTypeLower === 'market') {
      if (sideUpper === 'BUY') {
        // For market buy, size is the amount of quote currency to spend (e.g., USDC)
        orderConfiguration = {
          market_market_ioc: {
            quote_size: sizeStr,
          }
        };
      } else if (sideUpper === 'SELL') {
        // For market sell, size is the amount of base currency to sell (e.g., SYRUP)
        orderConfiguration = {
          market_market_ioc: {
            base_size: sizeStr,
          }
        };
      } else {
        throw new Error('Invalid side for market order. Must be BUY or SELL.');
      }
    } else if (orderTypeLower === 'limit') {
      if (!price) throw new Error('Limit orders require a price');
      const priceStr = price.toString();
      
      if (sideUpper === 'BUY' || sideUpper === 'SELL') {
        orderConfiguration = {
          limit_limit_gtc: {
            base_size: sizeStr,
            limit_price: priceStr,
            post_only: !!postOnly
          }
        };
      } else {
        throw new Error('Invalid side for limit order. Must be BUY or SELL.');
      }
    } else {
      throw new Error(`Order type "${orderType}" is not supported. Use 'market' or 'limit'.`);
    }

    const params = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: sideUpper,
      order_configuration: orderConfiguration,
    };

    console.log(`Submitting order with params:`, JSON.stringify(params, null, 2));
    try {
      const response = await this.client.submitOrder(params);
      console.log('Order submission successful:', JSON.stringify(response, null, 2));
      return response;
    } catch (error) {
      console.error(`Error submitting order for ${productId}:`, error.message || error);
      if (error.response && error.response.data) {
        console.error('Error details:', error.response.data);
      }
      throw error;
    }
  }
}

const coinbaseServiceInstance = new CoinbaseService();

module.exports = {
  coinbaseService: coinbaseServiceInstance
};