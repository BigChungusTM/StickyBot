import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

class TelegramService {
  constructor() {
    this.bot = null;
    this.chatId = null;
    this.enabled = false;
    this.initialize();
  }

  initialize() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.enabled = process.env.TELEGRAM_NOTIFICATIONS_ENABLED === 'true' && !!token;

    if (!this.enabled) {
      console.log('Telegram notifications are disabled');
      return;
    }

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

  setupCommands() {
    // Start command
    this.command('start', (ctx) => {
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
      // This will be implemented to return bot status
      this.sendMessage(ctx.chat.id, 'Status command handler will be implemented');
    });

    // Balance command
    this.bot.command('balance', async (ctx) => {
      // This will be implemented to return balances
      this.sendMessage(ctx.chat.id, 'Balance command handler will be implemented');
    });

    // Trades command
    this.bot.command('trades', async (ctx) => {
      // This will be implemented to return recent trades
      this.sendMessage(ctx.chat.id, 'Trades command handler will be implemented');
    });
  }

  async sendMessage(chatId, message, options = {}) {
    if (!this.enabled || !this.bot) return false;

    try {
      const targetChatId = chatId || this.chatId;
      if (!targetChatId) {
        console.error('No chat ID provided for Telegram message');
        return false;
      }

      await this.bot.telegram.sendMessage(targetChatId, message, {
        parse_mode: 'HTML',
        ...options
      });
      return true;
    } catch (error) {
      console.error('Failed to send Telegram message:', error);
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
