# Gmail

You can read Gmail using the `oauth2` and `api_call` tools with the `google` provider.

## Authentication

Get a bearer token:
```
oauth2(provider: "google")
```

## Endpoints

All endpoints use `oauth2_provider: "google"` for authentication.

### List messages

```
api_call(
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=is:unread",
  oauth2_provider: "google"
)
```

Returns `{ messages: [{ id, threadId }], ... }`. Each entry only has IDs — you need to fetch the full message.

### Get a message

```
api_call(
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date",
  oauth2_provider: "google"
)
```

Use `format=metadata` for headers only (fast), `format=full` for body content.

Headers are in `payload.headers[]` as `{ name, value }` pairs.

### Search

The `q` parameter uses Gmail search syntax:
- `is:unread` — unread messages
- `from:someone@example.com` — from a specific sender
- `subject:meeting` — subject contains "meeting"
- `newer_than:1d` — from the last day
- `has:attachment` — has attachments

Combine: `is:unread newer_than:1d from:@school.edu`

### Labels

```
api_call(
  url: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
  oauth2_provider: "google"
)
```

### Modify labels (mark read/unread)

```
api_call(
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}/modify",
  method: "POST",
  oauth2_provider: "google",
  body: "{\"removeLabelIds\": [\"UNREAD\"]}"
)
```

## Tips

- Always list messages first, then fetch individual ones for details.
- Use `format=metadata` when you only need headers (sender, subject, date).
- Use search queries to narrow results before fetching.
- Summarize emails concisely — the user wants the gist, not raw API data.

## Setup

If the google OAuth2 provider is not configured, guide the user:

1. Go to https://console.cloud.google.com/apis/credentials
2. Create an OAuth 2.0 Client ID (Desktop application)
3. Enable the Gmail API at https://console.cloud.google.com/apis/library/gmail.googleapis.com
4. Add the config to smithly.toml:

```toml
[[oauth2]]
name = "google"
client_id = "YOUR_CLIENT_ID"
client_secret = "YOUR_CLIENT_SECRET"
scopes = ["https://www.googleapis.com/auth/gmail.readonly"]
auth_url = "https://accounts.google.com/o/oauth2/auth"
token_url = "https://oauth2.googleapis.com/token"
```

5. Run: `smithly oauth2 auth google`
