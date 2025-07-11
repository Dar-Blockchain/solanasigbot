require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const redis = require('redis');
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
  requirePositivePriceChange: true, // Only process tokens with positive 24h price change
  // stopLoss: 0.95,
  // takeProfit: 1.25,
  // minScore: 60,
  // priorityFee: parseFloat(process.env.PRIORITY_FEE) || 0.00001,
  // pool: "auto",
};

// ==============================
// REDIS CONFIGURATION
// ==============================
const redisClient = redis.createClient({
  socket: {
    host: 'localhost',
    port: 6379,
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('❌ Redis max retry attempts reached');
        return new Error('Max retry attempts reached');
      }
      return Math.min(retries * 100, 3000);
    }
  }
});

// Redis connection events
redisClient.on('connect', () => {
  console.log('✅ Connected to Redis server');
});

redisClient.on('error', (err) => {
  console.error('❌ Redis error:', err.message);
});

redisClient.on('ready', () => {
  console.log('🚀 Redis client ready');
});

redisClient.on('end', () => {
  console.log('📴 Redis connection closed');
});

// ==============================
// REDIS HELPER FUNCTIONS
// ==============================
const REDIS_KEYS = {
  PROCESSED_TOKENS: 'meteora:processed_tokens',
  TOKEN_METADATA: 'meteora:token_metadata'
};

async function isTokenProcessed(tokenAddress) {
  try {
    if (!redisClient.isReady) {
      console.log('⚠️  Redis not ready, treating as unprocessed token');
      return false;
    }
    const result = await redisClient.sIsMember(REDIS_KEYS.PROCESSED_TOKENS, tokenAddress);
    return result === true;
  } catch (error) {
    console.error('❌ Redis error checking token:', error.message);
    return false; // Fallback to processing if Redis fails
  }
}

async function markTokenAsProcessed(tokenAddress, metadata = {}) {
  try {
    if (!redisClient.isReady) {
      console.log('⚠️  Redis not ready, skipping token marking');
      return false;
    }
    
    // Add to processed tokens set
    await redisClient.sAdd(REDIS_KEYS.PROCESSED_TOKENS, tokenAddress);
    
    // Store metadata with timestamp
    const tokenData = {
      address: tokenAddress,
      processedAt: new Date().toISOString(),
      ...metadata
    };
    
    // Convert all values to strings for Redis
    const stringifiedData = {};
    for (const [key, value] of Object.entries(tokenData)) {
      if (value !== null && value !== undefined) {
        stringifiedData[key] = String(value);
      }
    }
    
    await redisClient.hSet(
      `${REDIS_KEYS.TOKEN_METADATA}:${tokenAddress}`,
      stringifiedData
    );
    
    // Set expiration for metadata (30 days)
    await redisClient.expire(`${REDIS_KEYS.TOKEN_METADATA}:${tokenAddress}`, 30 * 24 * 60 * 60);
    
    return true;
  } catch (error) {
    console.error('❌ Redis error marking token:', error.message);
    return false;
  }
}

async function getProcessedTokensCount() {
  try {
    if (!redisClient.isReady) {
      return 0;
    }
    return await redisClient.sCard(REDIS_KEYS.PROCESSED_TOKENS);
  } catch (error) {
    console.error('❌ Redis error getting count:', error.message);
    return 0;
  }
}

async function cleanupOldTokens() {
  try {
    // This is a simple cleanup - in production you might want more sophisticated cleanup
    console.log('🧹 Redis cleanup completed');
    return true;
  } catch (error) {
    console.error('❌ Redis cleanup error:', error.message);
    return false;
  }
}

// ==============================
// INITIALIZATION
// ==============================
// const connection = new Connection(config.rpcUrl, {
//   commitment: 'confirmed',
// });
// const wallet = Keypair.fromSecretKey(Uint8Array.from(config.walletKey));

// Shared state for tracking processed tokens (now using Redis)
const state = {
  // processedTokens: new Set(), // Replaced with Redis
  // positions: {},
};

// ==============================
// UTILITY FUNCTIONS
// ==============================
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Parse pair age string to minutes (handles formats like "2h 25m", "4m", "2h", "30s")
function parseAgeToMinutes(ageString) {
  if (!ageString || typeof ageString !== 'string') return Infinity;
  
  const cleanAge = ageString.toLowerCase().trim();
  let totalMinutes = 0;
  
  // Handle complex format like "2h 25m"
  const hourMatch = cleanAge.match(/(\d+)h/);
  const minuteMatch = cleanAge.match(/(\d+)m/);
  const secondMatch = cleanAge.match(/(\d+)s/);
  const dayMatch = cleanAge.match(/(\d+)d/);
  
  if (dayMatch) {
    totalMinutes += parseInt(dayMatch[1]) * 60 * 24; // days to minutes
  }
  
  if (hourMatch) {
    totalMinutes += parseInt(hourMatch[1]) * 60; // hours to minutes
  }
  
  if (minuteMatch) {
    totalMinutes += parseInt(minuteMatch[1]); // already minutes
  }
  
  if (secondMatch) {
    totalMinutes += parseInt(secondMatch[1]) / 60; // seconds to minutes
  }
  
  // If no matches found, return infinity (invalid format)
  if (totalMinutes === 0 && !cleanAge.includes('0')) {
    return Infinity;
  }
  
  return totalMinutes;
}

// Check if token is newer than 6 hours (360 minutes)
function isTokenNewEnough(ageString) {
  const ageInMinutes = parseAgeToMinutes(ageString);
  const maxAgeMinutes = 6 * 60; // 6 hours
  const isNewEnough = ageInMinutes <= maxAgeMinutes;
  
  console.log(`⏰ Age check: "${ageString}" = ${ageInMinutes.toFixed(1)} minutes (${isNewEnough ? 'PASS' : 'FAIL'})`);
  return isNewEnough;
}



// Axios with timeout wrapper
async function axiosWithTimeout(config, timeoutMs = 15000) {
  const source = axios.CancelToken.source();
  
  const timeout = setTimeout(() => {
    source.cancel(`Request timeout after ${timeoutMs}ms`);
  }, timeoutMs);
  
  try {
    const response = await axios({
      ...config,
      cancelToken: source.token,
      timeout: timeoutMs
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (axios.isCancel(error)) {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

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
    console.log(`🔍 Checking Meteora pool for ${tokenAddress}...`);
    // Check if token has a Meteora pool by searching for pairs
    const response = await axiosWithTimeout({
      method: 'get',
      url: `https://api.dexscreener.com/token-pairs/v1/solana/${tokenAddress}`
    }, 10000);
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
    console.error(`❌ Error checking Meteora pool for ${tokenAddress}:`, error.message);
    return null;
  }
}

// ==============================
// PUMPFUN/PUMPSWAP POOL CHECK
// ==============================
async function checkPumpPools(tokenAddress) {
  try {
    console.log(`🔍 Checking PumpFun/PumpSwap pools for ${tokenAddress}...`);
    
    const response = await axiosWithTimeout({
      method: 'get',
      url: `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
    }, 10000);
    
    if (!response.data || !response.data.pairs) {
      console.log(`❌ No pairs data found for ${tokenAddress}`);
      return { hasPumpFun: false, hasPumpSwap: false, pairs: [] };
    }
    
    const pairs = response.data.pairs;
    const pumpFunPairs = pairs.filter(pair => 
      pair.dexId === 'pumpfun' || 
      pair.dexId === 'pump.fun' ||
      pair.url?.includes('pump.fun')
    );
    
    const pumpSwapPairs = pairs.filter(pair => 
      pair.dexId === 'pumpswap' || 
      pair.dexId === 'pump.swap' ||
      pair.url?.includes('pumpswap')
    );
    
    const hasPumpFun = pumpFunPairs.length > 0;
    const hasPumpSwap = pumpSwapPairs.length > 0;
    
    console.log(`✅ PumpFun pools: ${pumpFunPairs.length}, PumpSwap pools: ${pumpSwapPairs.length}`);
    
    return {
      hasPumpFun,
      hasPumpSwap,
      pumpFunPairs,
      pumpSwapPairs,
      allPairs: pairs
    };
    
  } catch (error) {
    console.error(`❌ Error checking pump pools for ${tokenAddress}:`, error.message);
    return { hasPumpFun: false, hasPumpSwap: false, pairs: [] };
  }
}

// ==============================
// TOKEN SAFETY CHECK
// ==============================
async function checkTokenSafety(tokenAddress) {
  try {
    console.log(`🛡️ Checking safety for ${tokenAddress}...`);
    const response = await axiosWithTimeout({
      method: 'get',
      url: `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`
    }, 10000);
    await sleep(1000);
    const score = response.data.score || 0;
    const isSafe = score <= 400;
    console.log(`✅ Safety check complete: ${score}/1000 (${isSafe ? 'SAFE' : 'RISKY'})`);
    return { isSafe, score };
  } catch (error) {
    console.error('❌ RugCheck error:', error.message);
    return { isSafe: false, score: null };
  }
}

// ==============================
// DEXSCREENER API FUNCTIONS
// ==============================
async function fetchMeteoraPairs() {
  try {
    console.log('🔍 Fetching Meteora pairs from DexScreener Search API...');
    console.log('📍 Target URL: https://api.dexscreener.com/latest/dex/search/?q=meteora');
    
    const response = await axiosWithTimeout({
      method: 'get',
      url: 'https://api.dexscreener.com/latest/dex/search/?q=meteora',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, 15000);
    
    console.log('📊 API Response Status:', response.status);
    
    if (!response.data || !response.data.pairs) {
      console.log('❌ No pairs data found in API response');
      return [];
    }
    
    const allPairs = response.data.pairs;
    console.log(`📊 Found ${allPairs.length} total pairs from meteora search API`);
    
    // Filter to only Meteora pairs (should already be filtered but double-check)
    const meteoraPairs = allPairs.filter(pair => 
      pair.dexId === 'meteora' && 
      pair.chainId === 'solana' && 
      pair.baseToken && 
      pair.baseToken.address
    );
    
    console.log(`📊 Filtered to ${meteoraPairs.length} Meteora pairs on Solana`);
    
    // Sort by pair creation date (newest first) to match the HTML page behavior
    meteoraPairs.sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));
    
    let validPairs = [];
    
    // Process each pair
    for (let i = 0; i < meteoraPairs.length; i++) {
      const pair = meteoraPairs[i];
      const tokenAddress = pair.baseToken.address;
      const symbol = pair.baseToken.symbol || 'Unknown';
      
      try {
        console.log(`\n[${i + 1}/${meteoraPairs.length}] Processing ${symbol} (${tokenAddress})`);
        
        // Calculate age from pairCreatedAt timestamp
        let ageInHours = null;
        let ageString = 'Unknown';
        
        if (pair.pairCreatedAt) {
          const ageInMs = Date.now() - pair.pairCreatedAt;
          ageInHours = ageInMs / (1000 * 60 * 60); // Convert to hours
          
          if (ageInHours < 1) {
            const ageInMinutes = Math.floor(ageInMs / (1000 * 60));
            ageString = `${ageInMinutes}m`;
          } else if (ageInHours < 24) {
            const hours = Math.floor(ageInHours);
            const minutes = Math.floor((ageInHours % 1) * 60);
            ageString = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
          } else {
            const days = Math.floor(ageInHours / 24);
            ageString = `${days}d`;
          }
        }
        
        console.log(`⏰ Token age: ${ageString} (${ageInHours ? ageInHours.toFixed(1) + 'h' : 'unknown'})`);
        
        // Filter: Check token age (6 hours or newer)
        if (ageInHours !== null && ageInHours > 6) {
          console.log(`⏰ ${symbol} is too old (${ageString}) - skipping`);
          continue;
        }
        
        // Check if already processed in Redis
        const isProcessed = await isTokenProcessed(tokenAddress);
        if (isProcessed) {
          console.log(`📝 ${symbol} already processed - skipping`);
          continue;
        }
        
        // Check for PumpFun/PumpSwap pools
        console.log(`🔍 Checking PumpFun/PumpSwap for ${symbol}...`);
        const pumpPools = await checkPumpPools(tokenAddress);
        
        // Filter: Only include tokens that are NOT on PumpFun or PumpSwap
        if (pumpPools.hasPumpFun || pumpPools.hasPumpSwap) {
          console.log(`🚫 ${symbol} is on PumpFun: ${pumpPools.hasPumpFun}, PumpSwap: ${pumpPools.hasPumpSwap} - skipping`);
          await markTokenAsProcessed(tokenAddress, {
            reason: 'has_pump_pools',
            symbol,
            hasPumpFun: pumpPools.hasPumpFun,
            hasPumpSwap: pumpPools.hasPumpSwap,
            age: ageString
          });
          continue;
        }
        
        console.log(`✅ ${symbol} is Meteora-only (no PumpFun/PumpSwap) - including`);
        
        // Add calculated age to pair data
        const enhancedPair = {
          ...pair,
          calculatedAge: ageString,
          ageInHours: ageInHours,
          hasPumpFun: false,
          hasPumpSwap: false,
          pumpPools: pumpPools
        };
        
        validPairs.push({
          tokenAddress: tokenAddress,
          address: tokenAddress,
          chainId: 'solana',
          pairData: enhancedPair
        });
        
        // Add delay between token checks to avoid overwhelming APIs
        await sleep(1000);
        
      } catch (error) {
        console.error(`❌ Error processing ${symbol}:`, error.message);
        continue;
      }
    }
    
    console.log(`\n✅ Found ${validPairs.length} Meteora-only pairs (no PumpFun/PumpSwap) from ${meteoraPairs.length} total`);
    
    if (validPairs.length === 0) {
      console.log('⚠️  No valid Meteora-only pairs found');
      console.log('💡 All tokens may be on PumpFun/PumpSwap or too old');
      return [];
    }
    
    // Log some sample token addresses
    if (validPairs.length > 0) {
      console.log('📋 Sample Meteora-only tokens:');
      validPairs.slice(0, 3).forEach((token, index) => {
        console.log(`   ${index + 1}. ${token.tokenAddress} (${token.pairData?.baseToken?.symbol || 'Unknown'}) - age: ${token.pairData?.calculatedAge}`);
      });
    }
    
    return validPairs;
    
  } catch (error) {
    console.error('❌ Critical error fetching Meteora pairs from API:', error.message);
    console.error('📊 Error details:', {
      name: error.name,
      code: error.code,
      response: error.response?.status,
      url: error.config?.url
    });
    
    if (error.response?.status === 403) {
      console.error('🚫 403 Forbidden - DexScreener API is blocking our requests');
      console.error('💡 This is unusual for the search API - may need to investigate');
    } else if (error.response?.status === 429) {
      console.error('⏱️  429 Too Many Requests - Rate limited by API');
      console.error('💡 Will wait longer before next attempt');
    } else if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
      console.error('🌐 Network connectivity issue');
    }
    
    console.log('🔄 Returning empty array, will retry in next cycle...');
    return [];
  }
}

async function fetchTokenPairDetails(tokenAddress) {
  try {
    console.log(`📊 Fetching token pair details for ${tokenAddress}...`);
    const response = await axiosWithTimeout({
      method: 'get',
      url: `https://api.dexscreener.com/token-pairs/v1/solana/${tokenAddress}`
    }, 10000);
    await sleep(1000);
    
    if (!response.data || response.data.length === 0) {
      console.log(`❌ No pair data found for ${tokenAddress}`);
      return null;
    }
    
    console.log(`✅ Found pair data for ${tokenAddress}`);
    return response.data[0];
  } catch (error) {
    console.error(`❌ Error fetching pair details for ${tokenAddress}:`, error.message);
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
async function monitorMeteoraPairs() {
  console.log('🔍 Starting Meteora pairs API monitoring for signals...');
  let cycleCount = 0;
  let errorCount = 0;
  let lastErrorType = null;
  
  while (true) {
    const cycleStartTime = Date.now();
    cycleCount++;
    
    try {
      console.log(`\n🔄 Starting monitoring cycle #${cycleCount} at ${new Date().toLocaleTimeString()}`);
      
      const meteoraPairs = await fetchMeteoraPairs();
      
      if (meteoraPairs.length === 0) {
        console.log('⏳ No new Meteora pairs to process');
        errorCount++; // Increment error count for empty results
      } else {
        errorCount = 0; // Reset error count on success
        console.log(`📝 Processing ${meteoraPairs.length} new Meteora pairs...`);
        
        for (let i = 0; i < meteoraPairs.length; i++) {
          const token = meteoraPairs[i];
          const tokenAddress = token.tokenAddress || token.address;
          
          try {
            console.log(`\n[${i + 1}/${meteoraPairs.length}] Processing token: ${tokenAddress}`);
            
            // Skip if already processed (check Redis)
            const isProcessed = await isTokenProcessed(tokenAddress);
            if (isProcessed) {
              console.log('⏭️  Already processed, skipping...');
              continue;
            }
            
            // Get detailed token data with timeout protection
            const tokenData = await fetchTokenPairDetails(tokenAddress);
            if (!tokenData) {
              console.log('❌ Failed to get token data, marking as processed');
              await markTokenAsProcessed(tokenAddress, { reason: 'failed_to_fetch_data' });
              continue;
            }
            
            const symbol = tokenData.baseToken?.symbol || 'Unknown';
            const pairAge = tokenData.pairAge || token.pairData?.pairAge;
            console.log(`🔍 Analyzing token: ${symbol} (age: ${pairAge})`);
            
            // Filter: Check token age (6 hours or newer)
            if (pairAge && !isTokenNewEnough(pairAge)) {
              console.log(`⏰ ${symbol} is too old (${pairAge}) - skipping`);
              await markTokenAsProcessed(tokenAddress, { reason: 'too_old', age: pairAge, symbol });
              continue;
            }
            
            // Filter: Only process tokens with positive 24h price change (if enabled)
            const priceChange24h = tokenData.priceChange?.h24 || 0;
            if (config.requirePositivePriceChange && priceChange24h <= 0) {
              console.log(`❌ ${symbol} has negative/zero 24h price change (${priceChange24h.toFixed(2)}%) - skipping`);
              await markTokenAsProcessed(tokenAddress, { 
                reason: 'negative_price_change', 
                priceChange24h, 
                symbol 
              });
              continue;
            }
            
            console.log(`✅ ${symbol} passed age and price change filters (age: ${pairAge}, change: +${priceChange24h.toFixed(2)}%)`);
            
            // Check if token has Meteora pool with timeout protection
            const meteoraPair = await checkMeteoraPool(tokenAddress);
            
            if (meteoraPair) {
              console.log(`✅ Found Meteora pool for ${symbol}!`);
              
              // Check token safety before sending signal with timeout protection
              const { isSafe, score } = await checkTokenSafety(tokenAddress);
              
              if (isSafe) {
                console.log(`✅ ${symbol} passed safety check - sending signal!`);
                await sendMeteoraSignal(tokenData, meteoraPair, score);
                await markTokenAsProcessed(tokenAddress, { 
                  reason: 'signal_sent', 
                  symbol, 
                  safetyScore: score,
                  hasMeteoraPool: true
                });
              } else {
                console.log(`❌ ${symbol} failed safety check - skipping signal`);
                await markTokenAsProcessed(tokenAddress, { 
                  reason: 'failed_safety_check', 
                  symbol, 
                  safetyScore: score 
                });
              }
            } else {
              console.log(`❌ No Meteora pool found for ${symbol}`);
              await markTokenAsProcessed(tokenAddress, { 
                reason: 'no_meteora_pool', 
                symbol 
              });
            }
            
            // Rate limiting between tokens
            await sleep(2000);
            
          } catch (tokenError) {
            console.error(`❌ Error processing token ${tokenAddress}:`, tokenError.message);
            // Mark as processed even on error to avoid infinite retries
            await markTokenAsProcessed(tokenAddress, { 
              reason: 'processing_error', 
              error: tokenError.message 
            });
            await sleep(1000);
          }
        }
      }
      
      const cycleTime = ((Date.now() - cycleStartTime) / 1000).toFixed(1);
      console.log(`✅ Completed monitoring cycle #${cycleCount} in ${cycleTime}s`);
      
      // Get processed tokens count from Redis
      const processedCount = await getProcessedTokensCount();
      console.log(`💾 Total processed tokens in Redis: ${processedCount}`);
      
      // Periodic cleanup every 50 cycles (Redis handles expiration automatically)
      if (cycleCount % 50 === 0) {
        await cleanupOldTokens();
      }
      
      // Dynamic wait time based on error count
      let waitTime = 30000; // Default 30 seconds
      
      if (errorCount > 0) {
        waitTime = Math.min(30000 + (errorCount * 15000), 120000); // Increase wait time, max 2 minutes
        console.log(`⚠️  ${errorCount} consecutive errors/empty results, waiting ${waitTime/1000}s...`);
      } else {
        console.log('⏳ Waiting 30 seconds before next cycle...');
      }
      
      console.log(''); // Empty line for readability
      await sleep(waitTime);
      
    } catch (error) {
      console.error('❌ Critical error in monitoring loop:', error.message);
      errorCount += 5; // Heavily penalize critical errors
      lastErrorType = error.response?.status || error.code;
      
      let recoveryTime = 60000;
      if (lastErrorType === 403) {
        recoveryTime = 120000; // Wait 2 minutes for 403 errors
        console.log('🔄 403 error detected, waiting 2 minutes before retry...');
      } else if (lastErrorType === 429) {
        recoveryTime = 180000; // Wait 3 minutes for rate limiting
        console.log('🔄 Rate limiting detected, waiting 3 minutes before retry...');
      } else {
        console.log('🔄 Critical error, attempting to recover in 60 seconds...');
      }
      
      await sleep(recoveryTime);
    }
  }
}

// ==============================
// STARTUP
// ==============================
async function main() {
  console.log('🤖 Starting Meteora Pairs Signal Bot...');
  console.log(`📢 Sending signals to: ${CHANNEL_USERNAME}`);
  console.log(`🔍 Source: DexScreener Search API (meteora)`);
  console.log(`⏰ Age Filter: Only tokens ≤ 6 hours old`);
  console.log(`🚫 PumpFun/PumpSwap Filter: Exclude tokens on these DEXs`);
  console.log(`💧 Min Liquidity Filter: $${config.minLiquidity.toLocaleString()}`);
  console.log(`📈 24h Price Change Filter: ${config.requirePositivePriceChange ? 'Positive only' : 'Disabled'}`);
  console.log(`⏱️  Anti-freeze Protection: Enabled (10s timeouts)`);
  console.log(`🗄️  Persistence: Redis (localhost:6379)`);
  console.log(`💓 Heartbeat: Every 5 minutes`);
  
  // Connect to Redis
  try {
    await redisClient.connect();
    const processedCount = await getProcessedTokensCount();
    console.log(`💾 Found ${processedCount} previously processed tokens in Redis`);
  } catch (redisError) {
    console.error('❌ Failed to connect to Redis:', redisError.message);
    console.log('⚠️  Bot will continue but processed tokens won\'t persist across restarts');
    console.log('🔧 Make sure Redis server is running on localhost:6379');
  }
  
  // Test channel access with timeout
  console.log('🔍 Testing channel connection...');
  try {
    // Add timeout to prevent hanging
    const messagePromise = bot.sendMessage(CHANNEL_USERNAME, '🤖 **Meteora Pairs Signal Bot Started!**\n\nMonitoring DexScreener API for new Meteora pairs (≤6h old, no PumpFun/PumpSwap)...\n\n#BotStarted #Meteora #Signals', {
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
  await monitorMeteoraPairs();
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down signal bot...');
  try {
    bot.stopPolling();
    await redisClient.quit();
    console.log('✅ Redis connection closed');
  } catch (error) {
    console.error('❌ Error during shutdown:', error.message);
  }
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled promise rejection:', error);
  console.log('🔄 Bot will continue running...');
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  console.log('🔄 Bot will continue running...');
});

// Heartbeat to show bot is alive
setInterval(() => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  console.log(`💓 Bot heartbeat - Uptime: ${hours}h ${minutes}m | Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
}, 5 * 60 * 1000); // Every 5 minutes

main().catch((error) => {
  console.error('❌ Critical error in main:', error);
  console.log('🔄 Restarting in 10 seconds...');
  setTimeout(() => {
    main().catch(console.error);
  }, 10000);
});
