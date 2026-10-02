import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: Request) {
  try {
    if (!supabase) {
      console.error('Chat API Error: Supabase is not configured.');
      return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 500 });
    }

    const body = await request.json();
    const { message, videoId, apiKey } = body;
    
    // Validate BYOK (Bring Your Own Key) or fallback to server env
    const activeApiKey = apiKey?.trim() || process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;

    console.log('Chat API Request received:', { videoId, messageLength: message?.length, hasCustomKey: !!apiKey });

    if (!activeApiKey) {
      return NextResponse.json({ 
        error: 'Missing Hugging Face API Key. Please enter your API key in the BYOK settings or configure it in your environment variables.' 
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
    
    // Only fetch transcript chunks if it's an actual question/content query
    if (!isCasualChat) {
      const { data: records, error: dbError } = await supabase
        .from('transcripts')
        .select('chunk_text')
        .eq('video_id', videoId);

      if (dbError) {
        console.error('Supabase fetch error:', dbError);
        return NextResponse.json({ error: `Database error: ${dbError.message}` }, { status: 500 });
      }

      if (records && records.length > 0) {
        transcriptContext = records.map((r) => r.chunk_text).join(' ');
        console.log(`Successfully loaded ${records.length} transcript chunks for context.`);
      }
    }

    // Define smart system instructions with fallback behavior if context doesn't cover the query
    const systemContent = transcriptContext 
      ? `You are an expert AI video analyst assistant. Answer the user's question based strictly on the provided YouTube video transcript context below. 

IMPORTANT RULE: If the user's question asks about something completely unrelated to the transcript or if the transcript doesn't contain the answer, politely inform them: "I couldn't find information about that in the current video transcript. Please ask a question related to the video's contents!"

Format your response cleanly using this exact structure when applicable:
- Provide a brief introductory paragraph summarizing the core answer or explanation with relevant timestamps if available.
- Use bold headers for **Key Concepts** with brief bullet points.
- Use bold headers for sub-categories (like **Types of ...**) if breaking down technical details.

Transcript Context:
${transcriptContext}`
      : `You are a friendly, helpful AI video companion assistant. Respond naturally and politely to the user's greeting, and let them know you're ready to answer questions about the currently loaded video!`;

    // Call Hugging Face Router API
    const response = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${activeApiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        messages: [
          {
            role: 'system',
            content: systemContent
          },
          {
            role: 'user',
            content: message
          }
        ],
        max_tokens: 2048, // Increased to accommodate reasoning tokens + output
        temperature: 0.3,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Hugging Face Provider Error Response:', data);
      
      if (response.status === 401 || response.status === 403) {
        return NextResponse.json({ 
          error: 'Invalid Hugging Face API Key. Please check your BYOK key and try again.' 
        }, { status: 401 });
      }

      if (response.status === 503) {
        return NextResponse.json({ 
          error: 'The AI model is currently loading into serverless memory. Please wait 10 seconds and try again.' 
        }, { status: 503 });
      }

      throw new Error(data.error?.message || data.error || 'Hugging Face provider inference failed.');
    }

    // Robust extraction handling reasoning tokens and standard completions
    const choice = data.choices?.[0];
    let rawReply = choice?.message?.content || '';

    if (!rawReply && choice?.text) {
      rawReply = choice.text;
    }

    // CLEAN UP: Remove DeepSeek R1 <think>...</think> blocks so they don't leak into the UI
    let reply = rawReply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    if (!reply || reply === '') {
      // Fallback if the whole output was somehow trapped inside think tags
      reply = rawReply.replace(/<\/?think>/g, '').trim();
    }

    if (!reply || reply === '') {
      reply = "I processed your request, but the model didn't return a text output. Please try rephrasing your question!";
    }

    return NextResponse.json({
      success: true,
      reply: reply
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown server error';
    console.error('Chat API Uncaught Exception:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}