/* =====================================================================
   ENHANCED — the switches for what this build adds from Pandora Dee 2.9.9.2. Every one starts off, so
   Jade Vault looks and works as before until one is turned on in Config (Appearance, or App → Note tools).
   ===================================================================== */
const IMPORT_ACCEPT = { plain: '.md,.markdown,.txt,text/markdown,text/plain', apps: '.md,.markdown,.txt,.zip,.json,.html,.htm,.docx,.pdf,.sdocx,text/markdown,text/plain,text/html,application/zip,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const ENH_KEYS = [['sRoomyOn', 'roomyOn'], ['sDragScrollOn', 'dragScrollOn'], ['sTidyOn', 'tidyOn'], ['sFindOn', 'findOn'], ['sNotesImportOn', 'notesImportOn'], ['sPandoraImportOn', 'pandoraImportOn'], ['sNoFollow', 'noFollow'], ['sNoScanlines', 'noScanlines'], ['sNoCyberGrid', 'noCyberGrid']];
const applyLook = () => { document.body.classList.toggle('no-scanlines', !!S.noScanlines); document.body.classList.toggle('no-cybergrid', !!S.noCyberGrid); document.body.classList.toggle('dragscroll', !!S.dragScrollOn); };
/** what is visible follows the switches */
function enhApply() {
  applyLook();
  if (typeof layoutApply === 'function') layoutApply();
  for (const id of ['btnFileRename', 'btnTidy']) { const b = document.getElementById(id); if (b) b.hidden = !S.tidyOn; }
  const fb = document.getElementById('btnFind'); if (fb) fb.hidden = !S.findOn;
  if (!S.findOn && document.getElementById('findBar') && !document.getElementById('findBar').hidden) closeFind();
  const up = document.getElementById('upload'), lab = document.querySelector('label[for="upload"]');
  if (up) up.accept = S.notesImportOn ? IMPORT_ACCEPT.apps : IMPORT_ACCEPT.plain;
  if (lab) lab.title = S.notesImportOn ? 'Import notes: markdown or text, or notes from Google Keep (Takeout .zip), Samsung Notes (Word, PDF, text) and Apple Notes (iCloud .zip, PDF), and HTML' : 'Import markdown files';
  if (typeof DRAG_STRIPS !== 'undefined') document.querySelectorAll(DRAG_STRIPS).forEach(el => dragScrollEdges(el));
  try { renderTree(); } catch {}
}
function enhFillSettings() { for (const [id, k] of ENH_KEYS) { const e = document.getElementById(id); if (e) e.checked = !!S[k]; } }
function enhReadSettings() { const o = {}; for (const [id, k] of ENH_KEYS) { const e = document.getElementById(id); if (e) o[k] = e.checked; } return o; }
// Import and drops: with the notes-app importer off, every file is copied in as before
const importOrUpload = files => (S.notesImportOn ? importAny : uploadFiles)(files);
Object.assign(window, { enhApply, enhFillSettings, enhReadSettings, applyLook, importOrUpload });
