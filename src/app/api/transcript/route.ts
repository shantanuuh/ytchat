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

// 1. Helper to extract YouTube Video ID from various URL formats
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

// 2. Format millisecond timestamp into [HH:MM:SS] or [MM:SS]
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

// 3. Select best caption track prioritizing human transcripts and multilingual codes (en, hi, mr)
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

// 4. Fetch server-side caption track JSON (&fmt=json3) via YouTube InnerTube Android API
async function fetchInnerTubeJson3(videoId: string, preferredLang?: string): Promise<{ events: Json3Event[]; language: string } | null> {
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
    const json3Url = selectedTrack.baseUrl.replace('&fmt=srv3', '') + '&fmt=json3';

    const trackResponse = await fetch(json3Url);
    if (!trackResponse.ok) {
      console.warn(`json3 track fetch failed with status ${trackResponse.status}`);
      return null;
    }

    const json3Data = await trackResponse.json();
    if (Array.isArray(json3Data?.events) && json3Data.events.length > 0) {
      return {
        events: json3Data.events,
        language: selectedTrack.languageCode || 'unknown',
      };
    }
    return null;
  } catch (err) {
    console.warn('InnerTube JSON3 retrieval error:', err);
    return null;
  }
}

// 5. Multilingual semantic chunker supporting Devanagari (Hindi/Marathi: । ॥) and Latin (. ! ?)
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

// 6. Fallback chunker for legacy youtube-transcript items
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

    if (!videoUrl) {
      return NextResponse.json({ error: 'Missing videoUrl in request.' }, { status: 400 });
    }

    const videoId = extractYouTubeVideoId(videoUrl);
    if (!videoId) {
      return NextResponse.json({ error: 'Invalid YouTube URL provided.' }, { status: 400 });
    }

    console.log(`Processing transcript ingestion for video ID: ${videoId}`);

    // Resolve OpenAI API Key: check BYOK header/body or server environment
    const activeOpenAIKey = 
      (typeof apiKey === 'string' && (apiKey.startsWith('sk-') || apiKey.startsWith('sk-proj-')) ? apiKey.trim() : null) ||
      process.env.OPENAI_API_KEY;

    // 1. Fetch transcript events using YouTube InnerTube & fmt=json3
    let chunks: TranscriptChunk[] = [];
    let detectedLang = 'en';

    const innerTubeResult = await fetchInnerTubeJson3(videoId, lang);

    if (innerTubeResult && innerTubeResult.events.length > 0) {
      detectedLang = innerTubeResult.language;
      chunks = chunkTranscriptEvents(innerTubeResult.events, 800);
      console.log(`Extracted ${chunks.length} chunks via InnerTube json3 (Lang: ${detectedLang})`);
    } else {
      // Fallback to youtube-transcript library
      console.log('InnerTube json3 unavailable, attempting youtube-transcript fallback...');
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
      return NextResponse.json({ error: 'Retrieved transcript contains no readable text.' }, { status: 400 });
    }

    // 2. Generate Vector Embeddings using OpenAI text-embedding-3-small
    let embeddingsGenerated = false;

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
        console.error('Embedding error:', msg);
        // If an explicit key was supplied and failed, notify user
        if (apiKey) {
          return NextResponse.json({ error: `OpenAI embedding generation failed: ${msg}` }, { status: 400 });
        }
      }
    } else {
      console.warn('No OpenAI API Key found. Chunks will be stored without vector embeddings until an OpenAI key is configured.');
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
    // Attempt insert with new schema (start_ms, end_ms, embedding)
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
    // If the database schema does not have start_ms or end_ms columns yet, insert legacy format
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
      message: embeddingsGenerated
        ? `Successfully parsed and indexed ${chunks.length} chunks with vector embeddings (text-embedding-3-small).`
        : `Successfully parsed and stored ${chunks.length} chunks. (Add an OpenAI key to enable vector similarity search).`,
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown server error';
    console.error('Transcript API Uncaught Exception:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
