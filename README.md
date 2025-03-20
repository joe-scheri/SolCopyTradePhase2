# Solana Wallet Tracker

A TypeScript application that tracks profitable traders on the Pump.fun platform on Solana blockchain.

## Features

- Tracks trader performance across different time periods (24h, 7d, 30d, 1y)
- Calculates profits in both SOL and USD
- Shows win rates and average trade sizes
- Displays current wallet balances
- Rate-limited API calls to prevent throttling
- Self-cleaning progress messages

## Future Features
- Connection to personal wallet
- Automatic percentage based copy trading of selected wallets within 500 ms of original transaction
- Manual copy trading via instant transaction notifications of selected wallets
- UI

## Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)
- A Solana RPC endpoint (currently using Helius)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/YOUR_USERNAME/solana-wallet-tracker.git
cd solana-wallet-tracker
```

2. Install dependencies:
```bash
npm install
```

## Usage

Run the tracker:
```bash
npm start
```

The tracker will process transactions in batches and display results for each time period.

## Configuration

You can modify the following constants in `walletTracker.ts`:
- `MAX_TRANSACTIONS_PER_INTERVAL`: Maximum transactions to process per time period (default: 800)
- `BATCH_SIZE`: Number of transactions to fetch in each batch (default: 50)
- `MIN_TRADES`: Minimum number of trades required to be considered a trader (default: 3)
- `BASE_DELAY`: Delay between API calls in milliseconds (default: 100)

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. 
