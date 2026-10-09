'use strict';

const STATUS_REFRESH_MS = 1500;

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response);
    });
  });
}

function setConnected(connected) {
  const state = document.getElementById('connState');
  if (state) {
    state.textContent = connected ? 'متصل' : 'قطع';
    state.className = `badge ${connected ? 'badge-on' : 'badge-off'}`;
  }
  const button = document.getElementById('toggleBtn');
  if (button) button.textContent = connected ? 'توقف' : 'شروع';
}

function validDeepSeekUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chat.deepseek.com';
  } catch {
    return false;
  }
}

async function refresh() {
  const status = await send({ type: 'get-status' });
  if (!status || status.ok === false) return;
  setConnected(Boolean(status.connected));
  const active = document.getElementById('activeReq');
  if (active) active.textContent = status.activeRequests?.length ? status.activeRequests.join(', ') : '—';
  const input = document.getElementById('targetUrl');
  if (input && document.activeElement !== input && status.targetUrl) input.value = status.targetUrl;
}

document.getElementById('openTarget')?.addEventListener('click', async () => {
  const input = document.getElementById('targetUrl');
  const value = input?.value.trim() || '';
  if (!validDeepSeekUrl(value)) {
    window.alert('لطفاً یک URL معتبر https://chat.deepseek.com/ وارد کنید.');
    return;
  }
  const result = await send({ type: 'open-tab', url: value });
  if (result?.ok) {
    input.value = value;
    if (result.targetSaved === false) {
      window.alert('تب باز شد، اما bridge متصل نیست؛ URL پیش‌فرض روی سرور ثبت نشد.');
    }
    setTimeout(refresh, 800);
  } else if (result?.error) {
    window.alert(result.error);
  }
});

document.getElementById('toggleBtn')?.addEventListener('click', async () => {
  const status = await send({ type: 'get-status' });
  await send({ type: status?.connected ? 'stop' : 'start' });
  setTimeout(refresh, 400);
});

document.getElementById('reloadBtn')?.addEventListener('click', () => chrome.runtime.reload());

document.getElementById('debugDom')?.addEventListener('click', async () => {
  const input = document.getElementById('targetUrl');
  const output = document.getElementById('debugOutput');
  if (output) output.textContent = 'در حال بررسی...';
  const result = await send({ type: 'debug-dom', url: input?.value.trim() || '' });
  if (output) {
    output.textContent = result?.ok
      ? JSON.stringify(result.debug, null, 2)
      : (result?.error || 'تشخیص ناموفق بود');
  }
});

document.getElementById('version').textContent = 'v0.4.0';
refresh();
setInterval(refresh, STATUS_REFRESH_MS);
