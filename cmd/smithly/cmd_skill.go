package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"smithly.dev/internal/config"
	"smithly.dev/internal/db/sqlite"
	"smithly.dev/internal/gatekeeper"
	"smithly.dev/internal/skills"
)

// cmdSkill manages instruction skills (list, add, remove).
func cmdSkill() {
	if len(os.Args) < 3 {
		fmt.Println(`Usage: smithly skill <subcommand>

Subcommands:
  list                List installed skills
  add <path>          Install a skill from a directory
  remove <name>       Remove an installed skill

Flags:
  --agent <id>        Target a specific agent (default: first agent)`)
		return
	}

	switch os.Args[2] {
	case "list":
		cmdSkillList()
	case "add":
		cmdSkillAdd()
	case "remove":
		cmdSkillRemove()
	default:
		fmt.Fprintf(os.Stderr, "unknown skill subcommand: %s\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdSkillList() {
	cfg, agentID := parseSkillFlags(3)
	ac := findAgent(cfg, agentID)

	skillsDir := filepath.Join(ac.Workspace, "skills")
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		fmt.Println("No skills installed.")
		return
	}

	count := 0
	fmt.Printf("%-20s %-10s %s\n", "NAME", "VERSION", "DESCRIPTION")
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		s, err := skills.Load(filepath.Join(skillsDir, entry.Name()))
		if err != nil {
			fmt.Fprintf(os.Stderr, "  warning: %s: %v\n", entry.Name(), err)
			continue
		}
		desc := s.Manifest.Skill.Description
		if desc == "" {
			desc = "(no description)"
		}
		version := s.Manifest.Skill.Version
		if version == "" {
			version = "-"
		}
		fmt.Printf("%-20s %-10s %s\n", s.Manifest.Skill.Name, version, desc)
		count++
	}
	if count == 0 {
		fmt.Println("No skills installed.")
	}
}

func cmdSkillAdd() {
	cfg, agentID := parseSkillFlags(4)
	ac := findAgent(cfg, agentID)

	// Find the source path argument (skip --agent flags)
	srcPath := ""
	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		if args[i] == "--agent" {
			i++ // skip value
			continue
		}
		srcPath = args[i]
		break
	}
	if srcPath == "" {
		log.Fatal("Usage: smithly skill add <path> [--agent <id>]")
	}

	// Validate it's a loadable skill
	s, err := skills.Load(srcPath)
	if err != nil {
		log.Fatalf("Invalid skill at %s: %v", srcPath, err)
	}

	// Copy to workspace/skills/<name>/
	destDir := filepath.Join(ac.Workspace, "skills", s.Manifest.Skill.Name)
	if _, err := os.Stat(destDir); err == nil {
		log.Fatalf("Skill %q already installed. Remove it first with: smithly skill remove %s",
			s.Manifest.Skill.Name, s.Manifest.Skill.Name)
	}

	if err := copyDir(srcPath, destDir); err != nil {
		log.Fatalf("Failed to install skill: %v", err)
	}

	fmt.Printf("Installed skill %q into %s\n", s.Manifest.Skill.Name, destDir)

	// Auto-approve required domains
	if s.Manifest.Requires != nil && len(s.Manifest.Requires.Domains) > 0 {
		dbStore, err := sqlite.New(cfg.Storage.Database)
		if err == nil {
			if err := dbStore.Migrate(context.Background()); err == nil {
				gk := gatekeeper.New(dbStore, nil)
				seeded := gk.SeedSkillDomains(context.Background(), s.Manifest.Requires.Domains, s.Manifest.Skill.Name)
				if len(seeded) > 0 {
					fmt.Printf("\nAuto-approved domains: %s\n", strings.Join(seeded, ", "))
				}

				// Warn about already-denied domains
				for _, d := range s.Manifest.Requires.Domains {
					entry, err := dbStore.GetDomain(context.Background(), strings.ToLower(d))
					if err == nil && entry.Status == "deny" {
						fmt.Printf("\n  Warning: domain %q is denied. Skill may not function correctly.\n", d)
						fmt.Printf("  Allow it with: smithly domain allow %s\n", d)
					}
				}
			}
			dbStore.Close()
		}
	}

	// Warn about OAuth2 requirements
	if s.Manifest.Requires != nil && len(s.Manifest.Requires.OAuth2) > 0 {
		cfg, err := config.Load("smithly.toml")
		if err == nil {
			configured := make(map[string]bool)
			for _, p := range cfg.OAuth2 {
				configured[p.Name] = true
			}
			for _, provider := range s.Manifest.Requires.OAuth2 {
				if !configured[provider] {
					fmt.Printf("\n  Warning: skill requires OAuth2 provider %q which is not configured.\n", provider)
					fmt.Printf("  Add a [[oauth2]] section to smithly.toml, then run: smithly oauth2 auth %s\n", provider)
				}
			}
		}
	}
}

func cmdSkillRemove() {
	cfg, agentID := parseSkillFlags(4)
	ac := findAgent(cfg, agentID)

	// Find the skill name argument (skip --agent flags)
	skillName := ""
	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		if args[i] == "--agent" {
			i++ // skip value
			continue
		}
		skillName = args[i]
		break
	}
	if skillName == "" {
		log.Fatal("Usage: smithly skill remove <name> [--agent <id>]")
	}

	destDir := filepath.Join(ac.Workspace, "skills", skillName)
	if _, err := os.Stat(destDir); err != nil {
		log.Fatalf("Skill %q not found in %s", skillName, filepath.Join(ac.Workspace, "skills"))
	}

	if err := os.RemoveAll(destDir); err != nil {
		log.Fatalf("Failed to remove skill: %v", err)
	}

	fmt.Printf("Removed skill %q\n", skillName)
}

// parseSkillFlags extracts --agent flag from args starting at position minArgs.
func parseSkillFlags(minArgs int) (cfg *config.Config, agentID string) {
	var err error
	cfg, err = config.Load("smithly.toml")
	if err != nil {
		log.Fatalf("Failed to load config: %v\nRun 'smithly init' first.", err)
	}

	args := os.Args[3:]
	for i := range args {
		if args[i] == "--agent" && i+1 < len(args) {
			agentID = args[i+1]
			break
		}
	}
	return cfg, agentID
}

// findAgent looks up an agent config by ID, or returns the first agent.
func findAgent(cfg *config.Config, agentID string) *config.AgentConfig {
	for i := range cfg.Agents {
		if agentID == "" || cfg.Agents[i].ID == agentID {
			return &cfg.Agents[i]
		}
	}
	if agentID != "" {
		log.Fatalf("Agent %q not found in config", agentID)
	}
	log.Fatal("No agents configured. Run 'smithly init' first.")
	return nil
}

// copyDir recursively copies a directory.
func copyDir(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			data, err := os.ReadFile(srcPath)
			if err != nil {
				return err
			}
			if err := os.WriteFile(dstPath, data, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}
