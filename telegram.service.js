import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

class TelegramService {
  constructor() {
    this.bot = null;
    this.chatId = process.env.TELEGRAM_CHAT_ID || null;
    this.adminUsername = process.env.TELEGRAM_ADMIN_USERNAME ? 
      process.env.TELEGRAM_ADMIN_USERNAME.toLowerCase() : null;
    this.enabled = false;
    this.initialize();
  }

  // Helper method to check if a user is authorized
  isAuthorizedUser(ctx) {
    if (!this.adminUsername) return true; // No admin username set, allow all
    
    const username = ctx.from?.username?.toLowerCase();
    if (!username) return false; // No username, not authorized
    
    return username === this.adminUsername;
  }

  // Helper method to send unauthorized message
  async sendUnauthorizedMessage(chatId) {
    return this.sendMessage(
      chatId,
      '⛔ *Unauthorized*\n\nYou do not have permission to use this command.',
      { parse_mode: 'Markdown' }
    );
  }

  initialize() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID || null;
    this.enabled = process.env.TELEGRAM_NOTIFICATIONS_ENABLED === 'true' && !!token && !!this.chatId;

    if (!this.enabled) {
      if (!token) {
        console.log('Telegram notifications disabled: No bot token provided');
      } else if (!this.chatId) {
        console.log('Telegram notifications disabled: No chat ID provided');
      } else {
        console.log('Telegram notifications are disabled in config');
      }
      return;
    }
    
    console.log('Initializing Telegram bot with chat ID:', this.chatId);

    try {
      this.bot = new Telegraf(token);
      this.setupCommands();
      this.bot.launch();
      console.log('Telegram bot started successfully');
      
      // Enable graceful stop
      process.once('SIGINT', () => this.bot.stop('SIGINT'));
      process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
    } catch (error) {
      console.error('Failed to initialize Telegram bot:', error);
      this.enabled = false;
    }
  }

  /**
   * Register a command handler
   * @param {string} command - Command name (without leading slash)
   * @param {Function} handler - Command handler function
   */
  command(command, handler) {
    if (!this.enabled || !this.bot) return;
    this.bot.command(command, handler);
  }

  /**
   * Set up command handlers with the trading bot instance
   * @param {Object} tradingBot - Instance of the trading bot
   */
  setupCommands(tradingBot) {
    console.log('Setting up Telegram commands with trading bot instance:', tradingBot ? 'Valid' : 'Invalid');
    if (!this.bot) {
      console.error('Telegram bot not initialized');
      return;
    }

    // Store the trading bot instance
    this.tradingBot = tradingBot;

    // Add the bot instance to the context for all commands
    this.bot.use((ctx, next) => {
      ctx.tradingBot = this.tradingBot;
      return next();
    });

    // Start command
    this.bot.command('start', (ctx) => {
      this.sendMessage(ctx.chat.id, '🚀 SYRUP Trading Bot is running! Use /help to see available commands.');
    });

    // Help command
    this.bot.command('help', (ctx) => {
      const helpText = `
        🤖 *SYRUP Trading Bot Commands* \n\n` +
        `/status - Show bot status and current position\n` +
        `/balance - Show current account balances\n` +
        `/trades - Show recent trades\n` +
        `/pause - Pause trading\n` +
        `/resume - Resume trading\n` +
        `/help - Show this help message`;
      
      this.sendMessage(ctx.chat.id, helpText, { parse_mode: 'Markdown' });
    });

    // Status command
    this.bot.command('status', async (ctx) => {
      try {
        await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
        this.sendMessage(ctx.chat.id, 'Status command handler will be implemented');
      } catch (error) {
        console.error('Error in status command:', error);
        this.sendMessage(ctx.chat.id, '❌ Error getting status. Please try again later.');
      }
    });

    // Balance command
    this.bot.command('balance', async (ctx) => {
      try {
        // Show typing indicator
        await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
        
        // Get and send balances
        const balanceMessage = await this.tradingBot.getFormattedBalances();
        await this.sendMessage(ctx.chat.id, balanceMessage, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error('Error in balance command:', error);
        await this.sendMessage(ctx.chat.id, '❌ Error fetching balances. Please try again later.');
      }
    });

    // Admin command wrapper
    this.adminCommand = (command, handler) => {
      this.bot.command(command, async (ctx) => {
        if (!this.isAuthorizedUser(ctx)) {
          return this.sendUnauthorizedMessage(ctx.chat.id);
        }
        return handler(ctx);
      });
    };

    // Trades command - Public
    this.bot.command('trades', async (ctx) => {
      try {
        await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
        this.sendMessage(ctx.chat.id, 'Trades command handler will be implemented');
      } catch (error) {
        console.error('Error in trades command:', error);
        this.sendMessage(ctx.chat.id, '❌ Error fetching trades. Please try again later.');
      }
    });

    // Pause command - Admin only
    this.adminCommand('pause', async (ctx) => {
      try {
        await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
        // Implementation will be added
        await this.sendMessage(ctx.chat.id, '⏸ Trading has been paused');
      } catch (error) {
        console.error('Error in pause command:', error);
        await this.sendMessage(ctx.chat.id, '❌ Error pausing trading. Please try again later.');
      }
    });

    // Resume command - Admin only
    this.adminCommand('resume', async (ctx) => {
      try {
        await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
        // Implementation will be added
        await this.sendMessage(ctx.chat.id, '▶️ Trading has been resumed');
      } catch (error) {
        console.error('Error in resume command:', error);
        await this.sendMessage(ctx.chat.id, '❌ Error resuming trading. Please try again later.');
      }
    });
  }

  async sendMessage(chatId, message, options = {}) {
    if (!this.enabled) {
      console.log('Telegram notifications are disabled');
      return false;
    }
    
    if (!this.bot) {
      console.error('Telegram bot is not initialized');
      return false;
    }

    try {
      // Always use the chat ID from the environment variables
      const targetChatId = this.chatId;
      
      if (!targetChatId) {
        console.error('No chat ID configured for Telegram messages');
        return false;
      }

      console.log(`Sending Telegram message to chat ID: ${targetChatId}`);
      
      await this.bot.telegram.sendMessage(targetChatId, message, {
        parse_mode: 'HTML',
        ...options
      });
      
      console.log('Telegram message sent successfully');
      return true;
      
    } catch (error) {
      console.error('Failed to send Telegram message:', {
        error: error.message,
        chatId: this.chatId,
        message: message.substring(0, 50) + (message.length > 50 ? '...' : '')
      });
      return false;
    }
  }

  // Public method to send notifications
  async notify(message, options = {}) {
    if (!this.enabled || !this.chatId) return false;
    return this.sendMessage(this.chatId, message, options);
  }
}

// Create and export a singleton instance
export const telegramService = new TelegramService();

export default telegramService;
