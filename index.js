const WebSocket = require('ws');

// Replace with your Shyft WebSocket endpoint
const wsUrl = 'wss://rpc.shyft.to?api_key=CzK9Y4ueBDkmLyTk';
const ws = new WebSocket(wsUrl);

// DAMM v2 program ID
const DAMM_V2_PROGRAM_ID = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';

ws.on('open', () => {
  console.log('Connected to Shyft WebSocket API');

  // Subscribe to logs related to the DAMM v2 program
  const subscribeMessage = {
    jsonrpc: '2.0',
    id: 1,
    method: 'logsSubscribe',
    params: [
      {
        mentions: [DAMM_V2_PROGRAM_ID]
      },
      {
        commitment: 'confirmed'
      }
    ]
  };

  ws.send(JSON.stringify(subscribeMessage));
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data);
    if (message.method === 'logsNotification') {
      const log = message.params;
      // Check if there are no errors and logs exist
      if (log.result.value.err === null && log.result.value.logs && log.result.value.logs.length > 0) {
        // Look for pool creation related logs
        // if(log.result.value.logs.includes('1') || log.result.value.logs.includes('1')){
        // }
        const poolCreationLog = log.result.value.logs.find(logLine => 
            logLine.includes('Instruction: InitializePool') ||
  logLine.includes('Program log: initialize_pool')

            

        
        //   logLine.includes('initialize_pool') || 
        //   logLine.includes('Pool created') ||
        //   logLine.includes('CreatePool')
        );
        console.log(poolCreationLog);
        if (poolCreationLog) {
          console.log('New DAMM v2 Pool Event Detected:');
          console.log('Transaction Signature:', log.signature);
          console.log('Log:', poolCreationLog);
          
          // Print all logs for additional context
          console.log('All transaction logs:');
          log.result.value.logs.forEach((logLine, index) => {
            console.log(`[${index}] ${logLine}`);
          });
        }
      }
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
});

ws.on('close', () => {
  console.log('Disconnected from Shyft WebSocket API');
});

ws.on('error', (error) => {
  console.error('WebSocket Error:', error);
});
