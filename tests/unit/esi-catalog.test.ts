import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('offline');
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('esi catalog tool schemas', () => {
  it('exposes field metadata for every generated ESI tool', async () => {
    const { loadEsiCatalog } = await import('../../src/eve/esi-catalog.js');
    const catalog = await loadEsiCatalog();

    for (const operation of catalog.values()) {
      const schema = operation.tool.parameters as {
        properties: Record<string, { description?: string; items?: { enum?: string[] } }>;
      };
      const fieldsSchema = schema.properties.fields;
      expect(fieldsSchema, `missing fields schema for ${operation.name}`).toBeDefined();

      if (operation.responseFields && operation.responseFields.length > 0) {
        expect(fieldsSchema.items?.enum, `missing fields enum for ${operation.name}`).toEqual(operation.responseFields);
        expect(fieldsSchema.description).toContain(`Allowed fields: ${operation.responseFields.join(', ')}`);
        expect(operation.tool.description).toContain(`Response fields: ${operation.responseFields.join(', ')}.`);
      } else {
        expect(fieldsSchema.description).toBe('Field projection is unsupported for this endpoint. Pass null.');
        expect(operation.tool.description).toContain('Response field projection is unsupported for this endpoint.');
      }
    }
  });

  it('adds optional fields to generated ESI tool schemas', async () => {
    const { loadEsiCatalog } = await import('../../src/eve/esi-catalog.js');
    const catalog = await loadEsiCatalog();
    const operation = catalog.get('get_markets_structures_structure_id');
    expect(operation).toBeDefined();
    const schema = operation?.tool.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.properties.fields).toEqual({
      type: ['array', 'null'],
      items: {
        type: 'string',
        enum: operation?.responseFields,
      },
      description: `Optional top-level response fields to return. Allowed fields: ${operation?.responseFields?.join(', ')}. Null uses the operation default behavior.`,
    });
    expect(schema.required).toContain('fields');
    expect(operation?.tool.description).toContain(`Response fields: ${operation?.responseFields?.join(', ')}.`);
  });

  it('keeps optional swagger query params out of required', async () => {
    const { loadEsiCatalog } = await import('../../src/eve/esi-catalog.js');
    const catalog = await loadEsiCatalog();
    const operation = catalog.get('get_characters_character_id_industry_jobs');
    expect(operation).toBeDefined();
    const schema = operation?.tool.parameters as {
      required: string[];
    };

    expect(schema.required).toContain('character_id');
    expect(schema.required).toContain('include_completed');
    expect(schema.required).toContain('fields');
  });

  it('captures top-level response fields for validation', async () => {
    const { loadEsiCatalog } = await import('../../src/eve/esi-catalog.js');
    const catalog = await loadEsiCatalog();
    const operation = catalog.get('get_markets_region_id_orders');

    expect(operation?.responseFields).toContain('price');
    expect(operation?.responseFields).toContain('volume_remain');
    expect(operation?.responseFields).toContain('order_id');
  });

  it('marks scalar-array endpoints as not supporting field projection in descriptions', async () => {
    const { loadEsiCatalog } = await import('../../src/eve/esi-catalog.js');
    const catalog = await loadEsiCatalog();
    const operation = catalog.get('get_markets_region_id_types');
    expect(operation).toBeDefined();

    const schema = operation?.tool.parameters as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties.fields.description).toBe('Field projection is unsupported for this endpoint. Pass null.');
    expect(operation?.tool.description).toContain('Response field projection is unsupported for this endpoint.');
  });
});
