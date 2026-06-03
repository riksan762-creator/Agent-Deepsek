/* ═══════════════════════════════════════════════════════════════════
   RIKSAN AI — script.js
   Main Application Logic
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ─────────────────────────────────────────────────────
const STORAGE_KEY    = 'riksan_ai_sessions';
const ACTIVE_KEY     = 'riksan_ai_active';
const THEME_KEY      = 'riksan_ai_theme';
const MAX_HISTORY    = 60;   // max messages per session
const MAX_SESSIONS   = 30;

// ── State ──────────────────────────────────────────────────────────
let sessions       = {};    // { [id]: { id, title, messages, createdAt, updatedAt } }
let activeSession  = null;  // current session id
let isGenerating   = false;
let abortController = null;

// ── DOM Refs ───────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

const dom = {
  sidebar:        $('#sidebar'),
  sidebarToggle:  $('#sidebarToggle'),
  sidebarClose:   $('#sidebarClose'),
  sidebarOverlay: $('#sidebarOverlay'),
  newChatBtn:     $('#newChatBtn'),
  chatHistory:    $('#chatHistory'),
  chatContainer:  $('#chatContainer'),
  welcomeScreen:  $('#welcomeScreen'),
  messages:       $('#messages'),
  messageInput:   $('#messageInput'),
  sendBtn:        $('#sendBtn'),
  stopBtn:        $('#stopBtn'),
  clearChatBtn:   $('#clearChatBtn'),
  themeToggle:    $('#themeToggle'),
  themeLabel:     $('.theme-label'),
  topbarTitle:    $('#topbarTitle'),
  charCount:      $('#charCount'),
  toastContainer: $('#toastContainer'),
};

// ── Init ───────────────────────────────────────────────────────────
function init() {
  loadSessions();
  loadTheme();
  setupMarked();
  bindEvents();

  // Restore or create session
  const lastActive = localStorage.getItem(ACTIVE_KEY);
  if (lastActive && sessions[lastActive]) {
    loadSession(lastActive);
  } else {
    createNewSession();
  }
}

// ── Marked.js config ──────────────────────────────────────────────
function setupMarked() {
  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  // Custom renderer for code blocks
  const renderer = new marked.Renderer();

  renderer.code = function(code, language) {
    const lang = language || 'plaintext';
    let highlighted = code;
    try {
      if (hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } else {
        highlighted = hljs.highlightAuto(code).value;
      }
    } catch (_) {}

    const id = 'cb_' + Math.random().toString(36).slice(2, 9);
    return `
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-lang">${escapeHtml(lang)}</span>
          <button class="btn-copy-code" onclick="copyCode('${id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Copy
          </button>
        </div>
        <pre><code id="${id}" class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>
      </div>`;
  };

  marked.use({ renderer });
}

// ── Sessions ───────────────────────────────────────────────────────
function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    sessions = raw ? JSON.parse(raw) : {};
  } catch (_) {
    sessions = {};
  }
}

function saveSessions() {
  try {
    // Trim sessions if over limit
    const ids = Object.keys(sessions).sort((a, b) => (sessions[b].updatedAt || 0) - (sessions[a].updatedAt || 0));
    if (ids.length > MAX_SESSIONS) {
      ids.slice(MAX_SESSIONS).forEach(id => {
        if (id !== activeSession) delete sessions[id];
      });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch (_) {}
}

function createNewSession() {
  const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  sessions[id] = {
    id,
    title: 'New Chat',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveSessions();
  loadSession(id);
}

function loadSession(id) {
  activeSession = id;
  localStorage.setItem(ACTIVE_KEY, id);

  dom.messages.innerHTML = '';
  const session = sessions[id];

  if (session.messages.length === 0) {
    showWelcome();
  } else {
    hideWelcome();
    session.messages.forEach(msg => renderMessage(msg, false));
    scrollToBottom();
  }

  updateTopbarTitle(session.title);
  renderChatHistory();
}

function getSession() {
  return sessions[activeSession];
}

function updateSessionTitle(title) {
  const session = getSession();
  if (!session) return;
  session.title = title.slice(0, 60);
  session.updatedAt = Date.now();
  saveSessions();
  updateTopbarTitle(session.title);
  renderChatHistory();
}

function addMessage(role, content) {
  const session = getSession();
  if (!session) return null;

  const msg = {
    id: 'msg_' + Date.now(),
    role,
    content,
    timestamp: Date.now(),
  };

  session.messages.push(msg);

  // Trim if over max
  if (session.messages.length > MAX_HISTORY) {
    session.messages = session.messages.slice(-MAX_HISTORY);
  }

  session.updatedAt = Date.now();
  saveSessions();
  return msg;
}

function deleteSession(id) {
  delete sessions[id];
  saveSessions();

  if (activeSession === id) {
    const remaining = Object.keys(sessions);
    if (remaining.length > 0) {
      loadSession(remaining[0]);
    } else {
      createNewSession();
    }
  } else {
    renderChatHistory();
  }
}

// ── Render Chat History Sidebar ────────────────────────────────────
function renderChatHistory() {
  const sortedSessions = Object.values(sessions)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (sortedSessions.length === 0) {
    dom.chatHistory.innerHTML = `<div class="chat-history-empty">No chats yet</div>`;
    return;
  }

  dom.chatHistory.innerHTML = sortedSessions.map(session => {
    const isActive = session.id === activeSession;
    return `
      <div class="chat-history-item ${isActive ? 'active' : ''}" data-session-id="${session.id}">
        <svg class="chat-history-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="chat-history-item-text">${escapeHtml(session.title)}</span>
        <button class="chat-history-item-delete" data-delete-id="${session.id}" aria-label="Delete chat">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>`;
  }).join('');
}

// ── Welcome Screen ─────────────────────────────────────────────────
function showWelcome() {
  dom.welcomeScreen.style.display = 'flex';
  dom.messages.style.display = 'none';
}

function hideWelcome() {
  dom.welcomeScreen.style.display = 'none';
  dom.messages.style.display = 'flex';
}

// ── Render Message ─────────────────────────────────────────────────
function renderMessage(msg, animate = true) {
  hideWelcome();
  const el = document.createElement('div');
  el.classList.add('message', msg.role);
  if (!animate) el.style.animation = 'none';
  el.dataset.msgId = msg.id;

  const time = formatTime(msg.timestamp);

  if (msg.role === 'user') {
    el.innerHTML = `
      <div class="message-avatar">U</div>
      <div class="message-content">
        <div class="message-header">
          <span class="message-role">You</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-body">${escapeHtml(msg.content)}</div>
      </div>`;
  } else {
    const html = renderMarkdown(msg.content);
    el.innerHTML = `
      <div class="message-avatar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="message-content">
        <div class="message-header">
          <span class="message-role">Riksan AI</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-body">${html}</div>
        <div class="message-actions">
          <button class="btn-msg-action" onclick="copyMessageText('${msg.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Copy
          </button>
          <button class="btn-msg-action" onclick="regenerateResponse('${msg.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Regenerate
          </button>
        </div>
      </div>`;
  }

  dom.messages.appendChild(el);
  return el;
}

// ── Streaming Message ──────────────────────────────────────────────
function createStreamingMessage() {
  hideWelcome();
  const el = document.createElement('div');
  el.classList.add('message', 'assistant');
  el.id = 'streaming-msg';

  el.innerHTML = `
    <div class="message-avatar">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-role">Riksan AI</span>
        <span class="message-time">${formatTime(Date.now())}</span>
      </div>
      <div class="message-body stream-body">
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    </div>`;

  dom.messages.appendChild(el);
  scrollToBottom();
  return el;
}

function updateStreamingMessage(el, text, done = false) {
  const body = el.querySelector('.stream-body');
  if (!body) return;

  const html = renderMarkdown(text);
  body.innerHTML = done ? html : html + '<span class="stream-cursor"></span>';
  scrollToBottom();
}

function finalizeStreamingMessage(el, msg) {
  el.id = '';
  el.dataset.msgId = msg.id;
  const body = el.querySelector('.stream-body');
  if (body) {
    body.classList.remove('stream-body');
    body.innerHTML = renderMarkdown(msg.content);
  }

  // Add action buttons
  const content = el.querySelector('.message-content');
  if (content) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.innerHTML = `
      <button class="btn-msg-action" onclick="copyMessageText('${msg.id}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        Copy
      </button>
      <button class="btn-msg-action" onclick="regenerateResponse('${msg.id}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
        Regenerate
      </button>`;
    content.appendChild(actions);
  }
}

// ── Send Message ───────────────────────────────────────────────────
async function sendMessage(content) {
  content = sanitizeInput(content.trim());
  if (!content || isGenerating) return;

  const session = getSession();
  if (!session) return;

  // Auto-title on first message
  if (session.messages.length === 0) {
    updateSessionTitle(content.length > 45 ? content.slice(0, 45) + '…' : content);
  }

  // Add user message
  const userMsg = addMessage('user', content);
  renderMessage(userMsg);
  scrollToBottom();

  // Clear input
  dom.messageInput.value = '';
  autoResizeTextarea();
  updateCharCount();

  // Set generating state
  setGenerating(true);

  // Create streaming message element
  const streamEl = createStreamingMessage();
  let accumulated = '';

  try {
    abortController = new AbortController();

    // Build messages array (include history for context)
    const contextMessages = buildContextMessages(session.messages.slice(0, -1), content);

    const onChunk = (chunk) => {
      accumulated += chunk;
      updateStreamingMessage(streamEl, accumulated);
    };

    await RiksanAPI.streamChat(contextMessages, onChunk, abortController.signal);

    // Finalize
    if (accumulated.trim()) {
      const aiMsg = addMessage('assistant', accumulated);
      finalizeStreamingMessage(streamEl, aiMsg);
    } else {
      streamEl.remove();
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      // Stopped by user
      if (accumulated.trim()) {
        const aiMsg = addMessage('assistant', accumulated + '\n\n*[Generation stopped]*');
        finalizeStreamingMessage(streamEl, aiMsg);
      } else {
        streamEl.remove();
      }
    } else {
      streamEl.remove();
      const errMsg = getErrorMessage(err);
      showToast(errMsg, 'error');

      // Add error message
      const errorMsg = addMessage('assistant', `⚠️ ${errMsg}\n\nPlease try again.`);
      renderMessage(errorMsg);
    }
  } finally {
    setGenerating(false);
    abortController = null;
    scrollToBottom();
  }
}

function buildContextMessages(history, currentContent) {
  // Use last 20 messages for context
  const contextHistory = history.slice(-20);
  const msgs = contextHistory.map(m => ({ role: m.role, content: m.content }));
  msgs.push({ role: 'user', content: currentContent });
  return msgs;
}

// ── Regenerate ─────────────────────────────────────────────────────
window.regenerateResponse = async function(msgId) {
  if (isGenerating) return;

  const session = getSession();
  if (!session) return;

  // Find the assistant message and get the preceding user message
  const idx = session.messages.findIndex(m => m.id === msgId);
  if (idx < 1) return;

  const userMsg = session.messages[idx - 1];
  if (!userMsg || userMsg.role !== 'user') return;

  // Remove the assistant message from session
  session.messages.splice(idx, 1);
  saveSessions();

  // Remove from DOM
  const el = dom.messages.querySelector(`[data-msg-id="${msgId}"]`);
  if (el) el.remove();

  // Re-send
  setGenerating(true);
  const streamEl = createStreamingMessage();
  let accumulated = '';

  try {
    abortController = new AbortController();
    const contextMessages = buildContextMessages(session.messages.slice(0, -1), userMsg.content);

    await RiksanAPI.streamChat(contextMessages, (chunk) => {
      accumulated += chunk;
      updateStreamingMessage(streamEl, accumulated);
    }, abortController.signal);

    if (accumulated.trim()) {
      const aiMsg = addMessage('assistant', accumulated);
      finalizeStreamingMessage(streamEl, aiMsg);
    } else {
      streamEl.remove();
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      streamEl.remove();
      showToast(getErrorMessage(err), 'error');
    } else if (accumulated.trim()) {
      const aiMsg = addMessage('assistant', accumulated);
      finalizeStreamingMessage(streamEl, aiMsg);
    } else {
      streamEl.remove();
    }
  } finally {
    setGenerating(false);
    abortController = null;
    scrollToBottom();
  }
};

// ── Copy Functions ─────────────────────────────────────────────────
window.copyCode = function(id) {
  const el = document.getElementById(id);
  if (!el) return;
  copyToClipboard(el.textContent, null);

  const btn = el.closest('.code-block-wrapper')?.querySelector('.btn-copy-code');
  if (btn) {
    btn.classList.add('copied');
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
    }, 2000);
  }
};

window.copyMessageText = function(msgId) {
  const session = getSession();
  if (!session) return;
  const msg = session.messages.find(m => m.id === msgId);
  if (!msg) return;

  copyToClipboard(msg.content, () => {
    const btn = dom.messages.querySelector(`[data-msg-id="${msgId}"] .btn-msg-action`);
    if (btn) {
      btn.classList.add('copied');
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
      }, 2000);
    }
    showToast('Copied to clipboard', 'success');
  });
};

function copyToClipboard(text, callback) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      callback?.();
    }).catch(() => fallbackCopy(text, callback));
  } else {
    fallbackCopy(text, callback);
  }
}

function fallbackCopy(text, callback) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); callback?.(); } catch (_) {}
  ta.remove();
}

// ── UI State ───────────────────────────────────────────────────────
function setGenerating(state) {
  isGenerating = state;
  dom.sendBtn.disabled = state;
  dom.sendBtn.classList.toggle('hidden', state);
  dom.stopBtn.classList.toggle('hidden', !state);
  dom.messageInput.disabled = state;
}

// ── Theme ──────────────────────────────────────────────────────────
function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const label = dom.themeLabel;
  if (label) label.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
  localStorage.setItem(THEME_KEY, theme);
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ── Sidebar ────────────────────────────────────────────────────────
function openSidebar() {
  dom.sidebar.classList.add('open');
  dom.sidebarOverlay.classList.add('active');
}

function closeSidebar() {
  dom.sidebar.classList.remove('open');
  dom.sidebarOverlay.classList.remove('active');
}

// ── Clear Chat ─────────────────────────────────────────────────────
function clearCurrentChat() {
  const session = getSession();
  if (!session) return;
  if (session.messages.length === 0) return;

  if (confirm('Clear all messages in this chat?')) {
    session.messages = [];
    session.title = 'New Chat';
    session.updatedAt = Date.now();
    saveSessions();
    dom.messages.innerHTML = '';
    showWelcome();
    updateTopbarTitle('New Chat');
    renderChatHistory();
  }
}

// ── Helpers ────────────────────────────────────────────────────────
function scrollToBottom() {
  requestAnimationFrame(() => {
    dom.chatContainer.scrollTop = dom.chatContainer.scrollHeight;
  });
}

function updateTopbarTitle(title) {
  dom.topbarTitle.textContent = title || 'Riksan AI';
}

function autoResizeTextarea() {
  const ta = dom.messageInput;
  ta.style.height = 'auto';
  const maxH = 220;
  ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px';
}

function updateCharCount() {
  const len = dom.messageInput.value.length;
  const max = 32000;
  dom.charCount.textContent = len > 1000 ? `${(len/1000).toFixed(1)}k` : '';
  dom.charCount.style.color = len > max * 0.9 ? '#ef4444' : '';
}

function sanitizeInput(str) {
  return str.replace(/[\u0000-\u001F\u007F]/g, c =>
    c === '\n' || c === '\t' ? c : ''
  ).slice(0, 32000);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderMarkdown(text) {
  try {
    const raw = marked.parse(text || '');
    return DOMPurify.sanitize(raw, {
      ADD_TAGS: ['code', 'pre'],
      ADD_ATTR: ['id', 'onclick', 'class'],
      ALLOW_DATA_ATTR: false,
    });
  } catch (_) {
    return escapeHtml(text);
  }
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getErrorMessage(err) {
  if (!navigator.onLine) return 'No internet connection';
  if (err.message?.includes('timeout')) return 'Request timed out. Please try again.';
  if (err.message?.includes('429')) return 'Rate limit reached. Please wait a moment.';
  if (err.message?.includes('500')) return 'Server error. Please try again.';
  if (err.message?.includes('401')) return 'Authentication error. Check your API key.';
  return err.message || 'Something went wrong. Please try again.';
}

// ── Toast ──────────────────────────────────────────────────────────
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icon = type === 'success'
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  toast.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 250);
  }, 3000);
}

// ── Events ─────────────────────────────────────────────────────────
function bindEvents() {
  // Send on Enter (not Shift+Enter)
  dom.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(dom.messageInput.value);
    }
  });

  dom.messageInput.addEventListener('input', () => {
    autoResizeTextarea();
    updateCharCount();
  });

  dom.sendBtn.addEventListener('click', () => {
    sendMessage(dom.messageInput.value);
  });

  dom.stopBtn.addEventListener('click', () => {
    if (abortController) {
      abortController.abort();
    }
  });

  dom.newChatBtn.addEventListener('click', () => {
    if (!isGenerating) createNewSession();
  });

  dom.clearChatBtn.addEventListener('click', clearCurrentChat);

  dom.themeToggle.addEventListener('click', toggleTheme);

  dom.sidebarToggle.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      openSidebar();
    } else {
      dom.sidebar.classList.toggle('collapsed');
    }
  });

  dom.sidebarClose.addEventListener('click', closeSidebar);
  dom.sidebarOverlay.addEventListener('click', closeSidebar);

  // Chat history delegation
  dom.chatHistory.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('[data-delete-id]');
    const item = e.target.closest('[data-session-id]');

    if (deleteBtn) {
      e.stopPropagation();
      const id = deleteBtn.dataset.deleteId;
      if (confirm('Delete this chat?')) deleteSession(id);
      return;
    }

    if (item) {
      const id = item.dataset.sessionId;
      if (id !== activeSession) loadSession(id);
      if (window.innerWidth <= 768) closeSidebar();
    }
  });

  // Suggestion cards
  dom.welcomeScreen.addEventListener('click', (e) => {
    const card = e.target.closest('.suggestion-card');
    if (card) {
      const prompt = card.dataset.prompt;
      if (prompt) {
        dom.messageInput.value = prompt;
        autoResizeTextarea();
        sendMessage(prompt);
      }
    }
  });

  // Paste handling
  dom.messageInput.addEventListener('paste', () => {
    setTimeout(() => {
      autoResizeTextarea();
      updateCharCount();
    }, 0);
  });
}

// ── Start ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
