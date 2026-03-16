import { createNativeResponse, toNativeMessage } from './native-responses.js';

export async function runModelText(developerPrompt: string, userPrompt: string): Promise<string> {
  const response = await createNativeResponse({
    instructions: developerPrompt,
    items: [toNativeMessage(userPrompt)],
    tools: [],
    parallelToolCalls: false,
  });
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.outputText.trim();
}
