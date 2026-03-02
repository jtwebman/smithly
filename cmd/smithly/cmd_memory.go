package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"

	"smithly.dev/internal/embedding"
	"smithly.dev/internal/memory"
)

// cmdMemory provides memory search, stats, export, and embed commands.
func cmdMemory() {
	if len(os.Args) < 3 {
		fmt.Println(`Usage: smithly memory <subcommand>

Subcommands:
  search <query>    Search conversation memory
  stats             Show message and embedding counts
  export            Export messages as JSON
  embed             Generate embeddings for un-embedded messages

Flags:
  --agent <id>      Target a specific agent (default: first agent)
  --limit <n>       Limit results (default varies by command)
  --mode <mode>     Search mode: keyword, semantic, hybrid`)
		return
	}

	switch os.Args[2] {
	case "search":
		cmdMemorySearch()
	case "stats":
		cmdMemoryStats()
	case "export":
		cmdMemoryExport()
	case "embed":
		cmdMemoryEmbed()
	default:
		fmt.Fprintf(os.Stderr, "unknown memory subcommand: %s\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdMemorySearch() {
	cfg, dbStore := loadConfig()

	agentID := ""
	limit := 20
	mode := ""
	query := ""

	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--agent":
			if i+1 < len(args) {
				i++
				agentID = args[i]
			}
		case "--limit":
			if i+1 < len(args) {
				i++
				if n, err := strconv.Atoi(args[i]); err == nil {
					limit = n
				}
			}
		case "--mode":
			if i+1 < len(args) {
				i++
				mode = args[i]
			}
		default:
			if query == "" {
				query = args[i]
			}
		}
	}

	if query == "" {
		fmt.Println("Usage: smithly memory search <query> [--agent ID] [--limit N] [--mode keyword|semantic|hybrid]")
		dbStore.Close()
		return
	}

	if agentID == "" && len(cfg.Agents) > 0 {
		agentID = cfg.Agents[0].ID
	}

	var embedder embedding.Client
	if cfg.Memory != nil && cfg.Memory.EmbeddingModel != "" {
		embedder = embedding.NewClient(
			cfg.Memory.EmbeddingBaseURL,
			cfg.Memory.EmbeddingAPIKey,
			cfg.Memory.EmbeddingModel,
			cfg.Memory.Dimensions,
		)
	}

	searcher := memory.NewSearcher(dbStore, embedder)
	results, err := searcher.Search(context.Background(), agentID, query, mode, limit)
	if err != nil {
		dbStore.Close()
		log.Fatalf("Search failed: %v", err)
	}

	if len(results) == 0 {
		fmt.Printf("No messages found matching %q.\n", query)
		dbStore.Close()
		return
	}

	fmt.Printf("Found %d result(s) for %q:\n\n", len(results), query)
	for _, r := range results {
		ts := r.CreatedAt.Format("2006-01-02 15:04:05")
		content := r.Content
		if len(content) > 200 {
			content = content[:200] + "..."
		}
		fmt.Printf("  [%.2f] %s %s: %s\n", r.Score, ts, r.Role, content)
	}
	dbStore.Close()
}

func cmdMemoryStats() {
	cfg, dbStore := loadConfig()

	agentID := ""
	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		if args[i] == "--agent" && i+1 < len(args) {
			i++
			agentID = args[i]
		}
	}

	if agentID == "" && len(cfg.Agents) > 0 {
		agentID = cfg.Agents[0].ID
	}

	msgs, err := dbStore.GetMessages(context.Background(), agentID, 1000000)
	if err != nil {
		dbStore.Close()
		log.Fatalf("Failed to get messages: %v", err)
	}

	embCount, err := dbStore.GetEmbeddingCount(context.Background(), agentID)
	if err != nil {
		dbStore.Close()
		log.Fatalf("Failed to get embedding count: %v", err)
	}

	fmt.Printf("Agent: %s\n", agentID)
	fmt.Printf("  Messages:   %d\n", len(msgs))
	fmt.Printf("  Embeddings: %d\n", embCount)
	if len(msgs) > 0 {
		pct := float64(embCount) / float64(len(msgs)) * 100
		fmt.Printf("  Coverage:   %.0f%%\n", pct)
	}

	if cfg.Memory != nil && cfg.Memory.EmbeddingModel != "" {
		fmt.Printf("  Provider:   %s\n", cfg.Memory.EmbeddingProvider)
		fmt.Printf("  Model:      %s\n", cfg.Memory.EmbeddingModel)
	} else {
		fmt.Printf("  Embeddings: not configured (FTS5 only)\n")
	}
	dbStore.Close()
}

func cmdMemoryExport() {
	cfg, dbStore := loadConfig()

	agentID := ""
	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		if args[i] == "--agent" && i+1 < len(args) {
			i++
			agentID = args[i]
		}
	}

	if agentID == "" && len(cfg.Agents) > 0 {
		agentID = cfg.Agents[0].ID
	}

	msgs, err := dbStore.GetMessages(context.Background(), agentID, 1000000)
	if err != nil {
		dbStore.Close()
		log.Fatalf("Failed to get messages: %v", err)
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(msgs); err != nil {
		dbStore.Close()
		log.Fatalf("Failed to encode: %v", err)
	}
	dbStore.Close()
}

func cmdMemoryEmbed() {
	cfg, dbStore := loadConfig()

	if cfg.Memory == nil || cfg.Memory.EmbeddingModel == "" {
		fmt.Println("No [memory] section in smithly.toml. Add embedding config first.")
		fmt.Println("\nExample:")
		fmt.Println("  [memory]")
		fmt.Println("  embedding_provider = \"ollama\"")
		fmt.Println("  embedding_model = \"nomic-embed-text\"")
		fmt.Println("  embedding_base_url = \"http://localhost:11434/v1\"")
		fmt.Println("  dimensions = 768")
		dbStore.Close()
		return
	}

	agentID := ""
	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		if args[i] == "--agent" && i+1 < len(args) {
			i++
			agentID = args[i]
		}
	}

	if agentID == "" && len(cfg.Agents) > 0 {
		agentID = cfg.Agents[0].ID
	}

	embedder := embedding.NewClient(
		cfg.Memory.EmbeddingBaseURL,
		cfg.Memory.EmbeddingAPIKey,
		cfg.Memory.EmbeddingModel,
		cfg.Memory.Dimensions,
	)

	msgs, err := dbStore.GetUnembeddedMessages(context.Background(), agentID, 0)
	if err != nil {
		dbStore.Close()
		log.Fatalf("Failed to get messages: %v", err)
	}

	if len(msgs) == 0 {
		fmt.Println("All messages already have embeddings.")
		dbStore.Close()
		return
	}

	fmt.Printf("Generating embeddings for %d messages...\n", len(msgs))
	count := 0
	for _, m := range msgs {
		vec, err := embedder.Embed(context.Background(), m.Content)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  warning: message %d: %v\n", m.ID, err)
			continue
		}
		if err := dbStore.StoreEmbedding(context.Background(), m.ID, vec, cfg.Memory.EmbeddingModel, len(vec)); err != nil {
			fmt.Fprintf(os.Stderr, "  warning: store embedding %d: %v\n", m.ID, err)
			continue
		}
		count++
		if count%10 == 0 {
			fmt.Printf("  %d/%d\n", count, len(msgs))
		}
	}
	fmt.Printf("Done. Generated %d embeddings.\n", count)
	dbStore.Close()
}
