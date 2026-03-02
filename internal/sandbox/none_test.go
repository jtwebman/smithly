package sandbox

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"smithly.dev/internal/skills"
)

func TestNoneBasicScript(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "main.sh"), []byte("#!/bin/bash\nread input\necho '{\"greeting\": \"hello\"}'\n"), 0755)

	p := &NoneProvider{}
	result, err := p.Run(context.Background(), RunOpts{
		Skill: codeSkill(dir, "bash", "main.sh"),
		Input: json.RawMessage(`{}`),
		Env:   []string{"PATH=" + os.Getenv("PATH")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 {
		t.Errorf("exit code = %d, stderr: %s", result.ExitCode, result.Error)
	}
	if result.Output == "" {
		t.Error("expected output from script")
	}
}

func TestNoneEnvVars(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "main.sh"), []byte("#!/bin/bash\necho \"$TEST_TOKEN\"\n"), 0755)

	p := &NoneProvider{}
	result, err := p.Run(context.Background(), RunOpts{
		Skill: codeSkill(dir, "bash", "main.sh"),
		Env:   []string{"TEST_TOKEN=secret-123", "PATH=" + os.Getenv("PATH")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Output != "secret-123\n" {
		t.Errorf("output = %q, want %q", result.Output, "secret-123\n")
	}
}

func TestNoneNonZeroExit(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "main.sh"), []byte("#!/bin/bash\necho 'error' >&2\nexit 1\n"), 0755)

	p := &NoneProvider{}
	result, err := p.Run(context.Background(), RunOpts{
		Skill: codeSkill(dir, "bash", "main.sh"),
		Env:   []string{"PATH=" + os.Getenv("PATH")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 1 {
		t.Errorf("exit code = %d, want 1", result.ExitCode)
	}
	if result.Error == "" {
		t.Error("expected stderr output")
	}
}

func TestNoneTimeout(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "main.sh"), []byte("#!/bin/bash\nsleep 60\n"), 0755)

	p := &NoneProvider{}
	start := time.Now()
	result, err := p.Run(context.Background(), RunOpts{
		Skill:   codeSkill(dir, "bash", "main.sh"),
		Env:     []string{"PATH=" + os.Getenv("PATH")},
		Timeout: 200 * time.Millisecond,
	})
	elapsed := time.Since(start)

	if elapsed > 5*time.Second {
		t.Errorf("took %v, expected quick timeout", elapsed)
	}
	if err == nil && result.ExitCode == 0 {
		t.Error("expected timeout to cause error or non-zero exit")
	}
}

func TestNoneNotCodeSkill(t *testing.T) {
	p := &NoneProvider{}
	_, err := p.Run(context.Background(), RunOpts{
		Skill: &skills.Skill{
			Manifest: skills.Manifest{
				Skill: skills.SkillMeta{Name: "test", Type: "instruction"},
			},
		},
	})
	if err == nil {
		t.Error("expected error for non-code skill")
	}
}

func TestNoneMissingCodeConfig(t *testing.T) {
	p := &NoneProvider{}
	_, err := p.Run(context.Background(), RunOpts{
		Skill: &skills.Skill{
			Manifest: skills.Manifest{
				Skill: skills.SkillMeta{Name: "test", Type: "code"},
			},
		},
	})
	if err == nil {
		t.Error("expected error for missing code config")
	}
}

func TestNoneSidecarEnvInjection(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "main.sh"), []byte("#!/bin/bash\necho \"API=$SMITHLY_API TOKEN=$SMITHLY_TOKEN\"\n"), 0755)

	sc := &mockSidecar{SidecarURL: "http://127.0.0.1:18791"}
	p := &NoneProvider{env: EnvConfig{Sidecar: sc}}
	result, err := p.Run(context.Background(), RunOpts{
		Skill: codeSkill(dir, "bash", "main.sh"),
		Env:   []string{"PATH=" + os.Getenv("PATH")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 {
		t.Errorf("exit code = %d, stderr: %s", result.ExitCode, result.Error)
	}
	if !strings.Contains(result.Output, "API=http://127.0.0.1:18791") {
		t.Errorf("output missing SMITHLY_API: %q", result.Output)
	}
	if !strings.Contains(result.Output, "TOKEN=mock-token-") {
		t.Errorf("output missing SMITHLY_TOKEN: %q", result.Output)
	}
	if !sc.Revoked {
		t.Error("expected token to be revoked after run")
	}
}

func TestNoneProxyEnvInjection(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "main.sh"), []byte("#!/bin/bash\necho \"HTTP=$HTTP_PROXY HTTPS=$HTTPS_PROXY\"\n"), 0755)

	p := &NoneProvider{env: EnvConfig{ProxyAddr: "127.0.0.1:18792"}}
	result, err := p.Run(context.Background(), RunOpts{
		Skill: codeSkill(dir, "bash", "main.sh"),
		Env:   []string{"PATH=" + os.Getenv("PATH")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 {
		t.Errorf("exit code = %d, stderr: %s", result.ExitCode, result.Error)
	}
	expected := "http://127.0.0.1:18792"
	if !strings.Contains(result.Output, "HTTP="+expected) {
		t.Errorf("output missing HTTP_PROXY: %q", result.Output)
	}
	if !strings.Contains(result.Output, "HTTPS="+expected) {
		t.Errorf("output missing HTTPS_PROXY: %q", result.Output)
	}
}

func TestNoneDefaultTimeout(t *testing.T) {
	p := &NoneProvider{}
	name := p.Name()
	if name != "none" {
		t.Errorf("name = %q, want %q", name, "none")
	}
	ok, _ := p.Available()
	if !ok {
		t.Error("NoneProvider should always be available")
	}
}

// codeSkill creates a test code skill.
func codeSkill(dir, runtime, entrypoint string) *skills.Skill {
	return &skills.Skill{
		Path: dir,
		Manifest: skills.Manifest{
			Skill: skills.SkillMeta{Name: "test", Type: "code"},
			Code: &skills.CodeSkillConfig{
				Runtime:    runtime,
				Entrypoint: entrypoint,
			},
		},
	}
}
