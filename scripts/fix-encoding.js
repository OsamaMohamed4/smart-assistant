#!/usr/bin/env node
// Fix "mojibake" Arabic text files — i.e. UTF-8 bytes that were decoded as
// Latin1 and re-saved (so "العنوان" shows as "Ø§ÙØ¹ÙÙØ§Ù").
//
// This is an EXACT byte-level reversal — it never guesses or rewrites content,
// so prices, neighborhood names, and numbers stay 100% faithful to your file.
//
// Usage:
//   node scripts/fix-encoding.js file1.md file2.md ...
//   node scripts/fix-encoding.js ./folder        (fixes every .md/.txt inside)
//
// For each input it writes "<name>.fixed.<ext>" next to the original.
// Your originals are never modified.

const fs = require('fs');
const path = require('path');

function looksMojibake(s) {
  // Arabic UTF-8 bytes shown as Latin1 are dominated by Ø (0xD8) and Ù (0xD9)
  // lead bytes. If those vastly outnumber real Arabic chars, it's mojibake.
  const markers = (s.match(/[ØÙ]/g) || []).length;
  const arabic  = (s.match(/[؀-ۿ]/g) || []).length;
  return markers > 10 && markers > arabic;
}

function fixOne(inPath) {
  const raw = fs.readFileSync(inPath, 'utf8');
  const ext = path.extname(inPath);
  const outPath = inPath.slice(0, -ext.length || undefined) + '.fixed' + ext;

  if (!looksMojibake(raw)) {
    console.log(`• ${path.basename(inPath)} — looks fine already, copied unchanged.`);
    fs.writeFileSync(outPath, raw, 'utf8');
    return;
  }
  // latin1 → original UTF-8 bytes → write raw. This is the exact inverse of the
  // corruption (UTF-8 → latin1 string → UTF-8 file).
  const fixed = Buffer.from(raw, 'latin1');
  fs.writeFileSync(outPath, fixed);
  console.log(`✓ ${path.basename(inPath)} → ${path.basename(outPath)}  (fixed)`);
}

function collect(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    return fs.readdirSync(target)
      .filter((f) => /\.(md|txt)$/i.test(f) && !/\.fixed\./i.test(f))
      .map((f) => path.join(target, f));
  }
  return [target];
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node scripts/fix-encoding.js <file-or-folder> [more files...]');
  process.exit(1);
}
const files = args.flatMap(collect);
if (!files.length) { console.error('No .md/.txt files found.'); process.exit(1); }
for (const f of files) {
  try { fixOne(f); } catch (e) { console.error(`✗ ${f}: ${e.message}`); }
}
console.log(`\nDone. Upload the *.fixed.md files to وكن → قاعدة المعرفة.`);
