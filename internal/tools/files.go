package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ReadFile reads a file and returns its contents.
type ReadFile struct {
	rootDir string // if set, paths are relative to this directory
}

func NewReadFile(rootDir string) *ReadFile {
	return &ReadFile{rootDir: rootDir}
}

func (r *ReadFile) Name() string        { return "read_file" }
func (r *ReadFile) Description() string { return "Read the contents of a file." }
func (r *ReadFile) NeedsApproval() bool { return false }

func (r *ReadFile) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"path": {
				"type": "string",
				"description": "Path to the file to read"
			}
		},
		"required": ["path"]
	}`)
}

func (r *ReadFile) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("parse args: %w", err)
	}

	path := r.resolvePath(params.Path)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read file: %w", err)
	}

	content := string(data)
	if len(content) > 100000 {
		content = content[:100000] + "\n\n[truncated — file too large]"
	}
	return content, nil
}

func (r *ReadFile) resolvePath(path string) string {
	if r.rootDir != "" && !filepath.IsAbs(path) {
		return filepath.Join(r.rootDir, path)
	}
	return path
}

// WriteFile writes content to a file. Requires approval.
type WriteFile struct {
	rootDir string
}

func NewWriteFile(rootDir string) *WriteFile {
	return &WriteFile{rootDir: rootDir}
}

func (w *WriteFile) Name() string        { return "write_file" }
func (w *WriteFile) Description() string { return "Write content to a file. Creates parent directories if needed." }
func (w *WriteFile) NeedsApproval() bool { return true }

func (w *WriteFile) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"path": {
				"type": "string",
				"description": "Path to the file to write"
			},
			"content": {
				"type": "string",
				"description": "Content to write to the file"
			}
		},
		"required": ["path", "content"]
	}`)
}

func (w *WriteFile) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("parse args: %w", err)
	}

	path := w.resolvePath(params.Path)

	// Create parent directories
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("create directory: %w", err)
	}

	if err := os.WriteFile(path, []byte(params.Content), 0644); err != nil {
		return "", fmt.Errorf("write file: %w", err)
	}

	return fmt.Sprintf("Wrote %d bytes to %s", len(params.Content), params.Path), nil
}

func (w *WriteFile) resolvePath(path string) string {
	if w.rootDir != "" && !filepath.IsAbs(path) {
		return filepath.Join(w.rootDir, path)
	}
	return path
}

// ListFiles lists files in a directory.
type ListFiles struct {
	rootDir string
}

func NewListFiles(rootDir string) *ListFiles {
	return &ListFiles{rootDir: rootDir}
}

func (l *ListFiles) Name() string        { return "list_files" }
func (l *ListFiles) Description() string { return "List files and directories at a given path." }
func (l *ListFiles) NeedsApproval() bool { return false }

func (l *ListFiles) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"path": {
				"type": "string",
				"description": "Directory path to list. Defaults to current directory."
			}
		}
	}`)
}

func (l *ListFiles) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Path string `json:"path"`
	}
	json.Unmarshal(args, &params)

	path := params.Path
	if path == "" {
		path = "."
	}
	if l.rootDir != "" && !filepath.IsAbs(path) {
		path = filepath.Join(l.rootDir, path)
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		return "", fmt.Errorf("list directory: %w", err)
	}

	var out strings.Builder
	for _, entry := range entries {
		info, _ := entry.Info()
		if entry.IsDir() {
			fmt.Fprintf(&out, "  %s/\n", entry.Name())
		} else if info != nil {
			fmt.Fprintf(&out, "  %s (%d bytes)\n", entry.Name(), info.Size())
		} else {
			fmt.Fprintf(&out, "  %s\n", entry.Name())
		}
	}

	if out.Len() == 0 {
		return "(empty directory)", nil
	}
	return out.String(), nil
}
