package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"smithly.dev/internal/config"
	"smithly.dev/internal/embedding"
	"smithly.dev/internal/sandbox"
)

// cmdDoctor checks that dependencies are available.
func cmdDoctor() {
	fmt.Println("Smithly Doctor")
	fmt.Println()

	// Check for smithly.toml
	if _, err := os.Stat("smithly.toml"); err == nil {
		fmt.Println("  [ok] smithly.toml found")
	} else {
		fmt.Println("  [--] smithly.toml not found (run 'smithly init')")
	}

	// Active sandbox provider
	var activeProvider string
	if cfg, err := config.Load("smithly.toml"); err == nil {
		activeProvider = cfg.Sandbox.Provider
	}
	if activeProvider == "" {
		activeProvider = "none"
	}
	fmt.Printf("  [ok] sandbox provider: %s\n", activeProvider)

	// Docker
	if ok, detail := sandbox.CheckDocker(); ok {
		fmt.Printf("  [ok] %s\n", detail)
	} else {
		fmt.Printf("  [--] %s\n", detail)
	}

	// Fly
	if ok, detail := sandbox.CheckFly(); ok {
		fmt.Printf("  [ok] %s\n", detail)
	} else {
		fmt.Printf("  [--] %s\n", detail)
	}

	// Ollama
	if _, err := exec.LookPath("ollama"); err == nil {
		fmt.Println("  [ok] ollama found")
	} else {
		fmt.Println("  [--] ollama not found")
	}

	// KVM
	if _, err := os.Stat("/dev/kvm"); err == nil {
		fmt.Println("  [ok] KVM available")
	} else {
		fmt.Println("  [--] KVM not available")
	}

	// Embedding provider
	if cfg, err := config.Load("smithly.toml"); err == nil && cfg.Memory != nil && cfg.Memory.EmbeddingModel != "" {
		embedder := embedding.NewClient(
			cfg.Memory.EmbeddingBaseURL,
			cfg.Memory.EmbeddingAPIKey,
			cfg.Memory.EmbeddingModel,
			cfg.Memory.Dimensions,
		)
		_, err := embedder.Embed(context.Background(), "test")
		if err == nil {
			fmt.Printf("  [ok] embedding provider: %s (%s)\n", cfg.Memory.EmbeddingProvider, cfg.Memory.EmbeddingModel)
		} else {
			fmt.Printf("  [--] embedding provider: %s (%v)\n", cfg.Memory.EmbeddingProvider, err)
		}
	}

	fmt.Println()
}
