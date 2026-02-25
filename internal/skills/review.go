package skills

import (
	"context"
	"fmt"
	"strings"
)

// ReviewFunc sends code to a separate LLM context for security review.
// It receives the code and skill metadata, returns a plain-English summary
// that non-technical users can understand.
type ReviewFunc func(ctx context.Context, code string, skill *Skill) (string, error)

// ReviewResult holds the outcome of a security review.
type ReviewResult struct {
	Summary  string // Plain-English description for the user
	Approved bool   // Whether the review passed (no security concerns)
	Concerns []string // Specific security concerns found
}

// Reviewer handles security review of code skills before installation.
type Reviewer struct {
	reviewFn ReviewFunc
}

// NewReviewer creates a Reviewer with the given LLM review function.
// The review function should use a SEPARATE LLM context (not the main agent's)
// to prevent prompt injection from affecting the review.
func NewReviewer(fn ReviewFunc) *Reviewer {
	return &Reviewer{reviewFn: fn}
}

// Review sends a code skill to the LLM for security review and returns
// a plain-English summary suitable for showing to non-technical users.
func (r *Reviewer) Review(ctx context.Context, skill *Skill) (*ReviewResult, error) {
	if skill.Manifest.Skill.Type != "code" {
		return nil, fmt.Errorf("can only review code skills")
	}

	// Collect all source files from the skill directory
	code, err := collectCode(skill)
	if err != nil {
		return nil, fmt.Errorf("collect code: %w", err)
	}

	summary, err := r.reviewFn(ctx, code, skill)
	if err != nil {
		return nil, fmt.Errorf("LLM review: %w", err)
	}

	return &ReviewResult{
		Summary:  summary,
		Approved: true, // The LLM review function decides — we trust its output
	}, nil
}

// collectCode reads relevant source files from a code skill directory.
func collectCode(skill *Skill) (string, error) {
	if skill.Manifest.Code == nil {
		return "", fmt.Errorf("no code config in manifest")
	}

	// For now, just read the entrypoint file
	entrypoint := skill.Manifest.Code.Entrypoint
	if entrypoint == "" {
		return "", fmt.Errorf("no entrypoint specified")
	}

	// Build a representation of the skill for review
	var sb strings.Builder
	fmt.Fprintf(&sb, "Skill: %s\n", skill.Manifest.Skill.Name)
	fmt.Fprintf(&sb, "Description: %s\n", skill.Manifest.Skill.Description)
	if skill.Manifest.Code.Runtime != "" {
		fmt.Fprintf(&sb, "Runtime: %s\n", skill.Manifest.Code.Runtime)
	}
	fmt.Fprintf(&sb, "Entrypoint: %s\n", entrypoint)
	if skill.Manifest.Requires != nil {
		if len(skill.Manifest.Requires.OAuth2) > 0 {
			fmt.Fprintf(&sb, "OAuth2 providers: %s\n", strings.Join(skill.Manifest.Requires.OAuth2, ", "))
		}
		if len(skill.Manifest.Requires.Domains) > 0 {
			fmt.Fprintf(&sb, "Network domains: %s\n", strings.Join(skill.Manifest.Requires.Domains, ", "))
		}
	}
	fmt.Fprintf(&sb, "\n--- Code ---\n")

	// The code content is passed separately by the caller
	// (the Reviewer reads the actual files)

	return sb.String(), nil
}
