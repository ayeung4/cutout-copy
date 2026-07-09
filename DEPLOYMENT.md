# Cutout Copy Backend

Small remove.bg proxy for the Cutout Copy Chrome extension.

## Setup

Set your remove.bg API key as an environment variable:

```powershell
$env:REMOVE_BG_API_KEY="your_remove_bg_api_key_here"
npm start
```

The backend runs at:

```text
http://localhost:8787
```

## Endpoints

- `GET /health`
- `GET /usage/status`
- `POST /remove-background`

The remove endpoint accepts either raw image bytes or JSON:

```json
{ "imageUrl": "https://example.com/image.jpg" }
```

## Render Deployment

1. Create a new Render Web Service from this repo.
2. Use these settings:

```text
Runtime: Node
Build command: leave blank
Start command: node server.js
Health check path: /health
```

3. Add this environment variable in Render:

```text
REMOVE_BG_API_KEY=your_remove_bg_api_key_here
```

4. Deploy.
5. Open `/health` on the Render URL and confirm `hasRemoveBgApiKey` is `true`.

## Analytics

The beta backend writes local metadata files:

```text
.data/events.jsonl
.data/usage.json
```

Each event stores action type, success/failure, timing, source domains, content type, and output size. It does not store image bytes.

For production beta traffic, use persistent disk or move analytics to a database such as Supabase, Neon, Render PostgreSQL, or another managed store.
