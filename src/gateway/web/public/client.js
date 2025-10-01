(() => {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const msgs = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const accountSelect = document.getElementById('accountSelect');
  const addAccountBtn = document.getElementById('addAccount');
  const removeAccountBtn = document.getElementById('removeAccount');

  const LS_KEY = 'beacon_web_accounts';
  let accounts = [];
  let active = null;

  function loadAccounts() {
    try { accounts = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { accounts = []; }
    if (!Array.isArray(accounts)) accounts = [];
    if (!active || !accounts.find(a => a === active)) active = accounts[0] || null;
    renderAccounts();
  }

  function saveAccounts() {
    localStorage.setItem(LS_KEY, JSON.stringify(accounts));
  }

  function renderAccounts() {
    accountSelect.innerHTML = '';
    accounts.forEach((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      if (id === active) opt.selected = true;
      accountSelect.appendChild(opt);
    });
    accountSelect.disabled = accounts.length === 0;
  }

  function add(type, text) {
    const el = document.createElement('div');
    el.className = `msg ${type}`;
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function loadHistory() {
    msgs.innerHTML = '';
    if (!active) return;
    try {
      const res = await fetch(`/api/history?account=${encodeURIComponent(active)}&limit=200`);
      const data = await res.json();
      const items = data.items || [];
      for (const m of items) {
        const c = m.content || {};
        // Render messages sent by this account as 'me'; messages to this account as 'them'
        if (c && c.from === active) add('me', c.text || '');
        else if (c && c.to === active) add('them', c.text || '');
      }
    } catch {}
  }

  ws.onmessage = (ev) => {
    try {
      const { event, payload } = JSON.parse(ev.data);
      if (event === 'hello') {
        // Ensure default account presence if provided by server
        const def = payload && payload.defaultWebId;
        if (def && !accounts.includes(def)) {
          accounts.push(def);
          active = active || def;
          saveAccounts();
          renderAccounts();
          loadHistory();
        }
      } else if (event === 'inbound_ack') {
        add('me', payload.text);
      } else if (event === 'outbound') {
        // Filter to active account if set
        if (!active || (payload.to && payload.to !== active)) return;
        add('them', payload.text || '');
      }
    } catch {}
  };

  function send() {
    const text = input.value.trim();
    if (!text) return;
    if (!active) { alert('Add/select an account ID first'); return; }
    ws.send(JSON.stringify({ event: 'send', payload: { text, from: active } }));
    input.value = '';
  }

  sendBtn.onclick = send;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  addAccountBtn.onclick = () => {
    const id = prompt('Enter new account ID (e.g., random number)');
    const trimmed = (id || '').trim();
    if (!trimmed) return;
    if (!accounts.includes(trimmed)) {
      accounts.push(trimmed);
      active = trimmed;
      saveAccounts();
      renderAccounts();
      loadHistory();
    } else {
      active = trimmed;
      renderAccounts();
      loadHistory();
    }
  };

  removeAccountBtn.onclick = () => {
    if (!active) return;
    const idx = accounts.indexOf(active);
    if (idx !== -1) {
      accounts.splice(idx, 1);
      // Choose next active
      active = accounts[idx] || accounts[idx - 1] || accounts[0] || null;
      saveAccounts();
      renderAccounts();
      loadHistory();
    }
  };

  accountSelect.onchange = () => { active = accountSelect.value || null; loadHistory(); };

  loadAccounts();
  loadHistory();
})();
