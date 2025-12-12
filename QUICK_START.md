# Quick Start Guide

Choose your demo and get running in 2 minutes! 🚀

## 📦 What's Available

```
SystemDesign-Backend/
│
├── 🟢 long-polling-nodejs/     ← Long polling with Node.js
│   ├── server/                    (Port 4000)
│   └── client/                    (Port 3000)
│
├── 🔵 long-polling-golang/     ← Long polling with Go
│   ├── server/                    (Port 4001)
│   └── client/                    (Port 3001)
│
└── 🟡 notification-demo/       ← SSE with Go
    ├── server/                    (Port 8080)
    └── client/                    (Port 3000)
```

---

## 🚀 Option 1: Long Polling with Node.js

**Best for:** Learning long polling concepts, JavaScript developers

### Terminal 1 - Start Server
```bash
cd long-polling-nodejs/server
npm install
npm start
```

### Terminal 2 - Start Client
```bash
cd long-polling-nodejs/client
npm install
npm run dev
```

### Test It
```bash
# Terminal 3 - Send a notification
curl -X POST http://localhost:4000/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from Node.js!", "type": "success"}'
```

**Open:** http://localhost:3000

---

## 🔵 Option 2: Long Polling with Golang

**Best for:** Performance, learning Go concurrency, production use

### Terminal 1 - Start Server
```bash
cd long-polling-golang/server
go run main.go
```

### Terminal 2 - Start Client
```bash
cd long-polling-golang/client
npm install
npm run dev
```

### Test It
```bash
# Terminal 3 - Send a notification
curl -X POST http://localhost:4001/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from Go!", "type": "info"}'
```

**Open:** http://localhost:3001

---

## 🟡 Option 3: Server-Sent Events (SSE) with Go

**Best for:** Most efficient server-to-client push

### Terminal 1 - Start Server
```bash
cd notification-demo/server
go run main.go
```

### Terminal 2 - Start Client
```bash
cd notification-demo/client
npm install
npm run dev
```

### Test It
```bash
# Terminal 3 - Send a notification
curl -X POST http://localhost:8080/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from SSE!", "type": "warning"}'
```

**Open:** http://localhost:3000

---

## 🎯 What to Try

Once your demo is running:

1. **📤 Send Notifications**
   - Use the web UI form
   - Try different types: info, success, warning, error
   - Watch them appear instantly!

2. **👀 Watch Connection Status**
   - See poll count increase
   - Connection state indicators
   - Real-time statistics

3. **🧪 Test with Multiple Clients**
   - Open multiple browser tabs
   - Send from one, receive in all
   - See broadcast in action

4. **💻 Test with curl**
   - Use the curl commands above
   - Watch server logs
   - See request/response cycle

---

## 🔍 Key Differences to Notice

### Long Polling (Node.js vs Go)

**Similar Behavior:**
- Both hold connections until data arrives
- Both respond immediately when notification sent
- Both timeout after 30 seconds

**Performance Differences:**

| Aspect | Node.js | Golang |
|--------|---------|--------|
| Memory per client | ~20-40 KB | ~4-8 KB |
| Max connections | 10,000-20,000 | 100,000+ |
| Response time | Few ms | Sub-ms |
| Code complexity | Callback-based | Channel-based |

**Try This:**
```bash
# Monitor server resources while running
# Node.js
cd long-polling-nodejs/server
npm start

# In another terminal
top -p $(pgrep -f "node server.js")

# vs Golang
cd long-polling-golang/server
go run main.go

# In another terminal
top -p $(pgrep -f "long-polling")
```

---

### Long Polling vs SSE

**Try Both and Notice:**

1. **Connection Pattern**
   - **Long Polling:** New HTTP request after each response
   - **SSE:** Single persistent connection

2. **Browser DevTools (Network Tab)**
   - **Long Polling:** Many requests (one per poll cycle)
   - **SSE:** One request that stays open

3. **Reconnection**
   - **Long Polling:** Manual retry logic
   - **SSE:** Browser handles automatically

4. **Latency**
   - **Long Polling:** ~200ms (reconnect overhead)
   - **SSE:** ~50ms (persistent connection)

---

## 🎓 Learning Exercise

### Run All Three Side-by-Side!

**Terminal Setup:**
```bash
# Terminal 1: Node.js Long Poll Server
cd long-polling-nodejs/server && npm start

# Terminal 2: Go Long Poll Server  
cd long-polling-golang/server && go run main.go

# Terminal 3: SSE Server
cd notification-demo/server && go run main.go

# Terminal 4: Node.js Client
cd long-polling-nodejs/client && npm run dev

# Terminal 5: Go Client
cd long-polling-golang/client && npm run dev

# Terminal 6: SSE Client
cd notification-demo/client && npm run dev
```

**Open 3 Browser Windows:**
- http://localhost:3000 (Node.js Long Poll)
- http://localhost:3001 (Go Long Poll)
- http://localhost:3000 (SSE) - use different profile/incognito

**Send notifications to each and compare:**
```bash
# To Node.js
curl -X POST http://localhost:4000/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Node.js test", "type": "info"}'

# To Go
curl -X POST http://localhost:4001/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Go test", "type": "success"}'

# To SSE
curl -X POST http://localhost:8080/send \
  -H "Content-Type: application/json" \
  -d '{"message": "SSE test", "type": "warning"}'
```

---

## 🐛 Troubleshooting

### Port Already in Use

```bash
# Find what's using the port
lsof -ti:4000 | xargs kill -9  # Node.js long poll
lsof -ti:4001 | xargs kill -9  # Go long poll
lsof -ti:8080 | xargs kill -9  # SSE
lsof -ti:3000 | xargs kill -9  # Client
```

### Go Not Installed

```bash
# macOS
brew install go

# Ubuntu/Debian
sudo apt install golang

# Check installation
go version
```

### Node.js Not Installed

```bash
# macOS
brew install node

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Check installation
node --version
npm --version
```

### Dependencies Not Installing

```bash
# Clear npm cache
npm cache clean --force

# Remove node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

---

## 📊 Monitoring Commands

### Watch Server Logs

```bash
# Node.js with timestamps
cd long-polling-nodejs/server
npm start 2>&1 | while read line; do echo "$(date '+%H:%M:%S') $line"; done

# Go with timestamps  
cd long-polling-golang/server
go run main.go 2>&1 | while read line; do echo "$(date '+%H:%M:%S') $line"; done
```

### Monitor Active Connections

```bash
# Check pending connections
curl http://localhost:4000/health  # Node.js
curl http://localhost:4001/health  # Go
curl http://localhost:8080/health  # SSE
```

### Watch Network Activity

```bash
# Monitor HTTP requests (macOS)
nettop -P -L 1 -J bytes_in,bytes_out -p node
nettop -P -L 1 -J bytes_in,bytes_out -p long-polling

# Or use lsof
watch -n 1 'lsof -i :4000'  # Node.js
watch -n 1 'lsof -i :4001'  # Go
watch -n 1 'lsof -i :8080'  # SSE
```

---

## 🎯 Next Steps

1. ✅ Get one demo running
2. ✅ Read the relevant README:
   - [`long-polling-nodejs/README.md`](./long-polling-nodejs/README.md)
   - [`long-polling-golang/README.md`](./long-polling-golang/README.md)
   - [`notification-demo/README.md`](./notification-demo/README.md)
3. ✅ Read [`POLLING_COMPARISON.md`](./POLLING_COMPARISON.md) for deep comparison
4. ✅ Try modifying the code
5. ✅ Compare all three implementations

---

## 💡 Pro Tips

1. **Use Browser DevTools**
   - Open Network tab to see requests
   - Check Console for logs
   - Monitor connection status

2. **Test with Multiple Tabs**
   - See broadcast in action
   - Understand connection management
   - Compare behavior across technologies

3. **Read the Code**
   - Start with the hook files (`useLongPolling.ts`, `useSSE.ts`)
   - Then read server implementations
   - Follow the data flow

4. **Experiment**
   - Change timeout values
   - Add more notification types
   - Implement user-specific channels
   - Add authentication

---

**Happy Coding! 🚀**

