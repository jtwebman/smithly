package sandbox

import (
	"context"
	"fmt"
	"os/exec"
)

// FlyProvider is a stub for future Fly Machines execution.
type FlyProvider struct{}

func (p *FlyProvider) Name() string { return "fly" }

// CheckFly reports whether flyctl is available (stub — always returns false).
func CheckFly() (ok bool, msg string) {
	return (&FlyProvider{}).Available()
}

func (p *FlyProvider) Available() (ok bool, msg string) {
	if _, err := exec.LookPath("flyctl"); err != nil {
		return false, "flyctl not found in PATH"
	}
	return false, "fly provider not yet implemented"
}

func (p *FlyProvider) Run(ctx context.Context, opts RunOpts) (*RunResult, error) {
	return nil, fmt.Errorf("fly sandbox provider is not yet implemented")
}
