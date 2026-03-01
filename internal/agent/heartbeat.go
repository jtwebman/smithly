package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"smithly.dev/internal/sandbox"
)

// HeartbeatConfig holds the scheduling parameters.
type HeartbeatConfig struct {
	Interval   time.Duration
	QuietStart int    // hour (0-23), -1 = no quiet hours
	QuietEnd   int    // hour (0-23)
	AutoResume bool   // auto-resume when token window expires (default true)
	Skill      string // run this code skill instead of LLM chat
}

// ParseHeartbeatConfig parses interval and quiet hours strings from config.
func ParseHeartbeatConfig(interval, quietHours string, autoResume bool, skill string) HeartbeatConfig {
	hc := HeartbeatConfig{
		Interval:   30 * time.Minute,
		QuietStart: -1,
		AutoResume: autoResume,
		Skill:      skill,
	}

	if interval != "" {
		if d, err := time.ParseDuration(interval); err == nil {
			hc.Interval = d
		}
	}

	// Parse quiet hours like "22-7" (10pm to 7am)
	if quietHours != "" {
		parts := strings.SplitN(quietHours, "-", 2)
		if len(parts) == 2 {
			if start, err := strconv.Atoi(strings.TrimSpace(parts[0])); err == nil {
				if end, err := strconv.Atoi(strings.TrimSpace(parts[1])); err == nil {
					hc.QuietStart = start
					hc.QuietEnd = end
				}
			}
		}
	}

	return hc
}

// StartHeartbeat runs a goroutine that periodically triggers a heartbeat.
// In skill mode, it executes a code skill directly (no LLM tokens).
// In chat mode, it sends HEARTBEAT.md content as a user message.
func (a *Agent) StartHeartbeat(ctx context.Context, hc HeartbeatConfig) {
	if hc.Skill == "" && a.Workspace.Heartbeat == "" {
		return
	}

	go func() {
		ticker := time.NewTicker(hc.Interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if isQuietHour(hc) {
					continue
				}

				// Check if agent is paused by a cost window
				if w := checkCostWindows(a.CostWindows); w != nil {
					if hc.AutoResume {
						slog.Info("heartbeat paused", "agent", a.ID, "limit", w.LimitCents, "window", w.formatWindow(), "resets_in", w.remaining().Round(time.Minute))
					}
					continue
				}

				if hc.Skill != "" {
					a.runSkillHeartbeat(ctx, hc.Skill)
				} else {
					_, err := a.Chat(ctx, a.Workspace.Heartbeat, nil)
					if err != nil {
						slog.Error("heartbeat chat failed", "agent", a.ID, "err", err)
					}
				}
			}
		}
	}()
}

// runSkillHeartbeat executes a code skill directly — no LLM, no tokens.
func (a *Agent) runSkillHeartbeat(ctx context.Context, skillName string) {
	skill, ok := a.Skills.Get(skillName)
	if !ok {
		slog.Warn("heartbeat skill not found", "agent", a.ID, "skill", skillName)
		return
	}

	if a.CodeRunner == nil {
		slog.Warn("heartbeat no code runner", "agent", a.ID)
		return
	}

	result, err := a.CodeRunner.Run(ctx, sandbox.RunOpts{
		Skill: skill,
		Input: json.RawMessage(`{}`),
	})
	if err != nil {
		slog.Error("heartbeat skill error", "agent", a.ID, "skill", skillName, "err", err)
		return
	}

	if result.ExitCode != 0 {
		slog.Warn("heartbeat skill nonzero exit", "agent", a.ID, "skill", skillName, "exit_code", result.ExitCode, "error", result.Error)
	} else if result.Output != "" {
		slog.Info("heartbeat skill complete", "agent", a.ID, "skill", skillName, "output", strings.TrimSpace(result.Output))
	}
}

func isQuietHour(hc HeartbeatConfig) bool {
	if hc.QuietStart < 0 {
		return false
	}

	hour := time.Now().Hour()

	if hc.QuietStart < hc.QuietEnd {
		// e.g., 9-17 (quiet during business hours)
		return hour >= hc.QuietStart && hour < hc.QuietEnd
	}
	// e.g., 22-7 (quiet overnight, wraps around midnight)
	return hour >= hc.QuietStart || hour < hc.QuietEnd
}
