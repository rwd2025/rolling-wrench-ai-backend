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
