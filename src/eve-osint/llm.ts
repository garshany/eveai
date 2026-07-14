import { createNativeResponse, toNativeMessage } from '../agent/native-responses.js';

const OSINT_ANALYSIS_PROMPT = `You are an EVE Online intelligence analyst. You receive a structured OSINT digest built from public killboard data about a player, corporation, or alliance.

Your job: synthesize all data into an actionable intelligence report. Do not invent facts — only interpret what the data shows.

## Data sections you will receive

- **hypotheses**: top candidate home/staging/hunting systems with scores and confidence
- **temporal**: hourly/daily activity histograms, estimated timezone, sleep window, activity regularity
- **sessions**: gaming session stats — count, avg/median duration, play hours per week
- **ship_profile**: ships flown, favorite ship, dominant hull class, capital usage, diversity
- **fleet_profile**: fleet size distribution (solo/small gang/medium/large), frequent companions
- **movement**: system-to-system travel routes, travel pipes, geographic spread
- **deployments**: region changes over time, current region, stability
- **vulnerability**: loss patterns, peak loss hours/systems, best ambush window, vulnerability score
- **alt_detection**: suspected alt pairs (corp/alliance only)
- **graph_signals**: split_theater, roaming_bias, hub_bias, member_concentration, activity_window_dispersion, security-band bias

## EVE Online context

- **Home system**: where entity lives, rats, mines. High losses here (defenders get caught). High unique activity days.
- **Staging system**: forward operating base for fleet ops. Mix of kills/losses. Often near hostile space.
- **Hunting area**: where they roam to kill. High kill ratio, few losses. Often transient.
- **Timezone**: EU (UTC+0..+3), US East (UTC-5..-4), US West (UTC-8..-7), AU (UTC+8..+11), RU (UTC+3..+5)
- **Fleet meta**: solo PvPer, small gang, blob/F1 monkey, capital pilot — different threat profiles
- **Vulnerability**: when they PvE (rat/mine) they are catchable. Loss concentration reveals this.

## Output schema (strict JSON only)

{
  "intelligence_summary": "2-4 sentence executive summary of who this entity is, where they operate, and their threat profile",
  "lifestyle": "one of: ratter | miner | solo_hunter | small_gang | fleet_pilot | capital_pilot | nomad | station_trader | mixed",
  "timezone_assessment": "e.g. 'EU timezone (UTC+1..+2), active 18:00-01:00 UTC, plays 4-5 days/week'",
  "threat_level": "low | medium | high | dangerous",
  "threat_reasoning": "why this threat level — based on ships, fleet size, skill indicators",
  "home_confidence": "low | medium | high — how confident we are about home system identification",
  "behavioral_patterns": ["up to 6 key observations about behavior, movement, habits"],
  "tactical_recommendations": ["up to 4 actionable suggestions for engaging/avoiding this entity"],
  "alternative_interpretations": ["up to 3 alternative readings of ambiguous data"],
  "uncertainty": ["up to 4 caveats about data quality, coverage, or confidence"]
}`;

const LLM_TIMEOUT_MS = 18_000;

export async function analyzeOsintGraphPatterns(digest: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const response = await withTimeout(
      createNativeResponse({
        instructions: OSINT_ANALYSIS_PROMPT,
        items: [toNativeMessage(JSON.stringify(digest, null, 2))],
        tools: [],
      }),
      LLM_TIMEOUT_MS,
    );
    return parseAnalysis(response.outputText);
  } catch (error) {
    console.warn('[eve-osint] LLM pattern analysis failed: %s', (error as Error).message);
    return null;
  }
}

function parseAnalysis(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.intelligence_summary !== 'string') return null;
    return {
      intelligence_summary: parsed.intelligence_summary,
      lifestyle: typeof parsed.lifestyle === 'string' ? parsed.lifestyle : 'mixed',
      timezone_assessment: typeof parsed.timezone_assessment === 'string' ? parsed.timezone_assessment : null,
      threat_level: typeof parsed.threat_level === 'string' ? parsed.threat_level : null,
      threat_reasoning: typeof parsed.threat_reasoning === 'string' ? parsed.threat_reasoning : null,
      home_confidence: typeof parsed.home_confidence === 'string' ? parsed.home_confidence : null,
      behavioral_patterns: filterStrings(parsed.behavioral_patterns, 6),
      tactical_recommendations: filterStrings(parsed.tactical_recommendations, 4),
      alternative_interpretations: filterStrings(parsed.alternative_interpretations, 3),
      uncertainty: filterStrings(parsed.uncertainty, 4),
    };
  } catch {
    return null;
  }
}

function filterStrings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').slice(0, max);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OSINT LLM call timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
