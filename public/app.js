const $ = selector => document.querySelector(selector);
let selectedCode = '';
let endingId = '';
let isAdmin = false;
let polling = false;
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
  if (value) void loadRooms();
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
  $('#room-title').value = ''; toast('房间正在准备，面试码稍后即可使用。'); await loadRooms();
});
bindForm('#end-form', '#end-error', async () => {
  await api(`/api/rooms/${endingId}/end`, {}); $('#end-dialog').close(); await loadRooms();
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
const statuses = { starting: '准备中', active: '进行中', ending: '结束中', ended: '已结束', error: '需要处理' };
const languages = { python: 'Python', typescript: 'TypeScript', go: 'Go', cpp: 'C++', rust: 'Rust' };
function roomCard(room) {
  const card = node('article', 'room-card'); card.dataset.roomId = room.id;
  const top = node('div', 'room-top');
  top.append(node('h3', 'room-title', room.title), node('span', `status ${room.status}`, statuses[room.status]));
  const meta = node('div', 'room-meta');
  meta.append(node('span', '', languages[room.language]), node('span', '', `创建于 ${new Date(room.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`));
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
    const link = node('a', 'button', '下载代码 ↓'); link.href = `/api/rooms/${room.id}/archive`; link.download = ''; actions.append(link);
  }
  bottom.append(actions); card.append(top, meta, bottom);
  if (room.error) card.append(node('p', 'error', room.error));
  if (room.status === 'starting') card.append(node('p', 'small muted', '正在启动编程空间，请稍候…'));
  return card;
}
async function loadRooms() {
  if (!isAdmin || polling) return;
  polling = true;
  try {
    const { rooms } = await api('/api/rooms');
    $('#list-error').textContent = ''; $('#room-count').textContent = `${rooms.length} 场面试`;
    const list = $('#room-list'); list.replaceChildren(...rooms.map(roomCard));
    if (!rooms.length) {
      const empty = node('div', 'empty-state');
      empty.append(node('span', 'symbol', '[ / ]'), node('strong', '', '下一场好对话，从这里开始'), node('p', '', '创建第一个空间，把面试码分享给候选人。')); list.append(empty);
    }
  } catch (error) { $('#list-error').textContent = error.message; }
  finally { polling = false; }
}
setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) void loadRooms(); }, 2500);
api('/api/session').then(data => showAdmin(data.admin)).catch(() => { $('#join-error').textContent = '服务暂时不可用，请刷新页面重试。'; });
