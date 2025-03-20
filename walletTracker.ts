import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import axios from "axios";

// Use Helius RPC for better rate limits
const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=139beb7c-3a31-4d0c-b1e6-7722cd750065";
const connection = new Connection(HELIUS_RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: undefined // Disable WebSocket connection
});

// Pump.fun smart contract address
const PUMPFUN_CONTRACT = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// Time periods in milliseconds
const TIME_PERIODS = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "1y": 365 * 24 * 60 * 60 * 1000,
};

// Rate limiting: Optimize for 10 requests/second (100ms between requests)
const BASE_DELAY = 100; // 100ms between requests = 10 requests/second
const MAX_RETRIES = 5;
const INITIAL_BACKOFF = 1000;
const BATCH_SIZE = 50; // Reduced batch size for faster initial results
const MAX_TRANSACTIONS_PER_INTERVAL = 800; // Cap transactions per time interval
const MAX_TRANSACTIONS = 1000; // Limit total transactions to process per time period

// Minimum number of trades to be considered a trader
const MIN_TRADES = 3;

// Helper function to add delay between requests
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to get current SOL price in USD
async function getSolPrice(): Promise<number> {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        return response.data.solana.usd;
    } catch (error) {
        console.warn('Failed to fetch SOL price:', error);
        return 0;
    }
}

// Helper function for exponential backoff
async function withRetry<T>(operation: () => Promise<T>, retryCount = 0): Promise<T> {
    try {
        return await operation();
    } catch (error: any) {
        if (error?.message?.includes('429') && retryCount < MAX_RETRIES) {
            const delay = INITIAL_BACKOFF * Math.pow(2, retryCount);
            // Use \r to overwrite the line and clear it
            process.stdout.write(`\rRate limited. Retrying in ${delay}ms... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
            await sleep(delay);
            // Clear the line after delay
            process.stdout.write('\r' + ' '.repeat(100) + '\r');
            return withRetry(operation, retryCount + 1);
        }
        throw error;
    }
}

// Helper function to format time
function formatTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

// Helper function to check if a transaction is a trade
function isTradeTransaction(transaction: any): boolean {
    if (!transaction?.meta?.preTokenBalances || !transaction?.meta?.postTokenBalances) {
        return false;
    }

    const preBalances = transaction.meta.preTokenBalances;
    const postBalances = transaction.meta.postTokenBalances;

    // Check if there are token balance changes
    for (let i = 0; i < preBalances.length; i++) {
        const pre = preBalances[i];
        const post = postBalances[i];
        
        if (pre && post && pre.owner && pre.uiTokenAmount && post.uiTokenAmount) {
            const preAmount = Number(pre.uiTokenAmount.amount);
            const postAmount = Number(post.uiTokenAmount.amount);
            
            // Check if there's a significant change in token balance
            if (Math.abs(postAmount - preAmount) > 0) {
                return true;
            }
        }
    }
    
    return false;
}

// Helper function to calculate SOL value of a trade
function calculateTradeValue(transaction: any): number {
    if (!transaction?.meta?.preBalances || !transaction?.meta?.postBalances) {
        return 0;
    }

    const preBalances = transaction.meta.preBalances;
    const postBalances = transaction.meta.postBalances;

    // Calculate total SOL balance change
    let totalChange = 0;
    for (let i = 0; i < preBalances.length; i++) {
        const preBalance = preBalances[i];
        const postBalance = postBalances[i];
        if (preBalance !== undefined && postBalance !== undefined) {
            const change = Math.abs(postBalance - preBalance) / LAMPORTS_PER_SOL;
            if (change > 0.001) { // Only count changes greater than 0.001 SOL
                totalChange += change;
            }
        }
    }

    return totalChange;
}

// Function to get current SOL balance for a wallet
async function getWalletSolBalance(walletAddress: string): Promise<number> {
    try {
        const publicKey = new PublicKey(walletAddress);
        const balance = await connection.getBalance(publicKey);
        return balance / LAMPORTS_PER_SOL;
    } catch (error) {
        console.warn(`Failed to fetch SOL balance for ${walletAddress}:`, error);
        return 0;
    }
}

// Add type definition for trader data
interface TraderData {
    profit: number;
    trades: number;
    totalVolume: number;
    successfulTrades: number;
    averageTradeSize: number;
    solBalance: number;
    usdProfit: number;
}

// Function to track profitable traders interacting with Pump.fun
export async function trackProfitablePumpFunTraders() {
    try {
        console.log("Trader Data: Tracking the most profitable traders on Pump.fun...");
        const now = Date.now();
        
        // Get current SOL price
        const solPrice = await getSolPrice();
        if (solPrice === 0) {
            console.error("Failed to fetch SOL price. Cannot calculate USD values.");
            return;
        }
        
        let profitTraders: { 
            [key: string]: { 
                profit: number, 
                trades: number, 
                totalVolume: number,
                successfulTrades: number,
                averageTradeSize: number,
                solBalance: number,
                usdProfit: number
            } 
        } = {};

        for (const [period, ms] of Object.entries(TIME_PERIODS)) {
            console.log(`\nFetching transactions for the last ${period}...`);
            
            // Add delay before fetching signatures
            await sleep(BASE_DELAY);
            
            // Get signatures with before parameter to properly paginate
            let allSignatures = [];
            let lastSignature = null;
            let keepFetching = true;
            let totalFetched = 0;
            
            while (keepFetching && totalFetched < MAX_TRANSACTIONS_PER_INTERVAL) {
                const options: any = { limit: BATCH_SIZE };
                if (lastSignature) {
                    options.before = lastSignature;
                }
                
                const signatures = await withRetry(() => 
                    connection.getSignaturesForAddress(PUMPFUN_CONTRACT, options)
                );
                
                if (signatures.length === 0) break;
                
                // Check if we've gone beyond our time window
                const oldestTx = signatures[signatures.length - 1];
                const oldestTxTime = oldestTx?.blockTime ? oldestTx.blockTime * 1000 : 0;
                if (oldestTxTime < now - ms) {
                    // Filter out transactions that are too old
                    const validSignatures = signatures.filter(sig => {
                        const blockTime = sig?.blockTime ? sig.blockTime * 1000 : 0;
                        return blockTime >= now - ms;
                    });
                    allSignatures.push(...validSignatures);
                    keepFetching = false;
                } else {
                    allSignatures.push(...signatures);
                    lastSignature = signatures[signatures.length - 1].signature;
                }
                
                totalFetched += signatures.length;
                
                // Stop if we've reached the transaction limit for this interval
                if (totalFetched >= MAX_TRANSACTIONS_PER_INTERVAL) {
                    console.log(`\nReached maximum transaction limit (${MAX_TRANSACTIONS_PER_INTERVAL}) for ${period}`);
                    keepFetching = false;
                }
                
                // Show intermediate results every 200 transactions
                if (totalFetched % 200 === 0 || !keepFetching) {
                    // Process the current batch of transactions
                    console.log(`\nProcessing ${allSignatures.length} transactions...`);
                    
                    let processedCount = 0;
                    for (let sig of allSignatures) {
                        try {
                            await sleep(BASE_DELAY);
                            const transaction = await withRetry(() => 
                                connection.getTransaction(sig.signature, {
                                    maxSupportedTransactionVersion: 0
                                })
                            );
                            
                            if (!transaction || !transaction.meta) continue;
                            if (!isTradeTransaction(transaction)) continue;

                            const tradeValue = calculateTradeValue(transaction);
                            if (tradeValue === 0) continue;

                            const preBalances = transaction.meta.preTokenBalances || [];
                            const postBalances = transaction.meta.postTokenBalances || [];
                            
                            for (let i = 0; i < preBalances.length; i++) {
                                const pre = preBalances[i];
                                const post = postBalances[i];
                                
                                if (pre && post && pre.owner && pre.uiTokenAmount && post.uiTokenAmount) {
                                    const change = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
                                    if (change !== 0) {
                                        if (!profitTraders[pre.owner]) {
                                            profitTraders[pre.owner] = { 
                                                profit: 0, 
                                                trades: 0, 
                                                totalVolume: 0,
                                                successfulTrades: 0,
                                                averageTradeSize: 0,
                                                solBalance: 0,
                                                usdProfit: 0
                                            };
                                        }
                                        
                                        const trader = profitTraders[pre.owner];
                                        trader.profit += change / 1e9; // Convert lamports to SOL immediately
                                        trader.trades += 1;
                                        trader.totalVolume += tradeValue;
                                        
                                        if (change > 0) {
                                            trader.successfulTrades += 1;
                                        }
                                        
                                        trader.averageTradeSize = trader.totalVolume / trader.trades;
                                    }
                                }
                            }

                            processedCount++;
                            if (processedCount % 10 === 0) {
                                process.stdout.write(`\rProcessed ${processedCount}/${allSignatures.length} transactions...`);
                            }
                        } catch (txError) {
                            console.warn(`\nError processing transaction ${sig.signature}:`, txError);
                            continue;
                        }
                    }

                    // Show intermediate results
                    console.log("\n\nIntermediate results:");
                    await displayResults(profitTraders, period, solPrice);
                }
                
                // Add delay before next batch
                await sleep(BASE_DELAY);
            }

            // Final results for this time period
            console.log(`\nFinal results for ${period} (processed ${totalFetched} transactions)`);
            await displayResults(profitTraders, period, solPrice);
            
            // Clear profit traders for next time period
            profitTraders = {};
        }
    } catch (error) {
        console.error("Error tracking profitable Pump.fun traders:", error);
    }
}

// Helper function to display results
async function displayResults(profitTraders: Record<string, TraderData>, period: string, solPrice: number) {
    // Get all traders that meet minimum criteria
    const eligibleTraders = Object.entries(profitTraders)
        .filter(([_, data]) => 
            data.trades >= MIN_TRADES && 
            data.profit > 0 && 
            (data.successfulTrades / data.trades) > 0.5
        )
        .sort((a, b) => b[1].profit - a[1].profit) // Sort by total profit
        .slice(0, 10); // Take top 10 most profitable traders

    // Update balances for eligible traders
    for (const [address, data] of eligibleTraders) {
        await sleep(BASE_DELAY);
        data.solBalance = await getWalletSolBalance(address);
        data.usdProfit = data.profit * solPrice;
    }

    // Create the output string
    let output = `\nTop 10 Most Profitable Pump.fun Traders (${period}):\n`;
    output += "--------------------------------------------------------------------------------------------------------\n";
    output += "Wallet Address                                    | Profit (SOL) | Balance (SOL) | Profit (USD) | Trades | Win Rate | Avg Trade Size\n";
    output += "--------------------------------------------------------------------------------------------------------\n";
    
    // Add each trader's data to the output string
    eligibleTraders.forEach(([address, data]: [string, TraderData]) => {
        const winRate = ((data.successfulTrades / data.trades) * 100).toFixed(1);
        const profitInSol = data.profit;
        const balanceInSol = data.solBalance;
        const profitInUsd = profitInSol * solPrice;
        const avgTradeSize = data.averageTradeSize;
        
        const formatNumber = (num: number, decimals: number = 4) => {
            return num.toLocaleString('en-US', {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            });
        };

        output += `${address.padEnd(44)} | ` +
            `${formatNumber(profitInSol, 4)} SOL | ` +
            `${formatNumber(balanceInSol, 4)} SOL | ` +
            `$${formatNumber(profitInUsd, 2)} | ` +
            `${data.trades.toString().padStart(3)} | ` +
            `${winRate.padStart(5)}% | ` +
            `${formatNumber(avgTradeSize, 4)} SOL\n`;
    });
    
    output += "--------------------------------------------------------------------------------------------------------\n\n";
    
    // Print the output
    process.stdout.write(output);
} 