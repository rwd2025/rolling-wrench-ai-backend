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


/* ===== V1.2 SEEDED PARTS CROSS REFERENCE DATABASE ===== */
const SEEDED_PARTS = {
  "3101874": {
    query: "3101874",
    verified_level: "seeded_web_reference",
    part_type: "Oil filter / filter element",
    notes: [
      "3101874 appears as a Volvo / White reference number in filter cross-reference listings.",
      "Do not treat this as a Cummins X15 water pump number.",
      "Verify by VIN, ESN, old part label, filter dimensions, and supplier catalog before purchase."
    ],
    crosses: [
      { brand: "Fleetguard", part_number: "LF634", confidence: "high" },
      { brand: "WIX", part_number: "51487", confidence: "high" },
      { brand: "Donaldson", part_number: "P550487", confidence: "medium-high" },
      { brand: "Baldwin", part_number: "PT903", confidence: "medium-high" },
      { brand: "Luber-Finer", part_number: "LP487", confidence: "medium" },
      { brand: "NAPA", part_number: "1487", confidence: "medium" }
    ],
    oem_refs: [
      { brand: "Volvo", part_number: "3101874" },
      { brand: "Volvo", part_number: "874487" },
      { brand: "White", part_number: "3101874" },
      { brand: "Cummins", part_number: "299634" },
      { brand: "Case IH", part_number: "279294C91" },
      { brand: "Case IH", part_number: "279294C92" },
      { brand: "Caterpillar", part_number: "3I1187" }
    ]
  }
};

function extractPartNumbers(q) {
  return String(q || "").match(/\b[A-Z0-9-]{4,}\b/gi) || [];
}

function formatSeededPartAnswer(hit) {
  const crosses = hit.crosses.map(x => `- **${x.brand}:** ${x.part_number} (${x.confidence})`).join("\n");
  const refs = hit.oem_refs.map(x => `- **${x.brand}:** ${x.part_number}`).join("\n");
  const notes = hit.notes.map(x => `- ${x}`).join("\n");
  return `## Parts Cross Reference — ${hit.query}

### Identification
- **Part Type:** ${hit.part_type}
- **Match Level:** ${hit.verified_level}

### Cross References
${crosses}

### OEM / Related References
${refs}

### Important Notes
${notes}

### Supplier Check
Ask supplier to verify:
- Dimensions
- Thread / seal style
- Application
- VIN / ESN
- Old part label

### Rolling Wrench Note
This looks like a filter cross-reference number, not an X15 water pump number.`;
}

function findSeededPart(q) {
  const nums = extractPartNumbers(q);
  for (const n of nums) {
    const clean = String(n).replace(/[^A-Z0-9]/gi, "").toUpperCase();
    if (SEEDED_PARTS[clean]) return SEEDED_PARTS[clean];
  }
  return null;
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



/* ===== V1.3 PARTS MASTER EXTENSION ===== */
const PARTS_MASTER = {
  "3101874": {
    query: "3101874",
    category: "Filter",
    type: "Oil filter / filter element",
    confidence: "High for seeded cross-reference; verify application",
    crosses: [
      { brand: "Fleetguard", part_number: "LF634" },
      { brand: "WIX", part_number: "51487" },
      { brand: "NAPA", part_number: "1487" },
      { brand: "Donaldson", part_number: "P550487" },
      { brand: "Baldwin", part_number: "PT903" },
      { brand: "Luber-Finer", part_number: "LP487" }
    ],
    oem: [
      { brand: "Volvo", part_number: "3101874" },
      { brand: "White", part_number: "3101874" },
      { brand: "Volvo", part_number: "874487" },
      { brand: "Cummins", part_number: "299634" },
      { brand: "Case IH", part_number: "279294C91 / 279294C92" },
      { brand: "Caterpillar", part_number: "3I1187" }
    ],
    verify: ["Old part label", "Thread/seal size", "Filter dimensions", "Application", "VIN/ESN"]
  },
  "LF634": {
    query: "LF634",
    category: "Filter",
    type: "Fleetguard oil filter",
    confidence: "High seeded cross-reference",
    crosses: [
      { brand: "Volvo/White", part_number: "3101874" },
      { brand: "WIX", part_number: "51487" },
      { brand: "NAPA", part_number: "1487" },
      { brand: "Donaldson", part_number: "P550487" },
      { brand: "Baldwin", part_number: "PT903" }
    ],
    oem: [{ brand: "Fleetguard", part_number: "LF634" }],
    verify: ["Application", "Dimensions", "Seal/thread", "Old filter"]
  },
  "LF14000NN": {
    query: "LF14000NN",
    category: "Filter",
    type: "Fleetguard lube filter, NanoNet style",
    confidence: "Common heavy-duty Cummins filter number; verify by ESN",
    crosses: [{ brand: "Fleetguard", part_number: "LF14000NN" }],
    oem: [{ brand: "Cummins/Fleetguard", part_number: "LF14000NN" }],
    verify: ["Engine serial number", "Filter head style", "Current filter label"]
  },
  "FS19727": {
    query: "FS19727",
    category: "Filter",
    type: "Fleetguard fuel/water separator",
    confidence: "Seeded common filter reference",
    crosses: [
      { brand: "Fleetguard", part_number: "FS19727" },
      { brand: "NAPA", part_number: "3727" }
    ],
    oem: [{ brand: "Fleetguard", part_number: "FS19727" }],
    verify: ["Micron rating", "Bowl/sensor style", "Thread", "Old filter"]
  }
};

function findPartsMaster(q) {
  const tokens = extractPartNumbers(q).map(x => String(x).replace(/[^A-Z0-9]/gi, "").toUpperCase());
  for (const t of tokens) {
    if (PARTS_MASTER[t]) return PARTS_MASTER[t];
  }
  return null;
}

function formatPartsMasterAnswer(p) {
  const crosses = (p.crosses || []).map(x => `- **${x.brand}:** ${x.part_number}`).join("\n") || "- No verified crosses in local database.";
  const oem = (p.oem || []).map(x => `- **${x.brand}:** ${x.part_number}`).join("\n") || "- No OEM references in local database.";
  const verify = (p.verify || []).map(x => `- ${x}`).join("\n");
  return `# Parts Master Result — ${p.query}

## Identification
- **Category:** ${p.category || "Unknown"}
- **Type:** ${p.type || "Unknown"}
- **Confidence:** ${p.confidence || "Verify before purchase"}

## Cross References
${crosses}

## OEM / Related References
${oem}

## Verify Before Ordering
${verify}

## Supplier Script
“Can you cross-reference **${p.query}** and verify it by application, dimensions, and old part label?”

## Rolling Wrench Note
Do not order by cross-reference alone. Confirm VIN/ESN/application and compare the old part.`;
}

function isWaterPumpRequest(q) {
  const s = String(q || "").toLowerCase();
  return s.includes("water pump") || s.includes("waterpump");
}

function formatWaterPumpRequest(q, context = {}) {
  const truck = context.truck || {};
  return `# Parts Master — Water Pump Request

## Need More Info
To give the correct OEM water pump number, I need one of these:

- **Engine Serial Number (ESN)**
- **VIN**
- **Old water pump part number**
- **Photo of pump label or casting**
- **Truck year / make / model**
- **Engine CPL**, if available

## Current Context
- **Engine:** ${truck.engine || "Not set"}
- **Truck:** ${truck.unit || "Not set"}
- **VIN:** ${truck.vin || "Not set"}

## Why I’m Not Guessing
Cummins X15/ISX water pumps can vary by engine serial number, CPL, pulley/housing style, chassis package, coolant pipe configuration, and reman/new option.

## Supplier Script
“I need the correct water pump for a Cummins X15. I can provide VIN/ESN. Please verify pump number, gasket/O-ring, pulley fitment, and core/reman option.”

## Next Step
Send the VIN, ESN, or a photo of the old pump label and I’ll cross-reference it.`;
}

app.get("/api/parts", (req, res) => {
  res.json({
    ok: true,
    endpoint: "/api/parts",
    version: "parts_master_v1_3",
    method: "POST",
    seeded_parts: Object.keys(PARTS_MASTER),
    examples: [
      { prompt: "3101874 cross reference" },
      { prompt: "LF634 cross reference" },
      { prompt: "Cummins X15 water pump" },
      { prompt: "FS19727 cross reference" }
    ]
  });
});

app.post("/api/parts", async (req, res) => {
  try {
    const q = req.body.prompt || req.body.query || req.body.question || "";
    const context = req.body.context || {};

    const master = findPartsMaster(q);
    if (master) {
      return res.json({
        answer: formatPartsMasterAnswer(master),
        match: master,
        source: "parts_master_v1_3"
      });
    }

    const seeded = findSeededPart(q);
    if (seeded) {
      return res.json({
        answer: formatSeededPartAnswer(seeded),
        match: seeded,
        source: "seeded_parts_v1_2"
      });
    }

    if (isWaterPumpRequest(q)) {
      return res.json({
        answer: formatWaterPumpRequest(q, context),
        source: "parts_master_water_pump_request"
      });
    }

    if (!openai) return res.status(500).json({ error: "OPENAI_API_KEY is not configured." });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: `${systemPrompt()}

You are in PARTS MASTER MODE.
Rules:
- If the part is not in local seeded data, do NOT invent exact cross-reference numbers.
- Be direct: “No verified match found in Parts Master yet.”
- Ask for VIN, ESN, old part label, photo, year/make/model, engine CPL.
- Provide supplier script and verification checklist.
- Format with headings and bullets.` },
        { role: "user", content: `Parts request:
${q}

Context:
${JSON.stringify(context, null, 2)}

Return a Parts Master style answer. Do not make up cross references.` }
      ],
      temperature: 0.05
    });

    res.json({ answer: completion.choices?.[0]?.message?.content || "" });
  } catch (err) {
    console.error("PARTS_ERROR", err);
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
