# Rolling Wrench AI Backend V1

This backend powers the Rolling Wrench AI app.

## What it does

Endpoints:

- `POST /api/ai` — answer anything using OpenAI-compatible AI
- `POST /api/vision` — analyze uploaded images from the app
- `POST /api/search` — web/search bridge endpoint
- `POST /api/parts` — parts assistant endpoint
- `POST /api/quotes` — save quotes to Supabase
- `POST /api/invoices` — save invoices to Supabase
- `POST /api/repair-memory` — save repair memories
- `POST /api/signature` — save customer signatures
- `POST /api/payment-link` — returns Square payment link if configured

## Install locally

```bash
npm install
cp .env.example .env
npm run dev
```

Then open:

```text
http://localhost:8787/api/health
```

## App Backend Connections

In the app, set:

```text
AI Endpoint:
https://YOUR-BACKEND/api/ai

Vision Endpoint:
https://YOUR-BACKEND/api/vision

Web Search Endpoint:
https://YOUR-BACKEND/api/search

Parts Endpoint:
https://YOUR-BACKEND/api/parts
```

## Supabase

Run `supabase_schema.sql` inside Supabase SQL Editor.

Use the Service Role key only on this backend server. Do not put service role key in the phone app.

## Deploy Options

Good easy options:

- Render
- Railway
- Fly.io
- VPS
- Supabase Edge Functions later

For first test, Render/Railway is easiest.

## V1.1 update
- Adds request logging so Render logs show POST /api/ai, /api/search, /api/vision.
- Adds live weather support through Open-Meteo on /api/search.
- Keeps OpenAI/Supabase endpoints.

## V1.2 Parts DB Fix
- GET /api/parts now returns endpoint status.
- POST /api/parts checks seeded cross-reference data before AI.
- Seeded: 3101874 cross reference data.
- Unknown parts return safer "no verified match" behavior instead of invented numbers.

## V1.3 Parts Master
- Adds Parts Master seeded database.
- Adds 3101874, LF634, LF14000NN, FS19727.
- Adds water pump request handling that asks for VIN/ESN instead of guessing.
- Adds supplier scripts and verification checklist.

V1.4: Adds /api/vin basic VIN decoder and Active Truck response.

## V1.5 Search Engine Layer
- Adds GET /api/search status endpoint.
- Upgrades POST /api/search routing: weather, supplier/local, parts/current/general.
- Attempts OpenAI Responses API web_search_preview when SDK/model supports it.
- Falls back to OpenAI chat response with verification warnings.
- Hooks supplier/local requests inside /api/parts.
- Goal: ChatGPT/Gemini/Google-style search behavior through Render backend.

## V1.5a Hotfix
- Adds findPartsMaster() compatibility function.
- Prevents ReferenceError: findPartsMaster is not defined.
