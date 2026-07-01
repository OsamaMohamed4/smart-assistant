// Scenario linter — flags things in a voice-agent prompt that commonly break
// Saudi-Arabic TTS or model behaviour, so a company editing its scenario sees
// the problem BEFORE it reaches a real call. Non-blocking: these are warnings,
// not hard errors. The worst offender is tashkeel (diacritics): "وَكَنْ" with
// harakat made ElevenLabs say "وكنسلاتيا".

// Only "manual full-vowelling" marks — fatha/damma/kasra/sukoon/superscript
// alef. We deliberately EXCLUDE tanwin (ً ٌ ٍ) and shadda (ّ) and tatweel (ـ),
// which are normal Arabic orthography ("أسعاراً", "يزوّدك") that TTS handles
// fine. It's names like "وَكَنْ" (fatha+fatha+sukoon) that break pronunciation.
const VOWEL_MARKS    = /[َُِْٰ]/g;
const WESTERN_DIGITS = /[0-9]/g;
const ARABIC_DIGITS  = /[٠-٩]/g;

// Remove {{variable}} placeholders so they don't trip the English/digit checks.
function stripPlaceholders(s) {
  return s.replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, ' ');
}

// Returns an array of { code, level: 'error'|'warn'|'info', message, ...meta }.
function lintScenario(text) {
  const warnings = [];
  if (!text || typeof text !== 'string') return warnings;
  const stripped = stripPlaceholders(text);

  // 1) Full-vowelling — the #1 cause of garbled company-name pronunciation.
  // Threshold of 3 skips normal orthography (a stray kasra like "استدعِ")
  // and only fires on deliberately-voweled words like "وَكَنْ".
  const dia = text.match(VOWEL_MARKS);
  if (dia && dia.length >= 3) {
    warnings.push({
      code: 'diacritics', level: 'error', count: dia.length,
      message: 'يوجد تشكيل كامل (حركات) على بعض الكلمات — يسبب نطقاً خاطئاً في الصوت (مثلاً "وَكَنْ" تُنطق غلط). اكتب الكلمات بدون تشكيل، خصوصاً اسم الشركة.',
    });
  }

  // 2) Numeric digits — should be spelled out for correct TTS.
  const digitCount = (stripped.match(WESTERN_DIGITS) || []).length
                   + (stripped.match(ARABIC_DIGITS) || []).length;
  if (digitCount > 0) {
    warnings.push({
      code: 'digits', level: 'warn', count: digitCount,
      message: 'يوجد أرقام رقمية — المحرك الصوتي قد ينطقها خطأ. اكتب الأرقام بالكلمات (مثال: 220 → مئتين وعشرين، 2,300,000 → مليونين وثلاثمائة ألف).',
    });
  }

  // 3) English words (outside {{placeholders}}) — odd pronunciation.
  // Allowlist tool/term names companies are *supposed* to write (endCall is
  // the hang-up tool; we even warn when it's missing in check 5).
  const ENGLISH_ALLOW = new Set(['endcall', 'whatsapp']);
  const eng = (stripped.match(/[A-Za-z]{2,}/g) || [])
    .filter((w) => !ENGLISH_ALLOW.has(w.toLowerCase()));
  if (eng.length) {
    warnings.push({
      code: 'english', level: 'info', count: eng.length,
      samples: [...new Set(eng)].slice(0, 6),
      message: 'توجد كلمات إنجليزية — قد تُنطق بشكل غريب في الصوت. استبدلها بالعربية إن أمكن.',
    });
  }

  // 4) No end-call instruction — agent may never hang up.
  if (!/endcall|end call|إنهاء المكالمة|أنهِ المكالمة|انهاء المكالمة|أقفل المكالمة/i.test(text)) {
    warnings.push({
      code: 'no_endcall', level: 'warn',
      message: 'لا توجد تعليمة لإنهاء المكالمة (endCall) — قد لا يقفل المساعد المكالمة تلقائياً بعد انتهاء الهدف.',
    });
  }

  return warnings;
}

module.exports = { lintScenario };
