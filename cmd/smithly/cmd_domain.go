package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	"smithly.dev/internal/db"
)

// cmdDomain manages the network domain allowlist.
func cmdDomain() {
	if len(os.Args) < 3 {
		fmt.Println(`Usage: smithly domain <subcommand>

Subcommands:
  list                List all domains and their status
  allow <domain>      Allow a domain
  deny <domain>       Deny a domain
  log [--domain <d>]  Show domain access log`)
		return
	}

	switch os.Args[2] {
	case "list":
		cmdDomainList()
	case "allow":
		cmdDomainSet("allow")
	case "deny":
		cmdDomainSet("deny")
	case "log":
		cmdDomainLog()
	default:
		fmt.Fprintf(os.Stderr, "unknown domain subcommand: %s\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdDomainList() {
	_, dbStore := loadConfig()

	entries, err := dbStore.ListDomains(context.Background())
	if err != nil {
		dbStore.Close()
		log.Fatalf("Failed to list domains: %v", err)
	}

	if len(entries) == 0 {
		fmt.Println("No domains in allowlist.")
		dbStore.Close()
		return
	}

	fmt.Printf("%-30s %-8s %-15s %-8s %s\n", "DOMAIN", "STATUS", "GRANTED BY", "COUNT", "LAST ACCESSED")
	for _, e := range entries {
		lastAccessed := "-"
		if !e.LastAccessed.IsZero() {
			lastAccessed = e.LastAccessed.Format("2006-01-02 15:04")
		}
		fmt.Printf("%-30s %-8s %-15s %-8d %s\n",
			e.Domain, e.Status, e.GrantedBy, e.AccessCount, lastAccessed)
	}
	dbStore.Close()
}

func cmdDomainSet(status string) {
	if len(os.Args) < 4 {
		fmt.Printf("Usage: smithly domain %s <domain>\n", status)
		return
	}

	domain := os.Args[3]
	_, dbStore := loadConfig()

	err := dbStore.SetDomain(context.Background(), &db.DomainEntry{
		Domain:    strings.ToLower(strings.TrimSpace(domain)),
		Status:    status,
		GrantedBy: "user",
	})
	if err != nil {
		dbStore.Close()
		log.Fatalf("Failed to set domain: %v", err)
	}

	fmt.Printf("Domain %q set to %s\n", domain, status)
	dbStore.Close()
}

func cmdDomainLog() {
	_, dbStore := loadConfig()

	query := db.AuditQuery{Limit: 50}

	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--domain":
			if i+1 < len(args) {
				i++
				query.Domain = args[i]
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

	// If no domain filter, only show gatekeeper entries
	entries, err := dbStore.GetAuditLog(context.Background(), query)
	if err != nil {
		dbStore.Close()
		log.Fatalf("Failed to read audit log: %v", err)
	}

	if len(entries) == 0 {
		fmt.Println("No domain access entries found.")
		dbStore.Close()
		return
	}

	fmt.Printf("%-20s %-8s %-30s %s\n", "TIMESTAMP", "ACTION", "DOMAIN", "ACTOR")
	for _, e := range entries {
		if e.Domain == "" {
			continue
		}
		action := strings.TrimPrefix(e.Action, "domain_")
		fmt.Printf("%-20s %-8s %-30s %s\n",
			e.Timestamp.Format("2006-01-02 15:04:05"),
			action,
			e.Domain,
			e.Actor,
		)
	}
	dbStore.Close()
}
