package tunnel

import (
	"context"
	"fmt"
	"log/slog"

	"golang.ngrok.com/ngrok/v2"
)

// Ngrok tunnels via the ngrok-go SDK.
type Ngrok struct {
	Authtoken string
	Domain    string // optional fixed domain (paid ngrok)

	agent   ngrok.Agent
	forward ngrok.EndpointForwarder
}

func (n *Ngrok) Start(ctx context.Context, localAddr string) (string, error) {
	agent, err := ngrok.NewAgent(ngrok.WithAuthtoken(n.Authtoken))
	if err != nil {
		return "", fmt.Errorf("ngrok agent: %w", err)
	}
	n.agent = agent

	upstream := ngrok.WithUpstream(localAddr)

	var endpointOpts []ngrok.EndpointOption
	if n.Domain != "" {
		endpointOpts = append(endpointOpts, ngrok.WithURL("https://"+n.Domain))
	}

	fwd, err := agent.Forward(ctx, upstream, endpointOpts...)
	if err != nil {
		return "", fmt.Errorf("ngrok forward: %w", err)
	}
	n.forward = fwd

	url := fwd.URL().String()
	slog.Info("ngrok tunnel established", "url", url)
	return url, nil
}

func (n *Ngrok) Stop(_ context.Context) error {
	if n.forward != nil {
		n.forward.Close()
	}
	if n.agent != nil {
		return n.agent.Disconnect()
	}
	return nil
}
