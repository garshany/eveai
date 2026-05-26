import { describe, expect, it } from 'vitest';
import { buildInformationAction, buildTypeLinkMeta } from '../../src/eve/eve-links.js';

describe('eve link helpers', () => {
  it('builds show_info link and telegram market command for types', () => {
    const links = buildTypeLinkMeta(44996, 'Marshal', 1620);

    expect(links.show_info).toBe('<url=showinfo:44996>Marshal</url>');
    expect(links.telegram_commands.open_market_details).toBe('/market 44996');
  });

  it('builds information action and telegram info command for owners', () => {
    const info = buildInformationAction(95999487);

    expect(info.open_information.command).toBe('ui_openwindow_information');
    expect(info.open_information.args).toEqual(['--target_id', '95999487']);
    expect(info.telegram_commands.open_information).toBe('/info 95999487');
  });
});
