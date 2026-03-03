// Package tunnel provides public URL tunneling for the webhook server.
package tunnel

import "context"

// Tunnel exposes a local address via a public URL.
type Tunnel interface {
	Start(ctx context.Context, localAddr string) (publicURL string, err error)
	Stop(ctx context.Context) error
}
