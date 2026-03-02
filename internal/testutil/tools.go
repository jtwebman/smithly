// Package testutil provides shared test mocks used across multiple test packages.
package testutil

import (
	"context"
	"encoding/json"
)

// EchoTool is a test tool that echoes back text.
type EchoTool struct{}

func (e *EchoTool) Name() string        { return "echo_tool" }
func (e *EchoTool) Description() string { return "Echoes back text" }
func (e *EchoTool) NeedsApproval() bool { return false }
func (e *EchoTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}`)
}
func (e *EchoTool) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", err
	}
	return "echoed: " + params.Text, nil
}

// DangerousTool is a test tool that requires approval.
type DangerousTool struct{}

func (d *DangerousTool) Name() string        { return "dangerous_tool" }
func (d *DangerousTool) Description() string { return "A dangerous tool that needs approval" }
func (d *DangerousTool) NeedsApproval() bool { return true }
func (d *DangerousTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{}}`)
}
func (d *DangerousTool) Run(ctx context.Context, args json.RawMessage) (string, error) {
	return "danger executed", nil
}
