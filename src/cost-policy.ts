import type { EstimateResult, PricingTable } from './estimate.js';

export type CostAwarenessMode = 'off' | 'warn' | 'require-approval';

export interface CostPolicy {
  /** Defaults to `warn`. */
  mode?: CostAwarenessMode;
  /** Warn when aggregate estimated spend reaches this amount. Defaults to $1. */
  warnAboveUsd?: number;
  /** Warn when aggregate parsed source size reaches this value. Defaults to 50,000. */
  warnAboveSourceCharacters?: number;
  /** Warn when aggregate estimated audio reaches this duration. Defaults to 30 minutes. */
  warnAboveAudioMinutes?: number;
  /** Hard ceiling. Exceeding it always stops before paid calls. */
  maxEstimatedUsd?: number;
  /** Optional pricing override for tenant/model-specific rates. */
  pricing?: Partial<PricingTable>;
  /**
   * Called in `require-approval` mode when warning thresholds are reached.
   * Return true to continue. A missing callback fails closed.
   */
  approve?: (assessment: CostAssessment) => boolean | Promise<boolean>;
}

export interface CostAssessment {
  documents: EstimateResult[];
  totals: {
    documents: number;
    sourceCharacters: number;
    sections: number;
    scriptInputTokens: number;
    scriptOutputTokens: number;
    ttsCharacters: number;
    audioMinutes: number;
    usd: {
      script: number;
      tts: number;
      total: number;
    };
  };
  warnings: string[];
  pricingLastVerified: string;
}

export interface ResolvedCostPolicy {
  mode: CostAwarenessMode;
  warnAboveUsd: number;
  warnAboveSourceCharacters: number;
  warnAboveAudioMinutes: number;
  maxEstimatedUsd?: number;
  pricing?: Partial<PricingTable>;
  approve?: CostPolicy['approve'];
}

export const DEFAULT_COST_POLICY: Readonly<ResolvedCostPolicy> = Object.freeze({
  mode: 'warn',
  warnAboveUsd: 1,
  warnAboveSourceCharacters: 50_000,
  warnAboveAudioMinutes: 30,
});

export class CostLimitExceededError extends Error {
  readonly assessment: CostAssessment;
  readonly limitUsd: number;

  constructor(assessment: CostAssessment, limitUsd: number) {
    super(
      `Estimated conversion cost $${formatUsd(assessment.totals.usd.total)} exceeds the configured maximum of $${formatUsd(limitUsd)}.`
    );
    this.name = 'CostLimitExceededError';
    this.assessment = assessment;
    this.limitUsd = limitUsd;
  }
}

export class CostApprovalRequiredError extends Error {
  readonly assessment: CostAssessment;

  constructor(assessment: CostAssessment) {
    super(
      'Cost approval is required before this conversion can start. Provide costPolicy.approve, use CLI --yes, or select cost-awareness mode "warn".'
    );
    this.name = 'CostApprovalRequiredError';
    this.assessment = assessment;
  }
}

export class CostApprovalDeclinedError extends Error {
  readonly assessment: CostAssessment;

  constructor(assessment: CostAssessment) {
    super('Conversion cancelled because cost approval was declined.');
    this.name = 'CostApprovalDeclinedError';
    this.assessment = assessment;
  }
}

export function resolveCostPolicy(input: CostPolicy | false | undefined): ResolvedCostPolicy {
  if (input === false) return { ...DEFAULT_COST_POLICY, mode: 'off' };
  const resolved: ResolvedCostPolicy = {
    ...DEFAULT_COST_POLICY,
    ...input,
  };
  validateThreshold('warnAboveUsd', resolved.warnAboveUsd);
  validateThreshold('warnAboveSourceCharacters', resolved.warnAboveSourceCharacters);
  validateThreshold('warnAboveAudioMinutes', resolved.warnAboveAudioMinutes);
  if (resolved.maxEstimatedUsd !== undefined) {
    validateThreshold('maxEstimatedUsd', resolved.maxEstimatedUsd);
  }
  return resolved;
}

export function createCostAssessment(
  documents: EstimateResult[],
  policy: ResolvedCostPolicy
): CostAssessment {
  const totals = documents.reduce(
    (sum, estimate) => ({
      documents: sum.documents + 1,
      sourceCharacters: sum.sourceCharacters + estimate.sourceCharacters,
      sections: sum.sections + estimate.sections,
      scriptInputTokens: sum.scriptInputTokens + estimate.total.scriptInputTokens,
      scriptOutputTokens: sum.scriptOutputTokens + estimate.total.scriptOutputTokens,
      ttsCharacters: sum.ttsCharacters + estimate.total.ttsCharacters,
      audioMinutes: sum.audioMinutes + estimate.total.audioMinutes,
      usd: {
        script: sum.usd.script + estimate.total.usd.script,
        tts: sum.usd.tts + estimate.total.usd.tts,
        total: sum.usd.total + estimate.total.usd.total,
      },
    }),
    {
      documents: 0,
      sourceCharacters: 0,
      sections: 0,
      scriptInputTokens: 0,
      scriptOutputTokens: 0,
      ttsCharacters: 0,
      audioMinutes: 0,
      usd: { script: 0, tts: 0, total: 0 },
    }
  );
  const warnings: string[] = [];
  if (totals.usd.total >= policy.warnAboveUsd) {
    warnings.push(
      `estimated cost $${formatUsd(totals.usd.total)} is at or above $${formatUsd(policy.warnAboveUsd)}`
    );
  }
  if (totals.sourceCharacters >= policy.warnAboveSourceCharacters) {
    warnings.push(
      `${totals.sourceCharacters.toLocaleString('en-US')} source characters are at or above ${policy.warnAboveSourceCharacters.toLocaleString('en-US')}`
    );
  }
  if (totals.audioMinutes >= policy.warnAboveAudioMinutes) {
    warnings.push(
      `estimated audio ${totals.audioMinutes.toFixed(1)} minutes is at or above ${policy.warnAboveAudioMinutes.toFixed(1)} minutes`
    );
  }
  return {
    documents,
    totals,
    warnings,
    pricingLastVerified: documents[0]?.pricingLastVerified ?? 'unknown',
  };
}

export async function enforceCostPolicy(
  assessment: CostAssessment,
  policy: ResolvedCostPolicy
): Promise<void> {
  if (
    policy.maxEstimatedUsd !== undefined &&
    assessment.totals.usd.total > policy.maxEstimatedUsd
  ) {
    throw new CostLimitExceededError(assessment, policy.maxEstimatedUsd);
  }
  if (policy.mode !== 'require-approval' || assessment.warnings.length === 0) return;
  if (!policy.approve) throw new CostApprovalRequiredError(assessment);
  if (!(await policy.approve(assessment))) throw new CostApprovalDeclinedError(assessment);
}

export function formatCostAssessment(assessment: CostAssessment): string {
  const total = assessment.totals;
  return [
    `${total.documents} document${total.documents === 1 ? '' : 's'}`,
    `${total.sourceCharacters.toLocaleString('en-US')} source characters`,
    `~${total.audioMinutes.toFixed(1)} audio minutes`,
    `~$${formatUsd(total.usd.total)} estimated Azure cost`,
  ].join(', ');
}

function validateThreshold(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite number greater than or equal to zero.`);
  }
}

function formatUsd(value: number): string {
  return value < 0.01 ? value.toFixed(4) : value.toFixed(2);
}
