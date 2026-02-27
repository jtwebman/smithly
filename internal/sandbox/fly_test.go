package sandbox

import (
	"context"
	"testing"
)

func TestFlyName(t *testing.T) {
	p := &FlyProvider{}
	if p.Name() != "fly" {
		t.Errorf("name = %q, want %q", p.Name(), "fly")
	}
}

func TestFlyAvailableReturnsFalse(t *testing.T) {
	p := &FlyProvider{}
	ok, _ := p.Available()
	if ok {
		t.Error("FlyProvider.Available() should always return false")
	}
}

func TestFlyRunReturnsError(t *testing.T) {
	p := &FlyProvider{}
	_, err := p.Run(context.Background(), RunOpts{})
	if err == nil {
		t.Error("FlyProvider.Run() should return an error")
	}
}
