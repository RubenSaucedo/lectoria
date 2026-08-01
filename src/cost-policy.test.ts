import { describe, expect, it, vi } from 'vitest';
import {
  CostApprovalDeclinedError,
  CostApprovalRequiredError,
  CostLimitExceededError,
  createCostAssessment,
  enforceCostPolicy,
  resolveCostPolicy,
} from './cost-policy.js';
import type { EstimateResult } from './estimate.js';

function estimate(overrides: Partial<EstimateResult['total']> = {}): EstimateResult {
  return {
    documentId: 'doc',
    documentTitle: 'Doc',
    sourceCharacters: 60_000,
    sections: 10,
    style: 'conversational',
    pricing: {
      openAiInputPer1M: 2.5,
      openAiOutputPer1M: 10,
      azureSpeechPer1M: 16,
    },
    pricingLastVerified: '2026-06-18',
    languages: [],
    total: {
      scriptInputTokens: 20_000,
      scriptOutputTokens: 15_000,
      ttsCharacters: 60_000,
      audioMinutes: 66,
      usd: { script: 0.2, tts: 0.96, total: 1.16 },
      ...overrides,
    },
    assumptions: [],
  };
}

describe('cost policy', () => {
  it('warns by default for large aggregate conversions', () => {
    const policy = resolveCostPolicy(undefined);
    const assessment = createCostAssessment([estimate()], policy);
    expect(policy.mode).toBe('warn');
    expect(assessment.warnings).toHaveLength(3);
  });

  it('enforces a hard maximum before approval', async () => {
    const policy = resolveCostPolicy({ maxEstimatedUsd: 1 });
    const assessment = createCostAssessment([estimate()], policy);
    await expect(enforceCostPolicy(assessment, policy)).rejects.toBeInstanceOf(
      CostLimitExceededError
    );
  });

  it('preserves full precision when aggregating many small documents', () => {
    const policy = resolveCostPolicy({ warnAboveUsd: 10 });
    const small = estimate({
      usd: { script: 0.001045, tts: 0.0011, total: 0.002145 },
    });
    const assessment = createCostAssessment(Array.from({ length: 1_000 }, () => small), policy);
    expect(assessment.totals.usd.total).toBeCloseTo(2.145, 10);
  });

  it('fails closed when approval is required without a callback', async () => {
    const policy = resolveCostPolicy({ mode: 'require-approval' });
    const assessment = createCostAssessment([estimate()], policy);
    await expect(enforceCostPolicy(assessment, policy)).rejects.toBeInstanceOf(
      CostApprovalRequiredError
    );
  });

  it('honors approval and rejection callbacks', async () => {
    const approve = vi.fn(async () => true);
    const approved = resolveCostPolicy({ mode: 'require-approval', approve });
    const assessment = createCostAssessment([estimate()], approved);
    await expect(enforceCostPolicy(assessment, approved)).resolves.toBeUndefined();
    expect(approve).toHaveBeenCalledWith(assessment);

    const declined = resolveCostPolicy({
      mode: 'require-approval',
      approve: () => false,
    });
    await expect(enforceCostPolicy(assessment, declined)).rejects.toBeInstanceOf(
      CostApprovalDeclinedError
    );
  });
});
