export type OsintScope = 'character' | 'corporation' | 'alliance';

export type OsintInferenceArgs = {
  scope: OsintScope;
  id: number;
  windowDays: number;
  includeMemberAnalysis: boolean;
  includeGraph: boolean;
  includeLlmPatternAnalysis: boolean;
};
