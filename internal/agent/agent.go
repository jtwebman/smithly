// Package agent implements the LLM agent loop with tool-use support.
// It sends messages to an OpenAI-compatible API, handles tool calls,
// executes them, and feeds results back to the LLM.
package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"smithly.dev/internal/db"
	"smithly.dev/internal/tools"
	"smithly.dev/internal/workspace"
)

// Agent represents a running agent with its workspace, memory, tools, and LLM connection.
type Agent struct {
	ID        string
	Model     string
	BaseURL   string
	APIKey    string
	Workspace *workspace.Workspace
	Store     db.Store
	Tools     *tools.Registry
	client    *http.Client
}

// New creates a new agent.
func New(id, model, baseURL, apiKey string, ws *workspace.Workspace, store db.Store) *Agent {
	return NewWithClient(id, model, baseURL, apiKey, ws, store, &http.Client{})
}

// NewWithClient creates a new agent with a custom HTTP client (for testing).
func NewWithClient(id, model, baseURL, apiKey string, ws *workspace.Workspace, store db.Store, client *http.Client) *Agent {
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	return &Agent{
		ID:        id,
		Model:     model,
		BaseURL:   strings.TrimRight(baseURL, "/"),
		APIKey:    apiKey,
		Workspace: ws,
		Store:     store,
		Tools:     tools.NewRegistry(),
		client:    client,
	}
}

// Callbacks for the agent loop — the channel (CLI, web, etc.) provides these.
type Callbacks struct {
	// OnDelta is called for each streamed token of assistant text.
	OnDelta func(token string)

	// OnToolCall is called when the agent wants to use a tool.
	// Receives tool name and arguments. Used to display what's happening.
	OnToolCall func(name string, args string)

	// OnToolResult is called with the tool's output.
	OnToolResult func(name string, result string)

	// Approve is called when a tool needs user approval.
	// Returns true if the user approves.
	Approve tools.ApprovalFunc
}

// chatMessage is a message in the OpenAI chat format, extended for tool use.
type chatMessage struct {
	Role       string     `json:"role"`
	Content    any        `json:"content,omitempty"` // string or null
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type toolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function functionCall `json:"function"`
}

type functionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// chatRequest is the OpenAI-compatible chat completion request.
type chatRequest struct {
	Model    string             `json:"model"`
	Messages []chatMessage      `json:"messages"`
	Tools    []tools.OpenAITool `json:"tools,omitempty"`
	Stream   bool               `json:"stream"`
}

// Chat sends a user message, runs the agent loop (possibly multiple LLM round-trips
// if tool calls are involved), and returns the final text response.
func (a *Agent) Chat(ctx context.Context, userMessage string, cb *Callbacks) (string, error) {
	if cb == nil {
		cb = &Callbacks{}
	}

	// Save user message
	if err := a.Store.AppendMessage(ctx, &db.Message{
		AgentID: a.ID,
		Role:    "user",
		Content: userMessage,
		Source:  "cli",
		Trust:   "trusted",
	}); err != nil {
		return "", fmt.Errorf("save user message: %w", err)
	}

	// Build message list: system prompt + recent history
	messages := []chatMessage{
		{Role: "system", Content: a.Workspace.SystemPrompt()},
	}

	history, err := a.Store.GetMessages(ctx, a.ID, 50)
	if err != nil {
		return "", fmt.Errorf("load history: %w", err)
	}
	for _, m := range history {
		messages = append(messages, chatMessage{Role: m.Role, Content: m.Content})
	}

	// Get tool definitions
	var toolDefs []tools.OpenAITool
	if len(a.Tools.All()) > 0 {
		toolDefs = a.Tools.OpenAITools()
	}

	// Agent loop — keep going until we get a text response (no more tool calls)
	const maxIterations = 20
	for i := 0; i < maxIterations; i++ {
		response, err := a.sendChat(ctx, messages, toolDefs, cb.OnDelta)
		if err != nil {
			return "", err
		}

		// If the response has tool calls, execute them and loop
		if len(response.ToolCalls) > 0 {
			// Add assistant message with tool calls to history
			messages = append(messages, chatMessage{
				Role:      "assistant",
				ToolCalls: response.ToolCalls,
			})

			// Execute each tool call
			for _, tc := range response.ToolCalls {
				if cb.OnToolCall != nil {
					cb.OnToolCall(tc.Function.Name, tc.Function.Arguments)
				}

				result, err := a.Tools.Execute(ctx, tc.Function.Name, json.RawMessage(tc.Function.Arguments), cb.Approve)
				if err != nil {
					result = fmt.Sprintf("Error: %v", err)
				}

				if cb.OnToolResult != nil {
					cb.OnToolResult(tc.Function.Name, result)
				}

				// Audit the tool call
				a.Store.LogAudit(ctx, &db.AuditEntry{
					Actor:      "agent:" + a.ID,
					Action:     "tool_call",
					Target:     tc.Function.Name,
					Details:    tc.Function.Arguments,
					TrustLevel: "trusted",
				})

				// Add tool result to messages
				messages = append(messages, chatMessage{
					Role:       "tool",
					Content:    result,
					ToolCallID: tc.ID,
				})
			}
			continue // Loop back to send tool results to LLM
		}

		// No tool calls — we have the final text response
		finalText := response.Content

		// Save assistant response
		if err := a.Store.AppendMessage(ctx, &db.Message{
			AgentID: a.ID,
			Role:    "assistant",
			Content: finalText,
			Source:  "llm",
			Trust:   "trusted",
		}); err != nil {
			return "", fmt.Errorf("save assistant message: %w", err)
		}

		a.Store.LogAudit(ctx, &db.AuditEntry{
			Actor:      "agent:" + a.ID,
			Action:     "llm_chat",
			TrustLevel: "trusted",
		})

		return finalText, nil
	}

	return "", fmt.Errorf("agent loop exceeded %d iterations", maxIterations)
}

// llmResponse is the parsed response from the LLM.
type llmResponse struct {
	Content   string
	ToolCalls []toolCall
}

func (a *Agent) sendChat(ctx context.Context, messages []chatMessage, toolDefs []tools.OpenAITool, onDelta func(string)) (*llmResponse, error) {
	reqBody := chatRequest{
		Model:    a.Model,
		Messages: messages,
		Tools:    toolDefs,
		Stream:   onDelta != nil,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	url := a.BaseURL + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if a.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.APIKey)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("llm request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("llm returned %d: %s", resp.StatusCode, string(errBody))
	}

	if onDelta != nil {
		return a.readStream(resp.Body, onDelta)
	}
	return a.readFull(resp.Body)
}

func (a *Agent) readStream(body io.Reader, onDelta func(string)) (*llmResponse, error) {
	scanner := bufio.NewScanner(body)
	// Increase scanner buffer for large responses
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	var contentBuf strings.Builder
	toolCallMap := make(map[int]*toolCall)

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			break
		}

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Type     string `json:"type"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) == 0 {
			continue
		}

		delta := chunk.Choices[0].Delta

		// Stream text content
		if delta.Content != "" {
			contentBuf.WriteString(delta.Content)
			onDelta(delta.Content)
		}

		// Accumulate tool calls
		for _, tc := range delta.ToolCalls {
			existing, ok := toolCallMap[tc.Index]
			if !ok {
				toolCallMap[tc.Index] = &toolCall{
					ID:   tc.ID,
					Type: tc.Type,
					Function: functionCall{
						Name:      tc.Function.Name,
						Arguments: tc.Function.Arguments,
					},
				}
			} else {
				// Append streamed arguments
				if tc.Function.Arguments != "" {
					existing.Function.Arguments += tc.Function.Arguments
				}
			}
		}
	}

	resp := &llmResponse{Content: contentBuf.String()}
	for i := 0; i < len(toolCallMap); i++ {
		if tc, ok := toolCallMap[i]; ok {
			resp.ToolCalls = append(resp.ToolCalls, *tc)
		}
	}

	return resp, scanner.Err()
}

func (a *Agent) readFull(body io.Reader) (*llmResponse, error) {
	var apiResp struct {
		Choices []struct {
			Message struct {
				Content   string     `json:"content"`
				ToolCalls []toolCall `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(body).Decode(&apiResp); err != nil {
		return nil, fmt.Errorf("decode llm response: %w", err)
	}
	if len(apiResp.Choices) == 0 {
		return nil, fmt.Errorf("llm returned no choices")
	}

	return &llmResponse{
		Content:   apiResp.Choices[0].Message.Content,
		ToolCalls: apiResp.Choices[0].Message.ToolCalls,
	}, nil
}
