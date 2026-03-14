import type { ChatCompletionTool } from 'openai/resources/chat/completions';

/**
 * The 4 tools exposed to the model.
 * Matches the tool schemas from the architecture plan.
 */
export const AGENT_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'safe_exec_ocli',
      description: 'Searches, inspects, and runs EVE ESI commands through whitelisted ocli profiles.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            enum: [
              'eve-public', 'eve-character', 'eve-wallet', 'eve-assets',
              'eve-market', 'eve-industry', 'eve-contracts', 'eve-mail',
              'eve-corp', 'eve-ui',
            ],
          },
          mode: {
            type: 'string',
            enum: ['search', 'help', 'run'],
          },
          query: { type: ['string', 'null'] },
          command: { type: ['string', 'null'] },
          args: { type: ['array', 'null'], items: { type: 'string' } },
        },
        required: ['profile', 'mode', 'query', 'command', 'args'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_sde',
      description: 'Queries local EVE static data index.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          entity: {
            type: 'string',
            enum: [
              'type', 'group', 'category', 'market_group',
              'dogma_attribute', 'dogma_effect',
              'region', 'constellation', 'system', 'station', 'blueprint',
            ],
          },
          lookup_mode: {
            type: 'string',
            enum: ['by_id', 'by_name', 'search'],
          },
          value: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['entity', 'lookup_mode', 'value', 'limit'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_eve_capabilities',
      description: 'Returns current EVE character binding, granted scopes, and allowed profiles.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string' },
        },
        required: ['intent'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description: 'Stores or updates the execution plan for the current request.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: {
                  type: 'string',
                  enum: ['pending', 'running', 'done', 'blocked', 'failed'],
                },
                depends_on: { type: 'array', items: { type: 'string' } },
                notes: { type: 'string' },
              },
              required: ['id', 'title', 'status', 'depends_on', 'notes'],
              additionalProperties: false,
            },
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
    },
  },
];
