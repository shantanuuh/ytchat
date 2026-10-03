import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function extractVideoId(url: string): string | null {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]*>?/gm, '');
}

export async function POST(request: Request) {
  try {
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 500 });
    }

    const { videoUrl } = await request.json();
    const videoId = extractVideoId(videoUrl);

    if (!videoId) {
      return NextResponse.json({ error: 'Invalid YouTube URL format.' }, { status: 400 });
    }

    // 1. Fetch YouTube watch page and caption tracks (same logic as before)
    const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!watchRes.ok) {
      return NextResponse.json({ error: 'Failed to access YouTube video page.' }, { status: 400 });
    }

    const html = await watchRes.text();
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionMatch) {
      return NextResponse.json({ error: 'No captions found for this video.' }, { status: 400 });
    }

    const captionTracks = JSON.parse(captionMatch[1]);
    const targetTrack = captionTracks.find((t: any) => t.kind !== 'asr' && !t.vssId?.startsWith('a.')) || captionTracks[0];
    const transcriptUrl = targetTrack.baseUrl.includes('&fmt=json3') ? targetTrack.baseUrl : `${targetTrack.baseUrl}&fmt=json3`;

    const transcriptRes = await fetch(transcriptUrl);
    const transcriptJson = await transcriptRes.json();
    const events = transcriptJson.events;

    if (!events || events.length === 0) {
      return NextResponse.json({ error: 'Transcript data events were empty.' }, { status: 400 });
    }

    // 2. Parse events into raw text lines
    const rawChunks: { text: string; index: number }[] = [];
    let index = 0;

    for (const event of events) {
      if (!event.segs) continue;
      const startSeconds = (event.tStartMs || 0) / 1000;
      const combinedText = event.segs.map((s: any) => s.utf8 || '').join('');
      const cleanedText = decodeHtmlEntities(combinedText).trim();

      if (cleanedText && cleanedText !== '\n') {
        const mins = Math.floor(startSeconds / 60).toString().padStart(2, '0');
        const secs = Math.floor(startSeconds % 60).toString().padStart(2, '0');
        const timeLabel = `[${mins}:${secs}]`;

        rawChunks.push({
          text: `${timeLabel} ${cleanedText}`,
          index: index++
        });
      }
    }

    // 3. Clear old chunks for this video in Supabase
    await supabase.from('transcripts').delete().eq('video_id', videoId);

    // 4. Batch generate embeddings using text-embedding-3-small and insert into Supabase
    // OpenAI allows embedding arrays of strings efficiently in batches
    const CHUNK_BATCH_SIZE = 100; // OpenAI batch limit safety
    for (let i = 0; i < rawChunks.length; i += CHUNK_BATCH_SIZE) {
      const batchSlice = rawChunks.slice(i, i + CHUNK_BATCH_SIZE);
      const textsToEmbed = batchSlice.map(c => c.text);

      // Call OpenAI API for embeddings
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: textsToEmbed,
      });

      const rowsToInsert = batchSlice.map((chunk, idx) => ({
        video_id: videoId,
        chunk_text: chunk.text,
        chunk_index: chunk.index,
        embedding: embeddingResponse.data[idx].embedding, // Vector array
        updated_at: new Date().toISOString()
      }));

      const { error: dbError } = await supabase.from('transcripts').insert(rowsToInsert);
      if (dbError) {
        throw new Error(`Supabase insert error: ${dbError.message}`);
      }
    }

    return NextResponse.json({
      success: true,
      videoId: videoId,
      chunkCount: rawChunks.length,
      message: 'Transcript and vector embeddings successfully indexed!'
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown server error';
    console.error('API Error:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
