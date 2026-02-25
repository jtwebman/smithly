package skills

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunnerBasicScript(t *testing.T) {
	dir := t.TempDir()

	// Write a simple bash script
	script := `#!/bin/bash
read input
echo "{\"greeting\": \"hello from bash\"}"
`
	os.WriteFile(filepath.Join(dir, "main.sh"), []byte(script), 0755)

	skill := &Skill{
		Path: dir,
		Manifest: Manifest{
			Skill: SkillMeta{Name: "test", Type: "code"},
			Code: &CodeSkillConfig{
				Runtime:    "bash",
				Entrypoint: "main.sh",
			},
		},
	}

	runner := NewRunner(5 * time.Second)
	result, err := runner.Run(context.Background(), skill, json.RawMessage(`{}`), os.Environ())
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

func TestRunnerEnvVars(t *testing.T) {
	dir := t.TempDir()

	script := `#!/bin/bash
echo "$TEST_TOKEN"
`
	os.WriteFile(filepath.Join(dir, "main.sh"), []byte(script), 0755)

	skill := &Skill{
		Path: dir,
		Manifest: Manifest{
			Skill: SkillMeta{Name: "test", Type: "code"},
			Code: &CodeSkillConfig{
				Runtime:    "bash",
				Entrypoint: "main.sh",
			},
		},
	}

	runner := NewRunner(5 * time.Second)
	env := []string{"TEST_TOKEN=secret-123", "PATH=" + os.Getenv("PATH")}
	result, err := runner.Run(context.Background(), skill, nil, env)
	if err != nil {
		t.Fatal(err)
	}
	if result.Output != "secret-123\n" {
		t.Errorf("output = %q, want %q", result.Output, "secret-123\n")
	}
}

func TestRunnerNonZeroExit(t *testing.T) {
	dir := t.TempDir()

	script := `#!/bin/bash
echo "error output" >&2
exit 1
`
	os.WriteFile(filepath.Join(dir, "main.sh"), []byte(script), 0755)

	skill := &Skill{
		Path: dir,
		Manifest: Manifest{
			Skill: SkillMeta{Name: "test", Type: "code"},
			Code: &CodeSkillConfig{
				Runtime:    "bash",
				Entrypoint: "main.sh",
			},
		},
	}

	runner := NewRunner(5 * time.Second)
	result, err := runner.Run(context.Background(), skill, nil, os.Environ())
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

func TestRunnerNotCodeSkill(t *testing.T) {
	skill := &Skill{
		Manifest: Manifest{
			Skill: SkillMeta{Name: "test", Type: "instruction"},
		},
	}

	runner := NewRunner(5 * time.Second)
	_, err := runner.Run(context.Background(), skill, nil, nil)
	if err == nil {
		t.Error("expected error for non-code skill")
	}
}

func TestRunnerMissingCodeConfig(t *testing.T) {
	skill := &Skill{
		Manifest: Manifest{
			Skill: SkillMeta{Name: "test", Type: "code"},
			// No Code config
		},
	}

	runner := NewRunner(5 * time.Second)
	_, err := runner.Run(context.Background(), skill, nil, nil)
	if err == nil {
		t.Error("expected error for missing code config")
	}
}

func TestRunnerTimeout(t *testing.T) {
	dir := t.TempDir()

	script := `#!/bin/bash
sleep 60
`
	os.WriteFile(filepath.Join(dir, "main.sh"), []byte(script), 0755)

	skill := &Skill{
		Path: dir,
		Manifest: Manifest{
			Skill: SkillMeta{Name: "test", Type: "code"},
			Code: &CodeSkillConfig{
				Runtime:    "bash",
				Entrypoint: "main.sh",
			},
		},
	}

	start := time.Now()
	runner := NewRunner(200 * time.Millisecond)
	result, err := runner.Run(context.Background(), skill, nil, os.Environ())
	elapsed := time.Since(start)

	// Should complete quickly (not wait for sleep 60)
	if elapsed > 5*time.Second {
		t.Errorf("took %v, expected quick timeout", elapsed)
	}
	// Should complete with error or non-zero exit
	if err == nil && result.ExitCode == 0 {
		t.Error("expected timeout to cause error or non-zero exit")
	}
}

func TestRunnerDefaultTimeout(t *testing.T) {
	runner := NewRunner(0)
	if runner.timeout != 30*time.Second {
		t.Errorf("default timeout = %v, want 30s", runner.timeout)
	}
}
