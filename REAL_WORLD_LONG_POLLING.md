# Real-World Long Polling Patterns

How to implement long polling for **actual data changes** (databases, APIs, external services) - not just in-memory notifications.

---

## 🎯 The Question

> "How does the server actually WAIT for real data changes before responding?"

**Answer:** The server uses one of several patterns to detect changes:

1. **Database Polling** - Repeatedly check database
2. **Database Push** - Database notifies server (PostgreSQL LISTEN/NOTIFY)
3. **Message Queue** - Redis Pub/Sub, RabbitMQ, etc.
4. **External API Polling** - Poll third-party APIs
5. **Event-Driven** - Application events trigger responses

---

## 📊 Pattern Comparison

| Pattern | Pros | Cons | Best For |
|---------|------|------|----------|
| **Database Polling** | Simple, works with any DB | High DB load | Low traffic |
| **DB LISTEN/NOTIFY** | Very efficient, instant | PostgreSQL only | High traffic |
| **Message Queue** | Scalable, decoupled | Extra infrastructure | Microservices |
| **API Polling** | External integrations | Rate limits, slower | Third-party APIs |
| **Event-Driven** | Most efficient | Complex setup | Large systems |

---

## Pattern 1: Database Polling

### How It Works

```javascript
// Server keeps checking database every N seconds
const intervalId = setInterval(async () => {
  const currentData = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  
  if (currentData.status !== lastStatus) {
    // CHANGED! Respond to client
    res.json({ status: currentData.status });
  }
}, 2000); // Check every 2 seconds
```

### Complete Example

```javascript
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

app.get('/orders/:orderId/poll', async (req, res) => {
  const { orderId } = req.params;
  const { lastStatus } = req.query;

  // Immediate check
  const order = await db.query(
    'SELECT id, status, updated_at FROM orders WHERE id = $1',
    [orderId]
  );
  
  if (order.rows[0].status !== lastStatus) {
    return res.json(order.rows[0]); // Changed immediately
  }

  // Start polling
  const intervalId = setInterval(async () => {
    const updated = await db.query(
      'SELECT id, status, updated_at FROM orders WHERE id = $1',
      [orderId]
    );
    
    if (updated.rows[0].status !== lastStatus) {
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      res.json(updated.rows[0]);
    }
  }, 2000);

  const timeoutId = setTimeout(() => {
    clearInterval(intervalId);
    res.json({ timeout: true });
  }, 30000);

  req.on('close', () => {
    clearInterval(intervalId);
    clearTimeout(timeoutId);
  });
});
```

### Pros & Cons

✅ **Pros:**
- Simple to implement
- Works with any database
- No special database features needed

❌ **Cons:**
- High database load (many queries)
- Not instant (2-second delay)
- Doesn't scale well (1000 clients = 500 queries/second!)

### When to Use
- Low traffic (<100 concurrent users)
- Simple use cases
- Prototype/MVP
- Any database (MySQL, MongoDB, etc.)

---

## Pattern 2: Database LISTEN/NOTIFY

### How It Works

```javascript
// PostgreSQL notifies server when data changes
// Server doesn't poll - database pushes!

dbClient.query('LISTEN order_updates');

dbClient.on('notification', (msg) => {
  const { orderId, status } = JSON.parse(msg.payload);
  // Immediately respond to waiting clients
});
```

### Complete Example

**Server:**
```javascript
const { Client } = require('pg');

// Dedicated connection for listening
const listener = new Client({ connectionString: process.env.DATABASE_URL });
await listener.connect();

// Listen to channel
await listener.query('LISTEN order_updates');

// Map: orderId → [pending responses]
const pendingPolls = new Map();

// When database sends notification
listener.on('notification', (msg) => {
  const data = JSON.parse(msg.payload);
  const { orderId, status, updatedAt } = data;
  
  console.log(`Received notification for order ${orderId}: ${status}`);
  
  // Find all clients waiting for this order
  const pending = pendingPolls.get(orderId) || [];
  
  // Respond to all
  pending.forEach(({ res, timeoutId, lastStatus }) => {
    if (status !== lastStatus) {
      clearTimeout(timeoutId);
      res.json({ orderId, status, updatedAt });
    }
  });
  
  pendingPolls.delete(orderId);
});

// Long poll endpoint
app.get('/orders/:orderId/poll', async (req, res) => {
  const { orderId } = req.params;
  const { lastStatus } = req.query;

  // Check current status
  const result = await db.query(
    'SELECT * FROM orders WHERE id = $1',
    [orderId]
  );
  
  if (result.rows[0].status !== lastStatus) {
    return res.json(result.rows[0]);
  }

  // Wait for notification
  const timeoutId = setTimeout(() => {
    const pending = pendingPolls.get(orderId) || [];
    pendingPolls.set(
      orderId,
      pending.filter(p => p.res !== res)
    );
    res.json({ timeout: true });
  }, 30000);

  const pending = pendingPolls.get(orderId) || [];
  pending.push({ res, timeoutId, lastStatus });
  pendingPolls.set(orderId, pending);

  req.on('close', () => {
    clearTimeout(timeoutId);
    const pending = pendingPolls.get(orderId) || [];
    pendingPolls.set(
      orderId,
      pending.filter(p => p.res !== res)
    );
  });
});
```

**PostgreSQL Trigger:**
```sql
-- Function to send notification
CREATE OR REPLACE FUNCTION notify_order_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Send notification on order update
  PERFORM pg_notify(
    'order_updates',
    json_build_object(
      'orderId', NEW.id,
      'status', NEW.status,
      'updatedAt', NEW.updated_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on status change
CREATE TRIGGER order_status_changed
AFTER UPDATE OF status ON orders
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION notify_order_update();
```

### Pros & Cons

✅ **Pros:**
- **Instant** - No polling delay!
- **Efficient** - Zero database polling
- **Scalable** - Handles 10,000+ connections
- Database does the work

❌ **Cons:**
- PostgreSQL only
- More complex setup
- Need to manage listener connection

### When to Use
- PostgreSQL database
- High traffic (1000+ concurrent users)
- Need instant updates
- Production systems

---

## Pattern 3: Redis Pub/Sub

### How It Works

```javascript
// Server subscribes to Redis channels
// When data changes, publish to channel
// All subscribers receive instantly

subscriber.subscribe('order:123');

subscriber.on('message', (channel, message) => {
  // Respond to waiting clients
});
```

### Complete Example

```javascript
const redis = require('redis');

const subscriber = redis.createClient();
const publisher = redis.createClient();

await subscriber.connect();
await publisher.connect();

// Map: channel → [pending responses]
const pendingPolls = new Map();

app.get('/orders/:orderId/poll', async (req, res) => {
  const { orderId } = req.params;
  const { lastStatus } = req.query;
  const channel = `order:${orderId}`;

  // Check Redis cache
  const currentStatus = await publisher.get(`order:${orderId}:status`);
  
  if (currentStatus !== lastStatus) {
    return res.json({ orderId, status: currentStatus });
  }

  // Subscribe if not already
  if (!pendingPolls.has(channel)) {
    pendingPolls.set(channel, []);
    
    await subscriber.subscribe(channel, (message) => {
      const data = JSON.parse(message);
      const pending = pendingPolls.get(channel) || [];
      
      pending.forEach(({ res, timeoutId }) => {
        clearTimeout(timeoutId);
        res.json(data);
      });
      
      pendingPolls.set(channel, []);
    });
  }

  const timeoutId = setTimeout(() => {
    const pending = pendingPolls.get(channel) || [];
    pendingPolls.set(
      channel,
      pending.filter(p => p.res !== res)
    );
    res.json({ timeout: true });
  }, 30000);

  const pending = pendingPolls.get(channel) || [];
  pending.push({ res, timeoutId });
  pendingPolls.set(channel, pending);

  req.on('close', () => {
    clearTimeout(timeoutId);
    const pending = pendingPolls.get(channel) || [];
    pendingPolls.set(
      channel,
      pending.filter(p => p.res !== res)
    );
  });
});

// When order updates (webhook, background job, etc.)
async function updateOrderStatus(orderId, newStatus) {
  // Update database
  await db.query(
    'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
    [newStatus, orderId]
  );
  
  // Update Redis cache
  await publisher.set(`order:${orderId}:status`, newStatus);
  
  // Publish to subscribers (triggers long poll responses!)
  await publisher.publish(
    `order:${orderId}`,
    JSON.stringify({
      orderId,
      status: newStatus,
      updatedAt: new Date().toISOString()
    })
  );
}
```

### Pros & Cons

✅ **Pros:**
- Instant updates
- Database-agnostic
- Great for microservices
- Horizontal scaling

❌ **Cons:**
- Extra infrastructure (Redis)
- More complexity
- Need to sync Redis with DB

### When to Use
- Microservices architecture
- Multiple servers/instances
- Need to scale horizontally
- Already using Redis

---

## Pattern 4: External API Polling

### Real Example: Stripe Payment

```javascript
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.get('/payments/:paymentIntentId/poll', async (req, res) => {
  const { paymentIntentId } = req.params;
  const { lastStatus } = req.query;

  // Check immediately
  let paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  
  if (paymentIntent.status !== lastStatus) {
    return res.json({
      paymentIntentId,
      status: paymentIntent.status,
      amount: paymentIntent.amount
    });
  }

  // Poll Stripe every 3 seconds
  const intervalId = setInterval(async () => {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== lastStatus) {
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      
      res.json({
        paymentIntentId,
        status: paymentIntent.status,
        amount: paymentIntent.amount
      });
    }
  }, 3000);

  const timeoutId = setTimeout(() => {
    clearInterval(intervalId);
    res.json({ timeout: true });
  }, 30000);

  req.on('close', () => {
    clearInterval(intervalId);
    clearTimeout(timeoutId);
  });
});
```

### Pros & Cons

✅ **Pros:**
- Works with third-party APIs
- No database changes needed
- Flexible

❌ **Cons:**
- Rate limits
- API costs
- Slower (network latency)
- External dependency

### When to Use
- Payment processors (Stripe, PayPal)
- Shipping carriers (FedEx, UPS)
- Any external service
- Webhook not available

---

## 🎯 Decision Tree

```
Need to wait for data changes?
│
├─ Own database?
│  │
│  ├─ PostgreSQL?
│  │  └─ Use LISTEN/NOTIFY ✅ (Best!)
│  │
│  └─ Other DB (MySQL, MongoDB)?
│     ├─ Low traffic?
│     │  └─ Use Database Polling ✅
│     │
│     └─ High traffic?
│        └─ Use Redis Pub/Sub ✅
│
└─ External API?
   ├─ Has webhooks?
   │  └─ Use webhooks + Redis ✅
   │
   └─ No webhooks?
      └─ Poll external API ⚠️
```

---

## 💡 Production Best Practices

### 1. Always Check Immediately First
```javascript
// ✅ Good
const current = await db.query('...');
if (changed) return res.json(current); // Don't wait!

// ❌ Bad
// Always wait even if already changed
```

### 2. Set Reasonable Timeouts
```javascript
// ✅ Good
const POLL_TIMEOUT = 30000; // 30 seconds

// ❌ Bad
const POLL_TIMEOUT = 300000; // 5 minutes - too long!
```

### 3. Clean Up Resources
```javascript
// ✅ Good
req.on('close', () => {
  clearInterval(intervalId);
  clearTimeout(timeoutId);
  // Remove from pending list
});

// ❌ Bad
// Never clean up - memory leak!
```

### 4. Use Exponential Backoff for API Polling
```javascript
// ✅ Good
let delay = 1000;
const poll = async () => {
  await checkAPI();
  delay = Math.min(delay * 1.5, 10000); // Max 10s
  setTimeout(poll, delay);
};

// ❌ Bad
setInterval(() => checkAPI(), 1000); // Hammers API
```

### 5. Monitor and Log
```javascript
// ✅ Good
console.log(`Poll started: ${orderId}, clients: ${pendingCount}`);
console.log(`Poll resolved: ${orderId}, duration: ${duration}ms`);

// Track metrics
metrics.increment('long_poll.started');
metrics.timing('long_poll.duration', duration);
```

---

## 📊 Performance Comparison

**Scenario:** 1000 concurrent users, 1 update per minute

| Pattern | DB Queries/sec | Latency | Memory | Complexity |
|---------|----------------|---------|--------|------------|
| DB Polling (2s) | 500 | 0-2s | Low | Low |
| LISTEN/NOTIFY | 0 | <100ms | Low | Medium |
| Redis Pub/Sub | 0 | <100ms | Medium | Medium |
| API Polling (3s) | 0 DB, 333 API | 0-3s | Low | Low |

---

## 🚀 Try the Production Example

I've created `server-production.js` that demonstrates:
- ✅ Real database simulation
- ✅ Independent order polling
- ✅ Multiple concurrent clients
- ✅ Status change detection
- ✅ Production-ready code

**Run it:**
```bash
cd long-polling-nodejs/server
node server-production.js
```

**Test it:**
```bash
# Terminal 1: Start long poll
curl "http://localhost:4000/orders/order-001/poll?lastStatus=pending"

# Terminal 2: Update status (triggers response in Terminal 1!)
curl -X POST http://localhost:4000/orders/order-001/status \
  -H "Content-Type: application/json" \
  -d '{"status": "shipped"}'
```

---

## Summary

**Long polling for real data = Repeatedly check for changes**

The key patterns:
1. **Database Polling** - Simple, works everywhere
2. **LISTEN/NOTIFY** - PostgreSQL, super efficient
3. **Redis Pub/Sub** - Scalable, microservices
4. **API Polling** - External services

Choose based on:
- Database type
- Traffic volume
- Infrastructure
- Performance needs

**Production tip:** Start with database polling, optimize to LISTEN/NOTIFY or Redis when needed! 🎯


