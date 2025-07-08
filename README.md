# Meteora Pool Monitor Telegram Bot

A Telegram bot that monitors DexScreener boosted tokens and alerts you when they have Meteora pools, with integrated buy/sell functionality.

## Features

- 🔍 Monitors DexScreener boosted tokens in real-time
- 🌐 Detects tokens with Meteora pools (DAMM v2, Dynamic AMM, DLMM)
- 📱 Sends Telegram alerts with token details
- 💰 Integrated buy/sell buttons for instant trading
- 🔗 Direct links to DexScreener and Meteora
- 📊 Shows price, liquidity, volume, and 24h change

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Create a new bot with `/newbot`
3. Get your bot token
4. Get your chat ID by messaging [@userinfobot](https://t.me/userinfobot)

### 3. Environment Variables

Create a `.env` file in the root directory:

```env
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here

# Solana Configuration
RPC_URL=https://api.mainnet-beta.solana.com
PRIVATE_KEY=[your_private_key_array_here]

# Trading Configuration (optional)
BUY_AMOUNT=0.08
SLIPPAGE=10
MIN_LIQUIDITY=10000
PRIORITY_FEE=0.00001
```

### 4. Configure Your Wallet

Convert your private key to the required format:

```javascript
// If you have a base58 private key
const bs58 = require('bs58');
const privateKeyArray = Array.from(bs58.decode('your_base58_private_key'));
console.log(JSON.stringify(privateKeyArray));
```

### 5. Run the Bot

```bash
# Start the Telegram bot
npm start

# Or run the WebSocket monitor separately
npm run websocket
```

## How It Works

1. **Token Discovery**: Fetches boosted tokens from DexScreener API
2. **Meteora Detection**: Checks each token for Meteora pools
3. **Alert System**: Sends formatted alerts to Telegram with token details
4. **Trading Interface**: Provides buy/sell buttons for instant trading
5. **Transaction Tracking**: Monitors and reports trade execution

## Bot Commands

The bot responds to inline keyboard buttons:

- 🟢 **Buy 0.08 SOL**: Executes a buy order for the specified amount
- 🔴 **Sell All**: Sells all tokens of that type in your wallet
- 📊 **View on DexScreener**: Opens token page on DexScreener
- 🌐 **View on Meteora**: Opens pool page on Meteora

## Configuration Options

Edit the `config` object in `bot.js`:

```javascript
const config = {
  buyAmount: 0.08,      // SOL amount per buy order
  slippage: 10,         // Slippage tolerance (basis points)
  minLiquidity: 10000,  // Minimum liquidity threshold (USD)
  priorityFee: 0.00001, // Priority fee for transactions
  pool: "auto",         // Exchange routing
};
```

## Safety Features

- ✅ Wallet balance checks before trading
- ✅ Token balance verification before selling
- ✅ Transaction confirmation and error handling
- ✅ Rate limiting to prevent API abuse
- ✅ Duplicate token filtering

## Files Structure

- `bot.js` - Main Telegram bot with trading functionality
- `index.js` - WebSocket monitor for real-time events
- `package.json` - Dependencies and scripts
- `.env` - Environment variables (create this)

## Troubleshooting

### Common Issues

1. **Bot not responding**: Check your `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
2. **Trading fails**: Verify your `PRIVATE_KEY` format and wallet balance
3. **API errors**: Check your RPC URL and network connectivity

### Error Messages

- `❌ Insufficient SOL balance`: Add more SOL to your wallet
- `❌ No tokens to sell`: You don't own any tokens of that type
- `❌ An error occurred`: Check logs for detailed error information

## Security Notes

- 🔒 Never share your private key or .env file
- 🔒 Use a dedicated trading wallet with limited funds
- 🔒 Monitor your trades and set appropriate limits
- 🔒 Test on devnet before using mainnet

## Disclaimer

This bot is for educational purposes. Trading cryptocurrencies involves risk. Only trade with funds you can afford to lose.

## License

MIT License 