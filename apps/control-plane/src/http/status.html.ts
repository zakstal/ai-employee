/**
 * Live status page for the sandbox fleet. Served as-is by `GET /status` (see server.ts).
 * Polls /runtime and /stats?since=1d every 5s; no build step, no framework, no CDN.
 */
export const STATUS_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ai-employee status</title>
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
  body { margin: 0; padding: 12px; background: var(--bg); color: var(--fg); font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
  header h1 { font-size: 16px; margin: 0; }
  header .meta { color: var(--muted); font-size: 12px; }
  section { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 10px; }
  .row { display: flex; flex-wrap: wrap; gap: 16px; }
  .col { flex: 1 1 260px; min-width: 0; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; background: var(--border); }
  .warning { background: var(--warn); color: #000; padding: 6px 8px; border-radius: 6px; margin-bottom: 10px; font-size: 12px; }
  .slots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); gap: 6px; }
  .slot { border: 1px solid var(--border); border-radius: 6px; padding: 6px; min-height: 54px; font-size: 11px; }
  .slot.empty { background: transparent; opacity: 0.4; }
  .slot.filled { background: color-mix(in srgb, var(--info) 12%, var(--card)); border-color: var(--info); }
  .slot-id { font-family: ui-monospace, monospace; font-weight: 600; }
  .slot-role { color: var(--muted); }
  .slot-elapsed { font-variant-numeric: tabular-nums; }
  ul.plain { list-style: none; margin: 0; padding: 0; }
  ul.plain li { padding: 3px 0; border-bottom: 1px dashed var(--border); }
  ul.plain li:last-child { border-bottom: none; }
  .mono { font-family: ui-monospace, monospace; }
  .empty { color: var(--muted); }
  .tree-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 3px 0; }
  .tree-row.awaiting { background: color-mix(in srgb, var(--warn) 15%, transparent); border-radius: 4px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .status-dot.done { background: var(--ok); }
  .status-dot.failed { background: var(--bad); }
  .status-dot.running { background: var(--info); }
  .status-dot.awaiting_input { background: var(--warn); }
  .status-dot.queued, .status-dot.cancelled, .status-dot.unknown { background: var(--muted); }
  .role { color: var(--muted); }
  .adapter { color: var(--muted); font-size: 11px; margin-left: auto; }
  .svg-wrap { overflow-x: auto; }
  .svg-wrap svg { display: block; }
  .tick { stroke: var(--border); stroke-width: 1; }
  .tick-label, .lane-label { fill: var(--muted); font-size: 10px; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .stat { text-align: center; }
  .stat .value { font-size: 20px; font-weight: 600; }
  .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; }
</style>
</head>
<body>
<header>
  <h1>ai-employee status</h1>
  <span class="meta" id="host"></span>
  <span class="meta" id="countdown"></span>
</header>

<section id="slots-section">
  <h2>Slots</h2>
  <div id="slots-warning" class="warning" hidden></div>
  <div class="row">
    <div class="col">
      <div style="margin-bottom:6px;"><span id="queued-badge" class="badge">queued: 0</span></div>
      <div class="slots-grid" id="slots-grid"></div>
    </div>
    <div class="col">
      <div style="color:var(--muted); margin-bottom:6px;">isolated (Cloud Run)</div>
      <ul class="plain" id="cloudrun-list"></ul>
    </div>
  </div>
</section>

<section>
  <h2>Task tree</h2>
  <div id="tree"></div>
</section>

<section>
  <h2>Timeline (24h)</h2>
  <div class="svg-wrap" id="timeline"></div>
</section>

<section>
  <h2>Today</h2>
  <div class="stat-grid">
    <div class="stat"><div class="value" id="today-tasks">-</div><div class="label">tasks</div></div>
    <div class="stat"><div class="value" id="today-done">-</div><div class="label">done</div></div>
    <div class="stat"><div class="value" id="today-failed">-</div><div class="label">failed</div></div>
    <div class="stat"><div class="value" id="today-cost">-</div><div class="label">est. cost</div></div>
    <div class="stat"><div class="value" id="today-tokens">-</div><div class="label">tokens</div></div>
  </div>
  <div style="color:var(--muted); margin-bottom:6px;">last 5 failed</div>
  <ul class="plain" id="failed-list"></ul>
</section>

<script>
(function () {
  var REFRESH_S = 5;
  var nextIn = REFRESH_S;

  document.getElementById('host').textContent = location.host;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtElapsed(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function statusColor(s) {
    if (s === 'done') return 'var(--ok)';
    if (s === 'failed') return 'var(--bad)';
    if (s === 'running') return 'var(--info)';
    if (s === 'awaiting_input') return 'var(--warn)';
    return 'var(--muted)';
  }

  function renderSlots(rt) {
    var warm = rt.warm || {};
    var activeById = {};
    (rt.active || []).forEach(function (t) { activeById[t.id] = t; });
    var grid = document.getElementById('slots-grid');
    var warnEl = document.getElementById('slots-warning');
    grid.innerHTML = '';
    if (warm.error) {
      warnEl.hidden = false;
      warnEl.textContent = 'warm runner unreachable: ' + warm.error;
      document.getElementById('queued-badge').textContent = 'queued: ?';
    } else {
      warnEl.hidden = true;
      var running = (warm.runs || []).filter(function (r) { return r.status === 'running'; });
      var capacity = warm.capacity || 0;
      for (var i = 0; i < capacity; i++) {
        var r = running[i];
        var box = document.createElement('div');
        box.className = 'slot ' + (r ? 'filled' : 'empty');
        if (r) {
          var t = activeById[r.runId];
          var elapsed = r.startedAt ? fmtElapsed(Date.now() - new Date(r.startedAt).getTime()) : '';
          box.innerHTML = '<div class="slot-id"><a href="/runs/' + encodeURIComponent(r.runId) + '/view">' + escapeHtml(r.runId.slice(-6)) + '</a></div>' +
            '<div class="slot-role">' + escapeHtml(t ? t.role : '?') + '</div>' +
            '<div class="slot-elapsed">' + elapsed + '</div>';
        }
        grid.appendChild(box);
      }
      document.getElementById('queued-badge').textContent = 'queued: ' + (warm.queued || 0);
    }

    var cloudList = document.getElementById('cloudrun-list');
    var cloudTasks = (rt.active || []).filter(function (t) { return t.adapter === 'cloudrun'; });
    cloudList.innerHTML = '';
    if (!cloudTasks.length) {
      cloudList.innerHTML = '<li class="empty">none</li>';
    } else {
      cloudTasks.forEach(function (t) {
        var li = document.createElement('li');
        var elapsed = fmtElapsed(Date.now() - new Date(t.created_at).getTime());
        li.innerHTML = '<a class="mono" href="/runs/' + encodeURIComponent(t.id) + '/view">' + escapeHtml(t.id.slice(-6)) + '</a> ' +
          '<span class="role">' + escapeHtml(t.role) + '</span> ' +
          '<span>' + elapsed + '</span>';
        cloudList.appendChild(li);
      });
    }
  }

  function renderTree(rt) {
    var all = {};
    (rt.recent || []).forEach(function (t) { all[t.id] = t; });
    (rt.active || []).forEach(function (t) { all[t.id] = t; }); // active is fresher, wins
    var children = {};
    var roots = [];
    Object.keys(all).forEach(function (id) {
      var t = all[id];
      var pid = t.parent_task_id;
      if (pid && all[pid]) {
        (children[pid] = children[pid] || []).push(t);
      } else {
        roots.push(t);
      }
    });

    function node(t, depth) {
      var wrap = document.createElement('div');
      var row = document.createElement('div');
      row.className = 'tree-row' + (t.status === 'awaiting_input' ? ' awaiting' : '');
      row.style.paddingLeft = (depth * 20) + 'px';
      var elapsed = fmtElapsed(Date.now() - new Date(t.created_at).getTime());
      var q = t.status === 'awaiting_input' && t.question ? (' — "' + escapeHtml(t.question) + '"') : '';
      row.innerHTML = '<span class="status-dot ' + t.status + '"></span>' +
        '<a class="mono" href="/runs/' + encodeURIComponent(t.id) + '/view">' + escapeHtml(t.id.slice(-8)) + '</a> ' +
        '<span class="role">' + escapeHtml(t.role) + '</span> ' +
        '<span class="badge">' + t.status + '</span>' + q + ' ' +
        '<span>' + elapsed + '</span>' +
        '<span class="adapter">' + escapeHtml(t.adapter || '') + '</span>';
      wrap.appendChild(row);
      (children[t.id] || []).forEach(function (c) { wrap.appendChild(node(c, depth + 1)); });
      return wrap;
    }

    var el = document.getElementById('tree');
    el.innerHTML = '';
    if (!roots.length) {
      el.innerHTML = '<div class="empty">no active tasks</div>';
      return;
    }
    roots.forEach(function (r) { el.appendChild(node(r, 0)); });
  }

  function renderTimeline(rt) {
    var container = document.getElementById('timeline');
    var width = Math.max(container.clientWidth || 0, 320);
    var lanes = ['warm', 'cloudrun', 'other'];
    var laneH = 28, padTop = 8, padLeft = 44, padRight = 8, padBottom = 18;
    var height = padTop + lanes.length * laneH + padBottom;
    var now = Date.now();
    var since = now - 24 * 3600 * 1000;
    function scaleX(t) {
      return padLeft + ((t - since) / (now - since)) * (width - padLeft - padRight);
    }

    var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '" xmlns="http://www.w3.org/2000/svg">';
    for (var h = 0; h <= 24; h += 3) {
      var x = scaleX(since + h * 3600 * 1000);
      svg += '<line x1="' + x + '" y1="' + padTop + '" x2="' + x + '" y2="' + (height - padBottom) + '" class="tick"/>';
      var label = new Date(since + h * 3600 * 1000).getHours().toString().padStart(2, '0') + ':00';
      svg += '<text x="' + x + '" y="' + (height - 4) + '" class="tick-label" text-anchor="middle">' + label + '</text>';
    }
    lanes.forEach(function (lane, i) {
      var y = padTop + i * laneH;
      svg += '<text x="0" y="' + (y + laneH / 2 + 4) + '" class="lane-label">' + lane + '</text>';
      var tasks = (rt.recent || []).filter(function (t) {
        var a = t.adapter || 'other';
        return lane === 'other' ? (a !== 'warm' && a !== 'cloudrun') : a === lane;
      });
      tasks.forEach(function (t) {
        var start = new Date(t.created_at).getTime();
        var end = new Date(t.updated_at || now).getTime();
        var x1 = scaleX(Math.max(start, since));
        var x2 = Math.max(x1 + 2, scaleX(Math.min(end, now)));
        var title = escapeHtml(t.id) + ' ' + escapeHtml(t.role) + (t.costUsd != null ? (' $' + Number(t.costUsd).toFixed(4)) : '');
        svg += '<rect x="' + x1 + '" y="' + (y + 4) + '" width="' + (x2 - x1) + '" height="' + (laneH - 8) + '" fill="' + statusColor(t.status) + '" rx="2"><title>' + title + '</title></rect>';
      });
    });
    svg += '</svg>';
    container.innerHTML = svg;
  }

  function renderToday(stats) {
    var t = stats.totals || {};
    document.getElementById('today-tasks').textContent = t.tasks || 0;
    document.getElementById('today-done').textContent = t.done || 0;
    document.getElementById('today-failed').textContent = t.failed || 0;
    document.getElementById('today-cost').textContent = '$' + Number(t.costUsd || 0).toFixed(4);
    document.getElementById('today-tokens').textContent = ((t.inputTokens || 0) + (t.outputTokens || 0)).toLocaleString();
  }

  function renderFailed(rt) {
    var failed = (rt.recent || [])
      .filter(function (t) { return t.status === 'failed'; })
      .sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); })
      .slice(0, 5);
    var el = document.getElementById('failed-list');
    el.innerHTML = '';
    if (!failed.length) {
      el.innerHTML = '<li class="empty">none</li>';
      return;
    }
    failed.forEach(function (t) {
      var li = document.createElement('li');
      li.innerHTML = '<a class="mono" href="/runs/' + encodeURIComponent(t.id) + '/view">' + escapeHtml(t.id.slice(-8)) + '</a> ' +
        '<span class="role">' + escapeHtml(t.role) + '</span> — ' + escapeHtml(t.resultText || '');
      el.appendChild(li);
    });
  }

  function renderCountdown() {
    document.getElementById('countdown').textContent = 'refresh in ' + nextIn + 's';
  }

  function refresh() {
    Promise.all([
      fetch('/runtime').then(function (r) { return r.json(); }),
      fetch('/stats?since=1d').then(function (r) { return r.json(); }),
    ]).then(function (results) {
      var rt = results[0], stats = results[1];
      renderSlots(rt);
      renderTree(rt);
      renderTimeline(rt);
      renderToday(stats);
      renderFailed(rt);
    }).catch(function (e) {
      document.getElementById('countdown').textContent = 'fetch error: ' + e.message;
    });
    nextIn = REFRESH_S;
    renderCountdown();
  }

  setInterval(function () {
    nextIn = nextIn <= 1 ? REFRESH_S : nextIn - 1;
    renderCountdown();
  }, 1000);
  setInterval(refresh, REFRESH_S * 1000);
  refresh();
})();
</script>
</body>
</html>
`;
