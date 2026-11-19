const STORAGE_KEY = 'nex-chat:v1';
const THEME_KEY = 'nex-chat:theme';

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'nex-n2.6',
  maxTokens: 8192,
  stream: true,
  thinking: false,
  systemPrompt: '',
  theme: 'dark',
};

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const sidebar = $('sidebar');
const sidebarBackdrop = $('sidebarBackdrop');
const convList = $('convList');
const msgList = $('msgList');
const emptyState = $('emptyState');
const chatTitle = $('chatTitle');
const modelBadge = $('modelBadge');
const input = $('input');
const sendBtn = $('sendBtn');
const stopBtn = $('stopBtn');
const usageHint = $('usageHint');
const keyStatus = $('keyStatus');
const toastEl = $('toast');
const settingsModal = $('settingsModal');

const state = {
  settings: { ...DEFAULT_SETTINGS },
  conversations: [],
  activeId: null,
  streaming: null,
  editingId: null,
  hasServerKey: false,
};

let stickToBottom = true;
let rafPending = false;
let toastTimer = null;

/* ---------- 本地存储 ---------- */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.settings) state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
      if (Array.isArray(data.conversations)) {
        state.conversations = data.conversations.filter((c) => c && Array.isArray(c.messages));
      }
      state.activeId = data.activeId || null;
    }
  } catch (err) {
    console.warn('读取本地会话失败', err);
  }

  state.settings.theme = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  state.settings.maxTokens = clampInt(state.settings.maxTokens, DEFAULT_SETTINGS.maxTokens, 1, 131072);

  if (!state.conversations.length) {
    const conv = createConversationData();
    state.conversations.push(conv);
    state.activeId = conv.id;
  }
  if (!state.conversations.some((c) => c.id === state.activeId)) {
    state.activeId = sortConversations()[0].id;
  }
}

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        settings: state.settings,
        conversations: state.conversations,
        activeId: state.activeId,
      }),
    );
    localStorage.setItem(THEME_KEY, state.settings.theme);
  } catch (err) {
    console.warn('保存本地会话失败', err);
    toast('本地存储空间不足，会话未能保存');
  }
}

/* ---------- 通用工具 ---------- */

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random().toString(16).slice(2);
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function createConversationData() {
  return { id: uid(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

function sortConversations() {
  return [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}

function activeConversation() {
  return state.conversations.find((c) => c.id === state.activeId) || state.conversations[0];
}

function makeTitle(text) {
  const line = text.split('\n').find((l) => l.trim()) || '新对话';
  const clean = line.replace(/\s+/g, ' ').trim();
  return clean.length > 24 ? clean.slice(0, 24) + '…' : clean || '新对话';
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatUsage(usage, model, speed, speedAverage) {
  if (!usage) return '';
  const parts = [];
  if (usage.prompt_tokens != null) parts.push(`输入 ${usage.prompt_tokens}`);
  if (usage.completion_tokens != null) parts.push(`输出 ${usage.completion_tokens}`);
  if (usage.total_tokens != null) parts.push(`合计 ${usage.total_tokens}`);
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;
  if (reasoning) parts.push(`思考 ${reasoning}`);
  const prefix = model ? `${model} · ` : '';
  const usageText = parts.length ? `${prefix}${parts.join(' · ')} tokens` : '';
  return [usageText, formatSpeed(speed, speedAverage)].filter(Boolean).join(' · ');
}

function computeSpeed(tokens, elapsedMs) {
  if (!tokens || !elapsedMs || elapsedMs < 50) return null;
  return tokens / (elapsedMs / 1000);
}

function formatSpeed(speed, average) {
  if (!speed || !Number.isFinite(speed)) return '';
  const value = speed >= 100 ? Math.round(speed) : Number(speed.toFixed(1));
  return `${average ? '平均 ' : ''}${value} tokens/s`;
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2400);
}

/* ---------- 侧边栏 ---------- */

function renderSidebar() {
  convList.innerHTML = '';
  for (const conv of sortConversations()) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === state.activeId ? ' active' : '');
    item.dataset.id = conv.id;

    if (state.editingId === conv.id) {
      const titleInput = document.createElement('input');
      titleInput.className = 'conv-title-input';
      titleInput.value = conv.title;
      titleInput.maxLength = 60;
      titleInput.addEventListener('click', (e) => e.stopPropagation());

      let finished = false;
      const finish = (save) => {
        if (finished) return;
        finished = true;
        const value = titleInput.value.trim();
        if (save && value) conv.title = value;
        state.editingId = null;
        saveState();
        renderSidebar();
        if (conv.id === state.activeId) chatTitle.textContent = conv.title;
      };

      titleInput.addEventListener('blur', () => finish(true));
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          titleInput.blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          finished = true;
          state.editingId = null;
          renderSidebar();
        }
      });

      item.appendChild(titleInput);
      queueMicrotask(() => {
        titleInput.focus();
        titleInput.select();
      });
    } else {
      const title = document.createElement('span');
      title.className = 'conv-title';
      title.textContent = conv.title;
      title.title = conv.title;
      item.appendChild(title);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'conv-del';
      del.title = '删除对话';
      del.setAttribute('aria-label', '删除对话');
      del.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12"/></svg>';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(conv.id);
      });
      item.appendChild(del);
    }

    item.addEventListener('click', () => {
      if (state.editingId) return;
      switchConversation(conv.id);
    });
    item.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (state.streaming) return;
      state.editingId = conv.id;
      renderSidebar();
    });

    convList.appendChild(item);
  }
}

function switchConversation(id) {
  if (id === state.activeId) return closeSidebar();
  state.activeId = id;
  saveState();
  renderSidebar();
  renderMessages(true);
  closeSidebar();
  input.focus();
}

function newChat() {
  const empty = state.conversations.find((c) => c.messages.length === 0);
  if (empty) {
    state.activeId = empty.id;
  } else {
    const conv = createConversationData();
    state.conversations.push(conv);
    state.activeId = conv.id;
  }
  saveState();
  renderSidebar();
  renderMessages(true);
  closeSidebar();
  input.focus();
}

function deleteConversation(id) {
  if (state.streaming?.convId === id) {
    toast('该对话正在生成回复，请先停止');
    return;
  }
  const idx = state.conversations.findIndex((c) => c.id === id);
  if (idx === -1) return;
  if (!confirm(`删除对话「${state.conversations[idx].title}」？删除后不可恢复。`)) return;

  state.conversations.splice(idx, 1);
  if (!state.conversations.length) {
    const conv = createConversationData();
    state.conversations.push(conv);
    state.activeId = conv.id;
  } else if (state.activeId === id) {
    state.activeId = sortConversations()[0].id;
  }
  saveState();
  renderSidebar();
  renderMessages(true);
}

/* ---------- 消息渲染 ---------- */

function renderMessages(scroll = false) {
  const conv = activeConversation();
  const messages = conv ? conv.messages : [];
  chatTitle.textContent = conv ? conv.title : '新对话';
  msgList.innerHTML = '';
  emptyState.classList.toggle('hidden', messages.length > 0);
  for (const m of messages) msgList.appendChild(buildMessageEl(m));
  updateComposerState();
  updateUsageHint();
  if (scroll) scrollToBottom();
}

function buildMessageEl(m) {
  const el = document.createElement('article');
  el.className = 'msg ' + (m.role === 'user' ? 'msg--user' : 'msg--assistant');
  el.dataset.id = m.id;

  if (m.role === 'user') {
    const head = document.createElement('div');
    head.className = 'msg-head';
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(m.createdAt);
    const name = document.createElement('span');
    name.className = 'msg-name';
    name.textContent = '你';
    head.append(time, name);

    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.textContent = m.content;

    el.append(head, bubble);
    return el;
  }

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  const avatarImg = document.createElement('img');
  avatarImg.src = '/logo/nex.svg';
  avatarImg.alt = 'Nex';
  avatar.appendChild(avatarImg);

  const main = document.createElement('div');
  main.className = 'msg-main';

  const head = document.createElement('div');
  head.className = 'msg-head';
  const name = document.createElement('span');
  name.className = 'msg-name';
  name.textContent = 'Nex';
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = formatTime(m.createdAt);
  head.append(name, time);

  const thinking = document.createElement('details');
  thinking.className = 'thinking hidden';
  thinking.innerHTML = '<summary>思考过程</summary><div class="thinking-body"></div>';

  const body = document.createElement('div');
  body.className = 'msg-body';

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.innerHTML = `
    <button type="button" data-act="copy">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>
      复制
    </button>
    <button type="button" data-act="regen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/></svg>
      重新生成
    </button>`;

  main.append(head, thinking, body, meta, actions);
  el.append(avatar, main);
  fillAssistantEl(el, m);
  return el;
}

function fillAssistantEl(el, m) {
  const body = el.querySelector('.msg-body');
  const thinking = el.querySelector('.thinking');
  const meta = el.querySelector('.msg-meta');
  const isStreaming = state.streaming?.msgId === m.id;

  if (m.reasoning) {
    thinking.classList.remove('hidden');
    thinking.querySelector('.thinking-body').textContent = m.reasoning;
  }

  if (m.content) {
    body.innerHTML = renderMarkdown(m.content) + (isStreaming ? '<span class="caret"></span>' : '');
  } else if (isStreaming) {
    body.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
  } else {
    body.innerHTML = '';
  }

  meta.textContent = m.usage ? formatUsage(m.usage, m.model, m.speed, m.speedAverage) : '';
  if (m.stopped) meta.textContent = (meta.textContent ? meta.textContent + ' · ' : '') + '已停止生成';

  if (m.error) {
    const error = document.createElement('div');
    error.className = 'msg-error';
    const text = document.createElement('span');
    text.textContent = m.error;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.dataset.act = 'retry';
    retry.textContent = '重试';
    error.append(text, retry);
    el.querySelector('.msg-main').insertBefore(error, el.querySelector('.msg-actions'));
  }
}

function updateStreamingEl(m) {
  const el = msgList.querySelector(`.msg[data-id="${m.id}"]`);
  if (!el) return;
  const body = el.querySelector('.msg-body');
  const isStreaming = state.streaming?.msgId === m.id;

  if (m.content) {
    body.innerHTML = renderMarkdown(m.content) + (isStreaming ? '<span class="caret"></span>' : '');
  }
  if (m.reasoning) {
    const thinking = el.querySelector('.thinking');
    thinking.classList.remove('hidden');
    thinking.querySelector('.thinking-body').textContent = m.reasoning;
  }
  if (m.usage) el.querySelector('.msg-meta').textContent = formatUsage(m.usage, m.model, m.speed, m.speedAverage);
  if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function scheduleStreamUpdate(m) {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    updateStreamingEl(m);
  });
}

function scrollToBottom(smooth = false) {
  stickToBottom = true;
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function updateComposerState() {
  const busy = !!state.streaming;
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  sendBtn.disabled = !input.value.trim();
  input.placeholder = busy ? '正在生成回复，可点击停止…' : '给 Nex 发送消息…';
}

function updateUsageHint() {
  const conv = activeConversation();
  const rounds = conv.messages.filter((m) => m.role === 'user').length;
  usageHint.textContent = rounds ? `本对话 ${rounds} 轮 · 数据仅保存在本机` : '';
}

function updateModelBadge() {
  modelBadge.textContent = state.settings.model;
}

function updateKeyStatus() {
  const hasKey = !!state.settings.apiKey;
  keyStatus.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = 'key-dot' + (hasKey || state.hasServerKey ? ' ok' : '');
  const label = document.createElement('span');
  if (hasKey) label.textContent = 'API Key 已配置';
  else if (state.hasServerKey) label.textContent = '使用服务端 API Key';
  else label.textContent = '未填写 API Key';
  keyStatus.append(dot, label);
}

/* ---------- Markdown 渲染 ---------- */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function renderInline(text) {
  const spans = [];
  let s = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    spans.push(code);
    return `\u0001${spans.length - 1}\u0001`;
  });
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(（])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${spans[Number(i)]}</code>`);
  return s;
}

function renderMarkdown(src) {
  if (!src) return '';
  const codeBlocks = [];
  const text = String(src).replace(/```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    codeBlocks.push({ lang, code: code.replace(/\n+$/, '') });
    return `\n\u0000C${codeBlocks.length - 1}\u0000\n`;
  });

  const html = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`<${list.type}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join('')}</${list.type}>`);
      list = null;
    }
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const codeMatch = trimmed.match(/^\u0000C(\d+)\u0000$/);
    if (codeMatch) {
      flushParagraph();
      flushList();
      const block = codeBlocks[Number(codeMatch[1])];
      html.push(
        `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(
          block.lang || 'code',
        )}</span><button type="button" data-act="copy-code">复制</button></div><pre><code>${escapeHtml(
          block.code,
        )}</code></pre></div>`,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length, 4);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push('<hr>');
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${renderInline(trimmed.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.*)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (unordered || ordered) {
      flushParagraph();
      const type = unordered ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((unordered || ordered)[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return html.join('');
}

/* ---------- 发送与流式接收 ---------- */

function buildApiMessages(conv, endExclusive) {
  const out = [];
  const system = state.settings.systemPrompt.trim();
  if (system) out.push({ role: 'system', content: system });
  for (const m of conv.messages.slice(0, endExclusive)) {
    if ((m.role === 'user' || m.role === 'assistant') && m.content && !m.error) {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

async function sendMessage(raw) {
  const text = (raw ?? input.value).trim();
  if (!text || state.streaming) return;

  if (!state.settings.apiKey && !state.hasServerKey) {
    toast('请先在设置中填写 MOSS API Key');
    openSettings();
    return;
  }

  const conv = activeConversation();
  conv.messages.push({ id: uid(), role: 'user', content: text, createdAt: Date.now() });
  if (conv.title === '新对话') conv.title = makeTitle(text);
  conv.updatedAt = Date.now();
  state.editingId = null;

  input.value = '';
  autoResize();
  stickToBottom = true;
  saveState();
  renderSidebar();
  renderMessages(true);
  await runCompletion(conv);
  saveState();
  renderSidebar();
}

async function runCompletion(conv) {
  const assistant = {
    id: uid(),
    role: 'assistant',
    content: '',
    reasoning: '',
    model: state.settings.model,
    createdAt: Date.now(),
  };
  const historyEnd = conv.messages.length;
  conv.messages.push(assistant);

  const controller = new AbortController();
  state.streaming = { controller, convId: conv.id, msgId: assistant.id };
  stickToBottom = true;
  renderMessages(true);

  const payload = {
    model: state.settings.model,
    messages: buildApiMessages(conv, historyEnd),
    max_tokens: state.settings.maxTokens,
    stream: !!state.settings.stream,
  };
  if (state.settings.thinking) payload.thinking = { type: 'enabled' };

  const startedAt = performance.now();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.settings.apiKey ? { Authorization: `Bearer ${state.settings.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(await readErrorResponse(res));

    if (payload.stream) {
      await consumeStream(res, assistant, startedAt);
    } else {
      const data = await res.json();
      const choice = Array.isArray(data.choices) && data.choices.length ? data.choices[0] : null;
      assistant.content = choice?.message?.content || '';
      assistant.reasoning = choice?.message?.reasoning_content || '';
      assistant.usage = data.usage || null;
      assistant.model = data.model || assistant.model;
      assistant.speed = computeSpeed(assistant.usage?.completion_tokens, performance.now() - startedAt);
      assistant.speedAverage = true;
      if (!assistant.content) assistant.error = '模型没有返回文本内容。';
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      assistant.stopped = true;
      if (!assistant.content && !assistant.reasoning) assistant.content = '（已停止生成）';
    } else {
      assistant.error = err.message || '请求失败';
    }
  } finally {
    if (state.streaming?.msgId === assistant.id) state.streaming = null;
    conv.updatedAt = Date.now();
    saveState();
    renderMessages();
    renderSidebar();
    updateComposerState();
    if (activeConversation()?.id === conv.id) scrollToBottom(true);
  }
}

async function consumeStream(res, assistant, startedAt) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let sawDone = false;
  let firstTokenAt = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    // SSE 以空行分隔事件；数据块可能被网络切成任意片段，需要保留残余
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (!data.length) continue;

      const payload = data.join('\n');
      if (payload === '[DONE]') {
        sawDone = true;
        continue;
      }

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json?.error) throw new Error(json.error.message || 'MOSS API 返回错误');

      if (json.model) assistant.model = json.model;
      if (json.usage) usage = json.usage;
      // 末尾的 usage 事件 choices 为空数组，先判断再取
      const choice = Array.isArray(json.choices) && json.choices.length ? json.choices[0] : null;
      const delta = choice?.delta || {};
      let changed = false;

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        assistant.reasoning += delta.reasoning_content;
        changed = true;
      }
      if (typeof delta.content === 'string' && delta.content) {
        assistant.content += delta.content;
        changed = true;
      }
      if (choice?.finish_reason === 'length') assistant.truncated = true;

      if (changed) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        scheduleStreamUpdate(assistant);
      }
    }
  }

  assistant.usage = usage;
  assistant.speed = computeSpeed(usage?.completion_tokens, performance.now() - (firstTokenAt ?? startedAt));
  if (assistant.truncated) {
    assistant.error = '输出达到 max_tokens 上限，回复被截断，可调大设置中的最大输出 Token。';
  } else if (!sawDone && !assistant.stopped) {
    assistant.error = assistant.content ? '连接提前结束，回复可能不完整。' : '连接提前结束，未收到回复内容。';
  }
}

async function readErrorResponse(res) {
  const fallback = `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
  let text = '';
  try {
    text = await res.text();
  } catch {}
  if (!text) return fallback;
  try {
    const data = JSON.parse(text);
    return data?.error?.message || data?.message || fallback;
  } catch {
    return `${fallback}：${text.slice(0, 200)}`;
  }
}

async function regenerate(msgId) {
  if (state.streaming) {
    toast('正在生成回复，请先停止');
    return;
  }
  const conv = activeConversation();
  const idx = conv.messages.findIndex((m) => m.id === msgId);
  if (idx <= 0) return;
  const prev = conv.messages[idx - 1];
  if (!prev || prev.role !== 'user') return;
  if (idx < conv.messages.length - 1 && !confirm('重新生成会删除这条回答之后的对话，继续？')) return;

  conv.messages.splice(idx);
  conv.updatedAt = Date.now();
  saveState();
  renderMessages();
  await runCompletion(conv);
  saveState();
  renderSidebar();
}

/* ---------- 复制 ---------- */

async function copyText(text) {
  if (!text) {
    toast('没有可复制的内容');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败');
    }
    ta.remove();
  }
}

/* ---------- 设置 ---------- */

function openSettings() {
  $('setApiKey').value = state.settings.apiKey;
  $('setModel').value = state.settings.model;
  $('setMaxTokens').value = state.settings.maxTokens;
  $('setSystemPrompt').value = state.settings.systemPrompt;
  $('setStream').checked = !!state.settings.stream;
  $('setThinking').checked = !!state.settings.thinking;
  settingsModal.hidden = false;
  $('setApiKey').focus();
}

function closeSettings() {
  settingsModal.hidden = true;
}

function saveSettings() {
  state.settings.apiKey = $('setApiKey').value.trim().replace(/^Bearer\s+/i, '');
  state.settings.model = $('setModel').value.trim() || DEFAULT_SETTINGS.model;
  state.settings.maxTokens = clampInt($('setMaxTokens').value, DEFAULT_SETTINGS.maxTokens, 1, 131072);
  state.settings.systemPrompt = $('setSystemPrompt').value;
  state.settings.stream = $('setStream').checked;
  state.settings.thinking = $('setThinking').checked;
  saveState();
  updateModelBadge();
  updateKeyStatus();
  closeSettings();
  toast('设置已保存');
}

function clearAllConversations() {
  if (!confirm('清空全部对话？本地记录将被删除，且无法恢复。')) return;
  if (state.streaming) state.streaming.controller.abort();
  state.conversations = [];
  const conv = createConversationData();
  state.conversations.push(conv);
  state.activeId = conv.id;
  saveState();
  renderSidebar();
  renderMessages(true);
  closeSettings();
  toast('已清空全部对话');
}

/* ---------- 主题与布局 ---------- */

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme === 'light' ? 'light' : 'dark';
}

function toggleTheme() {
  state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light';
  applyTheme();
  saveState();
}

function openSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.hidden = false;
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.hidden = true;
}

function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

/* ---------- 事件绑定 ---------- */

function bindEvents() {
  $('newChatBtn').addEventListener('click', newChat);
  $('settingsBtn').addEventListener('click', openSettings);
  $('themeBtn').addEventListener('click', toggleTheme);
  $('menuBtn').addEventListener('click', openSidebar);
  sidebarBackdrop.addEventListener('click', closeSidebar);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('clearAllBtn').addEventListener('click', clearAllConversations);

  for (const el of document.querySelectorAll('[data-close="settings"]')) {
    el.addEventListener('click', closeSettings);
  }

  sendBtn.addEventListener('click', () => sendMessage());
  stopBtn.addEventListener('click', () => state.streaming?.controller.abort());

  input.addEventListener('input', () => {
    autoResize();
    updateComposerState();
  });

  input.addEventListener('keydown', (e) => {
    // 中文输入法组合阶段的 Enter 不应触发发送
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messagesEl.addEventListener('scroll', () => {
    stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
  });

  emptyState.addEventListener('click', (e) => {
    const btn = e.target.closest('.suggestion');
    if (!btn) return;
    input.value = btn.dataset.prompt || btn.textContent.trim();
    autoResize();
    updateComposerState();
    sendMessage();
  });

  msgList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'copy-code') {
      const code = btn.closest('.code-block')?.querySelector('pre')?.textContent || '';
      await copyText(code);
      return;
    }

    const article = btn.closest('.msg');
    const msg = activeConversation()?.messages.find((m) => m.id === article?.dataset.id);
    if (!msg) return;

    if (act === 'copy') await copyText(msg.content || '');
    if (act === 'regen' || act === 'retry') await regenerate(msg.id);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!settingsModal.hidden) closeSettings();
    else closeSidebar();
  });
}

/* ---------- 启动 ---------- */

async function init() {
  loadState();
  applyTheme();
  bindEvents();
  renderSidebar();
  renderMessages(true);
  updateModelBadge();
  updateComposerState();
  autoResize();
  input.focus();

  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const data = await res.json();
      state.hasServerKey = !!data.hasServerKey;
    }
  } catch {}
  updateKeyStatus();

  if (!state.settings.apiKey && !state.hasServerKey) {
    setTimeout(() => {
      openSettings();
      toast('首次使用：请先填写 MOSS API Key');
    }, 350);
  }
}

init();
