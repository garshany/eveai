/**
 * Strip terminal control sequences from text that originates outside the CLI
 * itself (model answers, reasoning summaries, tool details, error messages).
 *
 * The agent quotes external data — pilot bios, web pages, killmail text — so a
 * hostile string like `\x1b]0;evil\x07` (window retitle), OSC 52 (clipboard
 * write) or `\x1b[2J` (screen wipe) must never reach the TTY verbatim. The
 * CLI's own styling (colorize) is applied AFTER this strip, so legitimate
 * output keeps its colors.
 */
export function stripTerminalControls(text: string): string {
  return text
    // OSC strings (ESC ] … BEL / ESC \): titles, hyperlinks, OSC 52 clipboard.
    .replace(/\x1b\][\s\S]*?(\x07|\x1b\\|$)/g, '')
    // DCS/SOS/PM/APC strings (ESC P|X|^|_ … ESC \).
    .replace(/\x1b[PX^_][\s\S]*?(\x1b\\|$)/g, '')
    // CSI sequences (ESC [ params intermediates final).
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, '')
    // Any remaining ESC + one char (SS2/SS3, charset switches, bare ESC).
    .replace(/\x1b[\s\S]?/g, '')
    // C0 controls except \t (0x09) and \n (0x0a); DEL; C1 range (raw 8-bit CSI/OSC).
    .replace(/[\0-\x08\x0b-\x1f\x7f\u0080-\u009f]/g, '');
}
