/* ================================================================
   ALETHIA — server.js
   Single-file backend: SightEngine + Gemini analysis
   
   ⚙️ ADD MORE APIs: Search for "// ⚙️ ADD" comments below
   ⚙️ SETUP: npm install express cors multer axios dotenv @google/generative-ai
   ================================================================ */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const axios    = require('axios');
const path     = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── CONFIG ──────────────────────────────────────────────────── */
// ⚙️ UPDATE: Set these in your .env file
const CONFIG = {
  SIGHTENGINE_USER:   process.env.SIGHTENGINE_API_USER   || '',
  SIGHTENGINE_SECRET: process.env.SIGHTENGINE_API_SECRET || '',
  GEMINI_API_KEY:     process.env.GEMINI_API_KEY          || '',
  MAX_FILE_SIZE_MB:   20,
};

/* ── MIDDLEWARE ──────────────────────────────────────────────── */
app.use(cors());
app.use(express.json({ limit: '5mb' }));

/* ── MULTER (in-memory upload) ───────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk  = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    cb(extOk && mimeOk ? null : new Error('Only image files allowed'), extOk && mimeOk);
  }
});

/* ================================================================
   SIGHTENGINE MODULE
   Docs: https://sightengine.com/docs
   ⚙️ ADD: More models to the 'models' array below
   ================================================================ */
async function runSightEngine(imageBase64, mimeType) {
  if (!CONFIG.SIGHTENGINE_USER || !CONFIG.SIGHTENGINE_SECRET) {
    console.warn('[SightEngine] API keys not configured — skipping');
    return null;
  }

  try {
    const { data } = await axios.post(
      'https://api.sightengine.com/1.0/check.json',
      new URLSearchParams({
        models: 'properties',  // ⚙️ ADD more models: 'face-attributes,gore,nudity' etc.
        api_user:   CONFIG.SIGHTENGINE_USER,
        api_secret: CONFIG.SIGHTENGINE_SECRET,
        image:      `data:${mimeType};base64,${imageBase64}`,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    return data;
  } catch (err) {
    console.error('[SightEngine] Error:', err.response?.data || err.message);
    return null;
  }
}

/* ================================================================
   GEMINI MODULE
   ⚙️ ADD: Adjust the prompt below to get different outputs
   ⚙️ ADD: Add more media types by extending the prompt
   ================================================================ */
const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY || 'placeholder');

async function runGemini(imageBase64, mimeType, sightEngineData) {
  if (!CONFIG.GEMINI_API_KEY) {
    console.warn('[Gemini] API key not configured — skipping');
    return null;
  }

  try {
    // ⚙️ UPDATE: Modify this prompt to change analysis behavior
    const prompt = `You are an expert forensic AI image analyst. Analyze this image and determine if it is AI-generated or authentic.

${sightEngineData ? `SightEngine preliminary data: ${JSON.stringify(sightEngineData)}` : ''}

Return ONLY a JSON object (no markdown, no extra text) with this exact structure:
{
  "verdict": "ai" | "real" | "uncertain",
  "aiProbability": <number 0-100>,
  "confidence": "High" | "Medium" | "Low",
  "estimatedGenerator": "<tool name or 'Unknown' or 'N/A'>",
  "summary": "<2-3 sentence plain-English verdict>",
  "aiIndicators": [
    { "name": "<short name>", "severity": "High"|"Medium"|"Low", "description": "<what was found>" }
  ],
  "realIndicators": [
    { "name": "<short name>", "severity": "High"|"Medium"|"Low", "description": "<what was found>" }
  ],
  "technicalDetails": "<technical forensic notes, one paragraph>"
}

Focus on: pixel statistics, noise patterns, GAN artifacts, metadata consistency, EXIF fingerprints, edge coherence, semantic plausibility, lighting physics.`;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    // ⚙️ UPDATE: Change model to 'gemini-1.5-pro' for higher accuracy (slower/costs more)

    const result = await model.generateContent([
      { inlineData: { data: imageBase64, mimeType } },
      prompt
    ]);

    const text = result.response.text().trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[Gemini] Error:', err.message);
    return null;
  }
}

/* ================================================================
   ⚙️ ADD MORE APIS HERE
   Example template:
   async function runMyNewAPI(imageBase64, mimeType) {
     const { data } = await axios.post('https://api.example.com/check', {
       image: imageBase64,
       key: process.env.MY_API_KEY
     });
     return data;
   }
   ================================================================ */

/* ── MERGE RESULTS ───────────────────────────────────────────── */
/*
  ⚙️ UPDATE: Modify this function to change how multiple API results
  are combined into the final verdict.
*/
function mergeResults(geminiResult, sightEngineData) {
  // If Gemini gave us a clean result, use it as the base
  if (geminiResult) {
    // Boost confidence from SightEngine data if available
    if (sightEngineData?.ai_generated?.ai) {
      const seScore = Math.round(sightEngineData.ai_generated.ai * 100);
      const merged = geminiResult.aiProbability;
      // Weighted average: 70% Gemini, 30% SightEngine
      geminiResult.aiProbability = Math.round(merged * 0.7 + seScore * 0.3);
      geminiResult.technicalDetails += `\n\nSightEngine raw score: ${seScore}% AI probability.`;
    }
    return geminiResult;
  }

  // Fallback: SightEngine only
  if (sightEngineData?.ai_generated?.ai !== undefined) {
    const ai = Math.round(sightEngineData.ai_generated.ai * 100);
    const verdict = ai > 70 ? 'ai' : ai < 40 ? 'real' : 'uncertain';
    return {
      verdict,
      aiProbability: ai,
      confidence: 'Medium',
      estimatedGenerator: 'Unknown',
      summary: `SightEngine forensics detected ${ai}% AI probability. Gemini analysis unavailable.`,
      aiIndicators: ai > 50 ? [{ name: 'AI Pattern Score', severity: ai > 80 ? 'High' : 'Medium', description: `SightEngine scored ${ai}% likelihood of AI generation.` }] : [],
      realIndicators: ai <= 50 ? [{ name: 'Authentic Signal', severity: 'Medium', description: `SightEngine scored only ${ai}% AI likelihood.` }] : [],
      technicalDetails: `SightEngine raw: ${JSON.stringify(sightEngineData.ai_generated)}`
    };
  }

  // No APIs available
  return {
    verdict: 'uncertain',
    aiProbability: 50,
    confidence: 'Low',
    estimatedGenerator: 'Unknown',
    summary: 'Analysis incomplete — API keys may not be configured.',
    aiIndicators: [],
    realIndicators: [],
    technicalDetails: 'No API results available. Check server logs and .env configuration.'
  };
}

/* ── CORE ANALYZE FUNCTION ───────────────────────────────────── */
async function analyze(imageBase64, mimeType) {
  console.log(`[Alethia] Analyzing ${mimeType} (${Math.round(imageBase64.length * 0.75 / 1024)}KB)`);

  // Run both APIs in parallel for speed
  const [sightEngineData, geminiResult] = await Promise.all([
    runSightEngine(imageBase64, mimeType),
    runGemini(imageBase64, mimeType, null) // We'll pass SE data separately in merge
  ]);

  const merged = mergeResults(geminiResult, sightEngineData);

  // Add mediaType to result
  merged.mediaType = mimeType.split('/')[0].toUpperCase();

  console.log(`[Alethia] Verdict: ${merged.verdict} (${merged.aiProbability}% AI)`);
  return merged;
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
    const base64   = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const result   = await analyze(base64, mimeType);
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

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024,
      headers: { 'User-Agent': 'Alethia-Bot/1.0' }
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    const mimeType    = contentType.split(';')[0].trim();
    const base64      = Buffer.from(response.data).toString('base64');
    const result      = await analyze(base64, mimeType);
    res.json(result);
  } catch (err) {
    console.error('[URL] Error:', err.message);
    res.status(500).json({ error: err.message || 'URL analysis failed' });
  }
});

/* ================================================================
   ⚙️ ADD MORE ROUTES HERE for video/audio when you're ready
   Example:
   app.post('/api/analyze/video', upload.single('video'), async (req, res) => { ... });
   ================================================================ */

/* ── START ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n🔍 Alethia backend running on http://localhost:${PORT}`);
  console.log(`   SightEngine: ${CONFIG.SIGHTENGINE_USER ? '✓ configured' : '✗ not configured'}`);
  console.log(`   Gemini:      ${CONFIG.GEMINI_API_KEY   ? '✓ configured' : '✗ not configured'}`);
  console.log(`\n   Set keys in .env:\n   SIGHTENGINE_API_USER=...\n   SIGHTENGINE_API_SECRET=...\n   GEMINI_API_KEY=...\n`);
});