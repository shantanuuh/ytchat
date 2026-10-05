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

const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// 1. Fetch visitorData token from YouTube homepage
async function getVisitorData(): Promise<string | null> {
  try {
    const resp = await fetch('https://www.youtube.com/', {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const match = html.match(/"visitorData":"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// 2. Decode HTML entities
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

// 3. Extract YouTube video ID
export function extractYouTubeVideoId(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts|live)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i
  );
  return match && match[1].length === 11 ? match[1] : null;
}

// 4. Format timestamp [MM:SS] or [HH:MM:SS]
function formatTimestamp(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// 5. Select caption track
function selectBestTrack(tracks: CaptionTrack[], preferredLang?: string): CaptionTrack {
  if (preferredLang) {
    const direct = tracks.find((t) => t.languageCode.toLowerCase().startsWith(preferredLang.toLowerCase()));
    if (direct) return direct;
  }
  const manual = tracks.filter((t) => t.kind !== 'asr');
  const pool = manual.length > 0 ? manual : tracks;
  for (const lang of ['en', 'hi', 'mr']) {
    const m = pool.find((t) => t.languageCode.toLowerCase().startsWith(lang));
    if (m) return m;
  }
  return pool[0];
}

// 6. Parse XML caption responses
function parseXmlEvents(xml: string): Json3Event[] {
  const events: Json3Event[] = [];
  const pRe = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(xml)) !== null) {
    const raw = m[3].replace(/<[^>]+>/g, '').trim();
    if (raw) events.push({ tStartMs: +m[1], dDurationMs: +m[2], segs: [{ utf8: decodeEntities(raw) }] });
  }
  if (events.length > 0) return events;

  const tRe = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = tRe.exec(xml)) !== null) {
    const raw = m[3].replace(/<[^>]+>/g, '').trim();
    if (raw) events.push({ tStartMs: Math.round(+m[1] * 1000), dDurationMs: Math.round(+m[2] * 1000), segs: [{ utf8: decodeEntities(raw) }] });
  }
  return events;
}

// 7. Fetch caption file
async function fetchCaptionFile(baseUrl: string): Promise<Json3Event[] | null> {
  const urls = (() => {
    try {
      const u = new URL(baseUrl);
      u.searchParams.set('fmt', 'json3');
      return [u.toString(), baseUrl];
    } catch {
      return [baseUrl];
    }
  })();

  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': ANDROID_UA } });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (!text.trim()) continue;

      try {
        const json = JSON.parse(text);
        if (Array.isArray(json?.events) && json.events.length > 0) return json.events;
      } catch {
        const xmlEvents = parseXmlEvents(text);
        if (xmlEvents.length > 0) return xmlEvents;
      }
    } catch {}
  }
  return null;
}

// 8. Fetch InnerTube
async function fetchViaInnerTube(
  videoId: string,
  preferredLang: string | undefined,
  trace: string[]
): Promise<{ events: Json3Event[]; language: string } | null> {
  try {
    const visitorData = await getVisitorData();
    trace.push(`visitorData: ${visitorData ? 'obtained' : 'unavailable'}`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': ANDROID_UA,
    };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    const body: Record<string, unknown> = {
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '20.10.38',
          hl: 'en',
          gl: 'US',
          ...(visitorData ? { visitorData } : {}),
        },
      },
      videoId,
    };

    const resp = await fetch(INNERTUBE_API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    trace.push(`InnerTube HTTP: ${resp.status}`);
    if (!resp.ok) return null;

    const data = await resp.json();
    const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks as CaptionTrack[] | undefined;
    trace.push(`InnerTube tracks: ${captionTracks?.length ?? 0}`);

    if (!captionTracks || captionTracks.length === 0) return null;

    const track = selectBestTrack(captionTracks, preferredLang);
    trace.push(`Selected track: ${track.languageCode} (${track.kind ?? 'manual'})`);

    const events = await fetchCaptionFile(track.baseUrl);
    if (events && events.length > 0) {
      return { events, language: track.languageCode };
    }
    return null;
  } catch (err: unknown) {
    trace.push(`InnerTube exception: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// 9. Fetch WebPage
async function fetchViaWebPage(
  videoId: string,
  preferredLang: string | undefined,
  trace: string[]
): Promise<{ events: Json3Event[]; language: string } | null> {
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
      },
    });
    if (!resp.ok) return null;

    const html = await resp.text();
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (captionMatch) {
      const tracks: CaptionTrack[] = JSON.parse(captionMatch[1]);
      if (tracks.length > 0) {
        const track = selectBestTrack(tracks, preferredLang);
        const events = await fetchCaptionFile(track.baseUrl);
        if (events && events.length > 0) {
          return { events, language: track.languageCode };
        }
      }
    }
    return null;
  } catch (err: unknown) {
    trace.push(`WebPage exception: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// 10. Fetch Library
async function fetchViaLibrary(
  videoId: string,
  preferredLang: string | undefined,
  trace: string[]
): Promise<{ events: Json3Event[]; language: string } | null> {
  try {
    const items = await YoutubeTranscript.fetchTranscript(videoId);
    if (!items || items.length === 0) return null;

    const events: Json3Event[] = items.map((item) => ({
      tStartMs: Math.round(item.offset || 0),
      dDurationMs: Math.round(item.duration || 0),
      segs: [{ utf8: item.text }],
    }));
    return { events, language: items[0].lang || 'en' };
  } catch (err: unknown) {
    trace.push(`youtube-transcript exception: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// 11. Chunking with Devanagari + Latin boundaries
function chunkEvents(events: Json3Event[], targetChars = 800): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let text = '';
  let startMs = 0;
  let endMs = 0;
  let idx = 0;

  for (const ev of events) {
    if (!ev.segs?.length) continue;
    const seg = ev.segs.map((s) => s.utf8 || '').join('').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!seg) continue;

    const evStart = ev.tStartMs || 0;
    const evEnd = evStart + (ev.dDurationMs || 0);
    if (!text) startMs = evStart;
    text += (text ? ' ' : '') + seg;
    endMs = evEnd;

    const atSentence = /[.!?।॥]\s*$/.test(text);
    if ((text.length >= targetChars && atSentence) || text.length >= targetChars * 1.5) {
      chunks.push({ chunk_index: idx++, start_ms: startMs, end_ms: endMs, chunk_text: `[${formatTimestamp(startMs)}] ${text.trim()}` });
      text = '';
    }
  }
  if (text.trim()) {
    chunks.push({ chunk_index: idx++, start_ms: startMs, end_ms: endMs, chunk_text: `[${formatTimestamp(startMs)}] ${text.trim()}` });
  }
  return chunks;
}

export async function POST(request: Request) {
  try {
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase is not configured on the server.' }, { status: 500 });
    }

    const body = await request.json();
    const { videoUrl, apiKey, lang } = body;

    if (!videoUrl?.trim()) {
      return NextResponse.json({ error: 'Please enter a YouTube video URL.' }, { status: 400 });
    }

    const videoId = extractYouTubeVideoId(videoUrl);
    if (!videoId) {
      return NextResponse.json({ error: 'Invalid YouTube URL format.' }, { status: 400 });
    }

    console.log(`Ingesting transcript for video: ${videoId}`);

    const isOpenAIKey = typeof apiKey === 'string' && (apiKey.startsWith('sk-') || apiKey.startsWith('sk-proj-'));
    const activeOpenAIKey = isOpenAIKey ? apiKey.trim() : process.env.OPENAI_API_KEY;

    // ─── Caption Extraction Cascade ───
    const trace: string[] = [];
    let captionResult: { events: Json3Event[]; language: string } | null = null;

    captionResult = await fetchViaInnerTube(videoId, lang, trace);
    if (!captionResult) captionResult = await fetchViaWebPage(videoId, lang, trace);
    if (!captionResult) captionResult = await fetchViaLibrary(videoId, lang, trace);

    if (!captionResult || captionResult.events.length === 0) {
      console.warn('All native extraction methods failed:', trace);
      return NextResponse.json({
        error: 'Could not retrieve captions for this video. Captions may be disabled or video is private.',
        trace,
      }, { status: 400 });
    }

    const chunks = chunkEvents(captionResult.events, 800);
    const detectedLang = captionResult.language;

    // ─── Vector Embeddings Generation ───
    let embeddingsGenerated = false;
    let embeddingWarning: string | null = null;

    if (activeOpenAIKey) {
      try {
        const openai = new OpenAI({ apiKey: activeOpenAIKey });
        for (let i = 0; i < chunks.length; i += 100) {
          const slice = chunks.slice(i, i + 100);
          const res = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: slice.map((c) => c.chunk_text.replace(/\n/g, ' ').trim()),
          });
          res.data.forEach((item, idx) => { slice[idx].embedding = item.embedding; });
        }
        embeddingsGenerated = true;
      } catch (e: unknown) {
        embeddingWarning = e instanceof Error ? e.message : 'Embedding generation failed';
        console.warn('Embedding warning:', embeddingWarning);
      }
    }

    // ─── Supabase Database Upsert ───
    await supabase.from('transcripts').delete().eq('video_id', videoId);

    const rows = chunks.map((c) => ({
      video_id: videoId,
      chunk_index: c.chunk_index,
      start_ms: c.start_ms,
      end_ms: c.end_ms,
      chunk_text: c.chunk_text,
      embedding: c.embedding || null,
      updated_at: new Date().toISOString(),
    }));

    let insertError: any = null;
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await supabase.from('transcripts').insert(rows.slice(i, i + 100));
      if (error) { insertError = error; break; }
    }

    if (insertError && (insertError.message?.includes('start_ms') || insertError.message?.includes('end_ms'))) {
      const legacyRows = chunks.map((c) => ({
        video_id: videoId,
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        embedding: c.embedding || null,
        updated_at: new Date().toISOString(),
      }));
      for (let i = 0; i < legacyRows.length; i += 100) {
        const { error } = await supabase.from('transcripts').insert(legacyRows.slice(i, i + 100));
        if (error) throw new Error(`Database error: ${error.message}`);
      }
      insertError = null;
    }

    if (insertError) {
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
        ? `Indexed ${chunks.length} chunks with vector embeddings (${detectedLang.toUpperCase()}).`
        : `Indexed ${chunks.length} chunks (${detectedLang.toUpperCase()}). Ready for chat!`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
