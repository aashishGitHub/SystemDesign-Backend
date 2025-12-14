/**
 * SERVICE WORKER
 * 
 * Service Workers are special workers that:
 * - Run in the background, independent of web pages
 * - Can intercept network requests
 * - Can cache resources for offline use
 * - Enable push notifications and background sync
 * - Are essential for Progressive Web Apps (PWAs)
 * 
 * Lifecycle:
 * 1. Install: Download and cache resources
 * 2. Activate: Clean up old caches
 * 3. Fetch: Intercept network requests
 */

const CACHE_NAME = 'web-workers-learning-v1';
const OFFLINE_URL = '/offline.html';

// Resources to cache immediately during installation
const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/service-worker-demo/service-worker-demo.html'
];

/**
 * INSTALL EVENT
 * Fired when Service Worker is first installed
 * Use this to precache essential resources
 */
self.addEventListener('install', event => {
    console.log('🔧 Service Worker installing...');
    
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('📦 Precaching resources...');
                // Cache essential resources
                return cache.addAll(PRECACHE_URLS.map(url => new Request(url, {cache: 'reload'})));
            })
            .then(() => {
                console.log('✅ Service Worker installed!');
                // Force the waiting service worker to become the active service worker
                return self.skipWaiting();
            })
            .catch(error => {
                console.error('❌ Install failed:', error);
            })
    );
});

/**
 * ACTIVATE EVENT
 * Fired when Service Worker is activated
 * Use this to clean up old caches
 */
self.addEventListener('activate', event => {
    console.log('⚡ Service Worker activating...');
    
    event.waitUntil(
        caches.keys()
            .then(cacheNames => {
                // Delete old caches
                return Promise.all(
                    cacheNames
                        .filter(name => name !== CACHE_NAME)
                        .map(name => {
                            console.log('🗑️ Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                console.log('✅ Service Worker activated!');
                // Take control of all pages immediately
                return self.clients.claim();
            })
    );
});

/**
 * FETCH EVENT
 * Intercept all network requests
 * Implement caching strategies here
 */
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);
    
    // Different strategies for different types of requests
    
    // Strategy 1: Network First (for API calls and dynamic content)
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirst(request));
        return;
    }
    
    // Strategy 2: Cache First (for static assets: CSS, JS, images)
    if (request.destination === 'style' || 
        request.destination === 'script' || 
        request.destination === 'image') {
        event.respondWith(cacheFirst(request));
        return;
    }
    
    // Strategy 3: Stale While Revalidate (for HTML pages)
    if (request.destination === 'document') {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }
    
    // Default: Network First
    event.respondWith(networkFirst(request));
});

/**
 * CACHING STRATEGY 1: Cache First
 * Check cache first, fallback to network
 * Best for: Static assets that rarely change
 */
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) {
        console.log('✅ Cache hit:', request.url);
        return addCacheHeader(cached, 'HIT');
    }
    
    try {
        const response = await fetch(request);
        
        // Cache the new response
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        
        return addCacheHeader(response, 'MISS');
    } catch (error) {
        console.error('❌ Fetch failed:', error);
        return createOfflineResponse();
    }
}

/**
 * CACHING STRATEGY 2: Network First
 * Try network first, fallback to cache
 * Best for: API calls and dynamic content
 */
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        
        // Cache successful responses
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        
        return addCacheHeader(response, 'NETWORK');
    } catch (error) {
        console.log('⚠️ Network failed, trying cache:', request.url);
        
        const cached = await caches.match(request);
        if (cached) {
            return addCacheHeader(cached, 'FALLBACK');
        }
        
        return createOfflineResponse();
    }
}

/**
 * CACHING STRATEGY 3: Stale While Revalidate
 * Return cached version immediately, update cache in background
 * Best for: Content that can be slightly stale
 */
async function staleWhileRevalidate(request) {
    const cached = await caches.match(request);
    
    // Start fetch in background
    const fetchPromise = fetch(request).then(response => {
        if (response.ok) {
            const cache = caches.open(CACHE_NAME);
            cache.then(c => c.put(request, response.clone()));
        }
        return response;
    });
    
    // Return cached version immediately if available
    if (cached) {
        console.log('✅ Serving from cache, updating in background:', request.url);
        return addCacheHeader(cached, 'STALE');
    }
    
    // Otherwise wait for network
    return fetchPromise.then(response => addCacheHeader(response, 'NETWORK'));
}

/**
 * Helper: Add cache status header to response
 */
function addCacheHeader(response, status) {
    const newHeaders = new Headers(response.headers);
    newHeaders.set('X-Cache-Status', status);
    
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}

/**
 * Helper: Create offline fallback response
 */
function createOfflineResponse() {
    return new Response(
        `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Offline</title>
            <style>
                body {
                    font-family: sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    text-align: center;
                }
                .container {
                    padding: 40px;
                    background: rgba(255,255,255,0.1);
                    border-radius: 20px;
                }
                h1 { font-size: 3em; margin: 0; }
                p { font-size: 1.2em; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📡 You're Offline</h1>
                <p>This page is not available offline.</p>
                <p>Please check your connection and try again.</p>
            </div>
        </body>
        </html>
        `,
        {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({
                'Content-Type': 'text/html',
                'X-Cache-Status': 'OFFLINE'
            })
        }
    );
}

/**
 * MESSAGE EVENT
 * Handle messages from the main thread
 */
self.addEventListener('message', event => {
    const { type, urls } = event.data;
    
    if (type === 'CACHE_URLS') {
        caches.open(CACHE_NAME).then(cache => {
            cache.addAll(urls);
            console.log('📦 Cached URLs:', urls);
        });
    }
    
    if (type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

/**
 * ADVANCED FEATURES YOU COULD ADD:
 * 
 * 1. Background Sync:
 *    - Queue failed requests
 *    - Retry when connection is restored
 * 
 * 2. Push Notifications:
 *    - Listen for push events
 *    - Show notifications to user
 * 
 * 3. Periodic Background Sync:
 *    - Update content in background
 *    - Even when app is closed
 * 
 * 4. Cache Versioning:
 *    - Implement cache expiration
 *    - Update strategies based on file types
 * 
 * 5. Analytics:
 *    - Track cache hit rates
 *    - Monitor offline usage
 */

console.log('🚀 Service Worker script loaded!');

