const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED_PLATFORMS, validateReport } = require('../scripts/promote-voicelock-model');

function approvedReport() {
  return {
    approvedBy: 'responsável técnico',
    quality: { siSdrImprovementDb: 12, targetStoi: 0.94, speakerSwitches: 0 },
    runtime: { frameP95Ms: 4, latencyP95Ms: 48, realtimeFactor: 0.20 },
    platforms: Object.fromEntries(REQUIRED_PLATFORMS.map((name) => [name, true])),
    legal: { datasetsApproved: true, weightsOwned: true }
  };
}

test('release report aprovado passa por todos os gates', () => {
  assert.equal(validateReport(approvedReport()), true);
});

test('release report reprova desempenho lento', () => {
  const report = approvedReport();
  report.runtime.frameP95Ms = 8;
  assert.throws(() => validateReport(report), /p95 por frame/);
});

test('release report exige toda a matriz de hardware', () => {
  const report = approvedReport();
  report.platforms['android-entry'] = false;
  assert.throws(() => validateReport(report), /android-entry/);
});
