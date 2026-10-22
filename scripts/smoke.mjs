/**
 * Live smoke test: hit the real extractors, print what came back, and give the
 * prompt the model would receive. No API key and no model call.
 *
 *   node scripts/smoke.mjs https://www.bilibili.com/video/BV1Xdnc6jEbL
 *   BILI_COOKIE=... node scripts/smoke.mjs <url>       # also probe subtitles
 *
 * Exits non-zero when extraction fails, so it doubles as a connectivity check.
 */
import { extractEvidence, readTranscript } from '../lib/index.js';
import { buildEvidenceText, confidenceOf, describeBasis, evidenceKinds } from '../lib/evidence.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../lib/prompt.js';

const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/smoke.mjs <video-url>');
  process.exit(2);
}

try {
  const started = Date.now();
  const evidence = await extractEvidence(url, { cookie: process.env.BILI_COOKIE });
  const elapsed = Date.now() - started;
  const built = buildEvidenceText(evidence);

  console.log('title      :', evidence.title);
  console.log('platform   :', evidence.platform, '| author:', evidence.author || '-');
  console.log('duration   :', evidence.durationSeconds, 's | published:', evidence.publishedAt || '-');
  console.log('kinds      :', evidenceKinds(evidence).join(', ') || '(none)');
  console.log('confidence :', confidenceOf(evidence));
  console.log('basis      :', describeBasis(evidence));
  console.log('evidence   :', built.text.length, 'chars | transcript', built.transcriptChars, 'chars');
  console.log('warnings   :', evidence.warnings.length ? evidence.warnings.join(' | ') : '(none)');
  console.log('elapsed    :', elapsed, 'ms');

  const prompt = buildUserPrompt(evidence, {
    language: '简体中文',
    detail: 'standard',
    evidenceText: built.text,
  });
  console.log('\n--- prompt preview (first 1200 chars) ---');
  console.log(prompt.slice(0, 1200));
  console.log('--- system prompt is', SYSTEM_PROMPT.length, 'chars ---');

  const transcript = await readTranscript({ url, maxChars: 4_000 });
  console.log('\ntranscript :', transcript.hasTranscript ? `${transcript.cueCount} cues / ${transcript.chars} chars` : 'not available');
  if (!transcript.hasTranscript) console.log('  reasons  :', transcript.warnings.join(' | '));
} catch (error) {
  console.error('FAILED:', error.code ?? '', error.message, error.hint ? `\n提示：${error.hint}` : '');
  process.exit(1);
}
