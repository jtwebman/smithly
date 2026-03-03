package tunnel

import "context"

// None is a no-op tunnel for local-only mode.
type None struct{}

func (n *None) Start(_ context.Context, localAddr string) (string, error) {
	return "http://" + localAddr, nil
}

func (n *None) Stop(_ context.Context) error {
	return nil
}
