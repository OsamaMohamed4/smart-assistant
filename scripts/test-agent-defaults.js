// The reference agent's settings as every company's default, and the one-time
// reset of the tuning saved before it (lib/agent-defaults.js).
//
//   node --test scripts/test-agent-defaults.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AGENT_DEFAULTS, AGENT_MODELS, TUNING_KEYS,
  resolveAgentModel, resolveVoiceTuning, textChannelModel, stripTuning,
} = require('../lib/agent-defaults');

test('the default model is Gemini, the reference agent\'s', () => {
  assert.equal(AGENT_DEFAULTS.model, 'gemini-3.5-flash-lite');
  assert.ok(AGENT_MODELS.includes(AGENT_DEFAULTS.model), 'the default must also be selectable');
  assert.deepEqual(resolveAgentModel({}), { model: 'gemini-3.5-flash-lite', temperature: 0.2, maxTokens: 120 });
  assert.deepEqual(resolveAgentModel(undefined), resolveAgentModel({}));
});

test('a company\'s own model choice wins; an unknown one does not', () => {
  assert.equal(resolveAgentModel({ model: 'gpt-4.1' }).model, 'gpt-4.1');
  assert.equal(resolveAgentModel({ model: 'gemini-3.1-flash-lite' }).model, 'gemini-3.1-flash-lite');
  assert.equal(resolveAgentModel({ model: 'made-up-model' }).model, 'gemini-3.5-flash-lite');
  assert.equal(resolveAgentModel({ temperature: 5 }).temperature, 1, 'clamped, not trusted');
  assert.equal(resolveAgentModel({ maxTokens: 10 }).maxTokens, 50);
});

test('voice tuning: defaults, overrides, and -1 surviving the clamp', () => {
  assert.deepEqual(resolveVoiceTuning({}), {
    stability: 0.55, similarityBoost: 0.75, voiceSpeed: 1, ttsModel: 'eleven_v4',
    expressiveMode: true, idleTimeoutSeconds: 6, silenceTimeoutSeconds: -1, interruptibleGreeting: true,
  });
  const own = resolveVoiceTuning({
    stability: 0.8, voiceSpeed: 1.1, ttsModel: 'eleven_turbo_v2_5', expressiveMode: false,
    turnTimeoutSeconds: 15, silenceEndCallSeconds: 30,
  });
  assert.equal(own.stability, 0.8);
  assert.equal(own.voiceSpeed, 1.1);
  assert.equal(own.ttsModel, 'eleven_turbo_v2_5');
  assert.equal(own.expressiveMode, false, 'an explicit false is a choice, not a missing value');
  assert.equal(own.idleTimeoutSeconds, 15);
  assert.equal(own.silenceTimeoutSeconds, 30);
  assert.equal(resolveVoiceTuning({ silenceEndCallSeconds: -1 }).silenceTimeoutSeconds, -1);
  assert.equal(resolveVoiceTuning({ voiceSpeed: 3 }).voiceSpeed, 1.2, 'clamped to the provider range');
});

test('text runs the agent\'s model when OpenAI has it, a stand-in when it does not', () => {
  // Playground chat, the public Agent API and the scenario tester call OpenAI
  // directly; sending it a Gemini model id fails every message.
  assert.equal(textChannelModel('gpt-4.1-mini'), 'gpt-4.1-mini');
  assert.equal(textChannelModel('gemini-3.5-flash-lite'), 'gpt-4.1');
  assert.equal(textChannelModel('gemini-3.1-flash-lite'), 'gpt-4.1');
  assert.equal(textChannelModel(undefined), 'gpt-4.1');
});

test('the reset removes tuning and keeps the company\'s own business', () => {
  const stored = JSON.stringify({
    model: 'gpt-4.1', temperature: 0.3, maxTokens: 300, stability: 0.65, similarityBoost: 0.8,
    voiceSpeed: 1.2, ttsModel: 'eleven_turbo_v2_5', expressiveMode: false,
    turnTimeoutSeconds: 15, silenceEndCallSeconds: 30,
    voiceId: 'yXEnnEln9armDCyhkXcA', transferPhoneNumber: '+966500000000',
    webhookUrl: 'https://hooks.example.com/x', webhookSecret: 's', dailyOutboundCap: 50,
  });
  const { settings, removed } = stripTuning(stored);
  assert.deepEqual(JSON.parse(settings), {
    voiceId: 'yXEnnEln9armDCyhkXcA', transferPhoneNumber: '+966500000000',
    webhookUrl: 'https://hooks.example.com/x', webhookSecret: 's', dailyOutboundCap: 50,
  });
  assert.deepEqual(Object.keys(removed).sort(), [...TUNING_KEYS].sort());
  assert.equal(removed.model, 'gpt-4.1', 'what was removed is reported, so it can be logged');
});

test('the reset leaves untouched anything it has nothing to do with', () => {
  assert.deepEqual(stripTuning(JSON.stringify({ voiceId: 'v' })), { settings: '{"voiceId":"v"}', removed: null });
  assert.deepEqual(stripTuning(null), { settings: null, removed: null });
  assert.deepEqual(stripTuning(''), { settings: '', removed: null });
  assert.deepEqual(stripTuning('not json'), { settings: 'not json', removed: null }, 'never destroys what it cannot read');
  assert.deepEqual(stripTuning('[1,2]'), { settings: '[1,2]', removed: null });
});
