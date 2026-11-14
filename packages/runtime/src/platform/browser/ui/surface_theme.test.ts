import { describe, expect, it } from 'vitest';
import type { UiEffect, UiLabelFrame } from '../../../core/index.js';
import { needsFeedbackTheme } from './surface.js';

const label: UiLabelFrame = { key: 1, text: 'Player', at: [0.5, 0.5], kind: 'quest' };
const toast = { kind: 'toast', text: 'hi', seconds: 2, viewport: null } as unknown as UiEffect;

describe('the feedback theme (ui/feedback.html)', () => {
  it('loads for world labels alone, so a label shown before any toast wears it', () => {
    expect(needsFeedbackTheme({ effects: [], labels: [label] })).toBe(true);
  });

  it('loads for toasts, announcements and floating text', () => {
    expect(needsFeedbackTheme({ effects: [toast], labels: [] })).toBe(true);
  });

  it('is not loaded for a frame with nothing it styles', () => {
    expect(needsFeedbackTheme({ effects: [], labels: [] })).toBe(false);
  });
});
