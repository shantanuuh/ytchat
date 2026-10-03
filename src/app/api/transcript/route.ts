import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

function extractVideoId(url: string): string | null {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
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

    console.log(`Fetching transcript for video ID: ${videoId}`);

    // Fetching via a reliable edge service to avoid Vercel datacenter IP blocks
    const transcriptRes = await fetch(`https://youtube-transcript.ai/transcript/${videoId}.txt?lang=en`);
    
    if (!transcriptRes.ok) {
      return NextResponse.json(
        { error: 'Could not fetch transcript. The video might be private, live, or have captions disabled.' },
        { status: 400 }
      );
    }

    const rawText = await transcriptRes.text();
    if (!rawText || rawText.trim().length === 0) {
      return NextResponse.json({ error: 'No transcript text found for this video.' }, { status: 400 });
    }

    // Split text into readable lines/chunks
    const lines = rawText.split('\n').filter(line => line.trim().length > 0);

    // 1. Clear old chunks for this video to prevent duplication
    const { error: deleteError } = await supabase
      .from('transcripts')
      .delete()
      .eq('video_id', videoId);

    if (deleteError) {
      console.error('Error clearing old transcript chunks:', deleteError);
    }

    // 2. Format rows with chunk_index to match your table schema
    const rowsToInsert = lines.map((line, index) => ({
      video_id: videoId,
      chunk_text: line,
      chunk_index: index,
      updated_at: new Date().toISOString()
    }));

    // 3. Batch inserts in chunks of 500 to prevent payload limits
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
