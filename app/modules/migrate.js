/* =====================================================================
   FROM PANDORA DEE — a Pandora Dee backup's files land where Jade keeps hers.
   Pandora Dee (a fork of Jade Vault) keeps her own files in /Pandora and calls flows rituals:
     /Pandora/SOUL.md → /Jade/SOUL.md, /Pandora/Rituals/<name>.ritual.json → /Jade/Flows/<name>.flow.json
   Off until Config → App → Backup → "Pandora Dee backups" is on; then importing a Pandora Dee backup moves
   those paths (a /Jade file in the same backup wins), and settings that hold a path follow. Without it a
   Pandora Dee backup comes in as it is, with her files in /Pandora. Each move is listed in /Jade/Logs/migration.log.
   ===================================================================== */
const MIGRATION_LOG = '/Jade/Logs/migration.log';
function jadePath(p) {
  p = String(p);
  if (p !== '/Pandora' && !p.startsWith('/Pandora/')) return p;
  let rest = p.slice(8);
  if (rest === '/Rituals' || rest.startsWith('/Rituals/')) {
    rest = '/Flows' + rest.slice(8);
    if (rest.endsWith('.ritual.json')) rest = rest.slice(0, -'.ritual.json'.length) + '.flow.json';
  }
  return '/Jade' + rest;
}
const migrateRuns = runs => Array.isArray(runs) ? runs.map(r => r && typeof r.path === 'string' && jadePath(r.path) !== r.path ? { ...r, path: jadePath(r.path) } : r) : runs;
// on import, before anything is written
function migrateBackup(data) {
  const log = [];
  if (!S.pandoraImportOn) return log;
  const v = data.vault || {}, files = {};
  for (const [p, x] of Object.entries(v.files || {})) {
    const to = jadePath(p);
    if (to !== p) { log.push(`import: ${p} → ${to}`); if (to in (v.files || {})) continue; }   // a /Jade file in the same backup wins
    files[to] = x;
  }
  v.files = files;
  v.dirs = [...new Set((v.dirs || []).map(jadePath))].sort();
  for (const [k, val] of Object.entries(data.settings || {})) if (typeof val === 'string' && jadePath(val) !== val) { data.settings[k] = jadePath(val); log.push(`import: setting ${k} ${val} → ${data.settings[k]}`); }
  if (data.db?.flowRuns) data.db.flowRuns = migrateRuns(data.db.flowRuns);
  if (log.length) {
    log.push(`import: a Pandora Dee backup's files now live in /Jade`);
    // the restore replaces the vault, so the log rides along in the backup itself
    const at = new Date().toISOString().slice(0, 19).replace('T', ' '), prev = typeof files[MIGRATION_LOG] === 'string' ? files[MIGRATION_LOG] : '';
    files[MIGRATION_LOG] = prev + log.map(l => `${at} ${l}\n`).join('');
  }
  return log;
}
