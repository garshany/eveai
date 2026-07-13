export type OpenAiSmokeCompletion = Record<string, unknown>;

export function validateOpenAiSmokeCompletion(
  completed: OpenAiSmokeCompletion | null,
  streamedText: string,
  expectedText: string,
): { text: string; id: string | null; model: string | null } {
  if (!completed) {
    throw new Error('Responses API stream ended without a terminal response event.');
  }

  const text = extractCompletionText(completed) || streamedText.trim();
  if (text !== expectedText) {
    throw new Error(`Responses API returned unexpected smoke text: "${text.slice(0, 120)}"`);
  }

  return {
    text,
    id: typeof completed.id === 'string' ? completed.id : null,
    model: typeof completed.model === 'string' ? completed.model : null,
  };
}

function extractCompletionText(response: OpenAiSmokeCompletion): string {
  if (typeof response.output_text === 'string') return response.output_text.trim();
  const output = Array.isArray(response.output) ? response.output : [];
  const chunks: string[] = [];
  for (const item of output as Array<Record<string, unknown>>) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
}
