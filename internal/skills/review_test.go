package skills

import (
	"context"
	"fmt"
	"testing"
)

func TestReviewerBasic(t *testing.T) {
	mockReview := func(ctx context.Context, code string, skill *Skill) (string, error) {
		return "This skill checks your Gmail for unread emails and sends a notification. It needs read-only Google access.", nil
	}

	reviewer := NewReviewer(mockReview)

	skill := &Skill{
		Manifest: Manifest{
			Skill: SkillMeta{
				Name:        "gmail-checker",
				Type:        "code",
				Description: "Check Gmail for unread emails",
			},
			Code: &CodeSkillConfig{
				Runtime:    "python3",
				Entrypoint: "main.py",
			},
			Requires: &Requires{
				OAuth2:  []string{"google"},
				Domains: []string{"gmail.googleapis.com"},
			},
		},
	}

	result, err := reviewer.Review(context.Background(), skill)
	if err != nil {
		t.Fatal(err)
	}
	if result.Summary == "" {
		t.Error("expected non-empty summary")
	}
	if !result.Approved {
		t.Error("expected approved")
	}
}

func TestReviewerNotCodeSkill(t *testing.T) {
	reviewer := NewReviewer(func(ctx context.Context, code string, skill *Skill) (string, error) {
		return "", nil
	})

	skill := &Skill{
		Manifest: Manifest{
			Skill: SkillMeta{Name: "test", Type: "instruction"},
		},
	}

	_, err := reviewer.Review(context.Background(), skill)
	if err == nil {
		t.Error("expected error for non-code skill")
	}
}

func TestReviewerLLMError(t *testing.T) {
	reviewer := NewReviewer(func(ctx context.Context, code string, skill *Skill) (string, error) {
		return "", fmt.Errorf("LLM unavailable")
	})

	skill := &Skill{
		Manifest: Manifest{
			Skill: SkillMeta{Name: "test", Type: "code"},
			Code:  &CodeSkillConfig{Runtime: "bash", Entrypoint: "main.sh"},
		},
	}

	_, err := reviewer.Review(context.Background(), skill)
	if err == nil {
		t.Error("expected error from LLM failure")
	}
}
