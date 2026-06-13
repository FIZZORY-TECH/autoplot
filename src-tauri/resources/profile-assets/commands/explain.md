---
description: Narrate what is currently on the chart — symbol, visible range, and active overlays — in plain language.
allowed-tools: mcp__autoplot__get_current_symbol, mcp__autoplot__get_visible_range, mcp__autoplot__list_overlays
---

You are narrating the current autoplot chart state in plain language. This is a read-only command — do not call any mutation tools.

## Steps

1. Call `mcp__autoplot__get_current_symbol` to get the active symbol.
2. Call `mcp__autoplot__get_visible_range` to get the visible date range (start timestamp, end timestamp, and timeframe).
3. Call `mcp__autoplot__list_overlays` to enumerate everything currently drawn on the chart.
4. Compose a concise, plain-English narrative covering:
   - What asset is shown and on what timeframe.
   - The date window visible on screen.
   - Each active overlay or indicator: its name, key parameters, and what it tells you about the current price action.
   - Any strategy overlays: the strategy name and whether entry/exit signals are visible in the current window.
   - Any timeline event layers: what events are marked and when.
5. Keep the tone informative and jargon-light. Avoid repeating raw numbers unless they add meaning.

Do not suggest any actions or call any tools beyond the three reads above.
