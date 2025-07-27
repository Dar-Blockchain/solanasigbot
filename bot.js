require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const redis = require('redis');

// ==============================
// VALIDATE ENVIRONMENT VARIABLES
// ==============================
function validateEnvironment() {
  const requiredEnvVars = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
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
    process.exit(1);
  }

  console.log('✅ Environment variables validated successfully');
  return true;
}

// Validate environment before proceeding
validateEnvironment();

// ==============================
// CONFIGURATION
// ==============================
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const CHANNEL_USERNAME = '@memesigsol'; // Channel username

const GECKOTERMINAL_API_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';
const MAX_PAGES = 10; // Monitor 100 pages
const REQUEST_DELAY = 1000; // 1 second delay between requests
const CYCLE_DELAY = 60000; // 60 seconds between monitoring cycles

const config = {
  minLiquidity: parseInt(process.env.MIN_LIQUIDITY) || 10000,
  requirePositivePriceChange: true, // Only process tokens with positive 24h price change
  maxMarketCap: 15000000, // Maximum market cap: $15M USD
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
  PROCESSED_TOKENS: 'meteora:processed_tokens', // Changed from pools to tokens
  TOKEN_METADATA: 'meteora:token_metadata',     // Changed from pools to tokens
  SIGNAL_LOCKS: 'meteora:signal_locks'         // Signal locks for tokens
};

async function isTokenProcessed(tokenAddress) {
  try {
    if (!redisClient.isReady) {
      console.log('⚠️  Redis not ready, treating as unprocessed token');
      return false;
    }
    
    // Use async/await instead of callbacks for better reliability
    const result = await redisClient.sIsMember(REDIS_KEYS.PROCESSED_TOKENS, tokenAddress);
    console.log(`🔍 Redis check for token ${tokenAddress}: ${result} (${result === true ? 'EXISTS' : 'NOT FOUND'})`);
    return result === true;
    
  } catch (error) {
    console.error('❌ Redis error checking token:', error.message);
    return false; // Fallback to processing if Redis fails
  }
}

// Atomic operation to check and mark token in one step to prevent race conditions
async function checkAndMarkTokenAsProcessed(tokenAddress, metadata = {}) {
  try {
    if (!redisClient.isReady) {
      console.log('⚠️  Redis not ready, treating as unprocessed');
      return false; // Return false = not processed yet (safe to proceed)
    }
    
    // Use SETNX (set if not exists) for atomic check-and-set operation
    const lockKey = `${REDIS_KEYS.SIGNAL_LOCKS}:${tokenAddress}`;
    const lockValue = `${Date.now()}-${Math.random()}`;
    
    // Try to acquire lock with expiration (10 minutes max)
    const lockAcquired = await redisClient.set(lockKey, lockValue, {
      NX: true, // Only set if doesn't exist
      EX: 600   // Expire in 10 minutes
    });
    
    if (!lockAcquired) {
      console.log(`🔒 Token ${tokenAddress} is locked by another process - skipping`);
      return true; // Return true = already being processed (skip)
    }
    
    // Check if token was already processed (double-check after acquiring lock)
    const alreadyProcessed = await redisClient.sIsMember(REDIS_KEYS.PROCESSED_TOKENS, tokenAddress);
    if (alreadyProcessed) {
      console.log(`✅ Token ${tokenAddress} already in processed set - releasing lock`);
      await redisClient.del(lockKey); // Release lock
      return true; // Return true = already processed (skip)
    }
    
    // Token is not processed and we have the lock - mark it as processed immediately
    await redisClient.sAdd(REDIS_KEYS.PROCESSED_TOKENS, tokenAddress);
    console.log(`✅ Atomically marked token ${tokenAddress} as processed`);
    
    // Store metadata with timestamp
    const tokenData = {
      tokenAddress: tokenAddress,
      processedAt: new Date().toISOString(),
      lockAcquiredAt: new Date().toISOString(),
      lockValue: lockValue,
      ...metadata
    };
    
    // Convert all values to strings for Redis
    const stringifiedData = {};
    for (const [key, value] of Object.entries(tokenData)) {
      if (value !== null && value !== undefined) {
        stringifiedData[key] = String(value);
      }
    }
    
    // Store metadata
    await redisClient.hSet(
      `${REDIS_KEYS.TOKEN_METADATA}:${tokenAddress}`,
      stringifiedData
    );
    
    // Set expiration for metadata (30 days)
    await redisClient.expire(`${REDIS_KEYS.TOKEN_METADATA}:${tokenAddress}`, 30 * 24 * 60 * 60);
    
    console.log(`✅ Stored metadata for token ${tokenAddress}`);
    
    // Keep the lock until signal is sent (don't release it here)
    // We'll release it in releaseTokenLock()
    
    return false; // Return false = not processed before (safe to proceed with signal)
    
  } catch (error) {
    console.error('❌ Redis error in atomic check-and-mark:', error.message);
    return false; // Fallback to processing if Redis fails
  }
}

async function releaseTokenLock(tokenAddress) {
  try {
    if (!redisClient.isReady) {
      return;
    }
    
    const lockKey = `${REDIS_KEYS.SIGNAL_LOCKS}:${tokenAddress}`;
    await redisClient.del(lockKey);
    console.log(`🔓 Released lock for token ${tokenAddress}`);
    
  } catch (error) {
    console.error('❌ Redis error releasing lock:', error.message);
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
    console.log(`✅ Added token ${tokenAddress} to Redis set`);
    
    // Store metadata with timestamp
    const tokenData = {
      tokenAddress: tokenAddress,
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
    
    // Store metadata
    await redisClient.hSet(
      `${REDIS_KEYS.TOKEN_METADATA}:${tokenAddress}`,
      stringifiedData
    );
    
    // Set expiration for metadata (30 days)
    await redisClient.expire(`${REDIS_KEYS.TOKEN_METADATA}:${tokenAddress}`, 30 * 24 * 60 * 60);
    
    console.log(`✅ Stored metadata for token ${tokenAddress}`);
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
    
    const count = await redisClient.sCard(REDIS_KEYS.PROCESSED_TOKENS);
    console.log(`📊 Redis token count: ${count}`);
    return count || 0;
    
  } catch (error) {
    console.error('❌ Redis error getting count:', error.message);
    return 0;
  }
}

// ==============================
// UTILITY FUNCTIONS
// ==============================
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parsePoolAge(createdAt) {
  try {
    const createdTime = new Date(createdAt);
    const now = new Date();
    const ageInMs = now - createdTime;
    const ageInMinutes = ageInMs / (1000 * 60);
    const ageInHours = ageInMinutes / 60;
    
    let ageString;
    if (ageInMinutes < 60) {
      ageString = `${Math.floor(ageInMinutes)}m`;
    } else if (ageInHours < 24) {
      const hours = Math.floor(ageInHours);
      const minutes = Math.floor(ageInMinutes % 60);
      ageString = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    } else {
      const days = Math.floor(ageInHours / 24);
      ageString = `${days}d`;
    }
    
    return {
      ageString,
      ageInMinutes,
      ageInHours
    };
  } catch (error) {
    console.error('❌ Error parsing pool age:', error.message);
    return {
      ageString: 'Unknown',
      ageInMinutes: Infinity,
      ageInHours: Infinity
    };
  }
}

function isTokenNewEnough(ageInHours) {
  const maxAgeHours = 6; // 6 hours
  return ageInHours <= maxAgeHours;
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

// ==============================
// GECKOTERMINAL API FUNCTIONS
// ==============================
async function fetchNewPoolsFromPage(page) {
  try {
    console.log(`📄 Fetching page ${page} from GeckoTerminal...`);
    
    const response = await axiosWithTimeout({
      method: 'get',
      url: `${GECKOTERMINAL_API_BASE}?include=dex&page=${page}`,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, 15000);
    
    if (!response.data || !response.data.data) {
      console.log(`❌ No data found on page ${page}`);
      return [];
    }
    
    const pools = response.data.data;
    console.log(`📊 Found ${pools.length} pools on page ${page}`);
    
    return pools;
    
  } catch (error) {
    console.error(`❌ Error fetching page ${page}:`, error.message);
    return [];
  }
}

async function fetchAllNewPools() {
  try {
    console.log(`🔍 Fetching new pools from GeckoTerminal (pages 1-${MAX_PAGES})...`);
    
    let allMeteoraPools = [];
    
    for (let page = 1; page <= MAX_PAGES; page++) {
      const pools = await fetchNewPoolsFromPage(page);
      
      // Filter for Meteora pools on this page
      const meteoraPoolsOnPage = pools.filter(pool => {
        const dexId = pool.relationships?.dex?.data?.id;
        return dexId === 'meteora' || dexId === 'meteora-damm-v2';
      });
      
      console.log(`🌊 Meteora pools on page ${page}: ${meteoraPoolsOnPage.length}`);
      allMeteoraPools = allMeteoraPools.concat(meteoraPoolsOnPage);
      
      // Add delay between requests to avoid rate limiting
      if (page < MAX_PAGES) {
        await sleep(REQUEST_DELAY);
      }
    }
    
    console.log(`📊 Total Meteora pools found: ${allMeteoraPools.length}`);
    return allMeteoraPools;
    
  } catch (error) {
    console.error('❌ Error fetching pools:', error.message);
    return [];
  }
}

// ==============================
// PUMPFUN/PUMPSWAP VERIFICATION
// ==============================
async function checkPumpPools(tokenAddress) {
  try {
    console.log(`🔍 Checking PumpFun/PumpSwap pools for ${tokenAddress}...`);
    
    const response = await axiosWithTimeout({
      method: 'get',
      url: `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
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
// DATA PROCESSING FUNCTIONS
// ==============================
function extractPoolData(pool) {
  try {
    const attributes = pool.attributes;
    const relationships = pool.relationships;
    
    const poolAddress = attributes.address;
    const poolName = attributes.name;
    const createdAt = attributes.pool_created_at;
    const baseTokenId = relationships.base_token?.data?.id;
    const quoteTokenId = relationships.quote_token?.data?.id;
    const dexId = relationships.dex?.data?.id;
    
    // Extract base token address from ID (format: "solana_TOKENADDRESS")
    const baseTokenAddress = baseTokenId ? baseTokenId.replace('solana_', '') : null;
    const quoteTokenAddress = quoteTokenId ? quoteTokenId.replace('solana_', '') : null;
    
    // Parse age
    const ageData = parsePoolAge(createdAt);
    
    // Extract pricing and volume data
    const baseTokenPriceUsd = parseFloat(attributes.base_token_price_usd) || 0;
    const fdvUsd = parseFloat(attributes.fdv_usd) || 0;
    const marketCapUsd = parseFloat(attributes.market_cap_usd) || null;
    const reserveUsd = parseFloat(attributes.reserve_in_usd) || 0;
    
    // Extract price changes
    const priceChanges = attributes.price_change_percentage || {};
    const priceChange24h = parseFloat(priceChanges.h24) || 0;
    
    // Extract volume data
    const volumeUsd = attributes.volume_usd || {};
    const volume24h = parseFloat(volumeUsd.h24) || 0;
    
    // Extract transaction data
    const transactions = attributes.transactions || {};
    const txData24h = transactions.h24 || {};
    
    return {
      poolAddress,
      poolName,
      poolId: pool.id,
      createdAt,
      ageData,
      baseTokenAddress,
      quoteTokenAddress,
      dexId,
      baseToken: {
        address: baseTokenAddress,
        symbol: poolName.split(' / ')[0] || 'Unknown',
        name: poolName.split(' / ')[0] || 'Unknown Token'
      },
      pricing: {
        baseTokenPriceUsd,
        fdvUsd,
        marketCapUsd,
        reserveUsd,
        priceChange24h,
        volume24h
      },
      transactions: {
        buys24h: txData24h.buys || 0,
        sells24h: txData24h.sells || 0,
        buyers24h: txData24h.buyers || 0,
        sellers24h: txData24h.sellers || 0
      }
    };
  } catch (error) {
    console.error('❌ Error extracting pool data:', error);
    return null;
  }
}

// ==============================
// TELEGRAM SIGNAL FUNCTIONS
// ==============================
async function sendPumpGraduateSignal(poolData, pumpPools, safetyScore = null) {
  try {
    const { baseToken, pricing, ageData, poolAddress, transactions } = poolData;
    const symbol = baseToken.symbol;
    const name = baseToken.name;
    const price = pricing.baseTokenPriceUsd;
    const liquidity = pricing.reserveUsd;
    const volume24h = pricing.volume24h;
    const priceChange24h = pricing.priceChange24h;
    const tokenAddress = baseToken.address;
    const marketCap = pricing.fdvUsd;

    const safetyInfo = safetyScore ? `🛡️ **Safety Score:** ${safetyScore}/1000 ✅\n` : '';
    
    // Determine which pump platforms the token is on
    const platformsFound = [];
    if (pumpPools.hasPumpFun) platformsFound.push('PumpFun');
    if (pumpPools.hasPumpSwap) platformsFound.push('PumpSwap');
    const platformsText = platformsFound.join(' + ');

    const message = `🚀 **PUMP PLATFORM GRADUATE** 🚀\n\n` +
      `📊 **Token:** ${name} (${symbol})\n` +
      `⏰ **Pool Age:** ${ageData.ageString}\n` +
      `💰 **Price:** $${price.toFixed(8)}\n` +
      `📈 **Market Cap:** $${marketCap.toLocaleString()}\n` +
      `💧 **Liquidity:** $${liquidity.toLocaleString()}\n` +
      `📊 **24h Volume:** $${volume24h.toLocaleString()}\n` +
      `📈 **24h Change:** ${priceChange24h.toFixed(2)}%\n` +
      `${safetyInfo}` +
      `\n📱 **24h Trading Activity:**\n` +
      `   • Buys: ${transactions.buys24h} (${transactions.buyers24h} buyers)\n` +
      `   • Sells: ${transactions.sells24h} (${transactions.sellers24h} sellers)\n\n` +
      `🎓 **Graduation Path:** ${platformsText} → Meteora\n` +
      `🔗 **Token Address:** \`${tokenAddress}\`\n` +
      `🔗 **Pool Address:** \`${poolAddress}\`\n\n` +
      `📊 **DexScreener:** https://dexscreener.com/solana/${tokenAddress}\n` +
      `🌐 **Meteora:** https://app.meteora.ag/pools/${poolAddress}\n` +
      `📈 **GeckoTerminal:** https://www.geckoterminal.com/solana/pools/${poolAddress}\n\n` +
      `⚡ **Signal:** TOKEN GRADUATED FROM PUMP PLATFORM TO METEORA!\n` +
      `🎯 **Strategy:** Strong candidate - proven on pump platforms\n` +
      `🛡️ **Safety:** Verified by RugCheck\n` +
      `📡 **Source:** GeckoTerminal API (100 pages monitored)\n\n` +
      `#Meteora #PumpGraduate #${platformsText.replace(/[^a-zA-Z0-9]/g, '')} #Solana #DeFi #${symbol} #SafeToken`;

    // Send to channel
    try {
      const messagePromise = bot.sendMessage(CHANNEL_USERNAME, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Message timeout')), 10000)
      );
      
      await Promise.race([messagePromise, timeoutPromise]);
      console.log(`✅ Sent pump platform graduate signal for ${symbol} to ${CHANNEL_USERNAME}`);
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
// MAIN MONITORING LOOP
// ==============================
async function monitorMeteoraPools() {
  console.log('🔍 Starting pump platform graduate monitoring...');
  let cycleCount = 0;
  let errorCount = 0;
  
  while (true) {
    const cycleStartTime = Date.now();
    cycleCount++;
    
    try {
      console.log(`\n🔄 Starting monitoring cycle #${cycleCount} at ${new Date().toLocaleTimeString()}`);
      
      const meteoraPools = await fetchAllNewPools();
      
      if (meteoraPools.length === 0) {
        console.log('⏳ No new Meteora pools found');
        errorCount++;
      } else {
        errorCount = 0; // Reset error count on success
        console.log(`📝 Processing ${meteoraPools.length} Meteora pools...`);
        
        let graduatesFound = 0;
        
        for (let i = 0; i < meteoraPools.length; i++) {
          const pool = meteoraPools[i];
          
          try {
            const poolData = extractPoolData(pool);
            if (!poolData) {
              console.log(`❌ Failed to extract data for pool ${i + 1}`);
              continue;
            }
            
            const { baseTokenAddress, baseToken, ageData, pricing, poolAddress } = poolData;
            const symbol = baseToken.symbol;
            
            console.log(`\n[${i + 1}/${meteoraPools.length}] Processing: ${symbol} (${baseTokenAddress})`);
            console.log(`📍 Pool: ${poolAddress}`);
            console.log(`⏰ Age: ${ageData.ageString}`);
            
            // ATOMIC CHECK: Use token address for deduplication to prevent duplicate signals for same token
            const wasAlreadyProcessed = await checkAndMarkTokenAsProcessed(baseTokenAddress, {
              reason: 'initial_processing',
              symbol,
              poolAddress,
              age: ageData.ageString,
              priceChange24h: pricing.priceChange24h,
              marketCap: pricing.fdvUsd
            });
            
            if (wasAlreadyProcessed) {
              console.log(`⏭️  Token ${baseTokenAddress} already processed/locked - skipping to prevent duplicate signal`);
              continue;
            }
            
            console.log(`🔒 Acquired exclusive lock for token ${baseTokenAddress} (pool: ${poolAddress}) - proceeding with filters...`);
            
                          try {
                // Filter: Check pool age (6 hours or newer)
                if (!isTokenNewEnough(ageData.ageInHours)) {
                  console.log(`⏰ Token is too old (${ageData.ageString}) - releasing lock`);
                  await releaseTokenLock(baseTokenAddress);
                  continue;
                }
                
                // Filter: Check if has positive price change
                if (config.requirePositivePriceChange && pricing.priceChange24h <= 0) {
                  console.log(`❌ Negative 24h price change (${pricing.priceChange24h.toFixed(2)}%) - releasing lock`);
                  await releaseTokenLock(baseTokenAddress);
                  continue;
                }
                
                // Filter: Check market cap (must be under $15M)
                if (pricing.fdvUsd > config.maxMarketCap) {
                  console.log(`💰 Market cap too high ($${pricing.fdvUsd.toLocaleString()} > $${config.maxMarketCap.toLocaleString()}) - releasing lock`);
                  await releaseTokenLock(baseTokenAddress);
                  continue;
                }
              
                              console.log(`✅ ${symbol} passed age, price, and market cap filters - checking pump platforms...`);
              
              // Check for PumpFun/PumpSwap pools
              const pumpPools = await checkPumpPools(baseTokenAddress);
              
                              // Filter: Only include tokens that ARE on PumpFun/PumpSwap
                if (!pumpPools.hasPumpFun && !pumpPools.hasPumpSwap) {
                  console.log(`🚫 ${symbol} is NOT on PumpFun/PumpSwap - releasing lock`);
                  await releaseTokenLock(baseTokenAddress);
                  continue;
                }
              
              console.log(`🎓 ${symbol} is a pump platform graduate! Found on:`);
              if (pumpPools.hasPumpFun) console.log(`   ✅ PumpFun`);
              if (pumpPools.hasPumpSwap) console.log(`   ✅ PumpSwap`);
              console.log(`   ✅ Meteora`);
              
              // Check token safety before sending signal
              const { isSafe, score } = await checkTokenSafety(baseTokenAddress);
              
                              if (isSafe) {
                  console.log(`✅ ${symbol} passed all filters including safety check - sending signal!`);
                  
                  // Send the signal (token is already marked as processed from checkAndMarkTokenAsProcessed)
                  await sendPumpGraduateSignal(poolData, pumpPools, score);
                  graduatesFound++;
                  
                  console.log(`🎯 Token ${baseTokenAddress} signal sent successfully!`);
                  
                  // Release the lock after successful signal
                  await releaseTokenLock(baseTokenAddress);
                  
                } else {
                  console.log(`❌ ${symbol} failed safety check - releasing lock`);
                  await releaseTokenLock(baseTokenAddress);
                }
                
              } catch (filterError) {
                console.error(`❌ Error during filtering for ${symbol}:`, filterError.message);
                // Always release lock on error
                await releaseTokenLock(baseTokenAddress);
              }
            
            // Rate limiting between tokens
            await sleep(2000);
            
          } catch (tokenError) {
            console.error(`❌ Error processing token ${i + 1}:`, tokenError.message);
            continue;
          }
        }
        
        console.log(`\n🎯 Found ${graduatesFound} pump platform graduates`);
      }
      
      const cycleTime = ((Date.now() - cycleStartTime) / 1000).toFixed(1);
      console.log(`✅ Completed monitoring cycle #${cycleCount} in ${cycleTime}s`);
      
      // Get processed tokens count from Redis
      const processedCount = await getProcessedTokensCount();
      console.log(`💾 Total processed tokens in Redis: ${processedCount}`);
      
      // Dynamic wait time based on error count
      let waitTime = CYCLE_DELAY; // Default 60 seconds
      
      if (errorCount > 0) {
        waitTime = Math.min(CYCLE_DELAY + (errorCount * 30000), 300000); // Max 5 minutes
        console.log(`⚠️  ${errorCount} consecutive errors, waiting ${waitTime/1000}s...`);
      } else {
        console.log(`⏳ Waiting ${waitTime/1000} seconds before next cycle...`);
      }
      
      console.log(''); // Empty line for readability
      await sleep(waitTime);
      
    } catch (error) {
      console.error('❌ Critical error in monitoring loop:', error.message);
      errorCount += 5;
      
      let recoveryTime = 120000; // 2 minutes default
      if (error.response?.status === 429) {
        recoveryTime = 300000; // 5 minutes for rate limiting
        console.log('🔄 Rate limiting detected, waiting 5 minutes...');
      } else {
        console.log('🔄 Critical error, attempting recovery in 2 minutes...');
      }
      
      await sleep(recoveryTime);
    }
  }
}

// ==============================
// MAIN APPLICATION
// ==============================
async function main() {
  console.log('🤖 Starting Pump Platform Graduate Signal Bot (GeckoTerminal API)...');
  console.log(`📢 Sending signals to: ${CHANNEL_USERNAME}`);
  console.log(`📡 Source: GeckoTerminal API (${MAX_PAGES} pages)`);
  console.log(`🌊 Primary Filter: Meteora + Meteora DAMM v2 pools only`);
  console.log(`🎓 Graduate Filter: Must exist on PumpFun/PumpSwap + Meteora`);
  console.log(`⏰ Age Filter: Only tokens ≤ 6 hours old`);
  console.log(`📈 Price Filter: ${config.requirePositivePriceChange ? 'Positive 24h change only' : 'Disabled'}`);
  console.log(`💰 Market Cap Filter: Only tokens < $${(config.maxMarketCap / 1000000).toFixed(1)}M`);
  console.log(`🗄️  Storage: Redis (localhost:6379) - Token-based deduplication`);
  console.log(`🔒 Bulletproof Deduplication: One signal per token address guaranteed`);
  console.log(`⏱️  Cycle Interval: ${CYCLE_DELAY/1000} seconds`);
  
  // Connect to Redis
  try {
    await redisClient.connect();
    const processedCount = await getProcessedTokensCount();
    console.log(`💾 Found ${processedCount} previously processed tokens in Redis`);
    
    // Clean up any orphaned locks from previous runs (older than 10 minutes)
    try {
      const lockPattern = `${REDIS_KEYS.SIGNAL_LOCKS}:*`;
      const lockKeys = await redisClient.keys(lockPattern);
      if (lockKeys.length > 0) {
        console.log(`🧹 Found ${lockKeys.length} existing locks, cleaning up...`);
        await redisClient.del(lockKeys);
        console.log(`✅ Cleaned up ${lockKeys.length} orphaned locks`);
      }
    } catch (cleanupError) {
      console.error('⚠️  Error cleaning up locks:', cleanupError.message);
    }
    
  } catch (redisError) {
    console.error('❌ Failed to connect to Redis:', redisError.message);
    console.log('⚠️  Bot will continue but processed pools won\'t persist across restarts');
    console.log('🔧 Make sure Redis server is running on localhost:6379');
  }
  
  // Test channel access
  console.log('🔍 Testing channel connection...');
  try {
    const messagePromise = bot.sendMessage(CHANNEL_USERNAME, 
      '🤖 **Pump Graduate Bot Started (GeckoTerminal)!**\n\n' +
      '📊 **API Source:** GeckoTerminal (10 pages)\n' +
      '🌊 **Primary Filter:** Meteora + Meteora DAMM v2 pools\n' +
      '🎓 **Graduate Check:** PumpFun/PumpSwap verification\n' +
      '⏰ **Age Filter:** ≤6 hours old\n' +
      '📈 **Price Filter:** Positive 24h change\n' +
      '💰 **Market Cap Filter:** < $15M USD\n' +
      '🛡️ **Safety:** RugCheck verification\n' +
      '🔒 **Token-based Deduplication:** One signal per token\n' +
      '🚫 **Zero Duplicates:** Each token signaled exactly once\n\n' +
      '#BotStarted #PumpGraduate #TokenDedup #MarketCapFilter',
      { parse_mode: 'Markdown' }
    );
    
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
    }
    console.log('⚠️  Bot will continue running without channel notifications...');
  }
  
  // Start monitoring
  await monitorMeteoraPools();
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
