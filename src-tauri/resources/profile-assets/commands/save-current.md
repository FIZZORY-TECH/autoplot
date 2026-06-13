---
description: Save the current chart view as a research note — captures symbol, visible range, and active overlays.
allowed-tools: mcp__autoplot__get_current_symbol, mcp__autoplot__get_visible_range, mcp__autoplot__list_overlays, mcp__autoplot__save_research_note
---

You are saving the current autoplot chart state as a research note.

## Steps

1. Call `mcp__autoplot__get_current_symbol` to get the active symbol.
2. Call `mcp__autoplot__get_visible_range` to get the visible date range.
3. Call `mcp__autoplot__list_overlays` to enumerate the active overlays and strategies on the chart.
4. Assemble a structured research note body:
   - **Symbol**: the result of step 1.
   - **Range**: human-readable date range from step 2.
   - **Overlays**: bullet list of active overlays from step 3.
   - **Note**: if the user passed a title or note via `$ARGUMENTS`, include it verbatim under a "Note" heading.
5. Call `mcp__autoplot__save_research_note` with:
   - `title`: the user-supplied title from `$ARGUMENTS`, or auto-generate one as `"<symbol> — <date>" `.
   - `body`: the assembled markdown body.
   - `tags`: `["chart-snapshot"]` plus any tags the user mentioned.

Confirm to the user that the note has been saved and give them the note title.

Optional title or note: $ARGUMENTS
