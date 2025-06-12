# StickyBot Development Plan

## Current Status
- ✅ Environment configuration using .env files
- ✅ Secure API key management
- ✅ One-click installation and startup scripts for Windows
- ✅ Automated dependency management
- ✅ Candle data caching with proper .gitignore exclusions

## Implementation Notes
- Technical indicators use only the most recent data for the current trading cycle
- Cached candles are stored for buy logic, not for indicator calculations
- The bot prints the latest candle and its indicators to the console
- 1 hour of candle data is backfilled and stored (60 candles)
- Account loading is handled by the `loadAccounts` method

## Recent Fixes & Improvements
- Fixed runtime errors related to cleanup functions
- Implemented proper error handling in fetchCandleData
- Resolved issues with trading cycle timing and alignment
- Added 2% profit-taking condition
- Implemented 24-hour low scoring with hourly candle cache
- Added manual trade detection for both buys and sales
- Improved position persistence across restarts
- Added one-click installation and startup scripts

## Known Issues
- Some IDE lint errors may still exist in the codebase (see IDE for details)
- Buy logic may need adjustment for better dip detection
- Confirmation decay logic may need fine-tuning for volatile markets

## Pending Features
- [ ] Implement trailing stop orders for better profit capture
- [ ] Add more comprehensive test coverage
- [ ] Create detailed documentation for configuration options
- [ ] Add more sophisticated risk management features
- [ ] Implement additional technical indicators for confirmation

## Installation & Setup
1. Clone the repository
2. Run `install.bat` (Windows) or `npm install`
3. Configure your `.env` file using the example
4. Run `start.bat` (Windows) or `node syrupBot.js`

## Configuration
See `.env.example` for all available configuration options. Key settings include:
- Coinbase API credentials
- Trading pair configuration
- Fee settings
- Profit thresholds
- Logging options

## Development Notes
- Follow existing code style and patterns
- Add comments for complex logic
- Update this document when making significant changes
- Test thoroughly before committing changes
