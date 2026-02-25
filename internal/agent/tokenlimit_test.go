package agent

import (
	"testing"
	"time"
)

func TestParseWindowDuration(t *testing.T) {
	tests := []struct {
		input string
		want  time.Duration
		err   bool
	}{
		{"1h", time.Hour, false},
		{"8h", 8 * time.Hour, false},
		{"24h", 24 * time.Hour, false},
		{"168h", 7 * 24 * time.Hour, false},
		{"daily", 24 * time.Hour, false},
		{"weekly", 7 * 24 * time.Hour, false},
		{"monthly", 30 * 24 * time.Hour, false},
		{"30m", 0, true},  // below minimum
		{"10s", 0, true},  // below minimum
		{"bad", 0, true},  // unparseable
	}
	for _, tt := range tests {
		got, err := parseWindowDuration(tt.input)
		if tt.err {
			if err == nil {
				t.Errorf("parseWindowDuration(%q) expected error", tt.input)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseWindowDuration(%q): %v", tt.input, err)
			continue
		}
		if got != tt.want {
			t.Errorf("parseWindowDuration(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestCalculateCost(t *testing.T) {
	pricing := ModelPricing{
		InputPerMillion:       3.0,  // $3/1M
		OutputPerMillion:      15.0, // $15/1M
		CachedInputPerMillion: 0.30, // $0.30/1M
	}

	// 1000 input tokens = $0.003 = 300 millicents
	// 1000 output tokens = $0.015 = 1500 millicents
	// 1000 cached tokens = $0.0003 = 30 millicents
	cost := calculateCost(pricing, 1000, 1000, 1000)
	// Expected: 300 + 1500 + 30 = 1830 millicents
	if cost != 1830 {
		t.Errorf("cost = %d millicents, want 1830", cost)
	}

	// Zero tokens = zero cost
	if c := calculateCost(pricing, 0, 0, 0); c != 0 {
		t.Errorf("zero tokens cost = %d, want 0", c)
	}
}

func TestCostWindowRecord(t *testing.T) {
	// $1.00 limit
	cw := &CostWindow{LimitCents: 1.0, Window: time.Hour}

	// Record $0.50 (50000 millicents)
	if cw.record(50000) {
		t.Error("$0.50 should not exceed $1.00 limit")
	}
	if cw.exceeded() {
		t.Error("should not be exceeded at $0.50/$1.00")
	}

	// Record another $0.60 (total $1.10)
	if !cw.record(60000) {
		t.Error("$1.10 should exceed $1.00 limit")
	}
	if !cw.exceeded() {
		t.Error("should be exceeded at $1.10/$1.00")
	}
}

func TestCostWindowAutoReset(t *testing.T) {
	cw := &CostWindow{
		LimitCents: 1.0,
		Window:     time.Hour,
		spent:      200000,                              // $2.00 — over limit
		started:    time.Now().Add(-2 * time.Hour), // 2 hours ago — window expired
	}

	// Window expired, so exceeded should return false
	if cw.exceeded() {
		t.Error("expired window should not report exceeded")
	}

	// Recording should start a new window
	if cw.record(10000) { // $0.10
		t.Error("$0.10 in fresh window should not exceed $1.00 limit")
	}
}

func TestCostWindowRemaining(t *testing.T) {
	cw := &CostWindow{
		LimitCents: 1.0,
		Window:     time.Hour,
		started:    time.Now().Add(-30 * time.Minute),
	}

	remaining := cw.remaining()
	if remaining < 29*time.Minute || remaining > 31*time.Minute {
		t.Errorf("remaining = %v, want ~30m", remaining)
	}
}

func TestMultipleCostWindows(t *testing.T) {
	hourly := &CostWindow{LimitCents: 1.0, Window: time.Hour}   // $1/hr
	daily := &CostWindow{LimitCents: 50.0, Window: 24 * time.Hour} // $50/day
	windows := []*CostWindow{hourly, daily}

	// Record $0.80
	if w := recordCostWindows(windows, 80000); w != nil {
		t.Error("$0.80 should not exceed either window")
	}

	// Record $0.30 more — hourly exceeded ($1.10/$1.00), daily fine ($1.10/$50.00)
	w := recordCostWindows(windows, 30000)
	if w == nil {
		t.Fatal("$1.10 should exceed hourly window")
	}
	if w.Window != time.Hour {
		t.Errorf("exceeded window = %v, want 1h", w.Window)
	}
	if daily.exceeded() {
		t.Error("daily should not be exceeded at $1.10/$50.00")
	}
}

func TestParseCostWindows(t *testing.T) {
	configs := []CostLimitConfig{
		{Dollars: 50.0, Window: "daily"},
		{Dollars: 200.0, Window: "monthly"},
		{Dollars: 0, Window: "1h"},      // invalid: 0 dollars
		{Dollars: 10.0, Window: "30m"},   // invalid: below 1h minimum
	}

	windows := ParseCostWindows(configs)
	if len(windows) != 2 {
		t.Fatalf("got %d windows, want 2 (invalid ones filtered)", len(windows))
	}
	if windows[0].LimitCents != 50.0 || windows[0].Window != 24*time.Hour {
		t.Errorf("window[0] = $%.2f/%v", windows[0].LimitCents, windows[0].Window)
	}
	if windows[1].LimitCents != 200.0 || windows[1].Window != 30*24*time.Hour {
		t.Errorf("window[1] = $%.2f/%v", windows[1].LimitCents, windows[1].Window)
	}
}

func TestFormatWindow(t *testing.T) {
	tests := []struct {
		window time.Duration
		want   string
	}{
		{time.Hour, "1 hour"},
		{24 * time.Hour, "daily"},
		{7 * 24 * time.Hour, "weekly"},
		{30 * 24 * time.Hour, "monthly"},
		{8 * time.Hour, "8h0m0s"},
	}
	for _, tt := range tests {
		cw := &CostWindow{Window: tt.window}
		if got := cw.formatWindow(); got != tt.want {
			t.Errorf("formatWindow(%v) = %q, want %q", tt.window, got, tt.want)
		}
	}
}

func TestLookupPricing(t *testing.T) {
	// Known model
	p := LookupPricing("claude-sonnet-4-6-20250514")
	if p.InputPerMillion != 3.0 {
		t.Errorf("sonnet input = %v, want 3.0", p.InputPerMillion)
	}
	if p.OutputPerMillion != 15.0 {
		t.Errorf("sonnet output = %v, want 15.0", p.OutputPerMillion)
	}
	if p.CachedInputPerMillion != 0.30 {
		t.Errorf("sonnet cached = %v, want 0.30", p.CachedInputPerMillion)
	}

	// Unknown model falls back to sonnet
	p = LookupPricing("unknown-model-xyz")
	if p.InputPerMillion != 3.0 {
		t.Error("unknown model should fall back to sonnet pricing")
	}
}

func TestSpentDollars(t *testing.T) {
	cw := &CostWindow{spent: 100_000} // 100_000 millicents = $1.00
	if got := cw.spentDollars(); got != 1.0 {
		t.Errorf("spentDollars = %v, want 1.0", got)
	}
}
