// src/app/api/verify-key/route.ts
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { apiKey, provider } = body;

    if (!apiKey || typeof apiKey !== 'string') {
      return NextResponse.json({ valid: false, error: 'API key is missing or invalid' }, { status: 400 });
    }

    const trimmedKey = apiKey.trim();
    let isValid = false;

    // 1. Hugging Face Key Check (starts with hf_ or handled via explicit provider / router check)
    if (provider === 'huggingface' || trimmedKey.startsWith('hf_')) {
      const res = await fetch('https://router.huggingface.co/v1/models', {
        headers: { Authorization: `Bearer ${trimmedKey}` },
      });
      isValid = res.ok;
    } 
    // 2. Groq Key Check
    else if (provider === 'groq' || trimmedKey.startsWith('gsk_')) {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${trimmedKey}` },
      });
      isValid = res.ok;
    } 
    // 3. OpenAI Key Check
    else if (provider === 'openai' || trimmedKey.startsWith('sk-')) {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${trimmedKey}` },
      });
      isValid = res.ok;
    } 
    // 4. Mistral / Default Fallback Check
    else {
      const res = await fetch('https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${trimmedKey}` },
      });
      isValid = res.ok;
      
      // If Mistral check fails and user didn't specify, try Hugging Face router as a safe catch-all
      if (!isValid) {
        const hfRes = await fetch('https://router.huggingface.co/v1/models', {
          headers: { Authorization: `Bearer ${trimmedKey}` },
        });
        isValid = hfRes.ok;
      }
    }

    if (isValid) {
      return NextResponse.json({ valid: true });
    } else {
      return NextResponse.json({ valid: false, error: 'Invalid API key or unauthorized provider credentials.' }, { status: 400 });
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Verification failed due to an unexpected error.';
    return NextResponse.json({ valid: false, error: errorMessage }, { status: 500 });
  }
}