/**
 * PRODUCTION LONG POLLING SERVER
 * 
 * Real-world example: Order status tracking
 * Demonstrates how to wait for actual data changes
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());

// ============================================================================
// SIMULATED DATABASE
// In production, this would be PostgreSQL, MongoDB, etc.
// ============================================================================

// Simulated orders database
const ordersDB = new Map();

// Initialize some sample orders
ordersDB.set('order-001', {
  id: 'order-001',
  customerId: 'customer-123',
  status: 'pending',
  items: ['Widget A', 'Widget B'],
  total: 49.99,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

ordersDB.set('order-002', {
  id: 'order-002',
  customerId: 'customer-456',
  status: 'processing',
  items: ['Gadget X'],
  total: 99.99,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

// ============================================================================
// PENDING POLLS MANAGEMENT
// Track which clients are waiting for which orders
// ============================================================================

// Structure: Map<orderId, Array<{ res, lastStatus, timeoutId, intervalId }>>
const pendingPolls = new Map();

// Configuration
const POLL_INTERVAL = 2000;  // Check every 2 seconds
const POLL_TIMEOUT = 30000;  // Timeout after 30 seconds

// ============================================================================
// PATTERN 1: DATABASE POLLING (Simple, works with any database)
// ============================================================================

/**
 * Long poll endpoint for order status
 * 
 * Client sends: GET /orders/order-001/poll?lastStatus=pending
 * Server holds connection until status changes or timeout
 * 
 * Use case: E-commerce order tracking, payment status, job processing
 */
app.get('/orders/:orderId/poll', async (req, res) => {
  const { orderId } = req.params;
  const { lastStatus } = req.query;
  
  console.log(`[${new Date().toISOString()}] Long poll started for order ${orderId}, lastStatus: ${lastStatus}`);

  // Set headers to prevent caching
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Check if order exists
  const order = ordersDB.get(orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  // IMMEDIATE CHECK: If status already different, respond immediately
  if (order.status !== lastStatus) {
    console.log(`[${new Date().toISOString()}] Immediate response for ${orderId}: ${order.status}`);
    return res.json({
      orderId: order.id,
      status: order.status,
      updatedAt: order.updatedAt,
      changed: true
    });
  }

  // STATUS UNCHANGED: Start long polling
  const pollId = `${orderId}-${Date.now()}`;
  
  // Poll database at regular intervals
  const intervalId = setInterval(() => {
    const currentOrder = ordersDB.get(orderId);
    
    if (!currentOrder) {
      // Order deleted
      cleanup();
      return res.status(404).json({ error: 'Order no longer exists' });
    }
    
    if (currentOrder.status !== lastStatus) {
      // STATUS CHANGED! Respond immediately
      console.log(`[${new Date().toISOString()}] Status changed for ${orderId}: ${lastStatus} → ${currentOrder.status}`);
      cleanup();
      
      return res.json({
        orderId: currentOrder.id,
        status: currentOrder.status,
        updatedAt: currentOrder.updatedAt,
        changed: true
      });
    }
    
    console.log(`[${new Date().toISOString()}] Polling ${orderId}: no change yet`);
  }, POLL_INTERVAL);

  // Timeout after 30 seconds
  const timeoutId = setTimeout(() => {
    console.log(`[${new Date().toISOString()}] Poll timeout for ${orderId}`);
    cleanup();
    
    res.json({
      orderId: order.id,
      status: order.status,
      updatedAt: order.updatedAt,
      changed: false,
      timeout: true
    });
  }, POLL_TIMEOUT);

  // Store pending poll
  if (!pendingPolls.has(orderId)) {
    pendingPolls.set(orderId, []);
  }
  pendingPolls.get(orderId).push({
    pollId,
    res,
    lastStatus,
    intervalId,
    timeoutId
  });

  // Cleanup function
  function cleanup() {
    clearInterval(intervalId);
    clearTimeout(timeoutId);
    
    const polls = pendingPolls.get(orderId) || [];
    pendingPolls.set(
      orderId,
      polls.filter(p => p.pollId !== pollId)
    );
    
    if (pendingPolls.get(orderId).length === 0) {
      pendingPolls.delete(orderId);
    }
  }

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[${new Date().toISOString()}] Client disconnected from ${orderId} poll`);
    cleanup();
  });
});

// ============================================================================
// SIMULATE EXTERNAL UPDATES
// In production, this could be:
// - Admin dashboard update
// - Warehouse system webhook
// - Payment processor callback
// - Shipping carrier update
// ============================================================================

/**
 * Update order status
 * This simulates an external event changing the order status
 * 
 * POST /orders/:orderId/status
 * Body: { status: "shipped" }
 */
app.post('/orders/:orderId/status', (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body;
  
  const order = ordersDB.get(orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  // Valid statuses
  const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const oldStatus = order.status;
  
  // UPDATE DATABASE
  order.status = status;
  order.updatedAt = new Date().toISOString();
  ordersDB.set(orderId, order);
  
  console.log(`[${new Date().toISOString()}] Order ${orderId} status updated: ${oldStatus} → ${status}`);
  console.log(`[${new Date().toISOString()}] Pending polls for ${orderId}: ${pendingPolls.get(orderId)?.length || 0}`);

  // NOTE: The polling intervalId will detect this change automatically!
  // This is how real-world long polling works - the server keeps checking
  
  res.json({
    success: true,
    orderId,
    oldStatus,
    newStatus: status,
    pendingClients: pendingPolls.get(orderId)?.length || 0
  });
});

// ============================================================================
// HELPER ENDPOINTS
// ============================================================================

/**
 * Get current order status (non-polling)
 */
app.get('/orders/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = ordersDB.get(orderId);
  
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  
  res.json(order);
});

/**
 * List all orders
 */
app.get('/orders', (req, res) => {
  const orders = Array.from(ordersDB.values());
  res.json({ orders, count: orders.length });
});

/**
 * Create new order
 */
app.post('/orders', (req, res) => {
  const { customerId, items, total } = req.body;
  
  const orderId = `order-${Date.now()}`;
  const order = {
    id: orderId,
    customerId,
    items,
    total,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  ordersDB.set(orderId, order);
  
  res.status(201).json(order);
});

/**
 * Health check
 */
app.get('/health', (req, res) => {
  const totalOrders = ordersDB.size;
  const totalPendingPolls = Array.from(pendingPolls.values())
    .reduce((sum, polls) => sum + polls.length, 0);
  
  res.json({
    status: 'ok',
    totalOrders,
    totalPendingPolls,
    pollsByOrder: Array.from(pendingPolls.entries()).map(([orderId, polls]) => ({
      orderId,
      pendingClients: polls.length
    })),
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  Production Long Polling Server Started                   ║
╠════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                               ║
║  Type: Order Status Tracking (Real-world example)         ║
║                                                            ║
║  Endpoints:                                                ║
║  • GET  /orders                    - List all orders      ║
║  • GET  /orders/:id                - Get order details    ║
║  • GET  /orders/:id/poll           - Long poll (WAIT!)    ║
║  • POST /orders/:id/status         - Update status        ║
║  • POST /orders                    - Create order         ║
║  • GET  /health                    - Health check         ║
║                                                            ║
║  Polling Config:                                           ║
║  • Check interval: ${POLL_INTERVAL / 1000}s                                 ║
║  • Timeout: ${POLL_TIMEOUT / 1000}s                                        ║
╚════════════════════════════════════════════════════════════╝

Sample orders created:
• order-001 (status: pending)
• order-002 (status: processing)

Try this workflow:
1. Start long poll:
   curl "http://localhost:${PORT}/orders/order-001/poll?lastStatus=pending"

2. In another terminal, update status:
   curl -X POST http://localhost:${PORT}/orders/order-001/status \\
     -H "Content-Type: application/json" \\
     -d '{"status": "shipped"}'

3. Watch terminal #1 receive immediate response!

Ready to accept long-poll connections!
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  
  // Clear all intervals and timeouts
  pendingPolls.forEach((polls, orderId) => {
    polls.forEach(({ res, intervalId, timeoutId }) => {
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      res.json({
        orderId,
        serverShutdown: true
      });
    });
  });
  
  process.exit(0);
});


