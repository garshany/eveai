export type UiAction = {
  operation: string;
  args: Record<string, unknown> | string[];
  command?: string;
};

export type TypeLinkMeta = {
  show_info: string;
  telegram_commands: {
    open_market_details: string;
  };
};

export type EntityLinkMeta = {
  open_information: UiAction;
  telegram_commands: {
    open_information: string;
  };
};

export function buildTypeLinkMeta(typeId: number, label: string | null): TypeLinkMeta {
  const safeLabel = normalizeLabel(label, `Type ${typeId}`);
  return {
    show_info: `<url=showinfo:${typeId}>${safeLabel}</url>`,
    telegram_commands: {
      open_market_details: `/market ${typeId}`,
    },
  };
}

export function buildMarketDetailsAction(typeId: number): UiAction {
  return {
    operation: 'post_ui_openwindow_marketdetails',
    command: 'ui_openwindow_marketdetails',
    args: ['--type_id', String(typeId)],
  };
}

export function buildInformationAction(targetId: number): EntityLinkMeta {
  return {
    open_information: {
      operation: 'post_ui_openwindow_information',
      command: 'ui_openwindow_information',
      args: ['--target_id', String(targetId)],
    },
    telegram_commands: {
      open_information: `/info ${targetId}`,
    },
  };
}

function normalizeLabel(value: string | null, fallback: string): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.replace(/[<>]/g, '');
}
