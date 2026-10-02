import { pipeline } from '@huggingface/transformers';

// Singleton pattern with explicit 'any' typing to bypass complex union overloads in transformers.js
let extractorPromise: Promise<any> | null = null;

async function getExtractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'fp32',
    });
  }
  return extractorPromise;
}

export async function generateEmbeddings(text: unknown): Promise<number[]> {
  try {
    const safeText = typeof text === 'string' 
      ? text 
      : Array.isArray(text) 
        ? text.join(' ') 
        : String(text || '');

    const cleanedText = safeText.replace(/\n/g, ' ').trim();

    if (!cleanedText) {
      // Return a zero-vector fallback for empty strings (dimension 384 for MiniLM-L6-v2)
      return new Array(384).fill(0);
    }

    const extractor = await getExtractor();
    
    const output = await extractor(cleanedText, {
      pooling: 'mean',
      normalize: true,
    });

    // Safely extract data array from transformers.js tensor output
    const embeddingArray = Array.from(output.data as Float32Array);
    return embeddingArray;

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown embedding generation error';
    console.error('Embedding Generation Exception:', errorMessage);
    throw new Error(`Failed to generate vector embeddings: ${errorMessage}`);
  }
}