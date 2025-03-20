import { trackProfitablePumpFunTraders } from './walletTracker';

// Run the tracker
trackProfitablePumpFunTraders().catch((error: Error) => {
    console.error('Error running wallet tracker:', error);
    process.exit(1);
}); 