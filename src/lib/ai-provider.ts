// src/lib/ai-provider.ts
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';

export function getModelInstance(provider: string = 'huggingface', apiKey?: string, customModelName?: string) {
  // Fallback key selection across common environment variables
  const key = apiKey || process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || process.env.MISTRAL_API_KEY || process.env.GROQ_API_KEY;

  switch (provider.toLowerCase()) {
    case 'huggingface':
    case 'hf': {
      // Hugging Face offers an OpenAI-compatible router endpoint
      const hfOpenAI = createOpenAI({
        baseURL: 'https://router.huggingface.co/v1',
        apiKey: key,
      });
      return hfOpenAI(customModelName || 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B');
    }
    case 'mistral': {
      const mistral = createMistral({ apiKey: key });
      return mistral(customModelName || 'mistral-large-latest');
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey: key });
      return openai(customModelName || 'gpt-4o-mini');
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: key });
      return anthropic(customModelName || 'claude-3-5-sonnet-20241022');
    }
    case 'gemini': {
      const google = createGoogleGenerativeAI({ apiKey: key });
      return google(customModelName || 'gemini-1.5-pro');
    }
    case 'groq': {
      const groq = createGroq({ apiKey: key });
      return groq(customModelName || 'llama-3.3-70b-versatile');
    }
    default: {
      // Default fallback to Hugging Face / DeepSeek R1 router
      const hfOpenAI = createOpenAI({
        baseURL: 'https://router.huggingface.co/v1',
        apiKey: key,
      });
      return hfOpenAI(customModelName || 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B');
    }
  }
}