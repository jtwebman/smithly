package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"smithly.dev/internal/config"
	"smithly.dev/internal/credentials"
)

// cmdOAuth2 manages OAuth2 providers (auth, list).
func cmdOAuth2() {
	if len(os.Args) < 3 {
		fmt.Println(`Usage: smithly oauth2 <subcommand>

Subcommands:
  auth <provider>   Authorize an OAuth2 provider (opens browser)
  list              List configured providers and auth status`)
		return
	}

	switch os.Args[2] {
	case "auth":
		cmdOAuth2Auth()
	case "list":
		cmdOAuth2List()
	default:
		fmt.Fprintf(os.Stderr, "unknown oauth2 subcommand: %s\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdOAuth2Auth() {
	if len(os.Args) < 4 {
		fmt.Println("Usage: smithly oauth2 auth <provider>")
		return
	}
	providerName := os.Args[3]

	cfg, err := config.Load("smithly.toml")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Find the OAuth2 provider config
	var providerCfg *config.OAuth2Config
	for i := range cfg.OAuth2 {
		if cfg.OAuth2[i].Name == providerName {
			providerCfg = &cfg.OAuth2[i]
			break
		}
	}
	if providerCfg == nil {
		fmt.Fprintf(os.Stderr, "OAuth2 provider %q not found in smithly.toml\n", providerName)
		fmt.Fprintf(os.Stderr, "\nConfigured providers:\n")
		for _, p := range cfg.OAuth2 {
			fmt.Fprintf(os.Stderr, "  - %s\n", p.Name)
		}
		os.Exit(1)
	}

	credStore := loadCredentialStore(cfg)

	// Start local callback server
	callbackPort := defaultOAuthCallbackPort
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code == "" {
			errCh <- fmt.Errorf("no authorization code in callback")
			fmt.Fprintf(w, "Error: no authorization code received.")
			return
		}
		codeCh <- code
		fmt.Fprintf(w, "Authorization successful! You can close this tab.")
	})

	srv := &http.Server{
		Addr:         fmt.Sprintf("localhost:%d", callbackPort),
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	// Build auth URL
	redirectURI := fmt.Sprintf("http://localhost:%d/callback", callbackPort)
	authURL := fmt.Sprintf("%s?client_id=%s&redirect_uri=%s&response_type=code&scope=%s&access_type=offline&prompt=consent",
		providerCfg.AuthURL,
		providerCfg.ClientID,
		redirectURI,
		strings.Join(providerCfg.Scopes, " "),
	)

	fmt.Printf("Opening browser for %s authorization...\n", providerName)
	fmt.Printf("\nIf the browser doesn't open, visit:\n%s\n\n", authURL)

	// Try to open browser
	openBrowser(authURL)

	fmt.Println("Waiting for authorization callback...")

	// Wait for callback
	select {
	case code := <-codeCh:
		// Exchange code for tokens
		data := fmt.Sprintf("grant_type=authorization_code&code=%s&redirect_uri=%s&client_id=%s&client_secret=%s",
			code, redirectURI, providerCfg.ClientID, providerCfg.ClientSecret)

		tokenClient := &http.Client{Timeout: 30 * time.Second}
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, providerCfg.TokenURL, strings.NewReader(data))
		if err != nil {
			log.Fatalf("Failed to create token request: %v", err)
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := tokenClient.Do(req)
		if err != nil {
			log.Fatalf("Token exchange failed: %v", err)
		}
		var tokenResp struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			TokenType    string `json:"token_type"`
			ExpiresIn    int    `json:"expires_in"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
			resp.Body.Close()
			log.Fatalf("Failed to parse token response: %v", err)
		}
		resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			log.Fatalf("Token endpoint returned HTTP %d", resp.StatusCode)
		}

		token := &credentials.OAuth2Token{
			AccessToken:  tokenResp.AccessToken,
			RefreshToken: tokenResp.RefreshToken,
			TokenType:    tokenResp.TokenType,
		}
		if tokenResp.ExpiresIn > 0 {
			token.Expiry = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
		}

		if err := credStore.Put(context.Background(), providerName, token); err != nil {
			log.Fatalf("Failed to save credentials: %v", err)
		}

		fmt.Printf("\n%s authorized successfully! Token saved.\n", providerName)

	case err := <-errCh:
		log.Fatalf("Authorization failed: %v", err)
	}

	if err := srv.Shutdown(context.Background()); err != nil {
		slog.Error("callback server shutdown error", "err", err)
	}
}

func cmdOAuth2List() {
	cfg, err := config.Load("smithly.toml")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if len(cfg.OAuth2) == 0 {
		fmt.Println("No OAuth2 providers configured.")
		fmt.Println("\nAdd providers to smithly.toml:")
		fmt.Println("  [[oauth2]]")
		fmt.Println("  name = \"google\"")
		fmt.Println("  client_id = \"...\"")
		fmt.Println("  client_secret = \"...\"")
		fmt.Println("  scopes = [\"https://www.googleapis.com/auth/gmail.readonly\"]")
		fmt.Println("  auth_url = \"https://accounts.google.com/o/oauth2/auth\"")
		fmt.Println("  token_url = \"https://oauth2.googleapis.com/token\"")
		return
	}

	credStore := loadCredentialStore(cfg)

	fmt.Printf("%-20s %-12s %s\n", "PROVIDER", "STATUS", "SCOPES")
	for _, p := range cfg.OAuth2 {
		status := "not authorized"
		tok, err := credStore.Get(context.Background(), p.Name)
		if err == nil && tok != nil {
			if tok.RefreshToken != "" {
				status = "authorized"
			} else {
				status = "no refresh token"
			}
		}
		scopes := strings.Join(p.Scopes, ", ")
		if len(scopes) > 50 {
			scopes = scopes[:50] + "..."
		}
		fmt.Printf("%-20s %-12s %s\n", p.Name, status, scopes)
	}
}

func openBrowser(url string) {
	// Try common browser openers
	for _, cmd := range []string{"xdg-open", "open", "wslview"} {
		if _, err := exec.LookPath(cmd); err == nil {
			if err := exec.Command(cmd, url).Start(); err != nil {
				slog.Error("failed to open browser", "cmd", cmd, "err", err)
			}
			return
		}
	}
}
