import { NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import { supabase } from '@/lib/supabase';

function extractVideoId(url: string): string | null {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

// Helper to format seconds into [HH:MM:SS] or [MM:SS] for rich context
function formatTimestamp(offsetSeconds: number): string {
  const totalSeconds = Math.floor(offsetSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export async function POST(request: Request) {
  try {
    if (!supabase) {
      console.error('Transcript API Error: Supabase is not configured.');
      return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 500 });
    }

    const { videoUrl } = await request.json();
    const videoId = extractVideoId(videoUrl);

    if (!videoId) {
      return NextResponse.json({ error: 'Invalid YouTube URL format.' }, { status: 400 });
    }

    console.log(`Fetching transcript for video ID: ${videoId}`);

    let transcriptItems;
    try {
      transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
    } catch (fetchErr) {
      console.error('YoutubeTranscript error:', fetchErr);
      return NextResponse.json(
        { error: 'Could not fetch transcript. The video might be private, live, or have captions disabled.' },
        { status: 400 }
      );
    }

    if (!transcriptItems || transcriptItems.length === 0) {
      return NextResponse.json({ error: 'No transcript text found for this video.' }, { status: 400 });
    }

    // 1. Clear old chunks for this video to prevent duplication
    const { error: deleteError } = await supabase
      .from('transcripts')
      .delete()
      .eq('video_id', videoId);

    if (deleteError) {
      console.error('Error clearing old transcript chunks:', deleteError);
    }

    // 2. Format rows with timestamps and chunk_index to match table schema
    const rowsToInsert = transcriptItems.map((item, index) => {
      const timeStr = formatTimestamp(item.offset || 0);
      return {
        video_id: videoId,
        chunk_text: `[${timeStr}] ${item.text}`,
        chunk_index: index, // Included to match your Supabase schema
        updated_at: new Date().toISOString()
      };
    });

    // 3. Batch inserts in chunks of 500 to prevent payload limits or database timeouts
    const BATCH_SIZE = 500;
    for (let i = 0; i < rowsToInsert.length; i += BATCH_SIZE) {
      const batch = rowsToInsert.slice(i, i + BATCH_SIZE);
      const { error: dbError } = await supabase
        .from('transcripts')
        .insert(batch);

      if (dbError) {
        throw new Error(`Supabase database batch error: ${dbError.message}`);
      }
    }

    console.log(`Successfully indexed ${rowsToInsert.length} chunks for video ${videoId}`);

    return NextResponse.json({
      success: true,
      videoId: videoId,
      chunkCount: rowsToInsert.length,
      message: 'Transcript indexed successfully into Supabase.'
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown server error';
    console.error('Transcript API Uncaught Exception:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
