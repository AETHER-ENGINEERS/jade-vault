# Jade Vault enhanced: run by build.py (exec, so rep/rd/s are build.py's) after every other step.
# Pandora Dee 2.9.9.2's extras, ported with Jade Vault's words: roomy layout, text size, drag to scroll, rename &
# tidy, find & replace, importing from notes apps, Pandora Dee backups, and an Appearance tab. Every new switch
# starts off; until one is on, Jade Vault looks and works as before.

rep("const DEFAULTS = { toolRouter: 'auto',", "const DEFAULTS = { roomyOn: false, uiScale: 1, uiWidth: 0, uiTreeW: 0, uiStageW: 0, uiStageH: 0, uiEdSplit: 0, dragScrollOn: false, tidyOn: false, findOn: false, notesImportOn: false, pandoraImportOn: false, noFollow: false, noScanlines: false, noCyberGrid: false, toolRouter: 'auto',")
for m in ('layout.js', 'dragscroll.js', 'tidy.js', 'findbar.js', 'notes_import.js', 'migrate.js', 'enhanced.js'):
    s = s.replace('/* =====================================================================\n   BOOT', rd(m) + '\n/* =====================================================================\n   BOOT', 1)
rep("  await applyPendingSettings();\n", "  await applyPendingSettings();\n  layoutInit(); dragScrollInit(); findInit();\n  $('#btnFileRename').onclick = () => editing && renameLeaf(editing); $('#btnTidy').onclick = () => tidyWorkshops();\n  enhApply();\n")
rep("  $('#sCompactAuto').checked = !!S.compactAuto;", "  enhFillSettings();\n  $('#sCompactAuto').checked = !!S.compactAuto;")
rep("  Object.assign(S, { jadeShow: $('#sJadeShow').checked,", "  Object.assign(S, enhReadSettings());\n  Object.assign(S, { jadeShow: $('#sJadeShow').checked,")
rep("saveSettings(); apiApply(); bgSync();", "saveSettings(); enhApply(); apiApply(); bgSync();")
rep("Object.assign(window, { DC,", "Object.assign(window, { layoutApply, layoutInit, uiZoom, migrateBackup, jadePath, MIGRATION_LOG, renderTree, openDirs, treeMenu, renameLeaf, renameWorkshop, deleteWorkshop, tidyWorkshops, openFind, closeFind, findGo, findReplace, findReplaceAll, Find, importNotes, importAny, htmlToMd, docxToMd, DC,")

# ---------- roomy layout and text size (layout.js) ----------
rep("  document.body.dataset.screen = name;\n", "  document.body.dataset.screen = name; if (typeof layoutPanes === 'function') layoutPanes();\n")
# the app's height in CSS px of the zoomed page (text size zooms the whole page; no change at 100 %)
rep("const h = vv ? vv.height : innerHeight; root.style.setProperty('--vvh', h + 'px');", "const h = vv ? vv.height : innerHeight; root.style.setProperty('--vvh', (h / (+root.style.zoom || 1)) + 'px');")
rep('[hidden]{display:none!important}\n', '[hidden]{display:none!important}\n' + """/* ---- roomy layout (layout.js): all of it under body.roomy, which only Config → Appearance turns on ---- */
body:not(.roomy) .ui-handle{display:none!important}
body.roomy{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body.roomy #app{max-width:var(--app-w,560px);padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)}
body.roomy .modal-bg>.frame{max-width:min(var(--app-w,560px),920px)!important}
/* iOS Safari zooms into any field under 16px (on screen, so after the text size) when it gets focus */
@media (pointer:coarse){ html[style*=zoom] :is(textarea,input,select):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]){font-size:max(calc(16px / var(--ui-zoom,1)),1em)!important} }
body.roomy .ui-handle{position:absolute;z-index:20;touch-action:none}
body.roomy .ui-handle::after{content:'';position:absolute;background:var(--yl);opacity:0;transition:opacity .15s}
body.roomy .ui-handle:hover::after,body.roomy .ui-handle.dragging::after{opacity:.9}
body.ui-dragging,body.ui-dragging *{-webkit-user-select:none!important;user-select:none!important}
body.ui-dragging .jade-stage{transition:none}
@media (pointer:coarse){body.roomy .ui-handle::after{opacity:.35}}
body.roomy .ui-app-left,body.roomy .ui-app-right{display:none;top:0;bottom:0;width:12px;cursor:ew-resize}
body.roomy .ui-app-left{left:-12px} body.roomy .ui-app-right{right:-12px}
body.roomy .ui-app-left::after,body.roomy .ui-app-right::after{top:0;bottom:0;left:5px;width:2px}
body.roomy.room .ui-app-left,body.roomy.room .ui-app-right{display:block}
/* wide: Notes shows the list beside the open note */
body.roomy .ui-tree{display:none;top:0;bottom:0;left:calc(var(--tree-w) - 5px);width:10px;cursor:ew-resize}
body.roomy .ui-tree::after{top:0;bottom:0;left:4px;width:2px}
body.roomy.wide:is([data-screen=files],[data-screen=file]) .ui-tree{display:block}
body.roomy.wide:is([data-screen=files],[data-screen=file]) .m-screens [data-panel=files]{right:auto;width:var(--tree-w);border-right:1px solid var(--line)}
body.roomy.wide:is([data-screen=files],[data-screen=file]) .m-screens [data-panel=file]{left:var(--tree-w)}
body.roomy.wide [data-panel=files]>.m-sub{flex-wrap:wrap;row-gap:6px}
body.roomy.wide [data-panel=files]>.m-sub .pane-h{flex:1 0 auto}
/* wide: Jade beside the conversation (when she is shown full size) */
body.roomy.wide #app:not(.jade-hidden):not(.jade-compact) [data-panel=chat]:not([hidden]){display:grid;grid-template-columns:var(--stage-w) minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto}
body.roomy.wide #app:not(.jade-hidden):not(.jade-compact) [data-panel=chat]>.jade-stage{grid-column:1;grid-row:1/-1;height:auto;border-right:1px solid var(--line)}
body.roomy.wide #app:not(.jade-hidden):not(.jade-compact) [data-panel=chat]>:not(.jade-stage):not(.ui-handle){grid-column:2}
body.roomy .ui-stage{display:none;top:0;bottom:0;left:calc(var(--stage-w) - 5px);width:10px;cursor:ew-resize}
body.roomy .ui-stage::after{top:0;bottom:0;left:4px;width:2px}
body.roomy.wide #app:not(.jade-hidden):not(.jade-compact) .ui-stage{display:block}
/* a phone: Jade's height, dragged from the bottom edge of her stage */
body.roomy:not(.kb) #app:not(.jade-compact) .jade-stage{height:var(--stage-h,clamp(150px,30vh,300px))}
body.roomy .ui-stage-h{left:0;right:0;bottom:0;height:16px;cursor:ns-resize}
body.roomy .ui-stage-h::after{left:calc(50% - 28px);width:56px;bottom:4px;height:3px;border-radius:2px}
body.roomy.wide .ui-stage-h,body.roomy #app.jade-compact .ui-stage-h,body.roomy.kb .ui-stage-h{display:none}
/* the editor's Split mode: stacked on a phone, side by side when wide, with a divider between */
body.roomy .ui-ed{display:none;position:relative;flex:none;height:10px;cursor:ns-resize}
body.roomy .ui-ed::after{left:0;right:0;top:4px;height:2px;opacity:.55;background:var(--line-hot)}
body.roomy .note-body[data-mode=split] .ui-ed{display:block}
body.roomy #app .note-body[data-mode=split] textarea{flex:0 0 calc(var(--ed-split,.45) * 100%);border-bottom:0}
body.roomy #app .note-body[data-mode=split] .note-prev{flex:1 1 0}
body.roomy.wide .note-body[data-mode=split]{flex-direction:row}
body.roomy.wide .note-body[data-mode=split] .ui-ed{height:auto;width:10px;cursor:ew-resize}
body.roomy.wide .note-body[data-mode=split] .ui-ed::after{left:4px;right:auto;top:0;bottom:0;width:2px;height:auto}
body.roomy.kb .note-body .ui-ed{display:none}
""")

# ---------- drag to scroll (dragscroll.js): a strip only changes once the switch is on ----------
rep("""      <div class="m-sub" style="border-top:1px solid var(--line);border-bottom:0">
        <button class="btn btn-ghost" id="btnLinks" hidden>Links</button>""", """      <div class="m-sub" id="noteFoot" style="border-top:1px solid var(--line);border-bottom:0">
        <button class="btn btn-ghost" id="btnLinks" hidden>Links</button>""")
rep("const DRAG_STRIPS = '.qk, .tag-bar, #noteFoot, #setTabs';", "const DRAG_STRIPS = '.qk, .tag-bar, #noteFoot, #leavesFoot, #setTabs';")
rep('[hidden]{display:none!important}\n', '[hidden]{display:none!important}\n' + """/* ---- drag to scroll (dragscroll.js) ---- */
body.dragscroll :is(#noteFoot,#leavesFoot){overflow-x:auto;scrollbar-width:none}
body.dragscroll :is(#noteFoot,#leavesFoot)::-webkit-scrollbar{display:none}
body.dragscroll :is(#noteFoot,#leavesFoot)>.btn{flex:none}
.can-drag{cursor:grab}
.can-drag.dragging,.can-drag.dragging *{cursor:grabbing;-webkit-user-select:none;user-select:none}
.more-r{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent)}
.more-l{-webkit-mask-image:linear-gradient(90deg,transparent,#000 28px);mask-image:linear-gradient(90deg,transparent,#000 28px)}
.more-l.more-r{-webkit-mask-image:linear-gradient(90deg,transparent,#000 28px,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(90deg,transparent,#000 28px,#000 calc(100% - 28px),transparent)}
""")

# ---------- rename & tidy (tidy.js): the buttons and the ⋯ on each row appear with the switch ----------
rep("""        <button class="btn btn-ghost" id="btnFileCopy">Copy</button>""", """        <button class="btn btn-ghost" id="btnFileRename" hidden>Rename</button>
        <button class="btn btn-ghost" id="btnFileCopy">Copy</button>""")
rep("""        <div class="hud flex-1 min-w-0 truncate" id="fsStats">—</div>
        <button class="btn btn-ghost" id="btnNewDir" title="New folder">+ Folder</button>""", """        <div class="hud flex-1 min-w-0 truncate" id="fsStats">—</div>
        <button class="btn btn-ghost" id="btnNewDir" title="New folder">+ Folder</button>
        <button class="btn btn-ghost" id="btnTidy" title="Remove every empty folder" hidden>Tidy</button>""")
_i = s.index('id="fsStats">—</div>'); _j = s.rindex('<div class="m-sub"', 0, _i)
s = s[:_j] + '<div class="m-sub" id="leavesFoot"' + s[_j + len('<div class="m-sub"'):]
rep("""<span class="${dir ? 'text-yl' : note ? '' : 'text-dim'} truncate">${esc(note ? noteName(q) : n)}${dir ? '/' : ''}</span>${right}</div>`);""",
    """<span class="${dir ? 'text-yl' : note ? '' : 'text-dim'} truncate">${esc(note ? noteName(q) : n)}${dir ? '/' : ''}</span>${right}${S.tidyOn ? `<button type="button" class="tree-more" data-more="${esc(q)}" aria-label="More for ${esc(note ? noteName(q) : n)}" title="Rename, delete">⋯</button>` : ''}</div>`);""")
rep("$('#tree').addEventListener('click', e => { const r = e.target.closest('.tree-row');", "$('#tree').addEventListener('click', e => { const more = e.target.closest('.tree-more'); if (more) { e.stopPropagation(); return treeMenu(more.dataset.more); } const r = e.target.closest('.tree-row');")
rep('[hidden]{display:none!important}\n', '[hidden]{display:none!important}\n' + """/* ---- rename & tidy (tidy.js) ---- */
.tree-more{flex:none;margin-left:2px;width:30px;height:26px;line-height:1;border:0;background:none;color:var(--dim);font-size:16px;opacity:.35;cursor:pointer}
.tree-row:hover .tree-more,.tree-row:focus-within .tree-more,.tree-more:focus-visible{opacity:1}
.tree-more:hover{color:var(--yl)}
@media (pointer:coarse){.tree-more{opacity:.7;width:36px;height:32px}}
""")

# ---------- find & replace (findbar.js): 🔍 and Ctrl/Cmd+F only with the switch ----------
rep("""      <div class="note-body" id="noteBody" data-mode="read">""", """      <div class="find-bar" id="findBar" role="search" aria-label="Find in this note" hidden>
        <div class="find-row">
          <button type="button" class="find-btn" id="findToggle" title="Show or hide replace" aria-label="Show or hide replace">⇅</button>
          <input id="findQ" class="field" placeholder="Find in this note" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Find">
          <span class="find-count mono" id="findCount" aria-live="polite"></span>
          <button type="button" class="find-btn" id="findCase" aria-pressed="false" title="Match case" aria-label="Match case">Aa</button>
          <button type="button" class="find-btn" id="findRe" aria-pressed="false" title="Regular expression" aria-label="Regular expression">.*</button>
          <button type="button" class="find-btn" id="findPrev" title="Previous (Shift+Enter)" aria-label="Previous match">↑</button>
          <button type="button" class="find-btn" id="findNext" title="Next (Enter)" aria-label="Next match">↓</button>
          <button type="button" class="find-btn" id="findClose" title="Close (Esc)" aria-label="Close find">✕</button>
        </div>
        <div class="find-row find-rep">
          <input id="findR" class="field" placeholder="Replace with" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" aria-label="Replace with">
          <button type="button" class="btn btn-ghost" id="findOne" title="Replace this match (Enter)">Replace</button>
          <button type="button" class="btn btn-ghost" id="findAll" title="Replace every match (Ctrl/Cmd+Enter)">All</button>
        </div>
      </div>
      <div class="note-body" id="noteBody" data-mode="read">""")
rep("  setSaveState('');\n", "  setSaveState(''); if (typeof findRefresh === 'function') findRefresh();\n")
rep('[hidden]{display:none!important}\n', '[hidden]{display:none!important}\n' + """/* ---- find & replace (findbar.js) ---- */
.find-bar{flex:none;display:flex;flex-direction:column;gap:6px;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--panel)}
.find-row{display:flex;align-items:center;gap:4px;min-width:0}
.find-row .field{flex:1 1 auto;min-width:0;padding:6px 8px}
.find-rep{display:none}
.find-bar.with-replace .find-rep{display:flex}
.find-btn{flex:none;min-width:32px;height:32px;padding:0 6px;border:1px solid var(--line);background:transparent;color:var(--dim);font-family:var(--f-mono);font-size:12px;cursor:pointer}
.find-btn:hover{color:var(--fg)}
.find-btn[aria-pressed=true]{color:var(--yl);border-color:var(--yl)}
.find-bar.with-replace #findToggle{color:var(--yl)}
.find-count{flex:none;font-size:11px;color:var(--dim);min-width:4.5em;text-align:right;white-space:nowrap}
#findQ.bad{border-color:var(--rd)}
""")

# ---------- import from notes apps (notes_import.js) and Pandora Dee backups (migrate.js) ----------
rep("$('#upload').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };", "$('#upload').onchange = e => { importOrUpload(e.target.files); e.target.value = ''; };")
rep("if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });", "if (e.dataTransfer.files.length) importOrUpload(e.dataTransfer.files); });")
rep("  if (data?.app !== 'jade-vault' || !data.vault) { toast('That is not a Jade Vault backup.', 'err'); return; }\n", "  if (data?.app !== 'jade-vault' || !data.vault) { toast('That is not a Jade Vault backup.', 'err'); return; }\n  const moved = migrateBackup(data);   // with the switch on, a Pandora Dee backup's /Pandora files land in /Jade\n  if (moved.length) toast(`From Pandora Dee: ${moved.length - 1} path${moved.length === 2 ? '' : 's'} moved to Jade's places (see ${MIGRATION_LOG})`, 'ok');\n")

# ---------- the look: her colours get a tab, and the cyberpunk touches can be hidden ----------
# Live2D draws with the GL texture it was first given, so a recoloured texture has to be uploaded again
rep("    state.appearanceTexture?.baseTexture?.update();\n", "    state.appearanceTexture?.baseTexture?.update();\n    // the model draws with the GL texture it was first given, so upload the new pixels to it now\n    try { if (state.app && state.appearanceTexture) state.app.renderer.texture.bind(state.appearanceTexture.baseTexture); } catch (e) { console.warn('Jade appearance upload failed', e); }\n")
rep("    else if (now - state.pointer.t < 4000) {", "    else if (!S.noFollow && now - state.pointer.t < 4000) {")
rep('body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:60;', 'body:not(.no-scanlines)::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:60;')
rep('[hidden]{display:none!important}\n', '[hidden]{display:none!important}\n' + """/* ---- no cyber grid: she stands in a soft pool of her gem's light instead ---- */
body.no-cybergrid::before{background:radial-gradient(1200px 600px at 85% -10%,rgba(var(--theme-rgb),.10),transparent 60%),radial-gradient(900px 500px at -10% 110%,rgba(var(--theme-highlight-rgb),.06),transparent 60%)}
body.no-cybergrid .jade-stage::before{left:0;right:0;height:46%;transform:none;-webkit-mask-image:none;mask-image:none;
  background:radial-gradient(ellipse 46% 34% at 50% 100%,rgba(var(--theme-rgb),.26),transparent 72%),radial-gradient(ellipse 80% 50% at 50% 110%,rgba(var(--theme-highlight-rgb),.10),transparent 70%)}
/* layer colour cards: the label above a full-width menu, so it fits at any text size */
.jade-appearance-card .appearance-field{flex-direction:column;align-items:stretch}
.jade-appearance-card .appearance-field .field{width:100%}
""")
rep("const SET_TABS = ['model', 'memory', 'tools', 'connect', 'app'];", "const SET_TABS = ['model', 'memory', 'tools', 'connect', 'look', 'app'];")
rep('data-tab="connect" aria-selected="false">Connect</button>', 'data-tab="connect" aria-selected="false">Connect</button><button type="button" role="tab" class="set-tab" data-tab="look" aria-selected="false">Appearance</button>')
rep("""      <section data-tab="app" class="flex flex-col gap-3">
        <div class="pane-h">Jade companion</div>
        <div><div class="lbl">Jade's gemstone theme</div>""", """      <section data-tab="look" class="flex flex-col gap-3">
        <div class="pane-h">Jade's colors</div>
        <div><div class="lbl">Jade's gemstone theme</div>""")
rep("""
        <div class="grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
          <label class="flex items-center gap-2 text-sm" for="sJadeShow">""", """
      </section>
      <section data-tab="look" class="flex flex-col gap-3">
        <div class="pane-h">Atmosphere</div>
        <div class="grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
          <label class="flex items-center gap-2 text-sm" for="sNoFollow"><input type="checkbox" id="sNoFollow" class="accent-emerald-400 w-4 h-4"> Her eyes stay still (do not follow the pointer)</label>
          <label class="flex items-center gap-2 text-sm" for="sNoScanlines"><input type="checkbox" id="sNoScanlines" class="accent-emerald-400 w-4 h-4"> Hide the scanlines over the screen</label>
          <label class="flex items-center gap-2 text-sm" for="sNoCyberGrid"><input type="checkbox" id="sNoCyberGrid" class="accent-emerald-400 w-4 h-4"> Hide the cyber grid (a soft glow of her gem instead)</label>
        </div>
        <p class="hint leading-relaxed">From Pandora Dee's fantasy look. Saved when you press Save.</p>
      </section>
      <section data-tab="look" class="flex flex-col gap-3">
        <div class="pane-h">Text &amp; layout</div>
        <div><label class="lbl" for="sUiScale">Text size</label><select id="sUiScale" class="field mt-1"></select><div class="hint mt-1">Scales the whole interface, on this device.</div></div>
        <label class="flex items-center gap-2 text-sm" for="sRoomyOn"><input type="checkbox" id="sRoomyOn" class="accent-emerald-400 w-4 h-4"> Roomy layout: use the space on a wide screen</label>
        <p class="hint leading-relaxed">With room to spare the app widens; drag the handles beside it to set its width. When it is wide, Notes shows the list beside the open note and Chat puts Jade beside the conversation, each with a divider to drag. The editor's Split mode and Jade's height (on a phone) drag too. Double-click a handle to reset it. Your layout is kept with your settings.</p>
        <label class="flex items-center gap-2 text-sm" for="sDragScrollOn"><input type="checkbox" id="sDragScrollOn" class="accent-emerald-400 w-4 h-4"> Drag to scroll: strips of buttons (the formatting bar, tags, a note's footer, these tabs) move with the mouse or the wheel</label>
        <div><button type="button" class="btn" id="btnUiReset">Reset layout</button></div>
      </section>
      <section data-tab="app" class="flex flex-col gap-3">
        <div class="pane-h">Note tools</div>
        <label class="flex items-center gap-2 text-sm" for="sFindOn"><input type="checkbox" id="sFindOn" class="accent-emerald-400 w-4 h-4"> Find &amp; replace in the editor (🔍 on the formatting bar, Ctrl/Cmd+F, Ctrl+H)</label>
        <label class="flex items-center gap-2 text-sm" for="sTidyOn"><input type="checkbox" id="sTidyOn" class="accent-emerald-400 w-4 h-4"> Rename &amp; tidy: rename notes and folders (links follow), delete empty folders, Tidy removes them all</label>
        <label class="flex items-center gap-2 text-sm" for="sNotesImportOn"><input type="checkbox" id="sNotesImportOn" class="accent-emerald-400 w-4 h-4"> Import from notes apps: Google Keep (Takeout .zip), Samsung Notes, Apple Notes (iCloud .zip), HTML, Word and PDF, with Import or by dropping files</label>
        <label class="flex items-center gap-2 text-sm" for="sPandoraImportOn"><input type="checkbox" id="sPandoraImportOn" class="accent-emerald-400 w-4 h-4"> Pandora Dee backups: when importing one, move her /Pandora files to Jade's places (rituals become flows)</label>
        <p class="hint leading-relaxed">From Pandora Dee. Saved when you press Save.</p>
      </section>
      <section data-tab="app" class="flex flex-col gap-3">
        <div class="pane-h">Jade companion</div>
        <div class="grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
          <label class="flex items-center gap-2 text-sm" for="sJadeShow">""")
