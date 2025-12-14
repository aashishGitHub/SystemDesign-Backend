package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// Notification represents a message sent to clients
type Notification struct {
	ID        int       `json:"id"`
	Type      string    `json:"type"`
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
}

// Client represents a connected SSE client
type Client struct {
	ID     string
	Events chan Notification
}

// Hub manages all connected clients
type Hub struct {
	clients    map[string]*Client
	register   chan *Client
	unregister chan *Client
	broadcast  chan Notification
	mu         sync.RWMutex
}

// NewHub creates a new Hub instance
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[string]*Client),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan Notification),
	}
}

// Run starts the hub's main loop
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.ID] = client
			h.mu.Unlock()
			log.Printf("Client connected: %s (total: %d)", client.ID, len(h.clients))

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client.ID]; ok {
				delete(h.clients, client.ID)
				close(client.Events)
			}
			h.mu.Unlock()
			log.Printf("Client disconnected: %s (total: %d)", client.ID, len(h.clients))

		case notification := <-h.broadcast:
			h.mu.RLock()
			for _, client := range h.clients {
				select {
				case client.Events <- notification:
				default:
					// Client buffer full, skip
				}
			}
			h.mu.RUnlock()
		}
	}
}

var hub = NewHub()
var notificationID = 0

func main() {
	// Start the hub
	go hub.Run()

	// Start a goroutine to send periodic notifications
	go sendPeriodicNotifications()

	// Setup routes
	http.HandleFunc("/events", handleSSE)
	http.HandleFunc("/send", handleSendNotification)
	http.HandleFunc("/health", handleHealth)

	// Enable CORS for all routes
	handler := corsMiddleware(http.DefaultServeMux)

	log.Println("🚀 SSE Server starting on http://localhost:8080")
	log.Println("📡 SSE endpoint: http://localhost:8080/events")
	log.Println("📤 Send notification: POST http://localhost:8080/send")

	if err := http.ListenAndServe(":8080", handler); err != nil {
		log.Fatal("Server failed to start:", err)
	}
}

// corsMiddleware adds CORS headers to responses
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Cache-Control")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// handleSSE handles the SSE endpoint
func handleSSE(w http.ResponseWriter, r *http.Request) {
	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering

	// Check if response writer supports flushing
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", http.StatusInternalServerError)
		return
	}

	// Create a new client
	clientID := fmt.Sprintf("client-%d", time.Now().UnixNano())
	client := &Client{
		ID:     clientID,
		Events: make(chan Notification, 10),
	}

	// Register the client
	hub.register <- client

	// Send initial connection event
	fmt.Fprintf(w, "event: connected\ndata: {\"clientId\": \"%s\", \"message\": \"Connected to SSE server\"}\n\n", clientID)
	flusher.Flush()

	// Use request context to detect client disconnect
	ctx := r.Context()

	// Heartbeat ticker
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	// Main event loop
	for {
		select {
		case <-ctx.Done():
			// Client disconnected
			hub.unregister <- client
			return

		case notification := <-client.Events:
			// Send notification to client
			data, err := json.Marshal(notification)
			if err != nil {
				log.Printf("Error marshaling notification: %v", err)
				continue
			}
			fmt.Fprintf(w, "event: notification\ndata: %s\n\n", data)
			flusher.Flush()

		case <-heartbeat.C:
			// Send heartbeat to keep connection alive
			fmt.Fprintf(w, "event: heartbeat\ndata: {\"time\": \"%s\"}\n\n", time.Now().Format(time.RFC3339))
			flusher.Flush()
		}
	}
}

// handleSendNotification allows sending a notification via POST
func handleSendNotification(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var input struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	}

	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if input.Message == "" {
		input.Message = "No message provided"
	}
	if input.Type == "" {
		input.Type = "info"
	}

	notificationID++
	notification := Notification{
		ID:        notificationID,
		Type:      input.Type,
		Message:   input.Message,
		Timestamp: time.Now(),
	}

	hub.broadcast <- notification

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":      true,
		"notification": notification,
	})
}

// handleHealth provides a health check endpoint
func handleHealth(w http.ResponseWriter, r *http.Request) {
	hub.mu.RLock()
	clientCount := len(hub.clients)
	hub.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":       "healthy",
		"clients":      clientCount,
		"uptime":       time.Now().Format(time.RFC3339),
	})
}

// sendPeriodicNotifications sends a notification every 10 seconds
func sendPeriodicNotifications() {
	messages := []string{
		"🎉 New user signed up!",
		"📦 Order #1234 has been shipped",
		"💰 Payment received successfully",
		"🔔 You have a new message",
		"⚡ System update completed",
		"📊 Weekly report is ready",
	}

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	i := 0
	for range ticker.C {
		notificationID++
		notification := Notification{
			ID:        notificationID,
			Type:      "auto",
			Message:   messages[i%len(messages)],
			Timestamp: time.Now(),
		}
		hub.broadcast <- notification
		log.Printf("Sent periodic notification: %s", notification.Message)
		i++
	}
}





