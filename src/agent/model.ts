import { createNativeResponse, toNativeMessage, type NativeUsage } from './native-responses.js';

export async function runModelText(
  developerPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  /** Spend accounting hook: invoked with the response usage, when present. */
  onUsage?: (usage: NativeUsage) => void,
): Promise<string> {
  const response = await createNativeResponse({
    instructions: developerPrompt,
    items: [toNativeMessage(userPrompt)],
    tools: [],
    parallelToolCalls: false,
    signal,
  });
  // Record billed usage first: a failed/incomplete response is still charged.
  if (response.usage) onUsage?.(response.usage);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.outputText.trim();
}
