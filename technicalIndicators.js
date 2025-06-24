// Technical analysis calculations
export class TechnicalIndicators {
  
  static calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    // Calculate exponential moving averages
    const emaFast = this.calculateEMA(prices, fastPeriod);
    const emaSlow = this.calculateEMA(prices, slowPeriod);
    
    // MACD line = EMA(12) - EMA(26)
    const macdLine = emaFast.map((fast, i) => fast - emaSlow[i]);
    
    // Signal line = EMA(9) of MACD line
    const signalLine = this.calculateEMA(macdLine, signalPeriod);
    
    // Histogram = MACD - Signal
    const histogram = macdLine.map((macd, i) => macd - signalLine[i]);
    
    return {
      macd: macdLine[macdLine.length - 1],
      signal: signalLine[signalLine.length - 1],
      histogram: histogram[histogram.length - 1],
      bullishCross: this.detectBullishCross(macdLine, signalLine),
      trend: histogram[histogram.length - 1] > histogram[histogram.length - 2] ? 'up' : 'down'
    };
  }
  
  static calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) {
      return { value: 50, overbought: false, oversold: false, bullish: false, momentum: 'neutral' };
    }
    
    const changes = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }
    
    let avgGain = 0;
    let avgLoss = 0;
    
    // Initial averages
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) avgGain += changes[i];
      else avgLoss -= changes[i];
    }
    
    avgGain /= period;
    avgLoss /= period;
    
    // Calculate subsequent values
    for (let i = period; i < changes.length; i++) {
      const change = changes[i];
      if (change > 0) {
        avgGain = (avgGain * (period - 1) + change) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) - change) / period;
      }
    }
    
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    
    return {
      value: rsi,
      overbought: rsi > 70,
      oversold: rsi < 30,
      bullish: rsi > 50 && rsi < 80,
      momentum: rsi > 60 ? 'strong' : rsi > 50 ? 'moderate' : 'weak'
    };
  }
  
  static calculateBollingerBands(prices, period = 20, stdDev = 2) {
    if (prices.length < period) {
      return {
        upper: 0,
        middle: 0,
        lower: 0,
        bandwidth: 0,
        priceNearUpperBand: false,
        squeeze: false,
        expansion: false
      };
    }
    
    const sma = this.calculateSMA(prices, period);
    const currentSMA = sma[sma.length - 1];
    const currentPrice = prices[prices.length - 1];
    
    // Calculate standard deviation
    const recentPrices = prices.slice(-period);
    const variance = recentPrices.reduce((sum, price) => 
      sum + Math.pow(price - currentSMA, 2), 0) / period;
    const standardDev = Math.sqrt(variance);
    
    const upperBand = currentSMA + (standardDev * stdDev);
    const lowerBand = currentSMA - (standardDev * stdDev);
    const bandwidth = (upperBand - lowerBand) / currentSMA;
    
    return {
      upper: upperBand,
      middle: currentSMA,
      lower: lowerBand,
      bandwidth: bandwidth,
      priceNearUpperBand: currentPrice > (upperBand * 0.95),
      squeeze: bandwidth < 0.1,
      expansion: bandwidth > 0.2
    };
  }
  
  static detectVolumeSpike(volumes, prices, period = 20) {
    if (volumes.length < period || prices.length < 2) {
      return {
        spike: false,
        ratio: 1,
        withPriceIncrease: false,
        intensity: 'low'
      };
    }
    
    const recentVolumes = volumes.slice(-period);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / period;
    const currentVolume = volumes[volumes.length - 1];
    const priceChange = (prices[prices.length - 1] / prices[prices.length - 2]) - 1;
    
    return {
      spike: currentVolume > (avgVolume * 1.5),
      ratio: avgVolume > 0 ? currentVolume / avgVolume : 1,
      withPriceIncrease: currentVolume > (avgVolume * 1.5) && priceChange > 0,
      intensity: currentVolume > (avgVolume * 2) ? 'high' : 
                currentVolume > (avgVolume * 1.5) ? 'medium' : 'low'
    };
  }
  
  static analyzeRecentHighs(prices, period = 10) {
    if (prices.length < 2) {
      return {
        newHigh: false,
        consecutiveHighs: 0,
        breakoutStrength: 0,
        momentum: 0
      };
    }
    
    const recentPrices = prices.slice(-period);
    const currentPrice = prices[prices.length - 1];
    const previousHigh = Math.max(...recentPrices.slice(0, -1));
    
    return {
      newHigh: currentPrice > previousHigh,
      consecutiveHighs: this.countConsecutiveHighs(prices),
      breakoutStrength: currentPrice > previousHigh ? 
        (currentPrice - previousHigh) / previousHigh : 0,
      momentum: this.calculatePriceMomentum(prices.slice(-5))
    };
  }
  
  // Helper methods
  static calculateEMA(prices, period) {
    if (prices.length === 0) return [];
    
    const multiplier = 2 / (period + 1);
    const ema = [prices[0]];
    
    for (let i = 1; i < prices.length; i++) {
      ema.push((prices[i] * multiplier) + (ema[i - 1] * (1 - multiplier)));
    }
    return ema;
  }
  
  static calculateSMA(prices, period) {
    const sma = [];
    for (let i = period - 1; i < prices.length; i++) {
      const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      sma.push(sum / period);
    }
    return sma;
  }
  
  static detectBullishCross(macdLine, signalLine) {
    if (macdLine.length < 2 || signalLine.length < 2) return false;
    const current = macdLine[macdLine.length - 1] > signalLine[signalLine.length - 1];
    const previous = macdLine[macdLine.length - 2] <= signalLine[signalLine.length - 2];
    return current && previous;
  }
  
  static countConsecutiveHighs(prices) {
    if (prices.length < 2) return 0;
    
    let count = 0;
    for (let i = prices.length - 1; i > 0; i--) {
      if (prices[i] > prices[i - 1]) count++;
      else break;
    }
    return count;
  }
  
  static calculatePriceMomentum(prices) {
    if (prices.length < 2) return 0;
    return (prices[prices.length - 1] / prices[0]) - 1;
  }
}

export default TechnicalIndicators;
