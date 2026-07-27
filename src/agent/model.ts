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
  if (response.error) {
    throw new Error(response.error.message);
  }
  if (response.usage) onUsage?.(response.usage);
  return response.outputText.trim();
}
