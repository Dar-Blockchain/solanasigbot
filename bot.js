require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
// const BN = require('bn.js');
// const fetch = require('node-fetch');
// const {
//   Connection,
//   Keypair,
//   PublicKey,
//   SystemProgram,
//   Transaction,
//   TransactionInstruction,
//   ComputeBudgetProgram,
//   LAMPORTS_PER_SOL,
//   VersionedTransaction,
// } = require('@solana/web3.js');
// const {
//   getAssociatedTokenAddress,
//   createAssociatedTokenAccountIdempotentInstruction,
//   createCloseAccountInstruction,
//   TOKEN_PROGRAM_ID,
//   ASSOCIATED_TOKEN_PROGRAM_ID,
//   createSyncNativeInstruction,
//   createInitializeAccountInstruction,
//   createAssociatedTokenAccountInstruction
// } = require('@solana/spl-token');
// const bs58 = require('bs58');

// ==============================
// VALIDATE ENVIRONMENT VARIABLES
// ==============================
function validateEnvironment() {
  const requiredEnvVars = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    // TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    // PRIVATE_KEY: process.env.PRIVATE_KEY
  };

  const missingVars = [];
  for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value || value.trim() === '') {
      missingVars.push(key);
    }
  }

  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:');
    missingVars.forEach(varName => {
      console.error(`   - ${varName}`);
    });
    console.error('\n📝 Please create a .env file in the project root with the following:');
    console.error('TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here');
    console.error('');
    console.error('🤖 To get your bot token:');
    console.error('1. Message @BotFather on Telegram');
    console.error('2. Use /newbot command to create a new bot');
    console.error('3. Copy the token and paste it in the .env file');
    console.error('');
    console.error('📢 To set up your channel:');
    console.error('1. Create a public channel or use existing one');
    console.error('2. Add your bot as an admin to the channel');
    console.error('3. Update CHANNEL_USERNAME in bot.js if needed');
    process.exit(1);
  }

  // Validate CHAT_ID format (should be a number)
  // const chatId = process.env.TELEGRAM_CHAT_ID;
  // if (isNaN(chatId)) {
  //   console.error('❌ TELEGRAM_CHAT_ID must be a number');
  //   console.error('Get your chat ID by messaging @userinfobot on Telegram');
  //   process.exit(1);
  // }

  console.log('✅ Environment variables validated successfully');
  return true;
}

// Validate environment before proceeding
validateEnvironment();

// ==============================
// TELEGRAM BOT CONFIGURATION
// ==============================
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const CHANNEL_USERNAME = '@memesigsol'; // Channel username

// ==============================
// CONSTANTS & CONFIGURATION
// ==============================
// const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const config = {
  // rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  // walletKey: JSON.parse(process.env.PRIVATE_KEY),
  // buyAmount: parseFloat(process.env.BUY_AMOUNT) || 0.08,
  // slippage: parseInt(process.env.SLIPPAGE) || 10,
  minLiquidity: parseInt(process.env.MIN_LIQUIDITY) || 10000,
  // stopLoss: 0.95,
  // takeProfit: 1.25,
  // minScore: 60,
  // priorityFee: parseFloat(process.env.PRIORITY_FEE) || 0.00001,
  // pool: "auto",
};

// ==============================
// INITIALIZATION
// ==============================
// const connection = new Connection(config.rpcUrl, {
//   commitment: 'confirmed',
// });
// const wallet = Keypair.fromSecretKey(Uint8Array.from(config.walletKey));

// Shared state for tracking processed tokens
const state = {
  processedTokens: new Set(),
  // positions: {},
};

// ==============================
// UTILITY FUNCTIONS
// ==============================
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// async function getSPLTokenBalance(tokenMintAddress) {
//   const ownerPublicKey = wallet.publicKey;
//   const tokenMintPubkey = new PublicKey(tokenMintAddress);
//   const tokenAccounts = await connection.getParsedTokenAccountsByOwner(ownerPublicKey, { mint: tokenMintPubkey });
//   let totalBalance = 0;
//   tokenAccounts.value.forEach(({ account }) => {
//     const tokenAmount = account.data.parsed.info.tokenAmount;
//     totalBalance += tokenAmount.uiAmount || 0;
//   });
//   return totalBalance;
// }

// ==============================
// METEORA POOL DETECTION
// ==============================
async function checkMeteoraPool(tokenAddress) {
  try {
    // Check if token has a Meteora pool by searching for pairs
    const response = await axios.get(`https://api.dexscreener.com/token-pairs/v1/solana/${tokenAddress}`);
    const pairs = response.data;
    
    if (!pairs || pairs.length === 0) return null;
    
    // Look for Meteora pools (DAMM v2, Dynamic AMM, DLMM)
    const meteoraPair = pairs.find(pair => 
      pair.dexId === 'meteora' || 
      pair.labels?.includes('meteora') ||
      pair.url?.includes('meteora')
    );
    
    return meteoraPair;
  } catch (error) {
    console.error(`Error checking Meteora pool for ${tokenAddress}:`, error.message);
    return null;
  }
}

// ==============================
// TOKEN SAFETY CHECK
// ==============================
async function checkTokenSafety(tokenAddress) {
  try {
    const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`);
    await sleep(1000);
    const score = response.data.score || 0;
    const isSafe = score <= 400;
    return { isSafe, score };
  } catch (error) {
    console.error('RugCheck error:', error.message);
    return { isSafe: false, score: null };
  }
}

// ==============================
// DEXSCREENER API FUNCTIONS
// ==============================
async function fetchBoostedTokens() {
  try {
    const response = await axios.get('https://api.dexscreener.com/token-boosts/latest/v1');
    console.log(response.data); 
   
    return response.data
      .filter(p => p.chainId === 'solana')
      .filter(p => !state.processedTokens.has(p.address));
  } catch (error) {
    console.error('Error fetching boosted tokens:', error.message);
    return [];
  }
}

async function fetchTokenPairDetails(tokenAddress) {
  try {
    const response = await axios.get(`https://api.dexscreener.com/token-pairs/v1/solana/${tokenAddress}`);
    await sleep(1000);
    console.log(response.data);
    return response.data[0];
  } catch (error) {
    console.error(`Error fetching pair details for ${tokenAddress}:`, error.message);
    return null;
  }
}

// ==============================
// TRADING FUNCTIONS (COMMENTED OUT)
// ==============================
// async function executeSwap(tokenAddress, amount, direction) {
//   try {
//     const tokenMint = new PublicKey(tokenAddress);
//     let swapAmount, denominatedInSol;
//     
//     if (direction === 'buy') {
//       swapAmount = amount;
//       denominatedInSol = true;
//     } else {
//       swapAmount = await getSPLTokenBalance(tokenAddress);
//       denominatedInSol = false;
//     }

//     const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json"
//       },
//       body: JSON.stringify({
//         publicKey: wallet.publicKey.toString(),
//         action: direction,
//         mint: tokenAddress,
//         denominatedInSol: denominatedInSol,
//         amount: swapAmount,
//         slippage: config.slippage,
//         priorityFee: config.priorityFee,
//         pool: config.pool
//       })
//     });

//     if (response.status === 200) {
//       const data = await response.arrayBuffer();
//       const tx = VersionedTransaction.deserialize(new Uint8Array(data));
//       tx.sign([wallet]);
//       const signature = await connection.sendTransaction(tx);
//       await connection.confirmTransaction(signature, 'confirmed');

//       let outputAmount;
//       if (direction === 'buy') {
//         const tokenAccount = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);
//         const tokenBalance = await connection.getTokenAccountBalance(tokenAccount);
//         outputAmount = tokenBalance.value.uiAmount;
//       } else {
//         const solBalance = await connection.getBalance(wallet.publicKey);
//         outputAmount = solBalance / LAMPORTS_PER_SOL;
//       }

//       return { txid: signature, outputAmount };
//     } else {
//       throw new Error(`Portal API error: ${response.statusText}`);
//     }
//   } catch (error) {
//     console.error("Swap failed:", error);
//     return { error: error.message };
//   }
// }

// ==============================
// TELEGRAM SIGNAL FUNCTIONS
// ==============================
async function sendMeteoraSignal(tokenData, meteoraPair, safetyScore = null) {
  try {
    const symbol = tokenData.baseToken?.symbol || 'Unknown';
    const name = tokenData.baseToken?.name || 'Unknown Token';
    const price = tokenData.priceUsd || 'N/A';
    const liquidity = tokenData.liquidity?.usd || 0;
    const volume24h = tokenData.volume?.h24 || 0;
    const priceChange24h = tokenData.priceChange?.h24 || 0;
    const tokenAddress = tokenData.baseToken?.address || tokenData.address;
    const marketCap = tokenData.marketCap || 0;

    const safetyInfo = safetyScore ? `🛡️ **Safety Score:** ${safetyScore}/1000 ✅\n` : '';

    const message = `🚀 **METEORA POOL SIGNAL** 🚀\n\n` +
      `📊 **Token:** ${name} (${symbol})\n` +
      `💰 **Price:** $${price}\n` +
      `📈 **Market Cap:** $${marketCap.toLocaleString()}\n` +
      `💧 **Liquidity:** $${liquidity.toLocaleString()}\n` +
      `📊 **24h Volume:** $${volume24h.toLocaleString()}\n` +
      `📈 **24h Change:** ${priceChange24h.toFixed(2)}%\n` +
      `${safetyInfo}` +
      `🔗 **Address:** \`${tokenAddress}\`\n` +
      `🌐 **DEX:** ${meteoraPair.dexId}\n` +
      `📱 **Pair:** ${meteoraPair.baseToken?.symbol}/${meteoraPair.quoteToken?.symbol}\n\n` +
      `📊 **DexScreener:** https://dexscreener.com/solana/${tokenAddress}\n` +
      `🌐 **Meteora:** https://app.meteora.ag/pools/${meteoraPair.pairAddress}\n\n` +
      `⚡ **Signal:** NEW METEORA POOL DETECTED!\n` +
      `🎯 **Strategy:** Monitor for entry opportunities\n` +
      `🛡️ **Safety:** Verified by RugCheck\n\n` +
      `#Meteora #Solana #DeFi #${symbol} #SafeToken`;

    // Send to channel without inline keyboard (signal only) with timeout
    try {
      const messagePromise = bot.sendMessage(CHANNEL_USERNAME, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Message timeout')), 10000)
      );
      
      await Promise.race([messagePromise, timeoutPromise]);
      console.log(`✅ Sent Meteora signal for ${symbol} to ${CHANNEL_USERNAME}`);
    } catch (messageError) {
      console.error(`❌ Failed to send signal for ${symbol}:`, messageError.message);
      if (messageError.message.includes('timeout')) {
        console.error('Signal sending timed out - continuing with monitoring...');
      }
    }
  } catch (error) {
    console.error('Error preparing Telegram signal:', error);
    if (error.response) {
      console.error('Telegram API response:', error.response.body);
    }
  }
}

// ==============================
// TELEGRAM BOT HANDLERS (COMMENTED OUT)
// ==============================
// bot.on('callback_query', async (callbackQuery) => {
//   const data = callbackQuery.data;
//   const chatId = callbackQuery.message.chat.id;
//   const messageId = callbackQuery.message.message_id;

//   try {
//     if (data.startsWith('buy_')) {
//       const tokenAddress = data.replace('buy_', '');
//       
//       // Check wallet balance
//       const walletBalance = await connection.getBalance(wallet.publicKey);
//       if (walletBalance <= 0.02 * 1e9) {
//         await bot.answerCallbackQuery(callbackQuery.id, {
//           text: `❌ Insufficient SOL balance: ${(walletBalance / 1e9).toFixed(4)} SOL`,
//           show_alert: true
//         });
//         return;
//       }

//       await bot.answerCallbackQuery(callbackQuery.id, {
//         text: '⏳ Executing buy order...'
//       });

//       const swapResult = await executeSwap(tokenAddress, config.buyAmount, 'buy');
//       
//       if (swapResult.txid) {
//         const tokenBalance = await getSPLTokenBalance(tokenAddress);
//         await bot.editMessageText(
//           `✅ *Buy Order Executed!*\n\n` +
//           `💰 Amount: ${config.buyAmount} SOL\n` +
//           `🪙 Received: ${tokenBalance.toLocaleString()} tokens\n` +
//           `🔗 Transaction: [View on Solscan](https://solscan.io/tx/${swapResult.txid})`,
//           {
//             chat_id: chatId,
//             message_id: messageId,
//             parse_mode: 'Markdown'
//           }
//         );
//         
//         // Store position
//         state.positions[tokenAddress] = {
//           amount: config.buyAmount,
//           tokenBalance: tokenBalance,
//           timestamp: Date.now()
//         };
//       } else {
//         await bot.editMessageText(
//           `❌ *Buy Order Failed!*\n\nError: ${swapResult.error}`,
//           {
//             chat_id: chatId,
//             message_id: messageId,
//             parse_mode: 'Markdown'
//           }
//         );
//       }
//     } else if (data.startsWith('sell_')) {
//       const tokenAddress = data.replace('sell_', '');
//       
//       const tokenBalance = await getSPLTokenBalance(tokenAddress);
//       if (tokenBalance === 0) {
//         await bot.answerCallbackQuery(callbackQuery.id, {
//           text: '❌ No tokens to sell',
//           show_alert: true
//         });
//         return;
//       }

//       await bot.answerCallbackQuery(callbackQuery.id, {
//         text: '⏳ Executing sell order...'
//       });

//       const swapResult = await executeSwap(tokenAddress, tokenBalance, 'sell');
//       
//       if (swapResult.txid) {
//         await bot.editMessageText(
//           `✅ *Sell Order Executed!*\n\n` +
//           `🪙 Sold: ${tokenBalance.toLocaleString()} tokens\n` +
//           `💰 Received: ${swapResult.outputAmount.toFixed(6)} SOL\n` +
//           `🔗 Transaction: [View on Solscan](https://solscan.io/tx/${swapResult.txid})`,
//           {
//             chat_id: chatId,
//             message_id: messageId,
//             parse_mode: 'Markdown'
//           }
//         );
//         
//         // Remove position
//         delete state.positions[tokenAddress];
//       } else {
//         await bot.editMessageText(
//           `❌ *Sell Order Failed!*\n\nError: ${swapResult.error}`,
//           {
//             chat_id: chatId,
//             message_id: messageId,
//             parse_mode: 'Markdown'
//           }
//         );
//       }
//     }
//   } catch (error) {
//     console.error('Error handling callback query:', error);
//     await bot.answerCallbackQuery(callbackQuery.id, {
//       text: '❌ An error occurred',
//       show_alert: true
//     });
//   }
// });

// ==============================
// MAIN MONITORING LOOP
// ==============================
async function monitorBoostedTokens() {
  console.log('🔍 Starting Meteora pool monitoring for signals...');
  
  while (true) {
    try {
      const boostedTokens = await fetchBoostedTokens();
      console.log(`Found ${boostedTokens.length} new boosted tokens`);
      
      for (const token of boostedTokens) {
        const tokenAddress = token.tokenAddress || token.address;
        
        // Skip if already processed
        if (state.processedTokens.has(tokenAddress)) continue;
        
        
        // Get detailed token data
        const tokenData = await fetchTokenPairDetails(tokenAddress);
        console.log(`Checking ${token.baseToken?.symbol || 'Unknown'} for Meteora pools...`);

        if (!tokenData) continue;
        
        // Check if token has Meteora pool
        const meteoraPair = await checkMeteoraPool(tokenAddress);
        
        if (meteoraPair) {
          console.log(`✅ Found Meteora pool for ${tokenData.baseToken?.symbol}!`);
          
          // Check token safety before sending signal
          console.log(`🔍 Checking token safety for ${tokenData.baseToken?.symbol}...`);
          const { isSafe, score } = await checkTokenSafety(tokenAddress);
          
          if (isSafe) {
            console.log(`✅ Token ${tokenData.baseToken?.symbol} passed safety check`);
            await sendMeteoraSignal(tokenData, meteoraPair, score);
          } else {
            console.log(`❌ Token ${tokenData.baseToken?.symbol} failed safety check - skipping signal`);
          }
        } else {
          console.log(`❌ No Meteora pool found for ${tokenData.baseToken?.symbol}`);
        }
        
        // Mark as processed
        state.processedTokens.add(tokenAddress);
        
        // Rate limiting
        await sleep(2000);
      }
      
      console.log('✅ Completed monitoring cycle');
      await sleep(30000); // Check every 30 seconds
      
    } catch (error) {
      console.error('Error in monitoring loop:', error);
      await sleep(60000); // Wait 1 minute on error
    }
  }
}

// ==============================
// STARTUP
// ==============================
async function main() {
  console.log('🤖 Starting Meteora Pool Signal Bot...');
  console.log(`📢 Sending signals to: ${CHANNEL_USERNAME}`);
  console.log(`💧 Min Liquidity Filter: $${config.minLiquidity.toLocaleString()}`);
  
  // Test channel access with timeout
  console.log('🔍 Testing channel connection...');
  try {
    // Add timeout to prevent hanging
    const messagePromise = bot.sendMessage(CHANNEL_USERNAME, '🤖 **Meteora Pool Signal Bot Started!**\n\nMonitoring for new boosted tokens with Meteora pools...\n\n#BotStarted #Meteora #Signals', {
      parse_mode: 'Markdown'
    });
    
    // Set 10 second timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Connection timeout')), 10000)
    );
    
    await Promise.race([messagePromise, timeoutPromise]);
    console.log('✅ Successfully connected to channel');
  } catch (error) {
    console.error('❌ Failed to send message to channel:', error);
    if (error.message.includes('timeout')) {
      console.error('Connection timed out. Check your internet connection and bot token.');
    } else if (error.message.includes('chat not found')) {
      console.error('Channel not found. Make sure the channel username is correct.');
    } else if (error.message.includes('Forbidden')) {
      console.error('Bot not authorized. Make sure the bot is added to the channel as an admin.');
    } else {
      console.error('Make sure:');
      console.error('1. Your TELEGRAM_BOT_TOKEN is correct in the .env file');
      console.error('2. The bot is added to the channel as an admin');
      console.error('3. The channel username is correct');
    }
    
    // Don't exit immediately, allow for debugging
    console.log('⚠️  Bot will continue running without channel notifications...');
    console.log('Press Ctrl+C to stop the bot if needed.');
  }
  
  // Start monitoring
  await monitorBoostedTokens();
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down signal bot...');
  bot.stopPolling();
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

main().catch(console.error);
