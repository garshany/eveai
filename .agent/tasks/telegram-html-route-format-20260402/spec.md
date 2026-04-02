# Telegram HTML Route Format Fix

## Goal
Restore valid Telegram formatting for HTML route replies so route summaries render as formatted HTML instead of showing raw tags.

## Acceptance Criteria
- AC1: Route summary kill lines and briefing kill lines do not emit raw `<-` inside Telegram HTML responses.
- AC2: `finalizeThreadMessage` does not append Markdown helper blocks to HTML replies; appended helper commands must stay valid Telegram HTML.
- AC3: Regression coverage proves route summary, briefing, and finalizer preserve valid HTML-friendly output.
