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

// 5. Parse XML events as fallback when YouTube returns XML instead of JSON3
function parseXmlEvents(xml: string): Json3Event[] {
  const events: Json3Event[] = [];

  // srv3 format: <p t="ms" d="ms">...</p>
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

  // Classic format: <text start="s" dur="s">...</text>
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

// 6. Fetch caption track using YouTube InnerTube Android API with URL parameter normalization
async function fetchInnerTubeCaptions(videoId: string, preferredLang?: string): Promise<{ events: Json3Event[]; language: string } | null> {
  const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const INNERTUBE_CLIENT_VERSION = '20.10.38';

  try {
    const resp = await fetch(INNERTUBE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: INNERTUBE_CLIENT_VERSION,
          },
        },
        videoId,
      }),
    });

    if (!resp.ok) {
      console.warn(`InnerTube player request returned status ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks as CaptionTrack[] | undefined;

    if (!captionTracks || captionTracks.length === 0) {
      return null;
    }

    const selectedTrack = selectBestTrack(captionTracks, preferredLang);
    
    // Normalize URL parameters to request fmt=json3
    let trackUrl: string;
    try {
      const urlObj = new URL(selectedTrack.baseUrl);
      urlObj.searchParams.set('fmt', 'json3');
      trackUrl = urlObj.toString();
    } catch {
      trackUrl = selectedTrack.baseUrl.replace('&fmt=srv3', '') + '&fmt=json3';
    }

    const trackResponse = await fetch(trackUrl);
    if (!trackResponse.ok) {
      console.warn(`Caption track fetch failed with status ${trackResponse.status}`);
      return null;
    }

    const responseText = await trackResponse.text();

    // Attempt parsing as JSON3
    try {
      const json3Data = JSON.parse(responseText);
      if (Array.isArray(json3Data?.events) && json3Data.events.length > 0) {
        return {
          events: json3Data.events,
          language: selectedTrack.languageCode || 'unknown',
        };
      }
    } catch {
      // Fallback: parse as XML (timedtext or srv3)
      const xmlEvents = parseXmlEvents(responseText);
      if (xmlEvents.length > 0) {
        return {
          events: xmlEvents,
          language: selectedTrack.languageCode || 'unknown',
        };
      }
    }

    return null;
  } catch (err) {
    console.warn('InnerTube caption retrieval error:', err);
    return null;
  }
}

// 7. Multilingual semantic chunker supporting Devanagari (Hindi/Marathi: । ॥) and Latin (. ! ?)
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

// 8. Fallback chunker for legacy youtube-transcript items
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

    // 1. Fetch transcript events using YouTube InnerTube & fmt=json3
    let chunks: TranscriptChunk[] = [];
    let detectedLang = 'en';

    const innerTubeResult = await fetchInnerTubeCaptions(videoId, lang);

    if (innerTubeResult && innerTubeResult.events.length > 0) {
      detectedLang = innerTubeResult.language;
      chunks = chunkTranscriptEvents(innerTubeResult.events, 800);
      console.log(`Extracted ${chunks.length} chunks via InnerTube (Lang: ${detectedLang})`);
    } else {
      // Fallback to youtube-transcript library
      console.log('InnerTube captions unavailable, attempting youtube-transcript fallback...');
      try {
        const fallbackItems = await YoutubeTranscript.fetchTranscript(videoId, { lang });
        if (fallbackItems && fallbackItems.length > 0) {
          chunks = chunkLegacyTranscriptItems(fallbackItems, 800);
          detectedLang = fallbackItems[0].lang || 'en';
          console.log(`Extracted ${chunks.length} chunks via fallback parser.`);
        }
      } catch (fallbackErr) {
        console.error('All transcript extraction methods failed:', fallbackErr);
        return NextResponse.json({
          error: 'Could not retrieve captions for this YouTube video. It may be private, live, or have captions disabled.',
        }, { status: 400 });
      }
    }

    if (chunks.length === 0) {
      return NextResponse.json({ 
        error: 'Retrieved transcript contains no readable text.' 
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
        // Notice: We do NOT abort with 400 here!
        // We still save the transcript chunks into Supabase so the user can immediately chat with the video!
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
          : `Successfully indexed ${chunks.length} chunks. Ready for chat!`,
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown server error';
    console.error('Transcript API Uncaught Exception:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
