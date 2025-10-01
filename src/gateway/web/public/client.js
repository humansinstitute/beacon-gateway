(() => {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const msgs = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const userEl = document.getElementById('userId');

  function add(type, text) {
    const el = document.createElement('div');
    el.className = `msg ${type}`;
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  ws.onmessage = (ev) => {
    try {
      const { event, payload } = JSON.parse(ev.data);
      if (event === 'hello') {
        userEl.textContent = payload.webId;
      } else if (event === 'inbound_ack') {
        add('me', payload.text);
      } else if (event === 'outbound') {
        add('them', payload.text || '');
      }
    } catch {}
  };

  function send() {
    const text = input.value.trim();
    if (!text) return;
    ws.send(JSON.stringify({ event: 'send', payload: { text } }));
    input.value = '';
  }

  sendBtn.onclick = send;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
})();

