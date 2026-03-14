import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { AGENT_TOOLS } from './tools.js';
import { safeExecOcli, type OcliRequest } from '../eve/ocli.js';
import { querySde, type SdeRequest } from '../eve/sde.js';
import { getEveCapabilities } from '../eve/capabilities.js';
import { updatePlan, createRequestId, type PlanStep } from './planner.js';
import { replanOnFailure } from './replanner.js';

const MAX_ITERATIONS = 10;
const MAX_HISTORY_MESSAGES = 20;

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Main agent loop. Takes user text, runs tool calls in a loop, returns final text.
 */
export async function handleAgentMessage(db: Db, threadId: string, userText: string): Promise<string> {
  // Load conversation history from DB
  const historyRows = db.prepare(
    'SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at ASC'
  ).all(threadId) as Array<{ role: string; content: string }>;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  // Add recent history (the latest user message is already stored by the handler)
  const recent = historyRows.slice(-MAX_HISTORY_MESSAGES);
  for (const row of recent) {
    messages.push({ role: row.role as 'user' | 'assistant', content: row.content });
  }

  const requestId = createRequestId();
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      tools: AGENT_TOOLS,
      tool_choice: 'auto',
    });

    const choice = response.choices[0];
    if (!choice) {
      return 'No response from model.';
    }

    const msg = choice.message;
    messages.push(msg as ChatCompletionMessageParam);

    // If no tool calls, we're done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const finalText = msg.content ?? 'No response.';
      // Store assistant response
      db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'assistant', finalText);
      return finalText;
    }

    // Execute tool calls and persist results for multi-turn context
    const toolSummaries: string[] = [];
    for (const toolCall of msg.tool_calls) {
      const result = await executeToolCall(db, requestId, userText, toolCall);

      // Check if tool failed and trigger replanning
      if (typeof result === 'object' && result !== null && 'error' in result) {
        const errMsg = String((result as Record<string, unknown>).error);
        replanOnFailure(db, requestId, errMsg);
      }

      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: resultStr,
      });

      // Build summary for persistent storage
      const toolName = toolCall.type === 'function' ? toolCall.function.name : 'unknown';
      const truncResult = resultStr.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr;
      toolSummaries.push(`[${toolName}]: ${truncResult}`);
    }

    // Persist tool interaction as assistant message for cross-turn context
    if (toolSummaries.length > 0) {
      db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(
        threadId, 'assistant', toolSummaries.join('\n')
      );
    }
  }

  const fallback = 'Reached maximum iterations. Please try a simpler question.';
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'assistant', fallback);
  return fallback;
}

async function executeToolCall(
  db: Db,
  requestId: string,
  goal: string,
  toolCall: ChatCompletionMessageToolCall,
): Promise<unknown> {
  if (toolCall.type !== 'function') {
    return { error: `Unsupported tool call type: ${toolCall.type}` };
  }

  const name = toolCall.function.name;

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
  } catch {
    return { error: `Invalid JSON in tool arguments for ${name}` };
  }

  try {
    switch (name) {
      case 'safe_exec_ocli': {
        const req: OcliRequest = {
          profile: args.profile as string,
          mode: args.mode as 'search' | 'help' | 'run',
          query: (args.query as string) ?? null,
          command: (args.command as string) ?? null,
          args: (args.args as string[]) ?? null,
        };
        return await safeExecOcli(db, req);
      }

      case 'query_sde': {
        const req: SdeRequest = {
          entity: args.entity as SdeRequest['entity'],
          lookup_mode: args.lookup_mode as SdeRequest['lookup_mode'],
          value: args.value as string,
          limit: args.limit as number,
        };
        return querySde(db, req);
      }

      case 'get_eve_capabilities': {
        return getEveCapabilities(db, args.intent as string);
      }

      case 'update_plan': {
        const steps = args.steps as PlanStep[];
        return updatePlan(db, requestId, goal, steps);
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: `Tool ${name} failed: ${(err as Error).message}` };
  }
}
