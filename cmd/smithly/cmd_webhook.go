package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"
)

func cmdWebhook() {
	if len(os.Args) < 3 {
		printWebhookUsage()
		os.Exit(1)
	}

	switch os.Args[2] {
	case "list":
		cmdWebhookList()
	case "log":
		cmdWebhookLog()
	case "help", "--help", "-h":
		printWebhookUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown webhook command: %s\n", os.Args[2])
		printWebhookUsage()
		os.Exit(1)
	}
}

func cmdWebhookList() {
	cfg, _ := loadConfig()

	if len(cfg.Webhooks) == 0 {
		fmt.Println("No webhooks configured.")
		return
	}

	bind := cfg.Webhook.Bind
	if bind == "" {
		bind = "127.0.0.1"
	}
	port := cfg.Webhook.Port
	if port == 0 {
		port = defaultWebhookPort
	}

	fmt.Printf("Webhook server: http://%s:%d\n\n", bind, port)
	fmt.Printf("%-15s %-15s %-10s %s\n", "NAME", "AGENT", "SECRET", "URL")
	for _, wh := range cfg.Webhooks {
		secret := "none"
		if wh.Secret != "" {
			secret = "yes"
		}
		fmt.Printf("%-15s %-15s %-10s /w/%s\n", wh.Name, wh.Agent, secret, wh.Name)
	}
}

func cmdWebhookLog() {
	flags := flag.NewFlagSet("webhook log", flag.ExitOnError)
	limit := flags.Int("limit", 20, "max entries to show")
	if err := flags.Parse(os.Args[3:]); err != nil {
		os.Exit(1)
	}

	var webhookName string
	if flags.NArg() > 0 {
		webhookName = flags.Arg(0)
	}

	_, store := loadConfig()

	entries, err := store.ListWebhookLog(context.Background(), webhookName, *limit)
	if err != nil {
		log.Fatalf("Failed to query webhook log: %v", err)
	}

	if len(entries) == 0 {
		fmt.Println("No webhook deliveries found.")
		return
	}

	fmt.Printf("%-6s %-12s %-15s %-5s %-10s %s\n", "ID", "WEBHOOK", "SOURCE IP", "SIG", "AGENT", "TIME")
	for _, e := range entries {
		sig := "n/a"
		if e.SignatureValid {
			sig = "ok"
		} else if e.Headers != "" {
			sig = "FAIL"
		}
		ts := e.CreatedAt.Format(time.DateTime)
		fmt.Printf("%-6s %-12s %-15s %-5s %-10s %s\n",
			strconv.FormatInt(e.ID, 10), e.Webhook, e.SourceIP, sig, e.AgentID, ts)
	}
}

func printWebhookUsage() {
	fmt.Println(`smithly webhook — manage inbound webhooks

Commands:
  list                    List configured webhooks
  log [name] [--limit N]  Show webhook delivery log`)
}
