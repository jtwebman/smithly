package channels

import "context"

// Channel is the interface for external message adapters (Telegram, Discord, etc.).
// Each channel owns its I/O loop internally and receives its agent at construction.
type Channel interface {
	Start(ctx context.Context) error // blocks until ctx cancelled or fatal error
	Stop() error                     // graceful shutdown
}
