package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"

	"smithly.dev/internal/db"
)

// cmdBinding manages channel → agent bindings.
func cmdBinding() {
	if len(os.Args) < 3 {
		fmt.Println(`Usage: smithly binding <subcommand>

Subcommands:
  list                             List all bindings
  add <channel> <agent>            Channel catch-all binding
  add <channel> <contact> <agent>  Specific contact binding
  remove <id>                      Remove binding by ID`)
		return
	}

	switch os.Args[2] {
	case "list":
		cmdBindingList()
	case "add":
		cmdBindingAdd()
	case "remove":
		cmdBindingRemove()
	default:
		fmt.Fprintf(os.Stderr, "unknown binding subcommand: %s\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdBindingList() {
	_, dbStore := loadConfig()

	bindings, err := dbStore.ListBindings(context.Background(), "")
	if err != nil {
		dbStore.Close()
		log.Fatalf("Failed to list bindings: %v", err)
	}

	if len(bindings) == 0 {
		fmt.Println("No bindings configured.")
		dbStore.Close()
		return
	}

	fmt.Printf("%-4s %-12s %-20s %-15s %s\n", "ID", "CHANNEL", "CONTACT", "AGENT", "PRIORITY")
	for _, b := range bindings {
		contact := "-"
		if b.Contact != "" {
			contact = b.Contact
		}
		fmt.Printf("%-4d %-12s %-20s %-15s %d\n", b.ID, b.Channel, contact, b.AgentID, b.Priority)
	}
	dbStore.Close()
}

func cmdBindingAdd() {
	// smithly binding add <channel> <agent>             → 5 args
	// smithly binding add <channel> <contact> <agent>   → 6 args
	if len(os.Args) < 5 {
		fmt.Println("Usage: smithly binding add <channel> [contact] <agent>")
		return
	}

	_, dbStore := loadConfig()

	var b db.Binding
	if len(os.Args) == 5 {
		// Channel catch-all
		b.Channel = os.Args[3]
		b.AgentID = os.Args[4]
	} else {
		// Specific contact
		b.Channel = os.Args[3]
		b.Contact = os.Args[4]
		b.AgentID = os.Args[5]
	}

	if err := dbStore.CreateBinding(context.Background(), &b); err != nil {
		dbStore.Close()
		log.Fatalf("Failed to create binding: %v", err)
	}

	contact := "(all)"
	if b.Contact != "" {
		contact = b.Contact
	}
	fmt.Printf("Binding #%d created: %s %s → %s (priority %d)\n", b.ID, b.Channel, contact, b.AgentID, b.Priority)
	dbStore.Close()
}

func cmdBindingRemove() {
	if len(os.Args) < 4 {
		fmt.Println("Usage: smithly binding remove <id>")
		return
	}

	id, err := strconv.ParseInt(os.Args[3], 10, 64)
	if err != nil {
		log.Fatalf("Invalid binding ID: %s", os.Args[3])
	}

	_, dbStore := loadConfig()

	if err := dbStore.DeleteBinding(context.Background(), id); err != nil {
		dbStore.Close()
		log.Fatalf("Failed to delete binding: %v", err)
	}

	fmt.Printf("Binding #%d removed.\n", id)
	dbStore.Close()
}
