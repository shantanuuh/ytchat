// src/app/api/chat/route.ts
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
      return NextResponse.json({ error: 'Supabase is not configured on the server.' }, { status: 500 });
    }

    const body = await request.json();
    const { message, videoId, apiKey, provider = 'auto' } = body;

    const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';

    // Provider Key Identifiers
    const isOpenAIKey = trimmedKey.startsWith('sk-') || trimmedKey.startsWith('sk-proj-');
    const isGroqKey = trimmedKey.startsWith('gsk_');
    const openAIKey = isOpenAIKey ? trimmedKey : process.env.OPENAI_API_KEY;

    // Resolve Active Provider & Key
    const activeApiKey =
      trimmedKey ||
      process.env.OPENAI_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.HUGGINGFACE_API_KEY ||
      process.env.HF_TOKEN ||
      process.env.MISTRAL_API_KEY;

    if (!activeApiKey) {
      return NextResponse.json(
        { error: 'Missing API key. Please enter your API key in settings or configure server environment variables.' },
        { status: 400 }
      );
    }

    if (!videoId) {
      return NextResponse.json({ error: 'Missing videoId in request.' }, { status: 400 });
    }

    // 1. Detect casual greetings or ultra-short messages
    const cleanMessage = message?.trim().toLowerCase() || '';
    const greetings = ['hi', 'hello', 'hey', 'namaste', 'greetings', 'thanks', 'thank you', 'dhanyawad', 'good morning', 'good evening', 'sup', 'bye'];
    const isCasualChat = greetings.includes(cleanMessage) || cleanMessage.length <= 3;

    let transcriptContext = '';
    let relevanceScore: number | null = null;
    let matchedChunksCount = 0;

    // 2. Vector Retrieval or Sequential Fallback
    if (!isCasualChat) {
      let matchedChunks: MatchedChunk[] = [];

      // Attempt Vector Similarity Search if OpenAI Key exists (for embedding model)
      if (openAIKey) {
        try {
          const openai = new OpenAI({ apiKey: openAIKey });
          const embRes = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: message.replace(/\n/g, ' ').trim(),
          });

          const queryEmbedding = embRes.data[0].embedding;

          // Query Postgres vector function
          const { data: rpcMatches, error: rpcError } = await supabase.rpc('match_video_transcripts', {
            query_embedding: queryEmbedding,
            target_video_id: videoId,
            match_threshold: 0.25, // Cosine similarity cutoff
            match_count: 8,
          });

          if (!rpcError && Array.isArray(rpcMatches) && rpcMatches.length > 0) {
            matchedChunks = rpcMatches;
            const validSimilarities = rpcMatches
              .map((m: any) => m.similarity)
              .filter((s: any) => typeof s === 'number');

            if (validSimilarities.length > 0) {
              relevanceScore = parseFloat(
                (validSimilarities.reduce((a: number, b: number) => a + b, 0) / validSimilarities.length).toFixed(3)
              );
            }
          } else if (rpcError) {
            console.warn('RPC vector match returned error, falling back to sequential fetch:', rpcError.message);
          }
        } catch (embErr) {
          console.warn('Vector search attempt failed, falling back to sequential fetch:', embErr);
        }
      }

      // Fallback: Fetch transcript chunks sequentially if vector match didn't return results
      if (matchedChunks.length === 0) {
        const { data: records, error: dbError } = await supabase
          .from('transcripts')
          .select('chunk_text')
          .eq('video_id', videoId)
          .order('chunk_index', { ascending: true })
          .limit(16);

        if (dbError) {
          console.error('Supabase fetch error:', dbError);
          return NextResponse.json({ error: `Database error: ${dbError.message}` }, { status: 500 });
        }

        if (records && records.length > 0) {
          matchedChunks = records;
        }
      }

      matchedChunksCount = matchedChunks.length;
      if (matchedChunks.length > 0) {
        transcriptContext = matchedChunks.map((r) => r.chunk_text).join('\n\n');
      }
    }

    // 3. System Prompt Configuration
    const systemContent = transcriptContext
      ? `You are an expert AI video analyst assistant. Answer the user's question based strictly on the provided YouTube video transcript context below.

CRITICAL INSTRUCTIONS:
1. Multi-Lingual Output: Respond in the exact language used in the user's question (e.g., English, Hindi, Marathi, or Hinglish).
2. Timestamp Citations: Cite relevant timestamps directly from the text (e.g., [02:45] or [01:12:05]) whenever stating key points.
3. Strict Grounding: If the question asks about topics completely absent from the context, state clearly in the user's language: "I couldn't find information about that in this video transcript. Please ask a question related to the video!"

Format your output using clean Markdown with bold headers and bullet points where applicable.

Transcript Context:
${transcriptContext}`
      : `You are a friendly, helpful AI video companion. Respond naturally to the user's greeting and invite them to ask any question about the loaded video!`;

    // 4. LLM Inference Engine Routing
    let reply = '';
    const targetProvider = provider !== 'auto' ? provider : isGroqKey ? 'groq' : isOpenAIKey ? 'openai' : 'huggingface';

    if (targetProvider === 'openai' || (isOpenAIKey && targetProvider === 'auto')) {
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
    } else if (targetProvider === 'groq' || isGroqKey) {
      const groqKey = isGroqKey ? trimmedKey : process.env.GROQ_API_KEY || trimmedKey;
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: message },
          ],
          temperature: 0.3,
          max_tokens: 1500,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Groq API request failed.');
      reply = data.choices?.[0]?.message?.content || '';
    } else if (targetProvider === 'mistral') {
      const mistralKey = trimmedKey || process.env.MISTRAL_API_KEY || '';
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${mistralKey}`,
        },
        body: JSON.stringify({
          model: 'mistral-small-latest',
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: message },
          ],
          temperature: 0.3,
          max_tokens: 1500,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Mistral API request failed.');
      reply = data.choices?.[0]?.message?.content || '';
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
        if (response.status === 401 || response.status === 403) {
          return NextResponse.json({ error: 'Invalid API Key. Please check your credentials.' }, { status: 401 });
        }
        if (response.status === 503) {
          return NextResponse.json(
            { error: 'The AI model is currently initializing. Please try again in 10 seconds.' },
            { status: 503 }
          );
        }
        throw new Error(data.error?.message || data.error || 'Hugging Face inference failed.');
      }

      const rawReply = data.choices?.[0]?.message?.content || '';
      reply = rawReply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!reply) reply = rawReply.replace(/<\/?think>/g, '').trim();
    }

    if (!reply) {
      reply = "I processed your request, but could not produce a response. Please try rephrasing your question.";
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
