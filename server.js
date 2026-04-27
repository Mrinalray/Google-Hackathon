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

/* ── RATE LIMITING (optional) ────────────────────────────────── */
try {
  const rateLimit = require('express-rate-limit');
  app.use('/api/analyze', rateLimit({
    windowMs: 60_000,
    max: 20,
    message: { error: 'Too many requests — please wait a moment.' }
  }));
} catch {
  console.warn('[RateLimit] express-rate-limit not installed — skipping.');
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
   INDICATOR NORMALIZER
   Gemini may return indicators as plain strings OR as objects.
   Frontend always expects: { name, severity, description }
   ================================================================ */
function normalizeIndicator(item, fallbackSeverity = 'Medium') {
  if (!item) return null;

  // Already correct object shape
  if (typeof item === 'object' && item.name && item.description) {
    return {
      name:        String(item.name).trim()        || 'Signal',
      severity:    item.severity                   || fallbackSeverity,
      description: String(item.description).trim() || String(item.name).trim(),
    };
  }

  // Plain string — convert to object
  if (typeof item === 'string' && item.trim()) {
    const text = item.trim();
    // Split on common separators to extract a short name
    for (const sep of [' — ', ' - ', ': ']) {
      const idx = text.indexOf(sep);
      if (idx > 0 && idx < 60) {
        return {
          name:        text.slice(0, idx).trim(),
          severity:    fallbackSeverity,
          description: text.slice(idx + sep.length).trim() || text,
        };
      }
    }
    // No separator — use first 5 words as name
    const words = text.split(' ');
    return {
      name:        words.slice(0, 5).join(' ').replace(/[.,;:]+$/, ''),
      severity:    fallbackSeverity,
      description: text,
    };
  }

  return null;
}

function normalizeIndicators(indicators, fallbackSeverity = 'Medium') {
  if (!Array.isArray(indicators) || indicators.length === 0) return [];
  return indicators.map(i => normalizeIndicator(i, fallbackSeverity)).filter(Boolean);
}

/* ================================================================
   SIGHTENGINE MODULE
   ================================================================ */
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

  let topKey = null, topScore = 0;
  for (const [key, score] of Object.entries(aiGenerators)) {
    if (score > topScore) { topScore = score; topKey = key; }
  }

  if (!topKey || topScore < 0.05) return null;
  return { key: topKey, label: LABEL[topKey] || topKey, score: topScore };
}

async function runSightEngine(fileBuffer, mimeType) {
  if (!CONFIG.SIGHTENGINE_USER || !CONFIG.SIGHTENGINE_SECRET) {
    console.warn('[SightEngine] API keys not configured — skipping');
    return null;
  }

  try {
    const form = new FormData();
    form.append('media', fileBuffer, { filename: 'image.jpg', contentType: mimeType });
    form.append('models',     'genai');
    form.append('api_user',   CONFIG.SIGHTENGINE_USER);
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
      (topGen ? `  top=${topGen.label} (${(topGen.score * 100).toFixed(1)}%)` : '')
    );
    return data;
  } catch (err) {
    console.error('[SightEngine] Error:', err.response?.data || err.message);
    return null;
  }
}

/* ================================================================
   GEMINI MODULE
   ================================================================ */
const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY || 'placeholder');

function extractJSON(text) {
  let clean = text.replace(/```json|```/gi, '').trim();
  try { return JSON.parse(clean); } catch (_) {}
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

async function runGemini(imageBase64, mimeType, sightEngineData) {
  if (!CONFIG.GEMINI_API_KEY) {
    console.warn('[Gemini] API key not configured — skipping');
    return null;
  }

  const MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
  ];

  let seSummary = '';
  if (sightEngineData?.type) {
    const aiScore = sightEngineData.type.ai_generated;
    const topGen  = extractTopGenerator(sightEngineData.type.ai_generators);
    seSummary = `SightEngine ai_generated: ${(aiScore * 100).toFixed(1)}%`;
    if (topGen) seSummary += `, top generator: ${topGen.label} (${(topGen.score * 100).toFixed(1)}%)`;
  }

  // ── Prompt instructs Gemini to return proper objects, not strings ──
  const prompt = `You are an expert forensic AI image analyst.

Analyze the provided image and determine whether it is AI-generated or a real photograph.

${seSummary ? `EXTERNAL SIGNAL (high-weight forensic evidence):\n${seSummary}\n` : ''}

DETECTION RULES:
1. Look for a small 4-pointed star (✦) watermark — this is Google SynthID. If found: verdict="ai", estimatedGenerator="Google Imagen / Gemini".
2. If SightEngine shows ai_generated >= 0.5, heavily weight toward "ai".
3. If SightEngine identifies a generator with score >= 0.3, use it as estimatedGenerator.
4. Do NOT let photorealism override forensic signals.
5. Check for: smooth skin, perfect symmetry, impossible bokeh, inconsistent shadows, garbled text, extra/missing fingers.

RESPONSE FORMAT: Return ONLY a raw JSON object — no prose, no markdown backticks.

{
  "verdict": "ai" | "real" | "uncertain",
  "aiProbability": <integer 0-100>,
  "confidence": "High" | "Medium" | "Low",
  "estimatedGenerator": "<tool name or empty string>",
  "summary": "<1-2 sentence summary>",
  "aiIndicators": [
    { "name": "<2-4 word label>", "severity": "High" | "Medium" | "Low", "description": "<one sentence>" },
    { "name": "<2-4 word label>", "severity": "High" | "Medium" | "Low", "description": "<one sentence>" }
  ],
  "realIndicators": [
    { "name": "<2-4 word label>", "severity": "High" | "Medium" | "Low", "description": "<one sentence>" }
  ],
  "technicalDetails": "<detailed forensic paragraph>"
}

STRICT RULES:
- aiIndicators MUST have at least 4 entries — each describing a DIFFERENT forensic signal (e.g. skin texture, lighting, shadows, edges, noise patterns, symmetry, background, text/fingers, color grading, depth of field).
- realIndicators MUST have at least 3 entries — each describing a DIFFERENT authentic characteristic found in the image.
- Do NOT repeat the same observation in multiple entries. Each entry must be a unique, distinct forensic finding.
- Every entry MUST have name (2-4 words), severity, and description (full sentence).
- NEVER use null, "Unknown", or empty string for name or description.
- name must describe the actual signal, e.g. "Skin Texture Smoothness", "Perfect Symmetry", "Lighting Inconsistency".`;

  function parseRetryDelay(msg) {
    const match = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
    if (!match) return null;
    const s = parseFloat(match[1]);
    return (!isNaN(s) && s <= 60) ? Math.ceil(s) * 1000 : null;
  }

  for (const modelName of MODELS) {
    let attempts = 0;
    while (attempts < 2) {
      attempts++;
      try {
        console.log(`[Gemini] Trying: ${modelName}${attempts > 1 ? ` (attempt ${attempts})` : ''}`);
        const model  = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent([
          { inlineData: { data: imageBase64, mimeType } },
          prompt,
        ]);

        const finishReason = result.response.candidates?.[0]?.finishReason;
        if (finishReason === 'MAX_TOKENS' || finishReason === 'RECITATION') {
          console.warn(`[Gemini] ${modelName} hit ${finishReason} — next model`);
          break;
        }

        const raw    = result.response.text().trim();
        const parsed = extractJSON(raw);
        if (parsed) { console.log(`[Gemini] Success: ${modelName}`); return parsed; }

        if (/unable|cannot|can't|sorry|refuse/i.test(raw)) {
          return {
            verdict: 'uncertain', aiProbability: 50, confidence: 'Low',
            estimatedGenerator: '',
            summary: 'Gemini declined to analyze this image.',
            aiIndicators:   [{ name: 'Analysis Declined', severity: 'Low', description: 'Gemini was unable to assess AI generation signals for this image.' }],
            realIndicators: [{ name: 'Analysis Declined', severity: 'Low', description: 'Gemini was unable to assess authenticity signals for this image.' }],
            technicalDetails: raw.slice(0, 300),
          };
        }

        break;
      } catch (err) {
        if (/404|not found/i.test(err.message)) { console.warn(`[Gemini] ${modelName} not available`); break; }
        if (/quota|429|rate/i.test(err.message)) {
          const delayMs = parseRetryDelay(err.message);
          if (delayMs && attempts < 2) {
            console.warn(`[Gemini] ${modelName} quota — waiting ${Math.ceil(delayMs / 1000)}s...`);
            await new Promise(r => setTimeout(r, delayMs));
            continue;
          }
          console.warn(`[Gemini] ${modelName} quota exhausted — next model`);
          break;
        }
        console.warn(`[Gemini] ${modelName} failed:`, err.message);
        break;
      }
    }
  }

  console.error('[Gemini] All models exhausted');
  return null;
}

/* ================================================================
   MERGE RESULTS
   ================================================================ */
function mergeResults(geminiResult, sightEngineData) {
  const seScore = sightEngineData?.type?.ai_generated !== undefined
    ? Math.round(sightEngineData.type.ai_generated * 100)
    : null;
  const topGen = extractTopGenerator(sightEngineData?.type?.ai_generators);

  if (geminiResult) {
    // Blend scores
    if (seScore !== null) {
      const seWeight = seScore >= 70 ? 0.5 : 0.3;
      geminiResult.aiProbability = Math.round(
        geminiResult.aiProbability * (1 - seWeight) + seScore * seWeight
      );
      console.log(`[Merge] Blended → ${geminiResult.aiProbability}%`);

      if (seScore >= 70 && geminiResult.verdict === 'real') {
        geminiResult.verdict    = 'uncertain';
        geminiResult.confidence = 'Low';
        geminiResult.summary    = `SightEngine flagged AI (${seScore}%) but visual analysis suggested real. Treating as uncertain.`;
      }
      if (geminiResult.aiProbability >= 70 && geminiResult.verdict !== 'ai') {
        geminiResult.verdict = 'ai';
      }
    }

    // ── KEY FIX: Normalize indicators (string → object) ───────
    geminiResult.aiIndicators   = normalizeIndicators(geminiResult.aiIndicators,   'Medium');
    geminiResult.realIndicators = normalizeIndicators(geminiResult.realIndicators, 'Medium');

    // Inject SightEngine as an indicator
    if (seScore !== null) {
      if (!geminiResult.aiIndicators.some(i => i.description?.toLowerCase().includes('sightengine'))) {
        geminiResult.aiIndicators.push({
          name:        topGen ? `SightEngine: ${topGen.label}` : 'SightEngine AI Score',
          severity:    seScore >= 70 ? 'High' : seScore >= 40 ? 'Medium' : 'Low',
          description: `SightEngine genai model detected ${seScore}% AI probability${topGen ? `, with ${topGen.label} as the most likely generator (${(topGen.score * 100).toFixed(1)}% confidence)` : ''}.`,
        });
      }
      if (!geminiResult.realIndicators.some(i => i.description?.toLowerCase().includes('sightengine'))) {
        geminiResult.realIndicators.push({
          name:        'SightEngine Human Score',
          severity:    seScore <= 30 ? 'High' : 'Low',
          description: `SightEngine detected ${100 - seScore}% probability that this is a real/authentic image.`,
        });
      }
    }

    // Guarantee minimums
    if (geminiResult.aiIndicators.length === 0) {
      geminiResult.aiIndicators.push({
        name:        topGen ? `Detected: ${topGen.label}` : 'AI Pattern Detected',
        severity:    'Medium',
        description: `Image shows characteristics consistent with AI generation (${geminiResult.aiProbability}% probability).`,
      });
    }
    if (geminiResult.realIndicators.length === 0) {
      geminiResult.realIndicators.push({
        name:        'Authentic Characteristics',
        severity:    'Low',
        description: `Image shows some characteristics consistent with authentic photography (${100 - geminiResult.aiProbability}% human probability).`,
      });
    }

    if (topGen && !geminiResult.estimatedGenerator) {
      geminiResult.estimatedGenerator = topGen.label;
    }

    return geminiResult;
  }

  // Fallback: SightEngine only
  if (seScore !== null) {
    const verdict = seScore >= 60 ? 'ai' : seScore <= 30 ? 'real' : 'uncertain';
    return {
      verdict,
      aiProbability:      seScore,
      confidence:         'Medium',
      estimatedGenerator: topGen?.label || '',
      summary:            `SightEngine analysis only (Gemini unavailable). AI probability: ${seScore}%.${topGen ? ` Likely generator: ${topGen.label}.` : ''}`,
      aiIndicators: [
        { name: 'SightEngine AI Score', severity: seScore >= 70 ? 'High' : 'Medium', description: `SightEngine genai model returned ${seScore}% AI probability.` },
        ...(topGen ? [{ name: `Generator: ${topGen.label}`, severity: topGen.score >= 0.6 ? 'High' : 'Medium', description: `SightEngine identified ${topGen.label} as the most likely generator with ${(topGen.score * 100).toFixed(1)}% confidence.` }] : []),
      ],
      realIndicators: [
        { name: 'Human Probability Score', severity: seScore <= 30 ? 'High' : 'Low', description: `SightEngine detected ${100 - seScore}% probability of being a real/authentic image.` },
      ],
      technicalDetails: `SightEngine ai_generated: ${sightEngineData.type.ai_generated}` +
                        (topGen ? ` | Top generator: ${topGen.label} (${(topGen.score * 100).toFixed(1)}%)` : ''),
    };
  }

  // No APIs
  return {
    verdict:            'uncertain',
    aiProbability:      50,
    confidence:         'Low',
    estimatedGenerator: '',
    summary:            'Analysis incomplete — API keys may not be configured.',
    aiIndicators:   [{ name: 'No Data Available', severity: 'Low', description: 'Unable to determine AI indicators — no API data was returned.' }],
    realIndicators: [{ name: 'No Data Available', severity: 'Low', description: 'Unable to determine authenticity — no API data was returned.' }],
    technicalDetails: 'No API results available. Check server logs and .env configuration.',
  };
}

/* ── CORE ANALYZE ────────────────────────────────────────────── */
async function analyze(fileBuffer, mimeType) {
  console.log(`[Alethia] Analyzing ${mimeType} (${Math.round(fileBuffer.length / 1024)}KB)`);
  const base64          = fileBuffer.toString('base64');
  const sightEngineData = await runSightEngine(fileBuffer, mimeType);
  const geminiResult    = await runGemini(base64, mimeType, sightEngineData);
  const result          = mergeResults(geminiResult, sightEngineData);
  result.mediaType      = mimeType.split('/')[0].toUpperCase();
  console.log(`[Alethia] Verdict: ${result.verdict} (${result.aiProbability}% AI)`);
  return result;
}

/* ================================================================
   ROUTES
   ================================================================ */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', apis: { sightengine: !!CONFIG.SIGHTENGINE_USER, gemini: !!CONFIG.GEMINI_API_KEY } });
});

app.post('/api/analyze/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    res.json(await analyze(req.file.buffer, req.file.mimetype));
  } catch (err) {
    console.error('[Upload] Error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

app.post('/api/analyze/url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    const blocked    = ['localhost', '127.0.0.1', '0.0.0.0'];
    const blockedPfx = ['169.254.', '10.', '192.168.', '172.16.'];
    if (blocked.includes(parsedUrl.hostname) || blockedPfx.some(p => parsedUrl.hostname.startsWith(p)))
      return res.status(400).json({ error: 'Private/internal URLs are not allowed' });
    if (!['http:', 'https:'].includes(parsedUrl.protocol))
      return res.status(400).json({ error: 'Only http/https URLs are allowed' });

    const response = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 10_000,
      maxContentLength: CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024,
      headers: { 'User-Agent': 'Alethia-Bot/1.0' },
    });

    const mimeType = (response.headers['content-type'] || '').split(';')[0].trim();
    if (!mimeType.startsWith('image/'))
      return res.status(400).json({ error: `URL did not return an image (got: ${mimeType})` });

    res.json(await analyze(Buffer.from(response.data), mimeType));
  } catch (err) {
    console.error('[URL] Error:', err.message);
    res.status(500).json({ error: err.message || 'URL analysis failed' });
  }
});

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

