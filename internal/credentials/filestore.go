package credentials

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"sync"
)

// FileStore stores credentials in a local JSON file with 0600 permissions.
type FileStore struct {
	path string
	mu   sync.Mutex
}

// NewFileStore creates a FileStore at the given path.
// The file is created on first write if it doesn't exist.
func NewFileStore(path string) *FileStore {
	return &FileStore{path: path}
}

func (s *FileStore) Get(_ context.Context, provider string) (*OAuth2Token, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.load()
	if err != nil {
		return nil, err
	}

	tok, ok := data[provider]
	if !ok {
		return nil, nil
	}
	return &tok, nil
}

func (s *FileStore) Put(_ context.Context, provider string, token *OAuth2Token) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.load()
	if err != nil {
		return err
	}

	data[provider] = *token
	return s.save(data)
}

func (s *FileStore) Delete(_ context.Context, provider string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.load()
	if err != nil {
		return err
	}

	if _, ok := data[provider]; !ok {
		return nil
	}
	delete(data, provider)
	return s.save(data)
}

func (s *FileStore) List(_ context.Context) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.load()
	if err != nil {
		return nil, err
	}

	names := make([]string, 0, len(data))
	for k := range data {
		names = append(names, k)
	}
	sort.Strings(names)
	return names, nil
}

// load reads the JSON file. Returns empty map if file doesn't exist.
func (s *FileStore) load() (map[string]OAuth2Token, error) {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]OAuth2Token), nil
		}
		return nil, fmt.Errorf("read credentials: %w", err)
	}

	var data map[string]OAuth2Token
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, fmt.Errorf("parse credentials: %w", err)
	}
	if data == nil {
		data = make(map[string]OAuth2Token)
	}
	return data, nil
}

// save writes the credential map to disk with 0600 permissions.
func (s *FileStore) save(data map[string]OAuth2Token) error {
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal credentials: %w", err)
	}
	if err := os.WriteFile(s.path, raw, 0o600); err != nil {
		return fmt.Errorf("write credentials: %w", err)
	}
	return nil
}
