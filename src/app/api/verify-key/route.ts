// src/app/api/verify-key/route.ts
import { NextResponse } from 'next/server';

interface VerificationTarget {
  name: string;
  url: string;
}

const PROVIDER_ENDPOINTS: Record<string, VerificationTarget> = {
  huggingface: { name: 'Hugging Face', url: 'https://router.huggingface.co/v1/models' },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/models' },
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/models' },
  mistral: { name: 'Mistral', url: 'https://api.mistral.ai/v1/models' },
};

function detectProvider(key: string, explicitProvider?: string): string {
  if (explicitProvider && PROVIDER_ENDPOINTS[explicitProvider]) {
    return explicitProvider;
  }
  if (key.startsWith('hf_')) return 'huggingface';
  if (key.startsWith('gsk_')) return 'groq';
  if (key.startsWith('sk-proj-') || key.startsWith('sk-')) return 'openai';
  return 'huggingface'; // Default fallback router
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { apiKey, provider } = body;

    if (!apiKey || typeof apiKey !== 'string') {
      return NextResponse.json(
        { valid: false, error: 'API key is missing or invalid.' },
        { status: 400 }
      );
    }

    const trimmedKey = apiKey.trim();
    const targetProviderKey = detectProvider(trimmedKey, provider);
    const target = PROVIDER_ENDPOINTS[targetProviderKey] || PROVIDER_ENDPOINTS['huggingface'];

    console.log(`Verifying key for provider: ${target.name}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8-second timeout guard

    const res = await fetch(target.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${trimmedKey}` },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      return NextResponse.json({ 
        valid: true, 
        provider: targetProviderKey,
        message: `Successfully authenticated with ${target.name}.` 
      });
    }

    // Handle specific status codes for granular user feedback
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json(
        { valid: false, error: `Invalid API key credentials for ${target.name}.` },
        { status: 401 }
      );
    }

    return NextResponse.json(
      { valid: false, error: `${target.name} returned status ${res.status}. Key may be expired or restricted.` },
      { status: 400 }
    );

  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json(
        { valid: false, error: 'Key verification timed out. Please check your network connection.' },
        { status: 504 }
      );
    }

    const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred during verification.';
    console.error('Verify Key API Exception:', errorMessage);
    
    return NextResponse.json(
      { valid: false, error: errorMessage },
      { status: 500 }
    );
  }
}