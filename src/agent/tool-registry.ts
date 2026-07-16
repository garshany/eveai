import type { NativeFunctionTool, NativeTool } from './native-responses.js';
import { validateJsonSchema } from './programmatic-contracts.js';
import { Buffer } from 'node:buffer';

export const MAX_FUNCTION_CALLS_PER_RESPONSE = 16;

export type EffectiveToolCall = {
  callId: string;
  name: string;
  argumentsText: string;
};

export type ToolCallRejection = {
  ok: false;
  blocked: true;
  error: string;
};

export type ToolCallBatchValidation = {
  ok: true;
  args: Array<Record<string, unknown>>;
  rejections: Array<ToolCallRejection | undefined>;
} | {
  ok: false;
  error: string;
};

export type ToolRegistryLoadDelta = {
  functions: number;
  namespaces: number;
  bytes: number;
  newFunctionNames: string[];
  newNamespaceNames: string[];
  alreadyLoadedFunctionNames: string[];
};

type RegistryEntry = {
  tool: NativeFunctionTool;
  namespaceName: string | null;
};

/**
 * Per-turn registry of function schemas the provider is actually allowed to
 * call. Client-side tool search adds definitions only after returning their
 * trusted local schemas to the model.
 */
export class EffectiveToolRegistry {
  readonly #tools = new Map<string, RegistryEntry>();
  readonly #namespaces = new Set<string>();

  constructor(initialTools: NativeTool[]) {
    this.add(initialTools);
  }

  previewAdd(tools: NativeTool[]): ToolRegistryLoadDelta {
    const staged = new Map<string, RegistryEntry>();
    const newNamespaces = new Set<string>();
    const alreadyLoaded = new Set<string>();
    let bytes = 0;

    for (const entry of flattenRegistryEntries(tools)) {
      const schemaError = validateToolSchemaDefinition(entry.tool.parameters);
      if (schemaError) {
        throw new Error(`Unsupported schema for tool ${entry.tool.name}: ${schemaError}`);
      }

      const existing = staged.get(entry.tool.name) ?? this.#tools.get(entry.tool.name);
      if (existing) {
        if (
          existing.namespaceName !== entry.namespaceName
          || JSON.stringify(existing.tool) !== JSON.stringify(entry.tool)
        ) {
          throw new Error(`Conflicting tool definition: ${entry.tool.name}`);
        }
        alreadyLoaded.add(entry.tool.name);
        continue;
      }

      staged.set(entry.tool.name, entry);
      bytes += Buffer.byteLength(JSON.stringify(entry.tool), 'utf8');
      if (entry.namespaceName && !this.#namespaces.has(entry.namespaceName)
        && !newNamespaces.has(entry.namespaceName)) {
        newNamespaces.add(entry.namespaceName);
        bytes += Buffer.byteLength(entry.namespaceName, 'utf8');
      }
    }

    return {
      functions: staged.size,
      namespaces: newNamespaces.size,
      bytes,
      newFunctionNames: [...staged.keys()].sort((left, right) => left.localeCompare(right)),
      newNamespaceNames: [...newNamespaces].sort((left, right) => left.localeCompare(right)),
      alreadyLoadedFunctionNames: [...alreadyLoaded].sort((left, right) => left.localeCompare(right)),
    };
  }

  add(tools: NativeTool[]): ToolRegistryLoadDelta {
    const delta = this.previewAdd(tools);
    const entries = new Map(flattenRegistryEntries(tools).map((entry) => [entry.tool.name, entry]));
    for (const name of delta.newFunctionNames) this.#tools.set(name, entries.get(name)!);
    for (const name of delta.newNamespaceNames) this.#namespaces.add(name);
    return delta;
  }

  get(name: string): NativeFunctionTool | undefined {
    return this.#tools.get(name)?.tool;
  }

  names(): string[] {
    return [...this.#tools.keys()].sort((left, right) => left.localeCompare(right));
  }
}

function flattenRegistryEntries(tools: NativeTool[]): RegistryEntry[] {
  return tools.flatMap((tool): RegistryEntry[] => {
    if (tool.type === 'function') return [{ tool, namespaceName: null }];
    if (tool.type === 'namespace') {
      return tool.tools.map((nested) => ({ tool: nested, namespaceName: tool.name }));
    }
    return [];
  });
}

export function flattenFunctionTools(tools: NativeTool[]): NativeFunctionTool[] {
  return tools.flatMap((tool): NativeFunctionTool[] => {
    if (tool.type === 'function') return [tool];
    if (tool.type === 'namespace') return tool.tools;
    return [];
  });
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

export function validateToolSchemaDefinition(
  schema: Readonly<Record<string, unknown>>,
  path = '$',
): string | null {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) return `${path}.${key} is unsupported`;
  }
  if (schema.format !== undefined && schema.format !== 'date-time') {
    return `${path}.format is unsupported`;
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) return `${path}.properties must be an object`;
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!isRecord(child)) return `${path}.properties.${name} must be a schema object`;
      const error = validateToolSchemaDefinition(child, `${path}.properties.${name}`);
      if (error) return error;
    }
  }
  if (schema.items !== undefined) {
    if (!isRecord(schema.items)) return `${path}.items must be a schema object`;
    const error = validateToolSchemaDefinition(schema.items, `${path}.items`);
    if (error) return error;
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) return `${path}.anyOf must be non-empty`;
    for (let index = 0; index < schema.anyOf.length; index += 1) {
      const child = schema.anyOf[index];
      if (!isRecord(child)) return `${path}.anyOf[${index}] must be a schema object`;
      const error = validateToolSchemaDefinition(child, `${path}.anyOf[${index}]`);
      if (error) return error;
    }
  }
  return null;
}

export function validateEffectiveToolCalls(
  registry: EffectiveToolRegistry,
  calls: EffectiveToolCall[],
  seenCallIds: ReadonlySet<string>,
): ToolCallBatchValidation {
  if (calls.length === 0 || calls.length > MAX_FUNCTION_CALLS_PER_RESPONSE) {
    return { ok: false, error: 'Invalid function call batch size' };
  }

  const batchIds = new Set<string>();
  for (const call of calls) {
    if (!call.callId || batchIds.has(call.callId) || seenCallIds.has(call.callId)) {
      return { ok: false, error: 'Duplicate or missing function call id' };
    }
    batchIds.add(call.callId);
  }

  const args: Array<Record<string, unknown>> = new Array(calls.length).fill(undefined);
  const rejections: Array<ToolCallRejection | undefined> = new Array(calls.length).fill(undefined);
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    const tool = registry.get(call.name);
    if (!tool) {
      args[index] = {};
      rejections[index] = rejection('Tool was not declared for this turn');
      continue;
    }

    const parsed = parseArgumentsObject(call.argumentsText);
    if (!parsed) {
      args[index] = {};
      rejections[index] = rejection('Tool arguments must be a valid JSON object');
      continue;
    }

    args[index] = parsed;
    const schemaValidation = validateJsonSchema(tool.parameters, parsed);
    if (!schemaValidation.valid) {
      rejections[index] = rejection(
        `Tool arguments failed schema validation: ${schemaValidation.errors.slice(0, 3).join('; ')}`,
      );
    }
  }

  if (rejections.some((entry) => entry !== undefined)) {
    for (let index = 0; index < rejections.length; index += 1) {
      rejections[index] ??= rejection('Tool call batch rejected because another call was invalid');
    }
  }

  return { ok: true, args, rejections };
}

function parseArgumentsObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function rejection(error: string): ToolCallRejection {
  return { ok: false, blocked: true, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
