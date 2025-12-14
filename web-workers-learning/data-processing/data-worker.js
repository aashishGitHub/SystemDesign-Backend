/**
 * DATA PROCESSING WORKER
 * 
 * This worker handles CPU-intensive data processing tasks
 * without blocking the main UI thread.
 * 
 * Key Concepts:
 * - Runs in a separate thread
 * - No access to DOM or window object
 * - Communicates via postMessage()
 * - Perfect for heavy calculations
 */

// Listen for messages from the main thread
self.onmessage = function(e) {
    const { type, limit, size, records } = e.data;
    const startTime = performance.now();
    
    let result;
    
    switch(type) {
        case 'CALCULATE_PRIMES':
            result = calculatePrimes(limit);
            self.postMessage({
                type: 'PRIMES_RESULT',
                data: result,
                time: (performance.now() - startTime).toFixed(2)
            });
            break;
            
        case 'PROCESS_ARRAY':
            result = processLargeArray(size);
            self.postMessage({
                type: 'ARRAY_RESULT',
                data: result,
                time: (performance.now() - startTime).toFixed(2)
            });
            break;
            
        case 'AGGREGATE_DATA':
            result = aggregateData(records);
            self.postMessage({
                type: 'AGGREGATE_RESULT',
                data: result,
                time: (performance.now() - startTime).toFixed(2)
            });
            break;
            
        default:
            console.log('Unknown message type:', type);
    }
};

/**
 * Calculate all prime numbers up to a limit
 * Uses Sieve of Eratosthenes algorithm
 */
function calculatePrimes(limit) {
    const primes = [];
    const isPrime = new Array(limit + 1).fill(true);
    isPrime[0] = isPrime[1] = false;
    
    for (let i = 2; i * i <= limit; i++) {
        if (isPrime[i]) {
            for (let j = i * i; j <= limit; j += i) {
                isPrime[j] = false;
            }
        }
    }
    
    for (let i = 2; i <= limit; i++) {
        if (isPrime[i]) {
            primes.push(i);
        }
    }
    
    return {
        primes: primes,
        count: primes.length
    };
}

/**
 * Process a large array of random numbers
 * Calculates statistics: min, max, average, median, sum
 */
function processLargeArray(size) {
    // Generate random array
    const arr = new Array(size);
    for (let i = 0; i < size; i++) {
        arr[i] = Math.floor(Math.random() * 10000);
    }
    
    // Calculate statistics
    let sum = 0;
    let min = arr[0];
    let max = arr[0];
    
    for (let i = 0; i < arr.length; i++) {
        sum += arr[i];
        if (arr[i] < min) min = arr[i];
        if (arr[i] > max) max = arr[i];
    }
    
    const avg = (sum / arr.length).toFixed(2);
    
    // Sort for median (this is the expensive operation!)
    arr.sort((a, b) => a - b);
    const median = arr[Math.floor(arr.length / 2)];
    
    return {
        min,
        max,
        avg,
        median,
        sum
    };
}

/**
 * Aggregate data simulation
 * Simulates grouping and analyzing a large dataset
 */
function aggregateData(recordCount) {
    const categories = ['Electronics', 'Clothing', 'Food', 'Books', 'Toys'];
    const data = [];
    
    // Generate fake records
    for (let i = 0; i < recordCount; i++) {
        data.push({
            id: i,
            category: categories[Math.floor(Math.random() * categories.length)],
            amount: Math.random() * 1000,
            quantity: Math.floor(Math.random() * 10) + 1
        });
    }
    
    // Group by category
    const grouped = {};
    let totalRevenue = 0;
    
    for (const record of data) {
        if (!grouped[record.category]) {
            grouped[record.category] = {
                count: 0,
                total: 0
            };
        }
        grouped[record.category].count++;
        grouped[record.category].total += record.amount;
        totalRevenue += record.amount;
    }
    
    // Find top category
    let topCategory = '';
    let topCategoryCount = 0;
    for (const [category, stats] of Object.entries(grouped)) {
        if (stats.count > topCategoryCount) {
            topCategory = category;
            topCategoryCount = stats.count;
        }
    }
    
    return {
        categories: Object.keys(grouped).length,
        totalRevenue: totalRevenue.toFixed(2),
        avgTransaction: (totalRevenue / recordCount).toFixed(2),
        topCategory,
        topCategoryCount,
        breakdown: grouped
    };
}

// Log that worker is ready
console.log('🔧 Data Worker initialized and ready!');


