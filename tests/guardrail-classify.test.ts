import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/llm.js')>();
  return {
    ...actual,
    getGuardrailLlm: vi.fn(() => ({
      withStructuredOutput: () => ({ invoke: invokeMock }),
    })),
  };
});

const { classifyRelatedToAudit } = await import('../src/agent/guardrail.js');

describe('classifyRelatedToAudit (mocked Groq)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('returns true without calling the model when user text is empty', async () => {
    const out = await classifyRelatedToAudit('   ');
    expect(out).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('returns false when structured output says unrelated', async () => {
    invokeMock.mockResolvedValueOnce({ related: false });
    const out = await classifyRelatedToAudit('how to bake bread');
    expect(out).toBe(false);
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it('returns true when structured output says related', async () => {
    invokeMock.mockResolvedValueOnce({ related: true });
    const out = await classifyRelatedToAudit('Is murabaha permissible in this structure?');
    expect(out).toBe(true);
  });
});
