package channels

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"smithly.dev/internal/agent"
)

const (
	discordMaxMessage = 2000
	discordAPIBase    = "https://discord.com/api/v10"

	// Gateway opcodes
	opDispatch         = 0
	opHeartbeat        = 1
	opIdentify         = 2
	opResume           = 6
	opReconnect        = 7
	opInvalidSession   = 9
	opHello            = 10
	opHeartbeatACK     = 11

	// Intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
	discordIntents = 1 | 512 | 4096 | 32768 // = 37377
)

// Discord is a channel adapter that receives messages via the Discord Gateway WebSocket
// and sends replies via the Discord REST API.
type Discord struct {
	Token       string
	Agent       *agent.Agent
	AutoApprove bool
	GatewayURL  string       // override for testing (ws:// URL)
	APIURL      string       // override for testing (REST base URL)
	client      *http.Client
	cancel      context.CancelFunc
	mu          sync.Mutex
	sessionID   string
	seq         atomic.Int64
	seqSet      atomic.Bool // true once we've received at least one sequence number
	botUserID   string      // our bot's user ID, learned from READY
}

// NewDiscord creates a Discord channel adapter for the given agent.
func NewDiscord(token string, a *agent.Agent, autoApprove bool) *Discord {
	return &Discord{
		Token:       token,
		Agent:       a,
		AutoApprove: autoApprove,
	}
}

// Start implements Channel. It connects to the Discord Gateway and processes events
// until ctx is cancelled or Stop is called.
func (d *Discord) Start(ctx context.Context) error {
	ctx, d.cancel = context.WithCancel(ctx)

	if d.APIURL == "" {
		d.APIURL = discordAPIBase
	}
	if d.client == nil {
		d.client = &http.Client{Timeout: 30 * time.Second}
	}

	// Resolve gateway URL if not overridden
	if d.GatewayURL == "" {
		u, err := d.getGatewayURL(ctx)
		if err != nil {
			return fmt.Errorf("discord get gateway: %w", err)
		}
		d.GatewayURL = u
	}

	// Reconnect loop — mirrors Telegram's retry-on-error pattern
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		err := d.runGateway(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}

		slog.Error("discord gateway disconnected, reconnecting", "err", err)
		select {
		case <-time.After(5 * time.Second):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// Stop implements Channel.
func (d *Discord) Stop(_ context.Context) error {
	if d.cancel != nil {
		d.cancel()
	}
	return nil
}

// --- Gateway WebSocket session ---

// gatewayPayload is the envelope for all Gateway messages.
type gatewayPayload struct {
	Op   int              `json:"op"`
	D    json.RawMessage  `json:"d,omitempty"`
	S    *int64           `json:"s,omitempty"`
	T    string           `json:"t,omitempty"`
}

type helloData struct {
	HeartbeatInterval int `json:"heartbeat_interval"` // milliseconds
}

type readyData struct {
	SessionID string      `json:"session_id"`
	User      discordUser `json:"user"`
}

type discordUser struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Bot      bool   `json:"bot"`
}

type discordMessage struct {
	ID        string      `json:"id"`
	ChannelID string      `json:"channel_id"`
	Content   string      `json:"content"`
	Author    discordUser `json:"author"`
}

func (d *Discord) runGateway(ctx context.Context) error {
	gwURL := d.GatewayURL + "?v=10&encoding=json"
	conn, resp, err := websocket.Dial(ctx, gwURL, nil)
	if err != nil {
		return fmt.Errorf("dial gateway: %w", err)
	}
	if resp != nil && resp.Body != nil {
		resp.Body.Close()
	}
	defer func() { _ = conn.CloseNow() }()

	// Read OP 10 Hello
	var hello gatewayPayload
	if err := readJSON(ctx, conn, &hello); err != nil {
		return fmt.Errorf("read hello: %w", err)
	}
	if hello.Op != opHello {
		return fmt.Errorf("expected op 10 Hello, got op %d", hello.Op)
	}
	var hd helloData
	if err := json.Unmarshal(hello.D, &hd); err != nil {
		return fmt.Errorf("decode hello data: %w", err)
	}

	// Start heartbeat goroutine
	heartCtx, heartCancel := context.WithCancel(ctx)
	defer heartCancel()
	go d.heartbeatLoop(heartCtx, conn, time.Duration(hd.HeartbeatInterval)*time.Millisecond)

	// Send Identify or Resume
	d.mu.Lock()
	sid := d.sessionID
	d.mu.Unlock()

	if sid != "" && d.seqSet.Load() {
		// Resume
		seq := d.seq.Load()
		if err := d.sendResume(ctx, conn, sid, seq); err != nil {
			return fmt.Errorf("send resume: %w", err)
		}
	} else {
		// Identify
		if err := d.sendIdentify(ctx, conn); err != nil {
			return fmt.Errorf("send identify: %w", err)
		}
	}

	// Read loop
	for {
		var payload gatewayPayload
		if err := readJSON(ctx, conn, &payload); err != nil {
			return fmt.Errorf("read payload: %w", err)
		}

		// Track sequence number
		if payload.S != nil {
			d.seq.Store(*payload.S)
			d.seqSet.Store(true)
		}

		switch payload.Op {
		case opDispatch:
			d.handleDispatch(ctx, payload)

		case opHeartbeat:
			// Server requests immediate heartbeat
			d.sendHeartbeat(ctx, conn)

		case opReconnect:
			return fmt.Errorf("server requested reconnect")

		case opInvalidSession:
			// Clear session for fresh identify
			d.mu.Lock()
			d.sessionID = ""
			d.mu.Unlock()
			d.seqSet.Store(false)
			return fmt.Errorf("invalid session")

		case opHeartbeatACK:
			// OK, nothing to do
		}
	}
}

func (d *Discord) handleDispatch(ctx context.Context, p gatewayPayload) {
	switch p.T {
	case "READY":
		var rd readyData
		if err := json.Unmarshal(p.D, &rd); err != nil {
			slog.Error("discord decode READY", "err", err)
			return
		}
		d.mu.Lock()
		d.sessionID = rd.SessionID
		d.botUserID = rd.User.ID
		d.mu.Unlock()
		slog.Info("discord bot connected", "username", rd.User.Username, "session", rd.SessionID)

	case "RESUMED":
		slog.Info("discord session resumed")

	case "MESSAGE_CREATE":
		var msg discordMessage
		if err := json.Unmarshal(p.D, &msg); err != nil {
			slog.Error("discord decode MESSAGE_CREATE", "err", err)
			return
		}

		// Skip messages from bots (including ourselves)
		if msg.Author.Bot {
			return
		}
		// Skip empty messages
		if msg.Content == "" {
			return
		}

		// Handle in goroutine so read loop stays responsive for heartbeats
		go d.handleMessage(ctx, msg)
	}
}

func (d *Discord) handleMessage(ctx context.Context, msg discordMessage) {
	// Send typing indicator
	d.sendTyping(ctx, msg.ChannelID)

	cb := &agent.Callbacks{
		Source: "channel:discord",
		Approve: func(toolName string, description string) bool {
			return d.AutoApprove
		},
	}

	response, err := d.Agent.Chat(ctx, msg.Content, cb)
	if err != nil {
		slog.Error("discord chat error", "channel_id", msg.ChannelID, "err", err)
		d.sendChannelMessage(ctx, msg.ChannelID, fmt.Sprintf("Error: %v", err))
		return
	}

	d.sendLongMessage(ctx, msg.ChannelID, response)
}

// sendLongMessage splits messages exceeding Discord's 2000 char limit,
// preferring to split at newline boundaries.
func (d *Discord) sendLongMessage(ctx context.Context, channelID, text string) {
	for text != "" {
		chunk := text
		if len(chunk) > discordMaxMessage {
			chunk = text[:discordMaxMessage]
			// Try to split at last newline
			if idx := strings.LastIndex(chunk, "\n"); idx > 0 {
				chunk = text[:idx]
			}
		}
		d.sendChannelMessage(ctx, channelID, chunk)
		text = text[len(chunk):]
	}
}

// --- Heartbeat ---

func (d *Discord) heartbeatLoop(ctx context.Context, conn *websocket.Conn, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.sendHeartbeat(ctx, conn)
		}
	}
}

func (d *Discord) sendHeartbeat(ctx context.Context, conn *websocket.Conn) {
	var seq any
	if d.seqSet.Load() {
		seq = d.seq.Load()
	}
	payload := gatewayPayload{Op: opHeartbeat}
	raw, _ := json.Marshal(seq)
	payload.D = raw
	data, _ := json.Marshal(payload)
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		slog.Error("discord heartbeat write failed", "err", err)
	}
}

// --- Gateway sends ---

func (d *Discord) sendIdentify(ctx context.Context, conn *websocket.Conn) error {
	identify := map[string]any{
		"token":   d.Token,
		"intents": discordIntents,
		"properties": map[string]string{
			"os":      "linux",
			"browser": "smithly",
			"device":  "smithly",
		},
	}
	return d.sendGatewayOp(ctx, conn, opIdentify, identify)
}

func (d *Discord) sendResume(ctx context.Context, conn *websocket.Conn, sessionID string, seq int64) error {
	resume := map[string]any{
		"token":      d.Token,
		"session_id": sessionID,
		"seq":        seq,
	}
	return d.sendGatewayOp(ctx, conn, opResume, resume)
}

func (d *Discord) sendGatewayOp(ctx context.Context, conn *websocket.Conn, op int, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	payload := gatewayPayload{Op: op, D: raw}
	msg, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, msg)
}

// --- REST API ---

func (d *Discord) apiURL(path string) string {
	return d.APIURL + path
}

func (d *Discord) doREST(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var bodyReader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		bodyReader = bytes.NewReader(data)
	} else {
		bodyReader = http.NoBody
	}
	req, err := http.NewRequestWithContext(ctx, method, d.apiURL(path), bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bot "+d.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return d.client.Do(req)
}

func (d *Discord) getGatewayURL(ctx context.Context) (string, error) {
	resp, err := d.doREST(ctx, "GET", "/gateway/bot", nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("GET /gateway/bot: %d %s", resp.StatusCode, string(body))
	}

	var result struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode gateway response: %w", err)
	}
	return result.URL, nil
}

func (d *Discord) sendChannelMessage(ctx context.Context, channelID, text string) {
	resp, err := d.doREST(ctx, "POST", "/channels/"+channelID+"/messages", map[string]string{
		"content": text,
	})
	if err != nil {
		slog.Error("discord sendMessage failed", "err", err)
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}

func (d *Discord) sendTyping(ctx context.Context, channelID string) {
	resp, err := d.doREST(ctx, "POST", "/channels/"+channelID+"/typing", nil)
	if err != nil {
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}

// --- helpers ---

func readJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	_, data, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}
