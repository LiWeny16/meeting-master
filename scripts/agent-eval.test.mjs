import assert from 'node:assert/strict';
import test from 'node:test';
import { cases, grade, unsupportedRelativeFriday } from './agent-eval.mjs';

function run(overrides = {}) {
  return { done: true, error: null, answer: 'Alice said Friday [eval-segment-1].', tools: [{ name: 'search_transcript', argumentsValid: true }], textChunks: 3, firstTextMs: 1, modelRequests: 2, ...overrides };
}

test('meeting evidence requires a relevant tool and segment citation', () => {
  assert.equal(grade(cases[0], run()).passed, true);
  assert.equal(grade(cases[0], run({ tools: [] })).passed, false);
  assert.equal(grade(cases[0], run({ answer: 'Alice said Friday.' })).passed, false);
  assert.equal(grade(cases[0], run({ answer: 'Alice said Monday [eval-segment-1].' })).passed, false);
});

test('invalid arguments, unexpected tools, errors and missing stream fail the case', () => {
  for (const change of [
    { tools: [{ name: 'search_transcript', argumentsValid: false }] },
    { tools: [{ name: 'save_meeting_summary', argumentsValid: true }] },
    { error: 'unavailable' },
    { textChunks: 0 },
    { done: false },
  ]) assert.equal(grade(cases[0], run(change)).passed, false);
});

test('unknown and selected-text cases check the expected outcome independently', () => {
  assert.equal(grade(cases[1], run({ answer: 'The budget was not discussed.' })).passed, true);
  assert.equal(grade(cases[1], run({ answer: 'The budget was $9,000.' })).passed, false);
  assert.equal(grade(cases[2], run({ answer: 'The deadline is the finish date.', tools: [] })).passed, true);
  assert.equal(grade(cases[2], run({ answer: 'The deadline is the finish date.' })).passed, false);
});

test('Friday alone does not establish which week; explicit uncertainty is allowed', () => {
  for (const text of ['Alice said this coming Friday [eval-segment-1].', 'Launch is next Friday.', 'Launch is Friday this week.', '会议将在这周五上线。']) {
    assert.equal(unsupportedRelativeFriday(text), true, text);
  }
  for (const text of ['Alice said Friday [eval-segment-1].', 'The transcript does not say whether this coming Friday was meant.', 'It is unclear whether it is next Friday.', '无法确定是不是这周五。']) {
    assert.equal(unsupportedRelativeFriday(text), false, text);
  }
  assert.equal(unsupportedRelativeFriday('The date is unclear, but it is next Friday.'), true);
  assert.equal(grade(cases[0], run({ answer: 'Alice said this coming Friday [eval-segment-1].' })).passed, false);
});
