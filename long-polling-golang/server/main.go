package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// Notification represents a message to be sent to clients
type Notification struct {
	ID        int       `json:"id"`
	Message   string    `json:"message"`
	Type      string    `json:"type"`
	Timestamp time.Time `json:"timestamp"`
}

// PendingRequest represents a client waiting for data
type PendingRequest struct {
	Writer http.ResponseWriter
	Done   chan bool
}

// PollResponse is sent to clients
type PollResponse struct {
	Notifications []Notification `json:"notifications"`
	Timestamp     time.Time      `json:"timestamp"`
}

// SendRequest is received from POST /send
type SendRequest struct {
	Message string `json:"message"`
	Type    string `json:"type"`
}

// Global state
var (
	pendingRequests   []*PendingRequest
	notificationQueue []Notification
	mutex             sync.Mutex
	notificationID    = 1
)

const (
	PORT               = 4001
	LONG_POLL_TIMEOUT  = 30 * time.Second
)

func main() {
	// Routes
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/poll", pollHandler)
	http.HandleFunc("/send", sendHandler)
	http.HandleFunc("/notifications", clearHandler)

	// Print startup banner
	fmt.Printf(`
╔═══════════════════════════════════════════════════════════╗
║  Long Polling Server (Golang) Started                     ║
╠═══════════════════════════════════════════════════════════╣
║  Port: %d                                                 ║
║  Health: http://localhost:%d/health                       ║
║  Poll: http://localhost:%d/poll                           ║
║  Send: http://localhost:%d/send                           ║
║                                                           ║
║  Long Poll Timeout: %d seconds                            ║
╚═══════════════════════════════════════════════════════════╝

Ready to accept long-poll connections!
`, PORT, PORT, PORT, PORT, int(LONG_POLL_TIMEOUT.Seconds()))

	// Start server
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", PORT), nil))
}

// healthHandler returns server status
func healthHandler(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	
	if r.Method == "OPTIONS" {
		return
	}

	mutex.Lock()
	pendingCount := len(pendingRequests)
	queuedCount := len(notificationQueue)
	mutex.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":               "ok",
		"pendingConnections":   pendingCount,
		"queuedNotifications":  queuedCount,
		"timestamp":            time.Now(),
	})
}

// pollHandler implements long polling
func pollHandler(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	
	if r.Method == "OPTIONS" {
		return
	}

	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	log.Printf("[%s] New poll request received", time.Now().Format(time.RFC3339))

	// Set headers to prevent caching
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")

	mutex.Lock()

	// If there are queued notifications, send them immediately
	if len(notificationQueue) > 0 {
		notifications := make([]Notification, len(notificationQueue))
		copy(notifications, notificationQueue)
		notificationQueue = []Notification{} // Clear queue
		mutex.Unlock()

		log.Printf("[%s] Sending %d queued notifications", time.Now().Format(time.RFC3339), len(notifications))

		json.NewEncoder(w).Encode(PollResponse{
			Notifications: notifications,
			Timestamp:     time.Now(),
		})
		return
	}

	// Create a done channel for this request
	done := make(chan bool, 1)
	pending := &PendingRequest{
		Writer: w,
		Done:   done,
	}

	// Add to pending requests
	pendingRequests = append(pendingRequests, pending)
	pendingCount := len(pendingRequests)
	mutex.Unlock()

	log.Printf("[%s] Added to pending requests (total: %d)", time.Now().Format(time.RFC3339), pendingCount)

	// Wait for data, timeout, or client disconnect
	select {
	case <-done:
		// Data was sent by broadcast, nothing to do
		log.Printf("[%s] Poll request completed via broadcast", time.Now().Format(time.RFC3339))

	case <-time.After(LONG_POLL_TIMEOUT):
		// Timeout occurred
		log.Printf("[%s] Poll request timed out, sending empty response", time.Now().Format(time.RFC3339))
		
		// Remove from pending requests
		mutex.Lock()
		removePendingRequest(pending)
		mutex.Unlock()

		// Send empty response
		json.NewEncoder(w).Encode(PollResponse{
			Notifications: []Notification{},
			Timestamp:     time.Now(),
		})

	case <-r.Context().Done():
		// Client disconnected
		log.Printf("[%s] Client disconnected", time.Now().Format(time.RFC3339))
		
		mutex.Lock()
		removePendingRequest(pending)
		mutex.Unlock()
	}
}

// sendHandler receives notifications and broadcasts them
func sendHandler(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	
	if r.Method == "OPTIONS" {
		return
	}

	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req SendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.Message == "" {
		http.Error(w, "Message is required", http.StatusBadRequest)
		return
	}

	if req.Type == "" {
		req.Type = "info"
	}

	// Create notification
	notification := Notification{
		ID:        notificationID,
		Message:   req.Message,
		Type:      req.Type,
		Timestamp: time.Now(),
	}
	notificationID++

	log.Printf("[%s] New notification: %s", time.Now().Format(time.RFC3339), req.Message)

	mutex.Lock()
	pendingCount := len(pendingRequests)

	if pendingCount > 0 {
		// Broadcast to all pending requests
		log.Printf("[%s] Broadcasting to %d pending connections", time.Now().Format(time.RFC3339), pendingCount)

		for _, pending := range pendingRequests {
			// Send notification
			json.NewEncoder(pending.Writer).Encode(PollResponse{
				Notifications: []Notification{notification},
				Timestamp:     time.Now(),
			})

			// Signal done
			close(pending.Done)
		}

		// Clear pending requests
		pendingRequests = []*PendingRequest{}
		mutex.Unlock()

		// Respond to sender
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":      true,
			"notification": notification,
			"deliveredTo":  "pending clients",
		})
	} else {
		// No pending requests, queue the notification
		log.Printf("[%s] No pending connections, queueing notification", time.Now().Format(time.RFC3339))
		notificationQueue = append(notificationQueue, notification)
		mutex.Unlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":      true,
			"notification": notification,
			"deliveredTo":  "queued",
		})
	}
}

// clearHandler clears all queued notifications
func clearHandler(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	
	if r.Method == "OPTIONS" {
		return
	}

	if r.Method != "DELETE" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	mutex.Lock()
	count := len(notificationQueue)
	notificationQueue = []Notification{}
	mutex.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"cleared": count,
	})
}

// Helper function to remove a pending request
func removePendingRequest(target *PendingRequest) {
	for i, pending := range pendingRequests {
		if pending == target {
			pendingRequests = append(pendingRequests[:i], pendingRequests[i+1:]...)
			return
		}
	}
}

// enableCORS sets CORS headers
func enableCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

