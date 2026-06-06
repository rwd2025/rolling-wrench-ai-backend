import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  console.log(`RWREQ ${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function requireSupabase() {
  if (!supabase) throw new Error("Supabase not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  return supabase;
}

function systemPrompt() {
  return `
You are Rolling Wrench AI, a mobile diesel/automotive repair command center assistant.
You can answer general questions like ChatGPT/Gemini, and also act as a diesel mechanic service advisor.

Primary jobs:
- Answer anything clearly.
- Diagnose diesel/gas/trailer/forklift/hydraulic/electrical issues.
- Build quote previews and invoice previews.
- Help identify parts, VINs, labels, fault screens, and documents.
- Save structured objects when requested by the app.

Style:
- Use phone-readable formatting.
- Use headings, bullets, and numbered steps.
- For repair procedures include: safety, tools, removal, installation, final checks, inspect-while-there, typical labor.
- Do not pretend to know live prices or local inventory unless web/parts data is supplied.
- If unsure, say what must be verified by VIN/OEM/supplier.

Shop defaults:
- Rolling Wrench Diesel
- Phone 260-502-6222
- Default labor rate $135/hr
- Default service call $250
`;
}

function normalizeAnswer(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  return data.answer || data.text || data.message || data.content || JSON.stringify(data, null, 2);
}


function isWeatherQuery(q) {
  return /\b(weather|temperature|forecast|rain|snow|wind|humidity|conditions)\b/i.test(String(q || ""));
}

function extractWeatherLocation(q) {
  const s = String(q || "").replace(/[?!.]/g, " ");
  const patterns = [
    /weather\s+(?:today\s+)?(?:in|near|for)\s+(.+)/i,
    /(?:temperature|forecast|conditions)\s+(?:today\s+)?(?:in|near|for)\s+(.+)/i,
    /(?:in|near|for)\s+([A-Za-z\s]+,\s*[A-Z]{2})/i
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return "Albion, Indiana";
}

async function getWeatherAnswer(q) {
  const location = extractWeatherLocation(q);
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const geoRes = await fetch(geoUrl);
  const geo = await geoRes.json();
  const place = geo.results && geo.results[0];
  if (!place) return `I could not find weather coordinates for ${location}. Try city and state, like Albion, Indiana.`;

  const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,wind_speed_10m,wind_gusts_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto`;
  const wxRes = await fetch(wxUrl);
  const wx = await wxRes.json();
  const c = wx.current || {};
  const codeMap = {
    0:"Clear sky",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",45:"Fog",48:"Rime fog",
    51:"Light drizzle",53:"Drizzle",55:"Heavy drizzle",61:"Light rain",63:"Rain",65:"Heavy rain",
    71:"Light snow",73:"Snow",75:"Heavy snow",80:"Light rain showers",81:"Rain showers",82:"Heavy rain showers",
    95:"Thunderstorm",96:"Thunderstorm with hail",99:"Severe thunderstorm with hail"
  };
  const desc = codeMap[c.weather_code] || "Current conditions";
  const city = `${place.name}${place.admin1 ? ", " + place.admin1 : ""}`;

  return `## Current Weather — ${city}

- **Condition:** ${desc}
- **Temperature:** ${Math.round(c.temperature_2m)}°F
- **Feels like:** ${Math.round(c.apparent_temperature)}°F
- **Humidity:** ${c.relative_humidity_2m}%
- **Wind:** ${Math.round(c.wind_speed_10m)} mph
- **Gusts:** ${Math.round(c.wind_gusts_10m || 0)} mph
- **Rain/Snow now:** ${c.precipitation || 0} in

Weather source: Open-Meteo live weather API.`;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Rolling Wrench AI Backend",
    version: "1.0.0",
    endpoints: ["/api/health", "/api/ai", "/api/vision", "/api/search", "/api/parts", "/api/quotes", "/api/invoices"]
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    openai: Boolean(process.env.OPENAI_API_KEY),
    supabase: Boolean(supabase),
    model: process.env.OPENAI_MODEL || "gpt-4o-mini"
  });
});

app.post("/api/ai", async (req, res) => {
  try {
    if (!openai) return res.status(500).json({ error: "OPENAI_API_KEY is not configured." });

    const prompt = req.body.prompt || req.body.question || "";
    const context = req.body.context || {};
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [
      { role: "system", content: systemPrompt() },
      { role: "user", content: `Context:\n${JSON.stringify(context, null, 2)}\n\nUser:\n${prompt}` }
    ];

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      temperature: 0.25
    });

    res.json({ answer: completion.choices?.[0]?.message?.content || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vision", async (req, res) => {
  try {
    if (!openai) return res.status(500).json({ error: "OPENAI_API_KEY is not configured." });

    const prompt = req.body.prompt || "Analyze this image or document for Rolling Wrench AI.";
    const files = req.body.files || [];

    const content = [
      { type: "text", text: `${systemPrompt()}\n\nUser request: ${prompt}` }
    ];

    for (const file of files) {
      if (file?.data && String(file.type || "").startsWith("image/")) {
        content.push({
          type: "image_url",
          image_url: { url: file.data }
        });
      }
    }

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
      messages: [{ role: "user", content }],
      temperature: 0.2
    });

    res.json({ answer: completion.choices?.[0]?.message?.content || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    const q = req.body.prompt || req.body.query || req.body.question || "";
    if (!q) return res.status(400).json({ error: "Missing query." });

    if (isWeatherQuery(q)) {
      const answer = await getWeatherAnswer(q);
      return res.json({ answer, source: "open-meteo" });
    }

    if (process.env.WEB_SEARCH_ENDPOINT) {
      const r = await fetch(process.env.WEB_SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.WEB_SEARCH_KEY ? { Authorization: `Bearer ${process.env.WEB_SEARCH_KEY}` } : {})
        },
        body: JSON.stringify(req.body)
      });
      const data = await r.json();
      return res.json({ answer: normalizeAnswer(data), raw: data });
    }

    if (!openai) return res.status(500).json({ error: "Search endpoint and OpenAI are not configured." });
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: `The user asked: ${q}\nAnswer normally using your built-in knowledge. If the answer requires live/current data besides weather, clearly say live web search is not connected yet.` }
      ],
      temperature: 0.2
    });
    res.json({ answer: completion.choices?.[0]?.message?.content || "" });
  } catch (err) {
    console.error("SEARCH_ERROR", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/parts", async (req, res) => {
  try {
    const q = req.body.prompt || req.body.query || "";
    const context = req.body.context || {};
    if (!openai) return res.status(500).json({ error: "OPENAI_API_KEY is not configured." });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: `${systemPrompt()}\nFor parts: provide likely part categories, what to verify, possible cross reference approach, and supplier questions. Do not invent exact OEM numbers unless supplied.` },
        { role: "user", content: `Parts request:\n${q}\n\nContext:\n${JSON.stringify(context, null, 2)}` }
      ],
      temperature: 0.2
    });

    res.json({ answer: completion.choices?.[0]?.message?.content || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/quotes", async (req, res) => {
  try {
    const db = requireSupabase();
    const quote = req.body.quote || req.body;
    quote.created_at = quote.created_at || new Date().toISOString();

    const { data, error } = await db.from("quotes").insert(quote).select().single();
    if (error) throw error;
    res.json({ ok: true, quote: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/invoices", async (req, res) => {
  try {
    const db = requireSupabase();
    const invoice = req.body.invoice || req.body;
    invoice.created_at = invoice.created_at || new Date().toISOString();

    const { data, error } = await db.from("invoices").insert(invoice).select().single();
    if (error) throw error;
    res.json({ ok: true, invoice: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/repair-memory", async (req, res) => {
  try {
    const db = requireSupabase();
    const memory = req.body.memory || req.body;
    memory.created_at = memory.created_at || new Date().toISOString();

    const { data, error } = await db.from("repair_memory").insert(memory).select().single();
    if (error) throw error;
    res.json({ ok: true, memory: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/signature", async (req, res) => {
  try {
    const db = requireSupabase();
    const signature = req.body.signature || req.body;
    signature.created_at = signature.created_at || new Date().toISOString();

    const { data, error } = await db.from("signatures").insert(signature).select().single();
    if (error) throw error;
    res.json({ ok: true, signature: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/payment-link", async (req, res) => {
  try {
    const base = process.env.SQUARE_PAYMENT_LINK || "";
    const amount = req.body.amount || req.body.total || 0;
    if (!base) {
      return res.json({
        ok: false,
        message: "Square payment link not configured.",
        payment_url: "",
        amount
      });
    }
    res.json({ ok: true, payment_url: base, amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`Rolling Wrench AI Backend running on port ${port}`);
});
