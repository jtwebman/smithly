package main

import (
	"fmt"
	"os"
)

const (
	defaultOAuthCallbackPort = 18790
	defaultSidecarPort       = 18791
	defaultGatekeeperPort    = 18792
	defaultWebhookPort       = 18793
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "init":
		cmdInit()
	case "start":
		cmdStart()
	case "chat":
		cmdChat()
	case "agent":
		cmdAgent()
	case "skill":
		cmdSkill()
	case "oauth2":
		cmdOAuth2()
	case "audit":
		cmdAudit()
	case "binding":
		cmdBinding()
	case "domain":
		cmdDomain()
	case "memory":
		cmdMemory()
	case "webhook":
		cmdWebhook()
	case "doctor":
		cmdDoctor()
	case "version":
		fmt.Println("smithly v0.1.0-dev")
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`smithly — secure AI agent runtime

Commands:
  init      First-time setup wizard
  start     Start gateway + agents (HTTP API)
  chat      Interactive terminal chat with an agent
  agent     Manage agents (list, add, remove)
  skill     Manage instruction skills (list, add, remove)
  oauth2    Manage OAuth2 providers (auth, list)
  audit     Show audit log
  binding   Manage channel → agent bindings
  domain    Manage network domain allowlist
  webhook   List configured webhooks and delivery log
  memory    Search, stats, export, and embed conversation memory
  doctor    Check dependencies
  version   Print version

Run 'smithly <command> --help' for details.`)
}
