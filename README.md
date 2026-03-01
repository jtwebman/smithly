# Smithly

Autonomous agent controller. Agents run LLM loops with tool-use, code skill authoring, sandboxed execution, and network gating.

**Status: in progress.** Core phases 1-6.5 are complete (agent loop, multi-agent, skills, sidecar API, network gatekeeper, sandbox providers, agent-authored skills). Memory, channels, and content firewall are ahead. See `backlog.md` for the full roadmap.

## Documentation

- **[INSTALL.md](INSTALL.md)** — Setup, build, and first-run guide
- **[docs/MODELS.md](docs/MODELS.md)** — Supported models, provider configs, and local model compatibility
- **[docs/local-llm.md](docs/local-llm.md)** — Running with llama.cpp or other local servers

## Supported Providers

OpenAI, Anthropic, Gemini, Ollama, and OpenRouter are fully tested. DeepSeek, Groq, xAI/Grok, Mistral, Kimi, Together AI, and Fireworks AI are planned. See [docs/MODELS.md](docs/MODELS.md) for config examples and details.

## License

MIT — see [LICENSE](LICENSE) for details.
