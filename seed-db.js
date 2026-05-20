// Migrate file-based companies (companies/*.json + companies/<id>.kb.md) into SQLite.
// Idempotent: existing rows are updated rather than duplicated.
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { sql } = require('./db');

const DIR = path.join(__dirname, 'companies');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));

console.log(`Seeding DB from ${files.length} files...`);

for (const f of files) {
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const kbPath = path.join(DIR, `${cfg.id}.kb.md`);
  const kb = fs.existsSync(kbPath) ? fs.readFileSync(kbPath, 'utf8') : null;

  const existing = sql.getCompany.get(cfg.id);
  const row = {
    id            : cfg.id,
    name          : cfg.name,
    language      : cfg.language || 'ar-SA',
    voice_id      : cfg.voice_id || process.env.ELEVENLABS_VOICE_ID || null,
    phone_number  : cfg.phone_number || null,
    assistant_id  : existing?.assistant_id || null,
    system_prompt : cfg.systemPrompt,
    kb_text       : kb,
  };

  if (existing) {
    sql.updateCompany.run(row);
    console.log(`   updated: ${cfg.id} | ${cfg.name}`);
  } else {
    sql.insertCompany.run(row);
    console.log(`   created: ${cfg.id} | ${cfg.name}`);
  }
}

console.log('Companies in DB:');
sql.listCompanies.all().forEach((c) => {
  console.log(`   ${c.id.padEnd(15)} | ${c.name.padEnd(30)} | voice: ${c.voice_id || '-'} | phone: ${c.phone_number || '-'}`);
});
