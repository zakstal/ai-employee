/**
 * One run, readable: header facts plus the event stream rendered as a transcript.
 * Served by `GET /runs/:id/view` (see server.ts). Reads `GET /tasks/:id` and `GET /tasks/:id/events`,
 * polls every 5s while the run is live, and stops once it reaches a terminal state.
 * No build step, no framework, no CDN — same rules as the status page.
 */
export const RUN_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>run</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f8; --fg: #1a1a1a; --muted: #8a8a8a; --border: #ddd; --card: #fff;
    --ok: #22863a; --bad: #d1242f; --info: #0969da; --warn: #bf8700;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16171a; --fg: #e6e6e6; --muted: #999; --border: #333; --card: #202225; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; background: var(--bg); color: var(--fg); font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  a { color: var(--info); }
  header { margin-bottom: 12px; }
  header h1 { font-size: 15px; margin: 0 0 4px; font-family: ui-monospace, monospace; word-break: break-all; }
  header .meta { color: var(--muted); font-size: 12px; }
  section { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 8px; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
  .fact .value { font-size: 17px; font-weight: 600; }
  .fact .label { color: var(--muted); font-size: 11px; text-transform: uppercase; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; background: var(--border); }
  .badge.done { background: var(--ok); color: #fff; }
  .badge.failed, .badge.cancelled { background: var(--bad); color: #fff; }
  .badge.running, .badge.queued { background: var(--info); color: #fff; }
  .badge.awaiting_input { background: var(--warn); color: #000; }
  .ev { border-top: 1px solid var(--border); padding: 7px 0; }
  .ev:first-child { border-top: none; }
  .ev .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .ev .seq { color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; min-width: 28px; }
  .ev .kind { font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
  .ev.assistant_text .kind { color: var(--fg); }
  .ev.tool_use .kind { color: var(--info); }
  .ev.error .kind, .ev.tool_result.iserror .kind { color: var(--bad); }
  .ev .tool { font-family: ui-monospace, monospace; font-weight: 600; }
  .ev .ts { color: var(--muted); font-size: 11px; margin-left: auto; font-variant-numeric: tabular-nums; }
  pre { margin: 4px 0 0; padding: 7px 9px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
        font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
  pre.text { background: transparent; border: none; padding: 4px 0 0; font: inherit; white-space: pre-wrap; }
  .empty { color: var(--muted); }
  .controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
  details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <div class="meta"><a href="/status">&larr; status</a></div>
  <h1 id="title">loading…</h1>
  <div class="meta" id="sub"></div>
</header>

<section>
  <h2>Run</h2>
  <div class="facts" id="facts"></div>
  <div id="result-wrap" style="margin-top:10px"></div>
</section>

<section>
  <h2>Transcript</h2>
  <div class="controls">
    <label><input type="checkbox" id="show-results" checked> tool results</label>
    <label><input type="checkbox" id="follow" checked> follow</label>
    <span id="count"></span>
  </div>
  <div id="events" style="margin-top:8px"><div class="empty">loading…</div></div>
</section>

<script>
  var TASK_ID = decodeURIComponent(location.pathname.replace(/^\\/runs\\//, '').replace(/\\/view$/, ''));
  var TERMINAL = { done: 1, failed: 1, cancelled: 1 };
  var seen = 0;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clip(v, n) {
    var s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    if (s == null) return '';
    return s.length > n ? s.slice(0, n) + '\\n… (' + (s.length - n) + ' more characters)' : s;
  }
  function fmtMoney(n) { return n == null ? '—' : '$' + Number(n).toFixed(2); }
  function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString(); } catch (e) { return ''; } }

  /** The one line worth reading for each event type. */
  function summary(e) {
    if (e.type === 'tool_use') {
      var i = e.input || {};
      return i.command || i.file_path || i.pattern || i.path || i.description || clip(i, 200);
    }
    if (e.type === 'assistant_text' || e.type === 'result') return e.text || '';
    if (e.type === 'error') return e.message || '';
    if (e.type === 'exit') return 'exit code ' + e.code;
    if (e.type === 'started') return (e.harness || '') + (e.model ? ' · ' + e.model : '') + (e.sessionId ? ' · session ' + e.sessionId.slice(0, 8) : '');
    if (e.type === 'tool_result') return clip(e.output, 1200);
    return '';
  }

  function renderFacts(t) {
    document.getElementById('title').textContent = t.id;
    document.getElementById('sub').innerHTML =
      '<span class="badge ' + t.status + '">' + escapeHtml(t.status) + '</span> ' +
      escapeHtml(t.role_id || '') + (t.parent_task_id ? ' · child of <a href="/runs/' + encodeURIComponent(t.parent_task_id) + '/view">' + escapeHtml(t.parent_task_id.slice(-10)) + '</a>' : '');
    var r = t.result || {};
    var facts = [
      ['turns', r.numTurns == null ? '—' : r.numTurns],
      ['cost', fmtMoney(r.costUsd)],
      ['started', fmtTime(t.created_at)],
      ['updated', fmtTime(t.updated_at)],
    ];
    if (r.exit) facts.push(['exit', r.exit.code + (r.exit.reason ? ' ' + r.exit.reason : '')]);
    document.getElementById('facts').innerHTML = facts.map(function (f) {
      return '<div class="fact"><div class="value">' + escapeHtml(f[1]) + '</div><div class="label">' + f[0] + '</div></div>';
    }).join('');
    var rw = document.getElementById('result-wrap');
    rw.innerHTML = r.text ? '<h2>Result</h2><pre class="text">' + escapeHtml(r.text) + '</pre>' : '';
  }

  function renderEvents(events) {
    var showResults = document.getElementById('show-results').checked;
    var el = document.getElementById('events');
    var list = events.filter(function (e) { return showResults || e.type !== 'tool_result'; });
    document.getElementById('count').textContent = events.length + ' events';
    if (!list.length) { el.innerHTML = '<div class="empty">no events yet</div>'; return; }
    el.innerHTML = list.map(function (e) {
      var cls = 'ev ' + e.type + (e.isError ? ' iserror' : '');
      var label = e.type === 'tool_use' ? '<span class="tool">' + escapeHtml(e.tool || 'tool') + '</span>' : '';
      var body = summary(e);
      var long = body.length > 160 || body.indexOf('\\n') >= 0;
      var pre = e.type === 'assistant_text' || e.type === 'result' ? 'text' : '';
      return '<div class="' + cls + '">' +
        '<div class="head"><span class="seq">' + e.seq + '</span>' +
        '<span class="kind">' + escapeHtml(e.type.replace(/_/g, ' ')) + '</span>' + label +
        (long ? '' : '<span>' + escapeHtml(body) + '</span>') +
        '<span class="ts">' + fmtTime(e.ts) + '</span></div>' +
        (long ? '<pre class="' + pre + '">' + escapeHtml(body) + '</pre>' : '') +
        '</div>';
    }).join('');
  }

  async function tick() {
    try {
      var t = await (await fetch('/tasks/' + encodeURIComponent(TASK_ID))).json();
      if (t.error) { document.getElementById('title').textContent = TASK_ID + ' — not found'; return; }
      renderFacts(t);
      var ev = await (await fetch('/tasks/' + encodeURIComponent(TASK_ID) + '/events')).json();
      var events = Array.isArray(ev) ? ev : (ev.events || []);
      var grew = events.length > seen;
      seen = events.length;
      renderEvents(events);
      if (grew && document.getElementById('follow').checked) window.scrollTo(0, document.body.scrollHeight);
      if (TERMINAL[t.status]) return; // stop polling once it is over
    } catch (e) { /* transient: try again on the next tick */ }
    setTimeout(tick, 5000);
  }
  document.getElementById('show-results').addEventListener('change', function () { seen = 0; tick(); });
  tick();
</script>
</body>
</html>`;
