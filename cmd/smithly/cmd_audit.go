package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"

	"smithly.dev/internal/db"
)

// cmdAudit shows the audit log.
func cmdAudit() {
	_, store := loadConfig()

	query := db.AuditQuery{Limit: 50}

	// Parse flags: smithly audit [--agent ID] [--limit N]
	args := os.Args[2:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--agent":
			if i+1 < len(args) {
				i++
				query.AgentID = args[i]
			}
		case "--limit":
			if i+1 < len(args) {
				i++
				if n, err := strconv.Atoi(args[i]); err == nil {
					query.Limit = n
				}
			}
		}
	}

	entries, err := store.GetAuditLog(context.Background(), query)
	if err != nil {
		store.Close()
		log.Fatalf("Failed to read audit log: %v", err)
	}

	if len(entries) == 0 {
		fmt.Println("No audit entries found.")
		store.Close()
		return
	}

	for _, e := range entries {
		target := ""
		if e.Target != "" {
			target = " → " + e.Target
		}
		details := ""
		if e.Details != "" {
			d := e.Details
			if len(d) > 80 {
				d = d[:80] + "..."
			}
			details = "  " + d
		}
		fmt.Printf("%s  %-20s  %-12s%s%s\n",
			e.Timestamp.Format("2006-01-02 15:04:05"),
			e.Actor,
			e.Action,
			target,
			details,
		)
	}
	store.Close()
}
