# Brave-backed web search

This extension registers the global `web_search` tool and calls Brave's Web
Search endpoint. It has no package dependencies beyond the Pi runtime and
Node's built-in `fetch`.

## Local credential

Populate the empty field in `auth.json`, which is ignored by Git:

```json
{
  "brave_search_api_key": "paste-the-key-here"
}
```

Keep the file mode at `0600`. `BRAVE_SEARCH_API_KEY` may be used instead and
takes precedence over the file. Never add the real key to `auth.example.json`.

After configuring the key, run `scripts/verify-web-search` from the monorepo
root. The script makes one live query and verifies that Brave returns URLs; it
does not print the key.
