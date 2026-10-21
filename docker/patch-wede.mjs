// Compatibility fixes for the exact upstream commit pinned by our submodule.
// Fail the build if upstream changes these anchors; never silently skip a fix.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('Usage: node patch-wede.mjs <upstream-root>');
function edit(path, transform) {
  const full = join(root, path);
  const source = readFileSync(full, 'utf8');
  writeFileSync(full, transform(source));
}
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Upstream patch anchor changed: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}

function removeBetween(source, start, end, replacement = '') {
  if (source.split(start).length !== 2) throw new Error(`Upstream patch start changed: ${start}`);
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  if (last < first) throw new Error(`Upstream patch end changed: ${end}`);
  return source.slice(0, first) + replacement + source.slice(last);
}

// Do not hand a new file the previous file's Y.Text during React's effect delay.
edit('web/src/hooks/useYDoc.ts', source => {
  source = replace(source, 'export interface UseYDocState {', 'export interface UseYDocState {\n  bindingKey?: string');
  source = replace(source, 'setState({ ytext, provider, awareness: provider.awareness })', 'setState({ ytext, provider, awareness: provider.awareness, bindingKey: `${workspaceId}:${path}` })');
  return replace(source, '  return state\n}', '  return state.bindingKey === `${workspaceId}:${path}` ? state : INACTIVE\n}');
});

// Interview UI: remove unrelated panels on desktop, mobile and command palette.
edit('web/src/components/IDE.tsx', source => {
  source = replace(source, "import Logo from './Logo'", "import InterviewLanguage from './InterviewLanguage'");
  const languageToolbar = `          <InterviewLanguage authFetch={authFetch} readOnly={role === 'viewer'} onActivate={async selection => {\n            await workspacesApi.refresh()\n            workspacesApi.setActiveWorkspaceId(selection.workspaceId)\n            setTerminalMode('docked')\n            await openFile({ path: selection.entry, rel: selection.entry, name: selection.entry.split('/').pop()!, isDir: false, workspaceId: selection.workspaceId }, { preview: false })\n          }} onRun={async selection => {
            if (workspaceId !== selection.workspaceId) throw new Error('项目切换中，请稍后重试')
            if (collabPath && (!collab.provider?.wsconnected || !collab.provider?.synced)) throw new Error('协作文档尚未连接，请稍后重试')
            const snapshots = tabs.filter(t => t.workspaceId === selection.workspaceId && !t.type && t.modified)
              .map(t => ({ path: t.rel!, content: t.content }))
            if (collabPath && collab.ytext) {
              const snapshot = { path: collabPath, content: collab.ytext.toString() }
              const index = snapshots.findIndex(t => t.path === collabPath)
              if (index >= 0) snapshots[index] = snapshot
              else snapshots.push(snapshot)
            }
            for (const snapshot of snapshots) {
              if (!collabPath) {
                const saved = await authFetch(workspaceUrl(selection.workspaceId, '/files/write'), {
                  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot),
                })
                if (!saved.ok) throw new Error('保存失败，未启动运行')
              } else {
                const deadline = Date.now() + 8000
                for (;;) {
                  const response = await authFetch(workspaceUrl(selection.workspaceId, '/files/read?path=' + encodeURIComponent(snapshot.path)))
                  if (!response.ok) throw new Error('读取代码失败，未启动运行')
                  if ((await response.json()).content === snapshot.content) break
                  if (Date.now() > deadline) throw new Error('代码仍在同步，请稍后重试')
                  await new Promise(resolve => setTimeout(resolve, 100))
                }
              }
            }
            const response = await authFetch('/api/interview/run', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ language: selection.language, revision: selection.revision }),
            })
            if (!response.ok) throw new Error(response.status === 409 ? '语言已变更或终端已满，请重试或关闭多余终端' : '运行失败，请重试')
            const result = await response.json()
            setTerminalMode('docked')
            terminalsApi.setActiveId(result.terminalId)
          }} />`;
  source = replace(source, '  // ── Mobile menu overlay ──', `  const interviewToolbar = (\n${languageToolbar}\n  )\n\n  // ── Mobile menu overlay ──`);
  source = replace(source, '          {workspacesApi && <WorkspaceSwitcher workspacesApi={workspacesApi} />}', '          {interviewToolbar}');
  source = removeBetween(source, '          <div className="flex items-center gap-2 pr-2 mr-0.5 border-r border-border h-6">', '          {interviewToolbar}');
  source = removeBetween(source, '            <Logo size={18} showName', '          </div>\n          <div className="flex items-center gap-1">', '            {interviewToolbar}\n');
  for (const line of [
    "import FolderPicker from './FolderPicker'\n",
    "import WorkspaceSwitcher from './WorkspaceSwitcher'\n",
    '  const [showFolderPicker, setShowFolderPicker] = useState(false)\n',
    "  const [pickerMode, setPickerMode] = useState<'open' | 'add'>('open') // 'open' = switch workspace; 'add' = add a root\n",
    "  const folderName = workspace?.split('/').pop() || 'wede'\n",
    "            { icon: FolderOpen, label: 'Open Folder', action: () => { setShowFolderPicker(true); setMobileMenu(false) } },\n",
  ]) source = replace(source, line, '');
  source = removeBetween(source, '  const handleWorkspaceOpen = (path: string) => {', '  // openFile follows VS Code');
  source = removeBetween(source, '  if (showFolderPicker) {', '  // ══════════════════════════');
  const callbacks = ' onAddFolder={openAddFolder} onCloseWorkspace={(id) => { void handleCloseWorkspace(id) }}';
  if (source.split(callbacks).length !== 3) throw new Error('Missing desktop/mobile folder controls');
  source = source.replaceAll(callbacks, '');
  const openFolder = 'onOpenFolder={() => setShowFolderPicker(true)}';
  if (source.split(openFolder).length !== 5) throw new Error('Missing folder selection callbacks');
  source = source.replaceAll(openFolder, '');
  source = replace(source, '{/* Left: logo + workspace */}', '{/* Left: interview controls */}');
  source = replace(source, `          <button onClick={() => openBrowser()}
            className="flex items-center px-2 py-1 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Open Browser Preview">
            <Globe className="w-3.5 h-3.5" />
          </button>`, '');
  source = replace(source, "useState<TerminalMode>('hidden')", "useState<TerminalMode>('docked')");
  source = replace(source, "useRef<TerminalMode>('floating')", "useRef<TerminalMode>('docked')");
  for (const title of ['Source Control', 'API Client']) {
    const pattern = new RegExp(`          <ActivityBtn\\n(?:(?!<ActivityBtn)[\\s\\S])*?title="${title}"[\\s\\S]*?          />\\n`);
    if (!pattern.test(source)) throw new Error(`Missing activity button: ${title}`);
    source = source.replace(pattern, '');
  }
  source = replace(source, '(parsed as Partial<Tab>[]).map', "(parsed as Partial<Tab>[]).filter(t => t.type !== 'apiclient' && t.type !== 'gitgraph').map");
  source = replace(source, "{gitBranch && (", "{false && gitBranch && (");
  source = replace(source, "onFocusGit={() => setMobilePanel('git')}", 'onFocusGit={() => {}}');
  source = replace(source, "onFocusGit={() => toggleSidebarTab('git')}", 'onFocusGit={() => {}}');
  return source;
});
edit('web/src/components/MobileNav.tsx', source => replace(source, "  { id: 'git', icon: GitBranch, label: 'Git' },\n", ''));
edit('web/src/components/CommandPalette.tsx', source => {
  for (const id of ['focus-git', 'git-stage-all', 'git-unstage-all', 'open-browser', 'open-folder']) {
    const pattern = new RegExp(`    \\{\\n      id: '${id}',[\\s\\S]*?    \\},\\n`);
    if (!pattern.test(source)) throw new Error(`Missing command: ${id}`);
    source = source.replace(pattern, '');
  }
  source = replace(source, '  onOpenFolder: () => void\n', '');
  return replace(source, '  onOpenFolder,\n', '');
});
edit('web/src/components/Settings.tsx', source => {
  source = removeBetween(source, '        {/* Workspace */}', '        {/* Workspace data location (owner only) */}');
  source = replace(source, '  onOpenFolder: () => void\n', '');
  return replace(source, 'onClose, onOpenFolder, workspace,', 'onClose, workspace,');
});

const overlays = join(dirname(fileURLToPath(import.meta.url)), 'wede');
edit('web/src/hooks/useAuth.ts', source => {
  source = replace(source, "      logout()\n      throw new Error('unauthorized')", "      if (localStorage.getItem('wede_token') === token) logout()\n      throw new Error('unauthorized')");
  const start = source.indexOf("    const t = localStorage.getItem('wede_token')");
  const end = source.indexOf('\n  }, []) // intentionally run once on mount only', start);
  if (start < 0 || end < start) throw new Error('Missing auth bootstrap effect');
  return source.slice(0, start) + `    let disposed = false\n    void (async () => {\n      let t = localStorage.getItem('wede_token')\n      try {\n        const response = await fetch('/__codingbox/bootstrap')\n        if (response.ok) {\n          const data = await response.json()\n          if (data.token && !disposed) {\n            t = data.token\n            localStorage.setItem('wede_token', data.token)\n            setToken(data.token)\n          }\n        }\n      } catch { /* allow standalone WEDE auth to continue */ }\n      if (!t || disposed) return\n      try {\n        const response = await fetch(API + '/auth/check', { headers: { Authorization: t } })\n        const data: AuthCheckResponse = await response.json()\n        if (disposed) return\n        if (data.authenticated && data.role) {\n          setRole(data.role)\n          localStorage.setItem('wede_role', data.role)\n        } else if (!data.authenticated) {\n          localStorage.removeItem('wede_token')\n          localStorage.removeItem('wede_username')\n          localStorage.removeItem('wede_role')\n          setToken(null); setUsername(''); setRole('')\n        }\n      } catch { /* retry on next load */ }\n    })()\n    return () => { disposed = true }` + source.slice(end);
});
mkdirSync(join(root, 'backend/internal/interview'), { recursive: true });
writeFileSync(join(root, 'backend/internal/interview/interview.go'), readFileSync(join(overlays, 'interview.go')));
writeFileSync(join(root, 'backend/internal/interview/interview_test.go'), readFileSync(join(overlays, 'interview_test.go')));
writeFileSync(join(root, 'web/src/components/InterviewLanguage.tsx'), readFileSync(join(overlays, 'InterviewLanguage.tsx')));
writeFileSync(join(root, 'backend/internal/collabdoc/stable-state.go'), readFileSync(join(overlays, 'stable-state.go')));
writeFileSync(join(root, 'backend/internal/collabdoc/stable-state_test.go'), readFileSync(join(overlays, 'stable-state_test.go')));
edit('backend/internal/collabdoc/persistence.go', source => {
  source = replace(source, 'type DiskPersistence struct {', 'type DiskPersistence struct {\n stateMu sync.Mutex\n states map[string]*crdt.Doc');
  source = replace(source, 'root:     root,', 'root:     root,\n states: make(map[string]*crdt.Doc),');
  source = replace(source, 'func (p *DiskPersistence) LoadDoc(room string)', 'func (p *DiskPersistence) seedDoc(room string)');
  source = replace(source, 'func (p *DiskPersistence) StoreUpdate(room string, _ []byte) error {', 'func (p *DiskPersistence) StoreUpdate(room string, update []byte) error {\n if err := p.retainUpdate(room, update); err != nil { return err }');
  return replace(source, '\tdoc := prov.GetDoc(room)\n\tif doc == nil {\n\t\treturn\n\t}\n\ttext := doc.GetText(contentField).ToString()', '\ttext, retained := p.retainedText(room)\n\tif !retained {\n\t doc := prov.GetDoc(room)\n\t if doc == nil { return }\n\t text = doc.GetText(contentField).ToString()\n\t}');
});
writeFileSync(join(root, 'web/src/hooks/useTerminals.ts'), readFileSync(join(overlays, 'useTerminals.ts')));
writeFileSync(join(root, 'backend/internal/terminal/registry.go'), readFileSync(join(overlays, 'registry.go')));
writeFileSync(join(root, 'backend/internal/terminal/registry_test.go'), readFileSync(join(overlays, 'registry_test.go')));
edit('backend/cmd/wede/main.go', source => {
  source = replace(source, '"wede/backend/internal/lsp"', '"wede/backend/internal/lsp"\n "wede/backend/internal/interview"');
  source = replace(source, '\tro := authHandler.RequireOwner', '\tro := authHandler.RequireOwner\n interviewHandler := interview.New(rootFolder.Current(), "/opt/codingbox/templates", wsMgr)\n protected.Handle("POST /api/interview/run", re(http.HandlerFunc(interviewHandler.Run)))\n protected.HandleFunc("GET /api/interview/language", interviewHandler.Handle)\n protected.Handle("POST /api/interview/language", re(http.HandlerFunc(interviewHandler.Handle)))');
  const route = '\tprotected.HandleFunc("GET /api/workspaces/{id}/terminal/sessions", rs(func(ws *workspace.Workspace) http.HandlerFunc { return ws.Terminal().ListSessions }))';
  return replace(source, route, route.replace('ListSessions', 'ManageSessions') + '\n\tprotected.Handle("POST /api/workspaces/{id}/terminal/sessions", re(rs(func(ws *workspace.Workspace) http.HandlerFunc { return ws.Terminal().ManageSessions })))');
});
edit('backend/internal/terminal/terminal.go', source => {
  source = replace(source, '\t"encoding/json"', '\t"encoding/json"\n\t"fmt"\n\t"strconv"');
  source = replace(source, '\tmu     sync.Mutex', '\toutputMu sync.Mutex // orders replay and live output\n\tmu     sync.Mutex');
  source = replace(source, '\tws       WorkspaceProvider', '\ttabs []terminalTab\n\tnextTab int\n\ttabRevision int\n\tws       WorkspaceProvider');
  source = replace(source, '\tif s, ok := h.sessions[id]; ok && !s.closed {', `\tif strings.HasPrefix(id, "term-") && h.nextTab > 0 {\n\t\tn, _ := strconv.Atoi(strings.TrimPrefix(id, "term-"))\n\t\tfound := false\n\t\tfor _, tab := range h.tabs { if tab.ID == n { found = true } }\n\t\tif !found { return nil, false, fmt.Errorf("terminal was closed") }\n\t}\n\n\tif s, ok := h.sessions[id]; ok && !s.closed {`);
  source = replace(source, 'len(s.buf.data)', 'len(s.buf.Bytes())');
  source = replace(source, '\t\t\ts.buf.Write(data)\n\t\t\ts.broadcast(websocket.BinaryMessage, data)', '\t\t\ts.outputMu.Lock()\n\t\t\ts.buf.Write(data)\n\t\t\ts.broadcast(websocket.BinaryMessage, data)\n\t\t\ts.outputMu.Unlock()');
  source = replace(source, '\tsub := s.addSub(conn)', '\ts.outputMu.Lock()\n\tsub := s.addSub(conn)');
  source = replace(source, '\t// Per-connection ping/pong keepalive.', '\ts.outputMu.Unlock()\n\n\t// Per-connection ping/pong keepalive.');
  // Bound a stalled viewer so it cannot block output for every participant.
  source = replace(source, '\treturn sub.conn.WriteMessage(msgType, data)', '\tsub.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))\n\treturn sub.conn.WriteMessage(msgType, data)');
  return source;
});
edit('web/src/components/Terminal.tsx', source => {
  source = replace(source, '    if (!containerRef.current || !token || termRef.current) return', '    if (!containerRef.current || !token || termRef.current) return\n    mountedRef.current = true');
  source = replace(source, '          term.clear()', '          term.reset()');
  source = replace(source, '    setTimeout(() => fitAddon.fit(), 50)', '    const canResize = () => !!containerRef.current?.offsetWidth && !!containerRef.current?.offsetHeight\n    setTimeout(() => { if (canResize()) fitAddon.fit() }, 50)');
  source = replace(source, "        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))", "        if (canResize()) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))");
  source = replace(source, "      if (ws && ws.readyState === WebSocket.OPEN) {\n        ws.send(JSON.stringify({ type: 'resize', cols, rows }))", "      if (canResize() && ws && ws.readyState === WebSocket.OPEN) {\n        ws.send(JSON.stringify({ type: 'resize', cols, rows }))");

  // Hidden tabs must not resize the shared PTY to their zero-sized container.
  source = replace(source, '    const ro = new ResizeObserver(() => {\n      try { fitAddon.fit() }', '    const ro = new ResizeObserver(() => {\n      if (!containerRef.current?.offsetWidth || !containerRef.current?.offsetHeight) return\n      try { fitAddon.fit() }');
  return source;
});
edit('web/src/components/TerminalPanel.tsx', source => replace(source,
  'onClick={(e) => { e.stopPropagation(); closeTerminal(t.id) }}',
  'title={`Close ${t.name}`} role="button" aria-label={`Close ${t.name}`} onClick={(e) => { e.stopPropagation(); closeTerminal(t.id) }}'));

edit('web/src/components/IDE.tsx', source => {
  const start = source.indexOf('  const { extension: lspExtension, available: lspAvailable } = useLSP({');
  const end = source.indexOf('\n  })', start) + '\n  })'.length;
  if (start < 0 || end <= start) throw new Error('Missing useLSP block');
  let lsp = source.slice(start, end);
  lsp = replace(lsp, "file: currentTab ? { ...currentTab, path: currentTab.rel ?? '' } : null,", "file: currentTab && (!collabPath || collab.ytext) ? { ...currentTab, path: documentPath } : null,");
  lsp = replace(lsp, '    workspaceId,', '    workspaceId: documentWorkspaceId,');
  source = source.slice(0, start) + source.slice(end);
  const collab = '  const collab = useYDoc({ workspaceId, path: collabPath, token, username, color: colorFromName(username) })';
  source = replace(source, collab, `  const documentWorkspaceId = currentTab?.workspaceId || workspaceId\n  const documentRoot = workspacesApi.workspaces.find(w => w.id === documentWorkspaceId)?.root || workspace || ''\n  const documentPath = documentRoot.replace(/\\/+$/, '') + '/' + (currentTab?.rel || '')\n${collab.replace('workspaceId,', 'workspaceId: documentWorkspaceId,')}\n\n${lsp}`);
  return replace(source, '    const editorEl = (', `    if (collabPath && !collab.ytext) {\n      return <div className="p-4 text-text-muted">Connecting shared document…</div>\n    }\n    const editorEl = (`);
});

// LSP JSON-RPC response IDs and unsaved buffers belong to a client connection.
// Sharing stdout among clients races reads and can misroute responses.
edit('backend/internal/lsp/lsp.go', source => {
  source = replace(source, 'var knownServers = map[string]langServer{', 'var knownServers = map[string]langServer{\n "cpp": {bin: "clangd", args: []string{"--background-index", "--clang-tidy"}, exts: []string{"cpp", "cc", "cxx", "hpp", "h", "c"}},');
  source = replace(source, 'key := serverKey{workspace: workspaceDir, lang: lang}', 'key := serverKey{workspace: workspaceDir, lang: fmt.Sprintf("%s:%p", lang, conn)}');
  const anchor = '\tlog.Printf("[lsp] ws connected: lang=%s workspace=%s", lang, workspaceDir)';
  return replace(source, anchor, `\tdefer func() {\n\t\th.mu.Lock()\n\t\tdelete(h.servers, key)\n\t\th.mu.Unlock()\n\t\tproc.kill()\n\t}()\n\n${anchor}`);
});

// One origin, many room paths: adapt explicit transport/asset/storage boundaries.
writeFileSync(join(root, 'web/src/roomScope.ts'), readFileSync(join(overlays, 'roomScope.ts')));
edit('web/vite.config.js', source => replace(source, 'export default defineConfig({', "export default defineConfig({\n  base: './',"));
// Reuse the portal mark; do not retain upstream favicon fallbacks or PWA icons.
writeFileSync(join(root, 'web/public/codingbox.svg'), readFileSync(process.argv[3] || join(dirname(fileURLToPath(import.meta.url)), '../public/icon.svg')));
edit('web/index.html', source => {
  source = replace(source, '<title>WEDE | Web Development Environment</title>', '<title>Codingbox · 一起思考，一起编程</title>');
  source = source.replaceAll('WEDE | Web Development Environment', 'Codingbox · 一起思考，一起编程');
  source = replace(source, '    <link rel="icon" href="/favicon.ico" sizes="48x48" />\n', '');
  source = replace(source, 'href="/icon.svg"', 'href="/codingbox.svg?v=0.0.1"');
  source = replace(source, '    <link rel="apple-touch-icon" href="/icon-180.png" />\n', '');
  source = replace(source, '    <link rel="manifest" href="/manifest.json" />\n', '');
  source = source.replaceAll('content="WEDE"', 'content="Codingbox"');
  return source.replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./');
});
edit('web/src/hooks/useAuth.ts', source => {
  source = "import { roomFetch as fetch } from '../roomScope'\n" + source;
  return replace(source, "const response = await fetch('/__codingbox/bootstrap')", "const response = await fetch('/__codingbox/bootstrap?name=' + encodeURIComponent(localStorage.getItem('wede_username') || '访客'), { headers: t ? { Authorization: t } : {} })");
});
for (const path of ['hooks/useAuth.ts', 'hooks/useTheme.tsx', 'components/IDE.tsx', 'components/Login.tsx']) {
  edit('web/src/' + path, source => {
    if (!source.includes('localStorage.')) throw new Error(`Missing storage boundary: ${path}`);
    return "import { roomStorage as localStorage } from '../roomScope'\n" + source;
  });
}
for (const path of ['hooks/useCollab.ts', 'hooks/useChat.ts', 'hooks/useDap.ts', 'hooks/useYDoc.ts']) {
  edit('web/src/' + path, source => "import { roomBase } from '../roomScope'\n" + replace(source, '${host}/api', '${host}${roomBase}/api'));
}
edit('web/src/hooks/useLSP.ts', source => "import { roomPath } from '../roomScope'\n" + replace(source, '${window.location.host}${path}', '${window.location.host}${roomPath(path)}'));
edit('web/src/components/Terminal.tsx', source => "import { roomPath } from '../roomScope'\n" + replace(source, '${host}${path}', '${host}${roomPath(path)}'));
edit('web/src/components/IDE.tsx', source => "import { roomPath } from '../roomScope'\n" + replace(source, 'new EventSource(url)', 'new EventSource(roomPath(url))'));
edit('web/src/components/Logo.tsx', source => "import { roomPath } from '../roomScope'\n" + replace(source, 'src={src}', 'src={roomPath(src)}'));
