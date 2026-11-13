# Harvest meeting plugin

Your AI agent joins Google Meet as a signed-in bot that hears, speaks (EN/RU), chats and shares pages.

```
/plugin marketplace add <this repo>
/plugin install harvest-meeting@harvest
```

Put your key in `~/.harvest/config.json` as `{"api_key": "hvst_live_..."}` (or `HARVEST_API_KEY`), then ask
your agent: "join https://meet.google.com/abc-defg-hij".

Works with any agent that can run a shell: the bridge (`scripts/harvest-bridge.mjs`, Node 22+, no
dependencies) writes meeting events to a JSONL file and reads commands from another file.
API reference: https://gateway.tryharvest.ai/v1/docs
