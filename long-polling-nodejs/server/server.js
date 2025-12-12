const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Store pending long-poll requests
// Each item: { res: Response, timeoutId: TimeoutId, userId: string }
let pendingRequests = [];

// Store notifications temporarily (in-memory queue)
let notificationQueue = [];
let notificationIdCounter = 1;

// Configuration
const LONG_POLL_TIMEOUT = 30000; // 30 seconds

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    pendingConnections: pendingRequests.length,
    queuedNotifications: notificationQueue.length,
    timestamp: new Date().toISOString()
  });
});

/**
 * Long polling endpoint
 * Client makes request and server holds it until data is available or timeout
 */
app.get('/poll', (req, res) => {
  console.log(`[${new Date().toISOString()}] New poll request received`);

  // Set headers to prevent caching
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');  // ← HTTP/1.0 (legacy)
  res.setHeader('Expires', '0');        // ← HTTP/1.0 (legacy)

  // If there are queued notifications, send them immediately
  if (notificationQueue.length > 0) {
    const notifications = [...notificationQueue];
    notificationQueue = []; // Clear the queue
    
    console.log(`[${new Date().toISOString()}] Sending ${notifications.length} queued notifications`);
    
    return res.json({
      notifications,
      timestamp: new Date().toISOString()
    });
  }

  // Set a timeout to respond after LONG_POLL_TIMEOUT
  const timeoutId = setTimeout(() => {
    // Remove this request from pending list
    pendingRequests = pendingRequests.filter(pending => pending.timeoutId !== timeoutId);
    
    console.log(`[${new Date().toISOString()}] Poll request timed out, sending empty response`);
    
    // Send empty response
    res.json({
      notifications: [],
      timestamp: new Date().toISOString()
    });
  }, LONG_POLL_TIMEOUT);

  // Store the pending request
  pendingRequests.push({ res, timeoutId });

  // Handle client disconnect
  req.on('close', () => {
    clearTimeout(timeoutId);
    pendingRequests = pendingRequests.filter(pending => pending.timeoutId !== timeoutId);
    console.log(`[${new Date().toISOString()}] Client disconnected, pending requests: ${pendingRequests.length}`);
  });
});

/**
 * Send notification endpoint
 * Broadcasts notification to all pending long-poll connections
 */
app.post('/send', (req, res) => {
  const { message, type = 'info' } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Create notification object
  const notification = {
    id: notificationIdCounter++,
    message,
    type,
    timestamp: new Date().toISOString()
  };

  console.log(`[${new Date().toISOString()}] New notification: ${message}`);

  // If there are pending requests, send immediately
  if (pendingRequests.length > 0) {
    const pendingCount = pendingRequests.length;
    console.log(`[${new Date().toISOString()}] Broadcasting to ${pendingCount} pending connections`);
    
    // Send to all pending requests
    pendingRequests.forEach(({ res, timeoutId }) => {
      clearTimeout(timeoutId);
      res.json({
        notifications: [notification],
        timestamp: new Date().toISOString()
      });
    });

    // Clear pending requests
    pendingRequests = [];
    
    // Respond to sender
    res.json({
      success: true,
      notification,
      deliveredTo: `${pendingCount} pending clients`
    });
  } else {
    // No pending requests, queue the notification
    console.log(`[${new Date().toISOString()}] No pending connections, queueing notification`);
    notificationQueue.push(notification);
    
    // Respond to sender
    res.json({
      success: true,
      notification,
      deliveredTo: 'queued'
    });
  }
});

/**
 * Clear all queued notifications
 */
app.delete('/notifications', (req, res) => {
  const count = notificationQueue.length;
  notificationQueue = [];
  res.json({ 
    success: true, 
    cleared: count 
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  Long Polling Server (Node.js) Started                     ║
╠════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                               ║
║  Health: http://localhost:${PORT}/health                     ║
║  Poll: http://localhost:${PORT}/poll                         ║
║  Send: http://localhost:${PORT}/send                         ║
║                                                            ║
║  Long Poll Timeout: ${LONG_POLL_TIMEOUT / 1000} seconds                       ║
╚════════════════════════════════════════════════════════════╝

Ready to accept long-poll connections!
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  
  // Respond to all pending requests
  pendingRequests.forEach(({ res, timeoutId }) => {
    clearTimeout(timeoutId);
    res.json({
      notifications: [],
      timestamp: new Date().toISOString(),
      serverShutdown: true
    });
  });
  
  process.exit(0);
});

