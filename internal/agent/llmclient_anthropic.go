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

	"smithly.dev/internal/tools"
)

// AnthropicClient speaks the Anthropic Messages API format (/messages).
// Used for Claude models (Opus, Sonnet, Haiku).
type AnthropicClient struct {
	BaseURL string
	APIKey  string
	Client  *http.Client
}

type anthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	System    string             `json:"system,omitempty"`
	Messages  []anthropicMessage `json:"messages"`
	Tools     []anthropicTool    `json:"tools,omitempty"`
	Stream    bool               `json:"stream"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"` // string or []anthropicContentBlock
}

// anthropicContentBlock represents a content block in the Anthropic Messages API.
// Used for text, tool_use (assistant calling a tool), and tool_result (returning tool output).
type anthropicContentBlock struct {
	Type string `json:"type"`
	// text block
	Text string `json:"text,omitempty"`
	// tool_use block
	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`
	// tool_result block
	ToolUseID string `json:"tool_use_id,omitempty"`
	Content   string `json:"content,omitempty"` // tool result text
}

type anthropicTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

func (c *AnthropicClient) SendChat(ctx context.Context, model string, messages []chatMessage, toolDefs []tools.OpenAITool, onDelta func(string)) (*llmResponse, error) {
	system, anthropicMsgs := convertToAnthropicMessages(messages)

	var anthropicTools []anthropicTool
	for _, t := range toolDefs {
		anthropicTools = append(anthropicTools, anthropicTool{
			Name:        t.Function.Name,
			Description: t.Function.Description,
			InputSchema: t.Function.Parameters,
		})
	}

	reqBody := anthropicRequest{
		Model:     model,
		MaxTokens: 8192,
		System:    system,
		Messages:  anthropicMsgs,
		Tools:     anthropicTools,
		Stream:    onDelta != nil,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	url := c.BaseURL + "/messages"
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("llm request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("llm returned %d: %s", resp.StatusCode, string(errBody))
	}

	if onDelta != nil {
		return c.readStream(resp.Body, onDelta)
	}
	return c.readFull(resp.Body)
}

// convertToAnthropicMessages converts the OpenAI-style chatMessage slice into
// Anthropic Messages API format: a system string + alternating user/assistant messages.
func convertToAnthropicMessages(messages []chatMessage) (string, []anthropicMessage) {
	var system string
	var result []anthropicMessage

	var pendingToolResults []anthropicContentBlock

	flushToolResults := func() {
		if len(pendingToolResults) == 0 {
			return
		}
		blocks := pendingToolResults
		pendingToolResults = nil

		// Anthropic requires alternating roles. If last message is user, merge.
		if len(result) > 0 && result[len(result)-1].Role == "user" {
			existing := result[len(result)-1]
			var merged []anthropicContentBlock
			switch v := existing.Content.(type) {
			case string:
				merged = append(merged, anthropicContentBlock{Type: "text", Text: v})
			case []anthropicContentBlock:
				merged = append(merged, v...)
			}
			merged = append(merged, blocks...)
			result[len(result)-1].Content = merged
		} else {
			result = append(result, anthropicMessage{Role: "user", Content: blocks})
		}
	}

	for _, m := range messages {
		switch m.Role {
		case "system":
			if s, ok := m.Content.(string); ok {
				if system != "" {
					system += "\n\n"
				}
				system += s
			}
		case "user":
			flushToolResults()
			s, _ := m.Content.(string)
			// Anthropic requires alternating roles. Merge consecutive user messages.
			if len(result) > 0 && result[len(result)-1].Role == "user" {
				existing := result[len(result)-1]
				var blocks []anthropicContentBlock
				switch v := existing.Content.(type) {
				case string:
					blocks = append(blocks, anthropicContentBlock{Type: "text", Text: v})
				case []anthropicContentBlock:
					blocks = append(blocks, v...)
				}
				blocks = append(blocks, anthropicContentBlock{Type: "text", Text: s})
				result[len(result)-1].Content = blocks
			} else {
				result = append(result, anthropicMessage{Role: "user", Content: s})
			}
		case "assistant":
			flushToolResults()
			if len(m.ToolCalls) > 0 {
				var blocks []anthropicContentBlock
				// Include text content if present alongside tool calls
				if s, ok := m.Content.(string); ok && s != "" {
					blocks = append(blocks, anthropicContentBlock{Type: "text", Text: s})
				}
				for _, tc := range m.ToolCalls {
					blocks = append(blocks, anthropicContentBlock{
						Type:  "tool_use",
						ID:    tc.ID,
						Name:  tc.Function.Name,
						Input: json.RawMessage(tc.Function.Arguments),
					})
				}
				result = append(result, anthropicMessage{Role: "assistant", Content: blocks})
			} else {
				s, _ := m.Content.(string)
				result = append(result, anthropicMessage{Role: "assistant", Content: s})
			}
		case "tool":
			s, _ := m.Content.(string)
			pendingToolResults = append(pendingToolResults, anthropicContentBlock{
				Type:      "tool_result",
				ToolUseID: m.ToolCallID,
				Content:   s,
			})
		}
	}

	flushToolResults()
	return system, result
}

func (c *AnthropicClient) readFull(body io.Reader) (*llmResponse, error) {
	var apiResp struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text,omitempty"`
			ID    string          `json:"id,omitempty"`
			Name  string          `json:"name,omitempty"`
			Input json.RawMessage `json:"input,omitempty"`
		} `json:"content"`
		Usage struct {
			InputTokens          int `json:"input_tokens"`
			OutputTokens         int `json:"output_tokens"`
			CacheReadInputTokens int `json:"cache_read_input_tokens"`
		} `json:"usage"`
	}

	if err := json.NewDecoder(body).Decode(&apiResp); err != nil {
		return nil, fmt.Errorf("decode anthropic response: %w", err)
	}

	result := &llmResponse{
		PromptTokens: apiResp.Usage.InputTokens,
		OutputTokens: apiResp.Usage.OutputTokens,
		CachedTokens: apiResp.Usage.CacheReadInputTokens,
	}

	for _, block := range apiResp.Content {
		switch block.Type {
		case "text":
			result.Content += block.Text
		case "tool_use":
			result.ToolCalls = append(result.ToolCalls, toolCall{
				ID:   block.ID,
				Type: "function",
				Function: functionCall{
					Name:      block.Name,
					Arguments: string(block.Input),
				},
			})
		}
	}

	return result, nil
}

func (c *AnthropicClient) readStream(body io.Reader, onDelta func(string)) (*llmResponse, error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	var contentBuf strings.Builder
	type blockInfo struct {
		blockType string // "text" or "tool_use"
		id        string
		name      string
		args      strings.Builder
	}
	blocks := make(map[int]*blockInfo)
	var blockOrder []int
	var inputTokens, outputTokens int

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")

		var envelope struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(data), &envelope); err != nil {
			continue
		}

		switch envelope.Type {
		case "message_start":
			var msg struct {
				Message struct {
					Usage struct {
						InputTokens int `json:"input_tokens"`
					} `json:"usage"`
				} `json:"message"`
			}
			if json.Unmarshal([]byte(data), &msg) == nil {
				inputTokens = msg.Message.Usage.InputTokens
			}

		case "content_block_start":
			var start struct {
				Index        int `json:"index"`
				ContentBlock struct {
					Type string `json:"type"`
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"content_block"`
			}
			if json.Unmarshal([]byte(data), &start) == nil {
				blocks[start.Index] = &blockInfo{
					blockType: start.ContentBlock.Type,
					id:        start.ContentBlock.ID,
					name:      start.ContentBlock.Name,
				}
				blockOrder = append(blockOrder, start.Index)
			}

		case "content_block_delta":
			var delta struct {
				Index int `json:"index"`
				Delta struct {
					Type        string `json:"type"`
					Text        string `json:"text"`
					PartialJSON string `json:"partial_json"`
				} `json:"delta"`
			}
			if json.Unmarshal([]byte(data), &delta) == nil {
				bi := blocks[delta.Index]
				if bi == nil {
					continue
				}
				switch delta.Delta.Type {
				case "text_delta":
					contentBuf.WriteString(delta.Delta.Text)
					onDelta(delta.Delta.Text)
				case "input_json_delta":
					bi.args.WriteString(delta.Delta.PartialJSON)
				}
			}

		case "message_delta":
			var md struct {
				Usage struct {
					OutputTokens int `json:"output_tokens"`
				} `json:"usage"`
			}
			if json.Unmarshal([]byte(data), &md) == nil {
				outputTokens = md.Usage.OutputTokens
			}
		}
	}

	result := &llmResponse{
		Content:      contentBuf.String(),
		PromptTokens: inputTokens,
		OutputTokens: outputTokens,
	}

	for _, idx := range blockOrder {
		bi := blocks[idx]
		if bi.blockType == "tool_use" {
			result.ToolCalls = append(result.ToolCalls, toolCall{
				ID:   bi.id,
				Type: "function",
				Function: functionCall{
					Name:      bi.name,
					Arguments: bi.args.String(),
				},
			})
		}
	}

	return result, scanner.Err()
}
