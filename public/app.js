const $ = selector => document.querySelector(selector);
let selectedCode = '';
let endingId = '';
let isAdmin = false;
let listRequest = 0;
let listController;
let loading = false;
let currentTab = 'ongoing';
let currentPage = 1;
let totalPages = 1;
let searchQuery = '';
let visibleRooms = [];
const selected = new Set();
let deletingIds = [];
let exporting = false;
let toastTimer;

async function api(path, body) {
  const response = await fetch(path, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2500);
}
function showAdmin(value) {
  isAdmin = value;
  $('#guest').hidden = value; $('#dashboard').hidden = !value;
  $('#admin-toggle').hidden = value; $('#logout').hidden = !value;
  if (value) void setTab('ongoing');
  else { listController?.abort(); listRequest++; selected.clear(); }
}
function bindForm(id, errorId, action) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; $(errorId).textContent = '';
    try { await action(Object.fromEntries(new FormData(form))); }
    catch (error) { $(errorId).textContent = error.message || '操作失败，请重试。'; }
    finally { button.disabled = false; }
  });
}
async function join(code, name) {
  const data = await api('/api/join', { code, name });
  location.assign(data.url);
}
bindForm('#join-form', '#join-error', values => join(values.code, values.name));
bindForm('#enter-form', '#enter-error', values => join(selectedCode, values.name));
bindForm('#login-form', '#login-error', async values => {
  await api('/api/login', values);
  $('#admin-password').value = ''; $('#login-dialog').close(); showAdmin(true);
});
bindForm('#create-form', '#create-error', async values => {
  await api('/api/rooms', { ...values, minutes: Number(values.minutes) });
  $('#room-title').value = ''; toast('房间正在准备，面试码稍后即可使用。'); await setTab('ongoing');
});
bindForm('#end-form', '#end-error', async () => {
  await api(`/api/rooms/${endingId}/end`, {}); $('#end-dialog').close(); await setTab('completed');
});
$('#admin-toggle').onclick = () => { $('#login-error').textContent = ''; $('#login-dialog').showModal(); };
$('#logout').onclick = async () => {
  try { await api('/api/logout', {}); showAdmin(false); }
  catch (error) { toast(error.message); }
};
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
document.querySelectorAll('dialog').forEach(dialog => { dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }); });
$('#join-code').addEventListener('input', event => {
  const value = event.target.value.replace(/[^A-Za-z2-9]/g, '').toUpperCase().slice(0, 8);
  event.target.value = value.length > 4 ? `${value.slice(0, 4)}-${value.slice(4)}` : value;
});
const initialCode = new URLSearchParams(location.search).get('code');
if (initialCode && /^[A-Za-z2-9-]{8,9}$/.test(initialCode)) $('#join-code').value = initialCode;

function node(tag, className, text) {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function action(label, handler, className = '') {
  const button = node('button', `button ${className}`, label);
  button.type = 'button';
  button.onclick = async () => {
    button.disabled = true;
    try { await handler(); } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  };
  return button;
}
const statuses = { starting: '准备中', recovering: '恢复中', active: '进行中', ending: '结束中', ended: '已结束', error: '需要处理' };
const displayTime = value => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function roomCard(room) {
  const card = node('article', 'room-card'); card.dataset.roomId = room.id;
  const top = node('div', 'room-top');
  if (room.status === 'ended') {
    const checkbox = node('input', 'record-select'); checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `选择 ${room.title}`); checkbox.checked = selected.has(room.id);
    checkbox.onchange = () => { if (checkbox.checked) selected.add(room.id); else selected.delete(room.id); updateSelection(); };
    top.append(checkbox);
  }
  top.append(node('h3', 'room-title', room.title), node('span', `status ${room.status}`, statuses[room.status]));
  const meta = node('div', 'room-meta');
  meta.append(node('span', '', `创建于 ${displayTime(room.createdAt)}`));
  if (room.endedAt) meta.append(node('span', '', `结束于 ${displayTime(room.endedAt)}`));
  if (room.status === 'active') meta.append(node('span', '', `剩余 ${Math.max(0, Math.ceil((room.expiresAt - Date.now()) / 60000))} 分钟`));
  const bottom = node('div', 'room-bottom');
  bottom.append(node('span', 'room-code', room.code));
  const actions = node('div', 'room-actions');
  if (room.status === 'active') {
    actions.append(action('复制面试码', async () => { await navigator.clipboard.writeText(room.code); toast('面试码已复制'); }));
    actions.append(action('邀请链接', async () => { await navigator.clipboard.writeText(room.joinUrl); toast('邀请链接已复制'); }));
    actions.append(action('进入 ↗', () => { selectedCode = room.code; $('#enter-error').textContent = ''; $('#enter-dialog').showModal(); }));
  }
  if (room.status !== 'ended' && room.status !== 'ending') actions.append(action('结束', () => {
    endingId = room.id; $('#end-error').textContent = ''; $('#end-dialog').showModal();
  }, 'danger'));
  if (room.status === 'ended') {
    const link = node('a', 'button', '下载代码 ↓'); link.href = `/api/rooms/${room.id}/archive`; link.download = ''; actions.append(link, action('删除记录', () => confirmDelete([room.id]), 'danger'));
  }
  bottom.append(actions); card.append(top, meta, bottom);
  if (room.error) card.append(node('p', 'error', room.error));
  if (room.status === 'starting') card.append(node('p', 'small muted', '正在启动编程空间，请稍候…'));
  return card;
}
function updateSelection() {
  $('#selection-count').textContent = `已选 ${selected.size} 项`;
  $('#select-page').checked = visibleRooms.length > 0 && selected.size === visibleRooms.length;
  $('#select-page').indeterminate = selected.size > 0 && selected.size < visibleRooms.length;
  $('#select-page').disabled = loading || !visibleRooms.length;
  $('#download-selected').disabled = loading || !selected.size || exporting;
  $('#delete-selected').disabled = loading || !selected.size;
  $('#previous-page').disabled = loading || currentPage <= 1;
  $('#next-page').disabled = loading || currentPage >= totalPages;
  for (const card of document.querySelectorAll('.room-card')) {
    const checkbox = card.querySelector('.record-select');
    if (checkbox) { checkbox.checked = selected.has(card.dataset.roomId); checkbox.disabled = loading; }
  }
}
function confirmDelete(ids) {
  deletingIds = [...ids];
  const titles = visibleRooms.filter(room => ids.includes(room.id)).map(room => room.title);
  $('#delete-summary').textContent = `将删除 ${ids.length} 条记录：${titles.slice(0, 3).join('、')}${titles.length > 3 ? '…' : ''}`;
  $('#delete-error').textContent = ''; $('#delete-dialog').showModal();
}
bindForm('#delete-form', '#delete-error', async () => {
  const result = await api('/api/rooms/batch-delete', { ids: deletingIds });
  for (const id of result.deleted) selected.delete(id);
  $('#delete-dialog').close();
  await loadRooms();
  toast(`已删除 ${result.deleted.length} 条记录${result.failed.length ? `，${result.failed.length} 条未删除` : ''}`);
  if (result.failed.length) $('#list-error').textContent = result.failed.map(item => item.error).join('；');
});
$('#select-page').onchange = event => {
  selected.clear();
  if (event.target.checked) for (const room of visibleRooms) selected.add(room.id);
  updateSelection();
};
$('#delete-selected').onclick = () => confirmDelete([...selected]);
$('#download-selected').onclick = async () => {
  const ids = [...selected]; exporting = true; updateSelection();
  $('#download-selected').textContent = '正在打包…';
  try {
    const { url } = await api('/api/rooms/batch-archive', { ids, delivery: 'download' });
    const link = document.createElement('a'); link.href = url; link.download = 'codingbox-interviews.tar.gz';
    document.body.append(link); link.click(); link.remove();
  } catch (error) { toast(error.message); }
  finally { exporting = false; $('#download-selected').textContent = '下载所选'; updateSelection(); }
};
function setTab(tab) {
  currentTab = tab; currentPage = 1; searchQuery = ''; selected.clear();
  $('#history-query').value = '';
  for (const name of ['ongoing', 'completed']) {
    const button = $(`#tab-${name}`); button.setAttribute('aria-selected', String(name === tab)); button.tabIndex = name === tab ? 0 : -1;
  }
  $('#session-panel').setAttribute('aria-labelledby', `tab-${tab}`);
  $('#search-form').hidden = tab !== 'completed'; $('#history-actions').hidden = tab !== 'completed';
  $('#room-list').replaceChildren();
  return loadRooms();
}
for (const name of ['ongoing', 'completed']) {
  const button = $(`#tab-${name}`);
  button.onclick = () => void setTab(name);
  button.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 'ongoing' : event.key === 'End' ? 'completed' : name === 'ongoing' ? 'completed' : 'ongoing';
    $(`#tab-${target}`).focus(); void setTab(target);
  };
}
$('#search-form').onsubmit = event => {
  event.preventDefault(); searchQuery = $('#history-query').value.trim(); currentPage = 1; selected.clear(); void loadRooms();
};
$('#clear-search').onclick = () => { $('#history-query').value = ''; searchQuery = ''; currentPage = 1; selected.clear(); void loadRooms(); };
$('#refresh-rooms').onclick = () => void loadRooms();
$('#previous-page').onclick = () => { if (currentPage > 1) { currentPage--; selected.clear(); void loadRooms(); } };
$('#next-page').onclick = () => { if (currentPage < totalPages) { currentPage++; selected.clear(); void loadRooms(); } };
async function loadRooms(background = false) {
  if (!isAdmin || (background && (loading || $('#room-list').contains(document.activeElement)))) return;
  const request = ++listRequest;
  listController?.abort(); listController = new AbortController(); loading = true;
  updateSelection();
  $('#list-loading').hidden = background; $('#session-panel').setAttribute('aria-busy', 'true');
  try {
    const query = new URLSearchParams({ tab: currentTab, page: String(currentPage), pageSize: '10', q: searchQuery });
    const response = await fetch(`/api/rooms?${query}`, { signal: listController.signal });
    const data = await response.json();
    if (request !== listRequest) return;
    if (!response.ok) throw new Error(data.error || '加载失败，请重试。');
    currentPage = data.page; totalPages = data.pages; visibleRooms = data.rooms;
    for (const id of selected) if (!visibleRooms.some(room => room.id === id)) selected.delete(id);
    $('#list-error').textContent = ''; $('#room-count').textContent = `共 ${data.total} 场面试`;
    $('#ongoing-count').textContent = data.counts.ongoing; $('#completed-count').textContent = data.counts.completed;
    const list = $('#room-list'); list.replaceChildren(...visibleRooms.map(roomCard));
    if (!visibleRooms.length) {
      const empty = node('div', 'empty-state');
      const title = currentTab === 'ongoing' ? '下一场好对话，从这里开始' : searchQuery ? '没有找到匹配的面试' : '还没有已完成的面试';
      const hint = currentTab === 'ongoing' ? '创建一个空间，把面试码分享给候选人。' : searchQuery ? '试试其他名称或面试码。' : '结束面试后，记录和代码会出现在这里。';
      empty.append(node('span', 'symbol', '[ / ]'), node('strong', '', title), node('p', '', hint)); list.append(empty);
    }
    $('#history-pagination').hidden = currentTab !== 'completed' && totalPages <= 1;
    $('#page-info').textContent = `第 ${currentPage} / ${totalPages} 页 · 共 ${data.total} 条`;
    $('#previous-page').disabled = currentPage <= 1; $('#next-page').disabled = currentPage >= totalPages;
    updateSelection();
  } catch (error) { if (request === listRequest && error.name !== 'AbortError') $('#list-error').textContent = error.message; }
  finally {
    if (request === listRequest) { loading = false; $('#list-loading').hidden = true; $('#session-panel').setAttribute('aria-busy', 'false'); updateSelection(); }
  }
}
setInterval(() => { if (currentTab === 'ongoing' && !document.hidden && !document.querySelector('dialog[open]')) void loadRooms(true); }, 2500);
api('/api/session').then(data => showAdmin(data.admin)).catch(() => { $('#join-error').textContent = '服务暂时不可用，请刷新页面重试。'; });
