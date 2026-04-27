/* ================================================================
   ALETHIA — server.js
   Single-file backend: SightEngine + Gemini analysis

   ⚙️ SETUP: npm install express cors multer axios dotenv @google/generative-ai form-data
   ================================================================ */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const axios    = require('axios');
const path     = require('path');
const FormData = require('form-data');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── CONFIG ──────────────────────────────────────────────────── */
const CONFIG = {
  SIGHTENGINE_USER:   process.env.SIGHTENGINE_API_USER   || '',
  SIGHTENGINE_SECRET: process.env.SIGHTENGINE_API_SECRET || '',
  GEMINI_API_KEY:     process.env.GEMINI_API_KEY         || '',
  MAX_FILE_SIZE_MB:   20,
};

/* ── MIDDLEWARE ──────────────────────────────────────────────── */
app.use(cors());
app.use(express.json({ limit: '5mb' }));

/* ── RATE LIMITING ───────────────────────────────────────────── */
// ⚙️ UPDATE: Adjust max requests per window as needed
let rateLimit;
try {
  rateLimit = require('express-rate-limit');
  app.use('/api/analyze', rateLimit({
    windowMs: 60_000,
    max: 20,
    message: { error: 'Too many requests — please wait a moment.' }
  }));
} catch {
  console.warn('[RateLimit] express-rate-limit not installed — skipping. Run: npm install express-rate-limit');
}

/* ── MULTER (in-memory upload) ───────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk   = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk  = allowed.test(file.mimetype);
    cb(extOk && mimeOk ? null : new Error('Only image files allowed'), extOk && mimeOk);
  }
});

/* ================================================================
   SIGHTENGINE MODULE
   ================================================================ */

/**
 * Returns the top generator name + score from ai_generators map,
 * or null if the map is absent / all scores are negligible.
 */
function extractTopGenerator(aiGenerators) {
  if (!aiGenerators) return null;

  const LABEL = {
    dalle:            'DALL-E (OpenAI)',
    firefly:          'Adobe Firefly',
    flux:             'Flux',
    gan:              'GAN',
    gpt:              'GPT-4o / ChatGPT',
    higgsfield:       'Higgsfield',
    ideogram:         'Ideogram',
    kling:            'Kling',
    imagen:           'Google Imagen / Gemini',
    midjourney:       'Midjourney',
    qwen:             'Qwen (Alibaba)',
    recraft:          'Recraft',
    reve:             'Reve',
    seedream:         'Seedream',
    stable_diffusion: 'Stable Diffusion',
    wan:              'Wan',
    z_image:          'Z-Image',
    other:            'Unknown AI Generator',
  };

  let topKey   = null;
  let topScore = 0;

  for (const [key, score] of Object.entries(aiGenerators)) {
    if (score > topScore) {
      topScore = score;
      topKey   = key;
    }
  }

  if (!topKey || topScore < 0.05) return null;

  return {
    key:   topKey,
    label: LABEL[topKey] || topKey,
    score: topScore,
  };
}

async function runSightEngine(fileBuffer, mimeType) {
  if (!CONFIG.SIGHTENGINE_USER || !CONFIG.SIGHTENGINE_SECRET) {
    console.warn('[SightEngine] API keys not configured — skipping');
    return null;
  }

  try {
    const form = new FormData();
    form.append('media', fileBuffer, { filename: 'image.jpg', contentType: mimeType });
    form.append('models', 'genai');
    form.append('api_user', CONFIG.SIGHTENGINE_USER);
    form.append('api_secret', CONFIG.SIGHTENGINE_SECRET);

    const { data } = await axios.post(
      'https://api.sightengine.com/1.0/check.json',
      form,
      { headers: form.getHeaders() }
    );

    const aiScore = data?.type?.ai_generated ?? null;
    const topGen  = extractTopGenerator(data?.type?.ai_generators);

    console.log(
      `[SightEngine] ai_generated=${aiScore}` +
      (topGen ? `  top_generator=${topGen.label} (${(topGen.score * 100).toFixed(1)}%)` : '')
    );

    return data;
  } catch (err) {
    console.error('[SightEngine] Error:', err.response?.data || err.message);
    return null;
  }
}

/* ================================================================
   GEMINI MODULE
   ⚙️ UPDATE: Modify the prompt below to change analysis behavior
   ================================================================ */
const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY || 'placeholder');

function extractJSON(text) {
  let clean = text.replace(/```json|```/gi, '').trim();

  try { return JSON.parse(clean); } catch (_) { /* fall through */ }

  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) { /* fall through */ }
  }

  return null;
}

async function runGemini(imageBase64, mimeType, sightEngineData) {
  if (!CONFIG.GEMINI_API_KEY) {
    console.warn('[Gemini] API key not configured — skipping');
    return null;
  }

  // ⚙️ UPDATE: Reorder or add models as needed
  const MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-1.5-flash',
  ];

  // Build a human-readable SightEngine summary for the prompt
  let seSummary = '';
  if (sightEngineData?.type) {
    const aiScore = sightEngineData.type.ai_generated;
    const topGen  = extractTopGenerator(sightEngineData.type.ai_generators);
    seSummary = `SightEngine detected ai_generated probability: ${(aiScore * 100).toFixed(1)}%`;
    if (topGen) {
      seSummary += `, most likely generator: ${topGen.label} (${(topGen.score * 100).toFixed(1)}%)`;
    }
  }

  // ⚙️ UPDATE: Modify this prompt to change analysis behavior
  const prompt = `You are an expert forensic AI image analyst.

Analyze the provided image and determine whether it is AI-generated or a real photograph.

${seSummary ? `EXTERNAL SIGNAL (treat as high-weight forensic evidence):\n${seSummary}\n` : ''}

CRITICAL DETECTION RULES — check these before anything else:
1. Look for a small 4-pointed star (✦) watermark in any corner — this is Google's SynthID marker meaning the image was generated by Google Gemini or Imagen. If found, verdict MUST be "ai" and estimatedGenerator MUST be "Google Imagen / Gemini".
2. If the external SightEngine signal shows ai_generated >= 0.5, heavily weight toward verdict "ai".
3. If SightEngine identifies a specific generator with score >= 0.3, use that as estimatedGenerator.
4. Do NOT let photorealism override forensic signals — modern AI generators like Gemini, Midjourney, DALL-E 3, and Flux produce near-perfect photos.
5. Look for: overly smooth skin, perfect symmetry, impossible bokeh, inconsistent shadows, garbled text, extra/missing fingers, unnatural hair.

IMPORTANT RULES:
- You MUST respond with a single raw JSON object — no prose, no markdown, no explanation outside the JSON.
- If you cannot analyze the image for any reason, still return JSON with verdict "uncertain".
- Do NOT write sentences before or after the JSON.

Required JSON schema (all fields required):
{
  "verdict": "ai" | "real" | "uncertain",
  "aiProbability": <integer 0-100>,
  "confidence": "High" | "Medium" | "Low",
  "estimatedGenerator": "<tool name or empty string>",
  "summary": "<1-2 sentence summary>",
  "aiIndicators": ["<indicator>"],
  "realIndicators": ["<indicator>"],
  "technicalDetails": "<detailed forensic notes>"
}`;

  for (const modelName of MODELS) {
    try {
      console.log(`[Gemini] Trying model: ${modelName}`);

      const model  = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        { inlineData: { data: imageBase64, mimeType } },
        prompt,
      ]);

      const candidate    = result.response.candidates?.[0];
      const finishReason = candidate?.finishReason;

      if (finishReason === 'MAX_TOKENS' || finishReason === 'RECITATION') {
        console.warn(`[Gemini] ${modelName} hit token limit (${finishReason}) — trying next model`);
        continue;
      }

      const raw    = result.response.text().trim();
      const parsed = extractJSON(raw);

      if (parsed) {
        console.log(`[Gemini] Success with: ${modelName}`);
        return parsed;
      }

      console.warn(`[Gemini] ${modelName} returned non-JSON:`, raw.slice(0, 120));

      const isRefusal = /unable|cannot|can't|sorry|refuse/i.test(raw);
      if (isRefusal) {
        return {
          verdict:            'uncertain',
          aiProbability:      50,
          confidence:         'Low',
          estimatedGenerator: '',
          summary:            'Gemini declined to analyze this image. Using SightEngine signal only.',
          aiIndicators:       [],
          realIndicators:     [],
          technicalDetails:   `Model response: ${raw.slice(0, 300)}`,
        };
      }

      continue;

    } catch (err) {
      console.warn(`[Gemini] Failed on ${modelName}:`, err.message);
      if (/quota|429|rate/i.test(err.message)) continue;
      return null;
    }
  }

  console.error('[Gemini] All models exhausted — token quota reached');
  return { tokenExhausted: true };
}

/* ================================================================
   ⚙️ ADD MORE APIS HERE
   async function runMyNewAPI(imageBase64, mimeType) {
     const { data } = await axios.post('https://api.example.com/check', {
       image: imageBase64,
       key: process.env.MY_API_KEY
     });
     return data;
   }
   Then call it inside analyze() and pass the result to mergeResults().
   ================================================================ */

/* ── MERGE RESULTS ───────────────────────────────────────────── */
/*
  ⚙️ UPDATE: Modify this function to change how multiple API results
  are combined into the final verdict.
  SE path: sightEngineData.type.ai_generated  (0.0 – 1.0)
  Generator map: sightEngineData.type.ai_generators { dalle, midjourney, ... }
*/
function mergeResults(geminiResult, sightEngineData) {
  if (geminiResult?.tokenExhausted) {
    return { tokenExhausted: true };
  }

  const seScore = sightEngineData?.type?.ai_generated !== undefined
    ? Math.round(sightEngineData.type.ai_generated * 100)
    : null;

  const topGen = extractTopGenerator(sightEngineData?.type?.ai_generators);

  if (geminiResult) {
    if (seScore !== null) {
      // Give SightEngine more weight when it is highly confident
      const seWeight     = seScore >= 70 ? 0.5 : 0.3;
      const geminiWeight = 1 - seWeight;

      geminiResult.aiProbability = Math.round(
        geminiResult.aiProbability * geminiWeight + seScore * seWeight
      );

      console.log(
        `[Merge] Gemini ${(geminiWeight * 100).toFixed(0)}% + SightEngine ${(seWeight * 100).toFixed(0)}%` +
        ` = ${geminiResult.aiProbability}%`
      );

      // Reconcile conflicting verdicts
      if (seScore >= 70 && geminiResult.verdict === 'real') {
        geminiResult.verdict    = 'uncertain';
        geminiResult.confidence = 'Low';
        geminiResult.summary    =
          `SightEngine flagged this as AI-generated (${seScore}%) but visual analysis suggested real. Treat as uncertain.`;
        console.warn(`[Merge] Conflict — SightEngine AI (${seScore}%) vs Gemini real → uncertain`);
      }

      // Promote verdict based on blended score
      if (geminiResult.aiProbability >= 70 && geminiResult.verdict !== 'ai') {
        geminiResult.verdict = 'ai';
        console.log(`[Merge] Promoted verdict to "ai" based on blended score ${geminiResult.aiProbability}%`);
      }
    }

    // If SightEngine identified a generator and Gemini didn't, use it
    if (topGen && !geminiResult.estimatedGenerator) {
      geminiResult.estimatedGenerator = topGen.label;
      console.log(`[Merge] estimatedGenerator set from SightEngine: ${topGen.label}`);
    }

    return geminiResult;
  }

  // Fallback: SightEngine only
  if (seScore !== null) {
    return {
      verdict:            seScore >= 60 ? 'ai' : seScore <= 30 ? 'real' : 'uncertain',
      aiProbability:      seScore,
      confidence:         'Medium',
      estimatedGenerator: topGen?.label || '',
      summary:            `Analysis based on SightEngine only (Gemini unavailable). Generator: ${topGen?.label || 'unknown'}.`,
      aiIndicators:       topGen ? [`Detected generator: ${topGen.label}`] : [],
      realIndicators:     [],
      technicalDetails:   `SightEngine ai_generated: ${sightEngineData.type.ai_generated}` +
                          (topGen ? ` | Top generator: ${topGen.label} (${(topGen.score * 100).toFixed(1)}%)` : ''),
    };
  }

  // No APIs available
  return {
    verdict:           'uncertain',
    aiProbability:     50,
    confidence:        'Low',
    estimatedGenerator: '',
    summary:           'Analysis incomplete — API keys may not be configured.',
    aiIndicators:      [],
    realIndicators:    [],
    technicalDetails:  'No API results available. Check server logs and .env configuration.'
  };
}

/* ── CORE ANALYZE FUNCTION ───────────────────────────────────── */
async function analyze(fileBuffer, mimeType) {
  console.log(`[Alethia] Analyzing ${mimeType} (${Math.round(fileBuffer.length / 1024)}KB)`);

  const base64 = fileBuffer.toString('base64');

  // Run SightEngine first so its signal feeds into Gemini's prompt
  const sightEngineData = await runSightEngine(fileBuffer, mimeType);
  const geminiResult    = await runGemini(base64, mimeType, sightEngineData);

  // ⚙️ ADD: const myApiResult = await runMyNewAPI(base64, mimeType);

  const result = mergeResults(geminiResult, sightEngineData);

  if (result.tokenExhausted) return result;

  result.mediaType = mimeType.split('/')[0].toUpperCase();
  console.log(`[Alethia] Verdict: ${result.verdict} (${result.aiProbability}% AI)`);
  return result;
}

/* ================================================================
   ROUTES
   ================================================================ */

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    apis: {
      sightengine: !!CONFIG.SIGHTENGINE_USER,
      gemini:      !!CONFIG.GEMINI_API_KEY,
    }
  });
});

// Analyze uploaded file
// ⚙️ UPDATE: Field name 'image' — must match frontend FormData key
app.post('/api/analyze/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const result = await analyze(req.file.buffer, req.file.mimetype);

    if (result.tokenExhausted) {
      return res.status(503).json({
        error:          'Token limit reached',
        message:        'All Gemini models have exhausted their token quota. Please try again later.',
        tokenExhausted: true,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('[Upload] Error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

// Analyze image from URL
app.post('/api/analyze/url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    // ── SSRF guard ─────────────────────────────────────────────
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const blockedHosts    = ['localhost', '127.0.0.1', '0.0.0.0'];
    const blockedPrefixes = ['169.254.', '10.', '192.168.', '172.16.'];
    const hostname        = parsedUrl.hostname;

    if (
      blockedHosts.includes(hostname) ||
      blockedPrefixes.some(p => hostname.startsWith(p))
    ) {
      return res.status(400).json({ error: 'Private/internal URLs are not allowed' });
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are allowed' });
    }
    // ───────────────────────────────────────────────────────────

    const response = await axios.get(url, {
      responseType:     'arraybuffer',
      timeout:          10_000,
      maxContentLength: CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024,
      headers:          { 'User-Agent': 'Alethia-Bot/1.0' }
    });

    const contentType = response.headers['content-type'] || '';
    const mimeType    = contentType.split(';')[0].trim();

    if (!mimeType.startsWith('image/')) {
      return res.status(400).json({ error: `URL did not return an image (got: ${mimeType})` });
    }

    const buffer = Buffer.from(response.data);
    const result = await analyze(buffer, mimeType);

    if (result.tokenExhausted) {
      return res.status(503).json({
        error:          'Token limit reached',
        message:        'All Gemini models have exhausted their token quota. Please try again later.',
        tokenExhausted: true,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('[URL] Error:', err.message);
    res.status(500).json({ error: err.message || 'URL analysis failed' });
  }
});

/* ================================================================
   ⚙️ ADD MORE ROUTES HERE for video/audio when you're ready
   app.post('/api/analyze/video', upload.single('video'), async (req, res) => { ... });
   ================================================================ */

/* ── START ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n🔍 Alethia backend running on http://localhost:${PORT}`);
  console.log(`   SightEngine: ${CONFIG.SIGHTENGINE_USER ? '✓ configured' : '✗ not configured'}`);
  console.log(`   Gemini:      ${CONFIG.GEMINI_API_KEY   ? '✓ configured' : '✗ not configured'}`);
  console.log(`\n   Set keys in .env:`);
  console.log(`   SIGHTENGINE_API_USER=...`);
  console.log(`   SIGHTENGINE_API_SECRET=...`);
  console.log(`   GEMINI_API_KEY=...\n`);
});