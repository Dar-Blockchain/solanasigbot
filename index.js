const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const redis = require('redis');
require('dotenv').config();

// ==============================
// CONFIGURATION
// ==============================
const GECKOTERMINAL_API_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';
const MAX_PAGES = 30; // Monitor pages 1-10
const REQUEST_DELAY = 1000; // 1 second delay between requests
const CYCLE_DELAY = 30000; // 30 seconds between monitoring cycles

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_USERNAME = '@memesigsol'; // Your channel

// Initialize Telegram bot if token is available
let bot = null;
if (TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
  console.log('✅ Telegram bot initialized');
} else {
  console.log('⚠️  No Telegram token found, running in monitoring-only mode');
}

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
  PROCESSED_POOLS: 'meteora:processed_pools',
  POOL_METADATA: 'meteora:pool_metadata'
};

async function isPoolProcessed(poolAddress) {
  try {
    if (!redisClient.isReady) {
      console.log('⚠️  Redis not ready, treating as unprocessed pool');
      return false;
    }
    const result = await redisClient.sIsMember(REDIS_KEYS.PROCESSED_POOLS, poolAddress);
    return result === true;
  } catch (error) {
    console.error('❌ Redis error checking pool:', error.message);
    return false; // Fallback to processing if Redis fails
  }
}

async function markPoolAsProcessed(poolAddress, metadata = {}) {
  try {
    if (!redisClient.isReady) {
      console.log('⚠️  Redis not ready, skipping pool marking');
      return false;
    }
    
    // Add to processed pools set
    await redisClient.sAdd(REDIS_KEYS.PROCESSED_POOLS, poolAddress);
    
    // Store metadata with timestamp
    const poolData = {
      address: poolAddress,
      processedAt: new Date().toISOString(),
      ...metadata
    };
    
    // Convert all values to strings for Redis
    const stringifiedData = {};
    for (const [key, value] of Object.entries(poolData)) {
      if (value !== null && value !== undefined) {
        stringifiedData[key] = String(value);
      }
    }
    
    await redisClient.hSet(
      `${REDIS_KEYS.POOL_METADATA}:${poolAddress}`,
      stringifiedData
    );
    
    // Set expiration for metadata (30 days)
    await redisClient.expire(`${REDIS_KEYS.POOL_METADATA}:${poolAddress}`, 30 * 24 * 60 * 60);
    
    return true;
  } catch (error) {
    console.error('❌ Redis error marking pool:', error.message);
    return false;
  }
}

async function getProcessedPoolsCount() {
  try {
    if (!redisClient.isReady) {
      return 0;
    }
    return await redisClient.sCard(REDIS_KEYS.PROCESSED_POOLS);
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

function isPoolNewEnough(ageInHours) {
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
    
    let allPools = [];
    
    for (let page = 1; page <= MAX_PAGES; page++) {
      const pools = await fetchNewPoolsFromPage(page);
      allPools = allPools.concat(pools);
      
      // Add delay between requests to avoid rate limiting
      if (page < MAX_PAGES) {
        await sleep(REQUEST_DELAY);
      }
    }
    
    console.log(`📊 Total pools fetched: ${allPools.length}`);
    
    // Filter for Meteora pools only
    const meteoraPools = allPools.filter(pool => {
      const dexId = pool.relationships?.dex?.data?.id;
      return dexId === 'meteora';
    });
    
    console.log(`🌊 Meteora pools found: ${meteoraPools.length}`);
    
    return meteoraPools;
    
  } catch (error) {
    console.error('❌ Error fetching pools:', error.message);
    return [];
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
// TELEGRAM NOTIFICATIONS
// ==============================
async function sendMeteoraPoolAlert(poolData) {
  if (!bot) {
    console.log('⚠️  Telegram bot not available, skipping notification');
    return;
  }

  try {
    const {
      poolAddress,
      poolName,
      ageData,
      baseTokenAddress,
      quoteTokenAddress,
      pricing,
      transactions
    } = poolData;

    // Create token name from pool name (remove "/ SOL" etc.)
    const tokenName = poolName.split(' / ')[0] || 'Unknown Token';
    
    const message = `🌊 **NEW METEORA POOL DETECTED!** 🌊\n\n` +
      `🎯 **Pool:** ${poolName}\n` +
      `⏰ **Age:** ${ageData.ageString}\n` +
      `💰 **Price:** $${pricing.baseTokenPriceUsd.toFixed(8)}\n` +
      `📊 **FDV:** $${pricing.fdvUsd.toLocaleString()}\n` +
      `${pricing.marketCapUsd ? `💎 **Market Cap:** $${pricing.marketCapUsd.toLocaleString()}\n` : ''}` +
      `💧 **Liquidity:** $${pricing.reserveUsd.toLocaleString()}\n` +
      `📈 **24h Volume:** $${pricing.volume24h.toLocaleString()}\n` +
      `📊 **24h Change:** ${pricing.priceChange24h.toFixed(2)}%\n\n` +
      `📱 **24h Activity:**\n` +
      `   • Buys: ${transactions.buys24h} (${transactions.buyers24h} buyers)\n` +
      `   • Sells: ${transactions.sells24h} (${transactions.sellers24h} sellers)\n\n` +
      `🔗 **Base Token:** \`${baseTokenAddress}\`\n` +
      `🔗 **Pool Address:** \`${poolAddress}\`\n\n` +
      `📊 **DexScreener:** https://dexscreener.com/solana/${baseTokenAddress}\n` +
      `🌐 **Meteora:** https://app.meteora.ag/pools/${poolAddress}\n` +
      `📈 **GeckoTerminal:** https://www.geckoterminal.com/solana/pools/${poolAddress}\n\n` +
      `⚡ **Source:** GeckoTerminal Real-time API\n` +
      `🎯 **DEX:** Meteora\n` +
      `🆕 **Status:** Fresh pool detection\n\n` +
      `#Meteora #NewPool #Solana #DeFi #${tokenName.replace(/[^a-zA-Z0-9]/g, '')} #RealTime`;

    await bot.sendMessage(CHANNEL_USERNAME, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    console.log(`✅ Sent Meteora pool alert for ${poolName}`);
  } catch (error) {
    console.error('❌ Error sending pool alert:', error.message);
  }
}

// ==============================
// MAIN MONITORING LOOP
// ==============================
async function monitorMeteoraPools() {
  console.log('🔍 Starting Meteora pool monitoring...');
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
        
        let newPoolsFound = 0;
        
        for (let i = 0; i < meteoraPools.length; i++) {
          const pool = meteoraPools[i];
          
          try {
            const poolData = extractPoolData(pool);
            if (!poolData) {
              console.log(`❌ Failed to extract data for pool ${i + 1}`);
              continue;
            }
            
            const { poolAddress, poolName, ageData } = poolData;
            
            console.log(`\n[${i + 1}/${meteoraPools.length}] Processing: ${poolName}`);
            console.log(`📍 Address: ${poolAddress}`);
            console.log(`⏰ Age: ${ageData.ageString}`);
            
            // Check if already processed
            const isProcessed = await isPoolProcessed(poolAddress);
            if (isProcessed) {
              console.log('⏭️  Already processed, skipping...');
              continue;
            }
            
            // Filter: Check pool age (6 hours or newer)
            if (!isPoolNewEnough(ageData.ageInHours)) {
              console.log(`⏰ Pool is too old (${ageData.ageString}) - skipping`);
              await markPoolAsProcessed(poolAddress, {
                reason: 'too_old',
                age: ageData.ageString,
                poolName
              });
              continue;
            }
            
            // Filter: Check if has positive price change (optional)
            if (poolData.pricing.priceChange24h <= 0) {
              console.log(`❌ Negative 24h price change (${poolData.pricing.priceChange24h.toFixed(2)}%) - skipping`);
              await markPoolAsProcessed(poolAddress, {
                reason: 'negative_price_change',
                priceChange24h: poolData.pricing.priceChange24h,
                poolName
              });
              continue;
            }
            
            console.log(`✅ ${poolName} passed filters - sending alert!`);
            
            // Send Telegram notification
            await sendMeteoraPoolAlert(poolData);
            newPoolsFound++;
            
            // Mark as processed
            await markPoolAsProcessed(poolAddress, {
              reason: 'alert_sent',
              poolName,
              age: ageData.ageString,
              priceChange24h: poolData.pricing.priceChange24h,
              fdv: poolData.pricing.fdvUsd
            });
            
            // Rate limiting between pools
            await sleep(2000);
            
          } catch (poolError) {
            console.error(`❌ Error processing pool ${i + 1}:`, poolError.message);
            continue;
          }
        }
        
        console.log(`\n🎯 Found ${newPoolsFound} new Meteora pools to alert`);
      }
      
      const cycleTime = ((Date.now() - cycleStartTime) / 1000).toFixed(1);
      console.log(`✅ Completed monitoring cycle #${cycleCount} in ${cycleTime}s`);
      
      // Get processed pools count from Redis
      const processedCount = await getProcessedPoolsCount();
      console.log(`💾 Total processed pools in Redis: ${processedCount}`);
      
      // Dynamic wait time based on error count
      let waitTime = CYCLE_DELAY; // Default 30 seconds
      
      if (errorCount > 0) {
        waitTime = Math.min(CYCLE_DELAY + (errorCount * 15000), 120000); // Max 2 minutes
        console.log(`⚠️  ${errorCount} consecutive errors, waiting ${waitTime/1000}s...`);
      } else {
        console.log(`⏳ Waiting ${waitTime/1000} seconds before next cycle...`);
      }
      
      console.log(''); // Empty line for readability
      await sleep(waitTime);
      
    } catch (error) {
      console.error('❌ Critical error in monitoring loop:', error.message);
      errorCount += 5;
      
      let recoveryTime = 60000; // 1 minute default
      if (error.response?.status === 429) {
        recoveryTime = 180000; // 3 minutes for rate limiting
        console.log('🔄 Rate limiting detected, waiting 3 minutes...');
      } else {
        console.log('🔄 Critical error, attempting recovery in 60 seconds...');
      }
      
      await sleep(recoveryTime);
    }
  }
}

// ==============================
// MAIN APPLICATION
// ==============================
async function main() {
  console.log('🚀 Starting Meteora Pool Monitor with GeckoTerminal API...');
  console.log(`📡 API Source: ${GECKOTERMINAL_API_BASE}`);
  console.log(`📄 Pages: 1-${MAX_PAGES}`);
  console.log(`📢 Telegram Channel: ${CHANNEL_USERNAME}`);
  console.log(`⏰ Age Filter: Only pools ≤ 6 hours old`);
  console.log(`📈 Price Filter: Positive 24h change only`);
  console.log(`🗄️  Storage: Redis (localhost:6379)`);
  console.log(`⏱️  Cycle Interval: ${CYCLE_DELAY/1000} seconds`);
  
  // Connect to Redis
  try {
    await redisClient.connect();
    const processedCount = await getProcessedPoolsCount();
    console.log(`💾 Found ${processedCount} previously processed pools in Redis`);
  } catch (redisError) {
    console.error('❌ Failed to connect to Redis:', redisError.message);
    console.log('⚠️  Bot will continue but processed pools won\'t persist across restarts');
    console.log('🔧 Make sure Redis server is running on localhost:6379');
  }
  
  // Test Telegram connection
  // if (bot) {
  //   try {
  //     await bot.sendMessage(CHANNEL_USERNAME, 
  //       '🚀 **Meteora Pool Monitor Started!**\n\n' +
  //       '📊 **Monitoring:** GeckoTerminal API (pages 1-10)\n' +
  //       '🌊 **Target:** New Meteora pools only\n' +
  //       '⏰ **Filter:** ≤6 hours old + positive 24h change\n' +
  //       '🗄️ **Storage:** Redis deduplication\n' +
  //       '📡 **Source:** Real-time GeckoTerminal API\n\n' +
  //       '#MeteoraMonitor #GeckoTerminal #NewPools #RealTime #Meteora',
  //       { parse_mode: 'Markdown' }
  //     );
  //     console.log('✅ Telegram connection verified\n');
  //   } catch (error) {
  //     console.error('❌ Telegram connection failed:', error.message);
  //   }
  // }
  
  // Start monitoring
  await monitorMeteoraPools();
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down Meteora Pool Monitor...');
  try {
    if (bot) {
      bot.stopPolling();
    }
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

// Heartbeat to show bot is alive
setInterval(() => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  console.log(`💓 Bot heartbeat - Uptime: ${hours}h ${minutes}m | Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
}, 5 * 60 * 1000); // Every 5 minutes

// Start the application
main().catch((error) => {
  console.error('❌ Application error:', error);
  process.exit(1);
});
