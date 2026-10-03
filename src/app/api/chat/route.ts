import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import OpenAI from 'openai';

interface MatchedChunk {
  id?: number;
  chunk_text: string;
  similarity?: number;
  start_ms?: number;
  end_ms?: number;
}

export async function POST(request: Request) {
  try {
    if (!supabase) {
      console.error('Chat API Error: Supabase is not configured.');
      return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 500 });
    }

    const body = await request.json();
    const { message, videoId, apiKey, provider } = body;

    const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';

    // Detect if key is OpenAI
    const isOpenAIKey = trimmedKey.startsWith('sk-') || trimmedKey.startsWith('sk-proj-');
    const openAIKey = isOpenAIKey ? trimmedKey : process.env.OPENAI_API_KEY;

    // Detect active inference key (BYOK key or env key)
    const activeApiKey = 
      trimmedKey || 
      process.env.HUGGINGFACE_API_KEY || 
      process.env.HF_TOKEN || 
      process.env.GROQ_API_KEY ||
      process.env.OPENAI_API_KEY;

    console.log('Chat API Request received:', { videoId, messageLength: message?.length, hasCustomKey: !!trimmedKey });

    if (!activeApiKey) {
      return NextResponse.json({ 
        error: 'Missing API Key. Please enter your API key in BYOK settings or configure it in server environment variables.' 
      }, { status: 400 });
    }

    if (!videoId) {
      return NextResponse.json({ error: 'Missing videoId in request.' }, { status: 400 });
    }

    // Check if the user input is a casual greeting or pleasantry
    const cleanMessage = message?.trim().toLowerCase() || '';
    const greetings = ['hi', 'hello', 'hey', 'greetings', 'thanks', 'thank you', 'good morning', 'good evening', 'sup', 'bye'];
    const isCasualChat = greetings.includes(cleanMessage) || cleanMessage.length <= 3;

    let transcriptContext = '';
    let relevanceScore: number | null = null;
    let matchedChunksCount = 0;

    // Retrieve transcript chunks only if it is an actual content query
    if (!isCasualChat) {
      let matchedChunks: MatchedChunk[] = [];

      // 1. Attempt Vector Similarity Search if OpenAI API key is available
      if (openAIKey) {
        try {
          const openai = new OpenAI({ apiKey: openAIKey });
          const embRes = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: message.replace(/\n/g, ' ').trim(),
          });

          const queryEmbedding = embRes.data[0].embedding;

          // Call Postgres RPC match_video_transcripts
          const { data: rpcMatches, error: rpcError } = await supabase.rpc('match_video_transcripts', {
            query_embedding: queryEmbedding,
            target_video_id: videoId,
            match_threshold: 0.15,
            match_count: 8,
          });

          if (!rpcError && Array.isArray(rpcMatches) && rpcMatches.length > 0) {
            matchedChunks = rpcMatches;
            const validSimilarities = rpcMatches
              .map((m: any) => m.similarity)
              .filter((s: any) => typeof s === 'number');
            if (validSimilarities.length > 0) {
              relevanceScore = parseFloat((validSimilarities.reduce((a: number, b: number) => a + b, 0) / validSimilarities.length).toFixed(3));
            }
            console.log(`Vector similarity search retrieved ${matchedChunks.length} chunks (Avg similarity: ${relevanceScore})`);
          } else if (rpcError) {
            console.warn('match_video_transcripts RPC call returned error, falling back to sequential fetch:', rpcError.message);
          }
        } catch (embErr) {
          console.warn('Vector search attempt failed, falling back to standard fetch:', embErr);
        }
      }

      // 2. Fallback: If vector search did not yield chunks, fetch transcript chunks sequentially
      if (matchedChunks.length === 0) {
        const { data: records, error: dbError } = await supabase
          .from('transcripts')
          .select('chunk_text')
          .eq('video_id', videoId)
          .order('chunk_index', { ascending: true })
          .limit(20);

        if (dbError) {
          console.error('Supabase fetch error:', dbError);
          return NextResponse.json({ error: `Database error: ${dbError.message}` }, { status: 500 });
        }

        if (records && records.length > 0) {
          matchedChunks = records;
          console.log(`Standard fetch loaded ${records.length} transcript chunks for context.`);
        }
      }

      matchedChunksCount = matchedChunks.length;
      if (matchedChunks.length > 0) {
        transcriptContext = matchedChunks.map((r) => r.chunk_text).join('\n\n');
      }
    }

    // Define system instructions with timestamp citations and structured format
    const systemContent = transcriptContext 
      ? `You are an expert AI video analyst assistant. Answer the user's question based strictly on the provided YouTube video transcript context below.

IMPORTANT RULES:
- When referencing facts, cite the timestamp from the context (e.g. [02:45]).
- If the user's question asks about something completely unrelated to the transcript or if the transcript doesn't contain the answer, politely inform them: "I couldn't find information about that in the current video transcript. Please ask a question related to the video's contents!"

Format your response cleanly using this exact structure when applicable:
- Provide a brief introductory paragraph summarizing the core answer with relevant timestamps.
- Use bold headers for **Key Concepts** with brief bullet points.
- Use bold headers for sub-categories (like **Types of ...**) if breaking down technical details.

Transcript Context:
${transcriptContext}`
      : `You are a friendly, helpful AI video companion assistant. Respond naturally and politely to the user's greeting, and let them know you're ready to answer questions about the currently loaded video!`;

    // 3. Execute LLM Inference
    // If the active key is an OpenAI key or Groq key, route appropriately, otherwise use Hugging Face router
    let reply = '';

    if (isOpenAIKey || (provider === 'openai' && trimmedKey)) {
      // Call OpenAI API
      const openai = new OpenAI({ apiKey: trimmedKey || process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: message },
        ],
        temperature: 0.3,
        max_tokens: 1500,
      });
      reply = completion.choices[0]?.message?.content || '';
    } else {
      // Default / Hugging Face Router API (DeepSeek-R1-Distill-Qwen-7B)
      const hfKey = trimmedKey || process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || '';
      const response = await fetch('https://router.huggingface.co/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hfKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: message },
          ],
          max_tokens: 2048,
          temperature: 0.3,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('LLM Provider Error Response:', data);
        if (response.status === 401 || response.status === 403) {
          return NextResponse.json({ 
            error: 'Invalid API Key. Please verify your BYOK credentials and try again.' 
          }, { status: 401 });
        }
        if (response.status === 503) {
          return NextResponse.json({ 
            error: 'The AI model is currently loading into serverless memory. Please wait 10 seconds and try again.' 
          }, { status: 503 });
        }
        throw new Error(data.error?.message || data.error || 'Provider inference failed.');
      }

      const choice = data.choices?.[0];
      const rawReply = choice?.message?.content || choice?.text || '';

      // Clean DeepSeek-R1 <think> reasoning tokens
      reply = rawReply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!reply) {
        reply = rawReply.replace(/<\/?think>/g, '').trim();
      }
    }

    if (!reply) {
      reply = "I processed your request, but could not produce a response. Please try rephrasing your question!";
    }

    return NextResponse.json({
      success: true,
      reply,
      relevanceScore,
      matchedChunksCount,
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown server error';
    console.error('Chat API Uncaught Exception:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}