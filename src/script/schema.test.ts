import { describe, expect, it } from 'vitest';
import { ModelOutputValidationError, parseModelScript } from './schema.js';

const speakers = new Set(['host', 'guest']);

describe('parseModelScript', () => {
  it('accepts the direct and wrapped response shapes and normalizes null pauses', () => {
    const direct = parseModelScript(
      JSON.stringify({
        episodeTitle: 'Lesson',
        summary: '',
        segments: [
          {
            kind: 'body',
            utterances: [{ voice: 'host', text: 'Hello', pauseAfterMs: null }],
          },
        ],
      }),
      speakers
    );
    expect(direct.segments[0]!.utterances[0]!.pauseAfterMs).toBeUndefined();

    const wrapped = parseModelScript(JSON.stringify({ script: direct }), speakers);
    expect(wrapped).toEqual(direct);
  });

  it('normalizes the prompt-supported null heading shape', () => {
    const parsed = parseModelScript(
      JSON.stringify({
        episodeTitle: 'Lesson',
        summary: '',
        segments: [
          {
            kind: 'body',
            heading: null,
            utterances: [{ voice: 'host', text: 'Hello' }],
          },
        ],
      }),
      speakers
    );
    expect(parsed.segments[0]!.heading).toBeUndefined();
  });

  it('rejects unknown properties and invalid pause values', () => {
    expect(() =>
      parseModelScript(
        JSON.stringify({
          episodeTitle: 'Lesson',
          summary: '',
          extra: true,
          segments: [
            {
              kind: 'body',
              utterances: [{ voice: 'host', text: 'Hello', pauseAfterMs: '400' }],
            },
          ],
        }),
        speakers
      )
    ).toThrow(ModelOutputValidationError);
  });

  it('rejects speakers that are not configured for the selected style', () => {
    expect(() =>
      parseModelScript(
        JSON.stringify({
          episodeTitle: 'Lesson',
          summary: '',
          segments: [
            {
              kind: 'body',
              utterances: [{ voice: 'narrator', text: 'Hello' }],
            },
          ],
        }),
        speakers
      )
    ).toThrow(/unconfigured speaker/i);
  });

  it('does not include raw model content in validation errors', () => {
    const secret = 'private-source-content';
    try {
      parseModelScript(`{"episodeTitle":"${secret}"`, speakers);
      throw new Error('expected parseModelScript to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
