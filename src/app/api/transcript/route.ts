// src/app/api/transcript/route.ts
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { YoutubeTranscript } from 'youtube-transcript';
import OpenAI from 'openai';

interface CaptionSegment {
  utf8?: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: CaptionSegment[];
}

interface CaptionTrack {
  baseUrl: string;
  name?: { runs?: { text?: string }[] };
  vssId?: string;
  languageCode: string;
  kind?: string;
}

interface TranscriptChunk {
  chunk_index: number;
  start_ms: number;
  end_ms: number;
  chunk_text: string;
  embedding?: number[];
}

const MODERN_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';

// 1. Decode HTML entities
function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// 2. Helper to extract YouTube Video ID from any URL format
export function extractYouTubeVideoId(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts|live)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = trimmed.match(regExp);
  return (match && match[1].length === 11) ? match[1] : null;
}

// 3. Format millisecond timestamp into [HH:MM:SS] or [MM:SS]
function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// 4. Select best caption track prioritizing human transcripts and multilingual codes (en, hi, mr)
function selectBestTrack(tracks: CaptionTrack[], preferredLang?: string): CaptionTrack {
  if (preferredLang) {
    const directMatch = tracks.find((t) => t.languageCode.toLowerCase().startsWith(preferredLang.toLowerCase()));
    if (directMatch) return directMatch;
  }

  // Prioritize manual non-ASR captions
  const manualTracks = tracks.filter((t) => t.kind !== 'asr');
  const pool = manualTracks.length > 0 ? manualTracks : tracks;

  // Language priority order: English, Hindi, Marathi, then first available
  const priorityLangs = ['en', 'hi', 'mr'];
  for (const lang of priorityLangs) {
    const match = pool.find((t) => t.languageCode.toLowerCase().startsWith(lang));
    if (match) return match;
  }

  return pool[0];
}

// 5. Parse XML events (supports srv3 <p t="ms" d="ms"> and classic <text start="s" dur="s">)
function parseXmlEvents(xml: string): Json3Event[] {
  const events: Json3Event[] = [];

  // Format A: <p t="ms" d="ms">...<s>words</s>...</p>
  const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match;
  while ((match = pRegex.exec(xml)) !== null) {
    const startMs = parseInt(match[1], 10);
    const durMs = parseInt(match[2], 10);
    const rawText = match[3].replace(/<[^>]+>/g, '').trim();
    if (rawText) {
      events.push({
        tStartMs: startMs,
        dDurationMs: durMs,
        segs: [{ utf8: decodeEntities(rawText) }],
      });
    }
  }
  if (events.length > 0) return events;

  // Format B: <text start="s" dur="s">content</text>
  const textRegex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  while ((match = textRegex.exec(xml)) !== null) {
    const startMs = Math.round(parseFloat(match[1]) * 1000);
    const durMs = Math.round(parseFloat(match[2]) * 1000);
    const rawText = match[3].replace(/<[^>]+>/g, '').trim();
    if (rawText) {
      events.push({
        tStartMs: startMs,
        dDurationMs: durMs,
        segs: [{ utf8: decodeEntities(rawText) }],
      });
    }
  }
  return events;
}

// 6. Fetch caption content from a given track baseUrl with automatic fallback between json3 and xml
async function fetchCaptionTrackContent(baseUrl: string, trace: string[]): Promise<Json3Event[] | null> {
  const attempts = [
    { url: baseUrl, headers: { 'User-Agent': ANDROID_UA }, desc: 'Original baseUrl with Android UA' },
    { url: baseUrl, headers: { 'User-Agent': MODERN_BROWSER_UA }, desc: 'Original baseUrl with Browser UA' },
  ];

  try {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set('fmt', 'json3');
    attempts.unshift({ url: urlObj.toString(), headers: { 'User-Agent': ANDROID_UA }, desc: 'fmt=json3 with Android UA' });
  } catch {
    // Ignore URL parse error
  }

  for (const attempt of attempts) {
    try {
      const resp = await fetch(attempt.url, { headers: attempt.headers });
      trace.push(`${attempt.desc}: status ${resp.status}`);
      if (!resp.ok) continue;

      const text = await resp.text();
      if (!text || text.trim().length === 0) continue;

      // 1. Try parsing as JSON3
      try {
        const json = JSON.parse(text);
        if (Array.isArray(json?.events) && json.events.length > 0) {
          trace.push(`Parsed ${json.events.length} JSON3 events successfully`);
          return json.events;
        }
      } catch {
        // Not valid JSON, continue to XML parse
      }

      // 2. Try parsing as XML
      const xmlEvents = parseXmlEvents(text);
      if (xmlEvents.length > 0) {
        trace.push(`Parsed ${xmlEvents.length} XML events successfully`);
        return xmlEvents;
      }
    } catch (err: any) {
      trace.push(`${attempt.desc} failed: ${err.message}`);
    }
  }

  return null;
}

// 7. Method 1: Fetch via YouTube InnerTube API (Android client)
async function fetchInnerTubeCaptions(videoId: string, preferredLang: string | undefined, trace: string[]): Promise<{ events: Json3Event[]; language: string } | null> {
  const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const INNERTUBE_CLIENT_VERSION = '20.10.38';

  try {
    const resp = await fetch(INNERTUBE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': ANDROID_UA,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: INNERTUBE_CLIENT_VERSION,
            hl: 'en',
            gl: 'US',
          },
        },
        videoId,
      }),
    });

    trace.push(`InnerTube player HTTP status: ${resp.status}`);
    if (!resp.ok) return null;

    const data = await resp.json();
    const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks as CaptionTrack[] | undefined;

    if (!captionTracks || captionTracks.length === 0) {
      trace.push(`InnerTube: no caption tracks in response (status: ${data?.playabilityStatus?.status || 'unknown'})`);
      return null;
    }

    trace.push(`InnerTube: found ${captionTracks.length} caption tracks (${captionTracks.map((t) => t.languageCode).join(', ')})`);
    const selectedTrack = selectBestTrack(captionTracks, preferredLang);
    trace.push(`Selected track: ${selectedTrack.languageCode} (${selectedTrack.kind || 'manual'})`);

    const events = await fetchCaptionTrackContent(selectedTrack.baseUrl, trace);
    if (events && events.length > 0) {
      return { events, language: selectedTrack.languageCode || 'unknown' };
    }
    return null;
  } catch (err: any) {
    trace.push(`InnerTube exception: ${err.message}`);
    return null;
  }
}

// 8. Method 2: Fetch via Web Page HTML scraping
async function fetchWebPageCaptions(videoId: string, preferredLang: string | undefined, trace: string[]): Promise<{ events: Json3Event[]; language: string } | null> {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pageResp = await fetch(watchUrl, {
      headers: {
        'User-Agent': MODERN_BROWSER_UA,
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8,mr;q=0.7',
      },
    });

    trace.push(`WebPage HTTP status: ${pageResp.status}`);
    if (!pageResp.ok) return null;

    const html = await pageResp.text();
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionMatch) {
      trace.push('WebPage: captionTracks regex not matched');
      return null;
    }

    const captionTracks: CaptionTrack[] = JSON.parse(captionMatch[1]);
    if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
      trace.push('WebPage: captionTracks array empty');
      return null;
    }

    trace.push(`WebPage: found ${captionTracks.length} caption tracks (${captionTracks.map((t) => t.languageCode).join(', ')})`);
    const selectedTrack = selectBestTrack(captionTracks, preferredLang);

    const events = await fetchCaptionTrackContent(selectedTrack.baseUrl, trace);
    if (events && events.length > 0) {
      return { events, language: selectedTrack.languageCode || 'unknown' };
    }
    return null;
  } catch (err: any) {
    trace.push(`WebPage exception: ${err.message}`);
    return null;
  }
}

// 9. Multilingual semantic chunker supporting Devanagari (Hindi/Marathi: । ॥) and Latin (. ! ?)
function chunkTranscriptEvents(events: Json3Event[], targetChunkChars = 800): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let currentText = '';
  let startMs = 0;
  let endMs = 0;
  let chunkIndex = 0;

  for (const ev of events) {
    if (!ev.segs || ev.segs.length === 0) continue;
    const segmentText = ev.segs
      .map((s) => s.utf8 || '')
      .join('')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ');

    if (!segmentText.trim()) continue;

    const evStart = ev.tStartMs || 0;
    const evDuration = ev.dDurationMs || 0;
    const evEnd = evStart + evDuration;

    if (!currentText) {
      startMs = evStart;
    }

    currentText += (currentText ? ' ' : '') + segmentText.trim();
    endMs = evEnd;

    // Check sentence boundary supporting English (. ! ?) and Hindi/Marathi Devanagari (। ॥)
    const endsWithSentencePunctuation = /[.!?।॥]\s*$/.test(currentText);
    const exceedsTargetLength = currentText.length >= targetChunkChars;
    const exceedsHardMax = currentText.length >= targetChunkChars * 1.5;

    if ((exceedsTargetLength && endsWithSentencePunctuation) || exceedsHardMax) {
      const timeStr = formatTimestamp(startMs);
      chunks.push({
        chunk_index: chunkIndex++,
        start_ms: startMs,
        end_ms: endMs,
        chunk_text: `[${timeStr}] ${currentText.trim()}`,
      });
      currentText = '';
    }
  }

  if (currentText.trim()) {
    const timeStr = formatTimestamp(startMs);
    chunks.push({
      chunk_index: chunkIndex++,
      start_ms: startMs,
      end_ms: endMs,
      chunk_text: `[${timeStr}] ${currentText.trim()}`,
    });
  }

  return chunks;
}

// 10. Fallback chunker for legacy youtube-transcript items
function chunkLegacyTranscriptItems(items: { text: string; offset?: number; duration?: number }[], targetChunkChars = 800): TranscriptChunk[] {
  const events: Json3Event[] = items.map((item) => ({
    tStartMs: Math.round(item.offset || 0),
    dDurationMs: Math.round(item.duration || 0),
    segs: [{ utf8: item.text }],
  }));
  return chunkTranscriptEvents(events, targetChunkChars);
}

export async function POST(request: Request) {
  try {
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase is not configured on the server.' }, { status: 500 });
    }

    const body = await request.json();
    const { videoUrl, apiKey, lang } = body;

    if (!videoUrl || typeof videoUrl !== 'string' || !videoUrl.trim()) {
      return NextResponse.json({ error: 'Please enter a YouTube video URL.' }, { status: 400 });
    }

    const videoId = extractYouTubeVideoId(videoUrl);
    if (!videoId) {
      return NextResponse.json({ 
        error: 'Invalid YouTube URL. Please provide a valid video link (e.g., https://www.youtube.com/watch?v=... or https://youtu.be/...)' 
      }, { status: 400 });
    }

    console.log(`Processing transcript ingestion for video ID: ${videoId}`);

    // Resolve OpenAI API Key: check BYOK header/body (sk-...) or server environment
    const isExplicitOpenAIKey = typeof apiKey === 'string' && (apiKey.startsWith('sk-') || apiKey.startsWith('sk-proj-'));
    const activeOpenAIKey = isExplicitOpenAIKey ? apiKey.trim() : process.env.OPENAI_API_KEY;

    let chunks: TranscriptChunk[] = [];
    let detectedLang = 'en';
    const trace: string[] = [];

    // 1. Method 1: YouTube InnerTube API
    const innerTubeResult = await fetchInnerTubeCaptions(videoId, lang, trace);
    if (innerTubeResult && innerTubeResult.events.length > 0) {
      detectedLang = innerTubeResult.language;
      chunks = chunkTranscriptEvents(innerTubeResult.events, 800);
      trace.push(`InnerTube successfully parsed ${chunks.length} chunks`);
    }

    // 2. Method 2: Web Page HTML scraping fallback
    if (chunks.length === 0) {
      trace.push('InnerTube produced no chunks, trying WebPage scraping...');
      const webPageResult = await fetchWebPageCaptions(videoId, lang, trace);
      if (webPageResult && webPageResult.events.length > 0) {
        detectedLang = webPageResult.language;
        chunks = chunkTranscriptEvents(webPageResult.events, 800);
        trace.push(`WebPage scraping successfully parsed ${chunks.length} chunks`);
      }
    }

    // 3. Method 3: youtube-transcript library fallback
    if (chunks.length === 0) {
      trace.push('WebPage produced no chunks, trying youtube-transcript library fallback...');
      try {
        const fallbackItems = await YoutubeTranscript.fetchTranscript(videoId);
        if (fallbackItems && fallbackItems.length > 0) {
          chunks = chunkLegacyTranscriptItems(fallbackItems, 800);
          detectedLang = fallbackItems[0].lang || 'en';
          trace.push(`youtube-transcript successfully parsed ${chunks.length} chunks`);
        }
      } catch (fallbackErr: any) {
        trace.push(`youtube-transcript failed: ${fallbackErr.message}`);
      }
    }

    if (chunks.length === 0) {
      console.warn('All extraction methods failed for video ID:', videoId, trace);
      return NextResponse.json({ 
        error: `Could not retrieve captions for this YouTube video. It may be private, live, or have captions disabled. (Trace: ${trace.join(' | ')})`,
        trace,
      }, { status: 400 });
    }

    // 2. Generate Vector Embeddings using OpenAI text-embedding-3-small (with fault-tolerant fallback)
    let embeddingsGenerated = false;
    let embeddingWarning: string | null = null;

    if (activeOpenAIKey) {
      console.log(`Generating OpenAI text-embedding-3-small embeddings for ${chunks.length} chunks...`);
      try {
        const openai = new OpenAI({ apiKey: activeOpenAIKey });
        const BATCH_SIZE = 100;

        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
          const slice = chunks.slice(i, i + BATCH_SIZE);
          const inputTexts = slice.map((c) => c.chunk_text.replace(/[\r\n]+/g, ' ').trim());

          const embeddingRes = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: inputTexts,
          });

          embeddingRes.data.forEach((item, idx) => {
            slice[idx].embedding = item.embedding;
          });
        }
        embeddingsGenerated = true;
        console.log(`Successfully generated vector embeddings for all ${chunks.length} chunks.`);
      } catch (embErr: unknown) {
        const msg = embErr instanceof Error ? embErr.message : 'OpenAI embedding generation failed';
        console.warn('OpenAI embedding generation warning:', msg);
        embeddingWarning = msg;
      }
    } else {
      console.log('No OpenAI API Key found. Chunks will be indexed with standard context mode.');
    }

    // 3. Clear existing chunks for this video ID to prevent duplication
    const { error: deleteError } = await supabase
      .from('transcripts')
      .delete()
      .eq('video_id', videoId);

    if (deleteError) {
      console.warn('Warning: Could not clear existing chunks for video:', deleteError.message);
    }

    // 4. Bulk insert chunks into Supabase table ('transcripts')
    const rowsWithTimestamps = chunks.map((c) => ({
      video_id: videoId,
      chunk_index: c.chunk_index,
      start_ms: c.start_ms,
      end_ms: c.end_ms,
      chunk_text: c.chunk_text,
      embedding: c.embedding || null,
      updated_at: new Date().toISOString(),
    }));

    const BATCH_INSERT_SIZE = 100;
    let insertError: any = null;

    for (let i = 0; i < rowsWithTimestamps.length; i += BATCH_INSERT_SIZE) {
      const batch = rowsWithTimestamps.slice(i, i + BATCH_INSERT_SIZE);
      const { error: err } = await supabase.from('transcripts').insert(batch);
      if (err) {
        insertError = err;
        break;
      }
    }

    // Graceful backward compatibility fallback:
    // If the database schema does not have start_ms or end_ms columns yet, insert baseline schema
    if (insertError && (insertError.message?.includes('start_ms') || insertError.message?.includes('end_ms'))) {
      console.warn('start_ms / end_ms columns not detected in Supabase. Inserting with baseline schema...');
      const fallbackRows = chunks.map((c) => ({
        video_id: videoId,
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        embedding: c.embedding || null,
        updated_at: new Date().toISOString(),
      }));

      for (let i = 0; i < fallbackRows.length; i += BATCH_INSERT_SIZE) {
        const batch = fallbackRows.slice(i, i + BATCH_INSERT_SIZE);
        const { error: fallbackErr } = await supabase.from('transcripts').insert(batch);
        if (fallbackErr) {
          throw new Error(`Database error: ${fallbackErr.message}`);
        }
      }
      insertError = null;
    }

    if (insertError) {
      console.error('Supabase bulk insert error:', insertError);
      return NextResponse.json({ error: `Database error: ${insertError.message}` }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      videoId,
      language: detectedLang,
      chunkCount: chunks.length,
      hasEmbeddings: embeddingsGenerated,
      warning: embeddingWarning || undefined,
      message: embeddingsGenerated
        ? `Successfully parsed and indexed ${chunks.length} chunks with vector embeddings (text-embedding-3-small).`
        : embeddingWarning
          ? `Indexed ${chunks.length} chunks successfully. (Vector embeddings skipped: ${embeddingWarning})`
          : `Successfully indexed ${chunks.length} chunks (${detectedLang.toUpperCase()}). Ready for chat!`,
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown server error';
    console.error('Transcript API Uncaught Exception:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
