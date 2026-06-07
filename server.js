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


/* ===== V1.4 VIN DECODER ===== */
function rwCleanVin(v){ return String(v || "").toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, ""); }
function rwIsVin(v){ return /^[A-HJ-NPR-Z0-9]{17}$/.test(rwCleanVin(v)); }
function rwExtractVin(text){
  const m = String(text || "").toUpperCase().match(/[A-HJ-NPR-Z0-9]{17}/);
  return m ? rwCleanVin(m[0]) : "";
}
function rwVinYear(code){
  const map = {A:2010,B:2011,C:2012,D:2013,E:2014,F:2015,G:2016,H:2017,J:2018,K:2019,L:2020,M:2021,N:2022,P:2023,R:2024,S:2025,T:2026,V:2027,W:2028,X:2029,Y:2030,1:2001,2:2002,3:2003,4:2004,5:2005,6:2006,7:2007,8:2008,9:2009};
  return map[code] || null;
}
function rwVinMake(wmi){
  const known = {"1XP":"Peterbilt","2XP":"Peterbilt","3XP":"Peterbilt","1XK":"Kenworth","2XK":"Kenworth","3WK":"Kenworth","1HT":"International","2HS":"International","3HS":"International","4V4":"Volvo","4V5":"Volvo","4V1":"Volvo","1FU":"Freightliner","3AK":"Freightliner","1FV":"Freightliner","1M1":"Mack","1M2":"Mack","1GB":"Chevrolet/GMC Medium Duty","1GC":"Chevrolet","1FD":"Ford","1FT":"Ford"};
  return known[wmi] || "Unknown";
}
function rwDecodeVin(vin){
  const v = rwCleanVin(vin);
  if(!rwIsVin(v)) throw new Error("Invalid VIN. VIN must be 17 characters.");
  const truck = {
    vin: v,
    wmi: v.slice(0,3),
    year: rwVinYear(v[9]),
    make: rwVinMake(v.slice(0,3)),
    model: "Verify by OEM build sheet",
    engine: "Unknown — verify by ESN/data plate",
    transmission: "Unknown — verify by build sheet",
    confidence: "basic offline decode",
    source: "vin_decoder_v1_4"
  };
  return truck;
}
function rwFormatVin(truck){
  return `# VIN Decode — ${truck.vin}

## Active Truck Profile
- **Year:** ${truck.year || "Unknown"}
- **Make:** ${truck.make}
- **Model:** ${truck.model}
- **Engine:** ${truck.engine}
- **Transmission:** ${truck.transmission}
- **Confidence:** ${truck.confidence}

## Saved Context
Use this VIN as the Active Truck context for parts, quotes, invoices, and repair memory.

## Verify For Parts
- Engine Serial Number
- CPL
- Old part number
- Data plate
- OEM build sheet`;
}


/* ===== V1.5 SEARCH ENGINE LAYER ===== */
function rwSearchIntent(q){
  const s = String(q || "").toLowerCase();
  if (/\b(weather|temperature|forecast|rain|snow|wind)\b/.test(s)) return "weather";
  if (/\b(near me|nearby|local|supplier|buy|price|availability|in stock|dealer|store|location)\b/.test(s)) return "supplier";
  if (/\b(cross reference|cross-reference|xref|part number|oem|fleetguard|baldwin|donaldson|napa|wix|cummins part)\b/.test(s) || /\b[A-Z0-9-]{5,}\b/i.test(s)) return "parts";
  if (/\b(today|current|latest|this year|who won|news|recall|price)\b/.test(s)) return "current";
  return "general";
}

async function rwOpenAIWebSearch(q, context = {}) {
  if (!openai) throw new Error("OPENAI_API_KEY is not configured.");

  // Preferred: OpenAI Responses API with web_search_preview tool, if SDK supports responses.
  if (openai.responses && openai.responses.create) {
    try {
      const response = await openai.responses.create({
        model: process.env.OPENAI_SEARCH_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
        tools: [{ type: "web_search_preview" }],
        input: [
          {
            role: "system",
            content: `You are Rolling Wrench AI with web search. Answer like ChatGPT/Gemini/Google.
Use live web results when needed. For parts/suppliers, include sources, supplier names, what to verify, and confidence.
Never invent pricing or availability. Say "verify with supplier" when needed.`
          },
          {
            role: "user",
            content: `Question: ${q}

Context:
${JSON.stringify(context, null, 2)}`
          }
        ]
      });

      const text = response.output_text || (response.output || []).map(o => {
        if (o.content) return o.content.map(c => c.text || "").join("\n");
        return "";
      }).join("\n");
      if (text) return text;
    } catch (err) {
      console.error("OPENAI_WEB_SEARCH_FALLBACK", err.message);
    }
  }

  // Fallback: normal AI answer with current-info warning.
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: `${systemPrompt()}
You are in SEARCH MODE.
If live web search is unavailable, be transparent.
For parts, suppliers, prices, weather, or current data, say what must be verified.
Format with headings and bullets.` },
      { role: "user", content: `Search request:
${q}

Context:
${JSON.stringify(context, null, 2)}` }
    ],
    temperature: 0.15
  });
  return completion.choices?.[0]?.message?.content || "";
}

function rwFormatSearchAnswer(title, body, source="search_engine_v1_5"){
  return `# ${title}

${body}

## Search Status
- **Route:** ${source}
- **Note:** Verify live prices, inventory, fitment, VIN/ESN, and supplier availability before ordering.`;
}

async function rwSupplierSearch(q, context = {}) {
  const location = context.location || context.userLocation || "Northern Indiana";
  const expanded = `${q} supplier price availability near ${location}`;
  const answer = await rwOpenAIWebSearch(expanded, context);
  return rwFormatSearchAnswer("Supplier / Local Search", answer, "supplier_search_v1_5");
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


app.get("/api/search", (req, res) => {
  res.json({
    ok: true,
    endpoint: "/api/search",
    version: "search_engine_v1_5",
    methods: ["GET", "POST"],
    routes: ["weather", "supplier", "parts", "current", "general"],
    examples: [
      { prompt: "weather Albion, IN" },
      { prompt: "Find 3101874 cross reference and supplier near me" },
      { prompt: "Cummins X15 water pump supplier near Albion Indiana" }
    ]
  });
});

app.post("/api/search", async (req, res) => {
  try {
    const q = req.body.prompt || req.body.query || req.body.question || "";
    const context = req.body.context || {};
    if (!q) return res.status(400).json({ error: "Missing query." });

    const intent = rwSearchIntent(q);

    if (intent === "weather" && typeof getWeatherAnswer === "function") {
      try {
        const answer = await getWeatherAnswer(q);
        return res.json({ answer, route: "weather", source: "open_meteo" });
      } catch (err) {
        console.error("WEATHER_FALLBACK_TO_WEB", err.message);
      }
    }

    if (intent === "supplier") {
      const answer = await rwSupplierSearch(q, context);
      return res.json({ answer, route: "supplier", source: "search_engine_v1_5" });
    }

    const answer = await rwOpenAIWebSearch(q, context);
    res.json({
      answer: rwFormatSearchAnswer(intent === "current" ? "Current Search" : "Search Result", answer, "openai_web_search_v1_5"),
      route: intent,
      source: "search_engine_v1_5"
    });
  } catch (err) {
    console.error("SEARCH_ERROR", err);
    res.status(500).json({ error: err.message });
  }
});


/* ===== V1.5a findPartsMaster compatibility hotfix ===== */
function findPartsMaster(q) {
  try {
    if (typeof findSeededPart === "function") {
      const seeded = findSeededPart(q);
      if (seeded) return seeded;
    }

    const text = String(q || "").toUpperCase();
    const nums = text.match(/\b[A-Z0-9-]{4,}\b/g) || [];
    const cleanNums = nums.map(n => String(n).replace(/[^A-Z0-9]/g, ""));

    if (typeof PARTS_MASTER !== "undefined") {
      for (const n of cleanNums) {
        if (PARTS_MASTER[n]) return PARTS_MASTER[n];
      }
    }

    if (typeof SEEDED_PARTS !== "undefined") {
      for (const n of cleanNums) {
        if (SEEDED_PARTS[n]) return SEEDED_PARTS[n];
      }
    }

    return null;
  } catch (err) {
    console.error("findPartsMaster hotfix error", err);
    return null;
  }
}

function formatPartsMasterResult(part, q) {
  if (!part) {
    return `# Parts Master Result

## No Verified Match Found
No verified local Parts Master match was found for **${q || "this request"}**.

## Need To Verify
- VIN
- ESN
- Old part label
- Application
- Dimensions
- Supplier catalog

## Rolling Wrench Note
Do not guess part numbers. Verify before ordering.`;
  }

  if (typeof formatPartsMasterAnswer === "function") {
    try { return formatPartsMasterAnswer(part, q); } catch(e) {}
  }
  if (typeof formatSeededPartAnswer === "function") {
    try { return formatSeededPartAnswer(part, q); } catch(e) {}
  }

  const crosses = (part.crosses || part.crossReferences || []).map(x => {
    if (typeof x === "string") return `- ${x}`;
    return `- **${x.brand || x.make || "Cross"}:** ${x.part_number || x.partNumber || x.number || ""}`;
  }).join("\n") || "- No cross references listed.";

  const oem = (part.oem || part.oem_refs || part.oemRefs || []).map(x => {
    if (typeof x === "string") return `- ${x}`;
    return `- **${x.brand || x.make || "OEM"}:** ${x.part_number || x.partNumber || x.number || ""}`;
  }).join("\n") || "- No OEM references listed.";

  return `# Parts Master Result — ${part.query || part.part_number || part.partNumber || q || "Part"}

## Identification
- **Category:** ${part.category || "Unknown"}
- **Type:** ${part.type || part.part_type || "Unknown"}
- **Confidence:** ${part.confidence || "Verify before purchase"}

## Cross References
${crosses}

## OEM / Related References
${oem}

## Verify Before Ordering
- VIN / ESN
- Old part label
- Dimensions
- Application
- Supplier catalog`;
}


/* ===== V1.5b formatPartsMasterAnswer compatibility hotfix ===== */
function formatPartsMasterAnswer(part, q) {
  if (!part) {
    return `# Parts Master Result

## No Verified Match Found
No verified local Parts Master match was found for **${q || "this request"}**.

## Need To Verify
- VIN
- ESN
- Old part label
- Application
- Dimensions
- Supplier catalog

## Rolling Wrench Note
Do not guess part numbers. Verify before ordering.`;
  }

  if (typeof formatSeededPartAnswer === "function") {
    try {
      const out = formatSeededPartAnswer(part, q);
      if (out) return out;
    } catch(e) {}
  }

  const crosses = (part.crosses || part.crossReferences || part.cross_refs || []).map(x => {
    if (typeof x === "string") return `- ${x}`;
    return `- **${x.brand || x.make || "Cross"}:** ${x.part_number || x.partNumber || x.number || ""}${x.confidence ? " (" + x.confidence + ")" : ""}`;
  }).join("\n") || "- No cross references listed.";

  const oem = (part.oem || part.oem_refs || part.oemRefs || []).map(x => {
    if (typeof x === "string") return `- ${x}`;
    return `- **${x.brand || x.make || "OEM"}:** ${x.part_number || x.partNumber || x.number || ""}`;
  }).join("\n") || "- No OEM references listed.";

  const notes = (part.notes || []).map(x => `- ${x}`).join("\n") || "- Verify before ordering.";

  return `# Parts Master Result — ${part.query || part.part_number || part.partNumber || q || "Part"}

## Identification
- **Category:** ${part.category || "Unknown"}
- **Type:** ${part.type || part.part_type || "Unknown"}
- **Confidence:** ${part.confidence || part.verified_level || "Verify before purchase"}

## Cross References
${crosses}

## OEM / Related References
${oem}

## Important Notes
${notes}

## Verify Before Ordering
- VIN / ESN
- Old part label
- Dimensions
- Application
- Supplier catalog

## Rolling Wrench Note
Do not order by cross-reference alone. Confirm fitment before purchase.`;
}

app.post("/api/parts", async (req, res) => {
  try {
    const q = req.body.prompt || req.body.query || req.body.question || "";
    const context = req.body.context || {};

    /* PARTS_SEARCH_ENGINE_V1_5_HOOK */
    if (/\b(near me|nearby|local|supplier|buy|price|availability|in stock|dealer|store)\b/i.test(q)) {
      const answer = await rwSupplierSearch(q, context);
      return res.json({ answer, source: "parts_supplier_search_v1_5" });
    }



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
