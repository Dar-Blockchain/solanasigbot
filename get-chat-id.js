require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// Check if bot token is provided
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ Please set TELEGRAM_BOT_TOKEN in your .env file');
  console.error('Get your bot token from @BotFather on Telegram');
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

console.log('🤖 Chat ID Helper Bot Started!');
console.log('📱 Send any message to your bot to get your chat ID');
console.log('⏹️  Press Ctrl+C to stop');

// Listen for any message
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.username || msg.from.first_name || 'Unknown';
  
  console.log(`\n✅ Chat ID found!`);
  console.log(`👤 User: ${userName}`);
  console.log(`💬 Chat ID: ${chatId}`);
  console.log(`\nAdd this to your .env file:`);
  console.log(`TELEGRAM_CHAT_ID=${chatId}`);
  
  // Send confirmation message
  bot.sendMessage(chatId, `✅ Your Chat ID is: \`${chatId}\`\n\nAdd this to your .env file:\n\`TELEGRAM_CHAT_ID=${chatId}\``, {
    parse_mode: 'Markdown'
  });
});

// Handle errors
bot.on('error', (error) => {
  console.error('❌ Bot error:', error.message);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down Chat ID helper...');
  bot.stopPolling();
  process.exit(0);
}); 