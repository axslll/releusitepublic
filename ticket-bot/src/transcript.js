/**
 * Discord-style HTML transcripts.
 *
 * `toMessageData` turns discord.js messages into plain objects, and `renderTranscript` turns those
 * into one self-contained HTML page that looks like Discord's dark theme - including the bot's own
 * Components V2 containers (ticket card, AI replies, notices). Keeping the renderer on plain data
 * means it can be tested without a Discord connection.
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const hex = (n) => (typeof n === 'number' ? `#${n.toString(16).padStart(6, '0')}` : null);

const TIME_FORMATS = {
  t: { hour: 'numeric', minute: '2-digit' },
  T: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  d: { year: 'numeric', month: '2-digit', day: '2-digit' },
  D: { year: 'numeric', month: 'long', day: 'numeric' },
  f: { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  F: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
};

function formatStamp(seconds, style = 'f') {
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  if (style === 'R') return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return date.toLocaleString('en-US', { ...(TIME_FORMATS[style] ?? TIME_FORMATS.f), timeZone: 'UTC' });
}

/** Renders the Discord markdown subset that bots and people actually use. Input is untrusted: everything is escaped. */
export function renderMarkdown(raw, r = {}) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let t = String(raw ?? '');
  t = t.replace(/```(?:[\w+-]*\n)?([\s\S]*?)```/g, (_, code) => keep(`<pre><code>${esc(code.replace(/^\n|\n$/g, ''))}</code></pre>`));
  t = t.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code class="inline">${esc(c)}</code>`));
  t = esc(t);

  t = t.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => keep(`<span class="mention">@${esc(r.user?.(id) ?? 'Unknown user')}</span>`));
  t = t.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => keep(`<span class="mention">@${esc(r.role?.(id) ?? 'Unknown role')}</span>`));
  t = t.replace(/&lt;#(\d+)&gt;/g, (_, id) => keep(`<span class="mention">#${esc(r.channel?.(id) ?? 'unknown-channel')}</span>`));
  t = t.replace(/@(everyone|here)\b/g, (m) => keep(`<span class="mention">${m}</span>`));
  t = t.replace(/&lt;(a?):(\w+):(\d+)&gt;/g, (_, anim, name, id) =>
    keep(`<img class="emoji" src="https://cdn.discordapp.com/emojis/${id}.${anim ? 'gif' : 'webp'}?size=48" alt=":${esc(name)}:" title=":${esc(name)}:">`),
  );
  t = t.replace(/&lt;t:(-?\d+)(?::([tTdDfFR]))?&gt;/g, (_, sec, style) => keep(`<span class="time-chip">${esc(formatStamp(sec, style))}</span>`));
  t = t.replace(/(https?:\/\/[^\s<]+?)(?=[.,;:!?)]*(?:\s|$|&lt;))/g, (url) => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));

  const inline = (s) =>
    s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<u>$1</u>')
      .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler">$1</span>');

  const lines = t.split('\n').map((line) => {
    let m;
    if ((m = line.match(/^### (.*)$/))) return `<div class="h3">${inline(m[1])}</div>`;
    if ((m = line.match(/^## (.*)$/))) return `<div class="h2">${inline(m[1])}</div>`;
    if ((m = line.match(/^# (.*)$/))) return `<div class="h1">${inline(m[1])}</div>`;
    if ((m = line.match(/^-# (.*)$/))) return `<div class="subtext">${inline(m[1])}</div>`;
    if ((m = line.match(/^&gt; (.*)$/))) return `<div class="quote">${inline(m[1])}</div>`;
    if ((m = line.match(/^[-*] (.*)$/))) return `<div class="li">${inline(m[1])}</div>`;
    return line.trim() ? `<div>${inline(line)}</div>` : '<div class="blank"></div>';
  });

  let html = lines.join('');
  for (let i = 0; i < 3 && /\u0000\d+\u0000/.test(html); i++) html = html.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)]);
  return html;
}

/* ------------------------------ components ------------------------------ */

const BUTTON_STYLE = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link' };

function renderEmoji(e) {
  if (!e) return '';
  return e.id
    ? `<img class="emoji" src="https://cdn.discordapp.com/emojis/${esc(e.id)}.webp?size=32" alt="">`
    : `<span class="btn-emoji">${esc(e.name ?? '')}</span>`;
}

function renderComponent(c, r) {
  if (!c) return '';
  switch (c.type) {
    case 17: {
      const color = hex(c.accent_color);
      return `<div class="container"${color ? ` style="border-left-color:${color}"` : ''}>${(c.components ?? []).map((x) => renderComponent(x, r)).join('')}</div>`;
    }
    case 10:
      return `<div class="text">${renderMarkdown(c.content, r)}</div>`;
    case 14:
      return c.divider === false ? '<div class="gap"></div>' : '<hr class="sep">';
    case 1:
      return `<div class="row">${(c.components ?? []).map((x) => renderComponent(x, r)).join('')}</div>`;
    case 2:
      return `<span class="btn ${BUTTON_STYLE[c.style] ?? 'secondary'}${c.disabled ? ' disabled' : ''}">${renderEmoji(c.emoji)}${c.label ? esc(c.label) : ''}${c.style === 5 ? ' ↗' : ''}</span>`;
    case 3:
    case 5:
    case 6:
    case 7:
    case 8:
      return `<span class="btn secondary select">${esc(c.placeholder || 'Select an option')} ▾</span>`;
    case 9: {
      const accessory = c.accessory?.type === 11 ? `<img class="thumb" src="${esc(c.accessory.media?.url)}" alt="">` : renderComponent(c.accessory, r);
      return `<div class="section"><div class="section-text">${(c.components ?? []).map((x) => renderComponent(x, r)).join('')}</div>${accessory}</div>`;
    }
    case 12:
      return `<div class="gallery">${(c.items ?? []).map((i) => `<img class="attach-img" src="${esc(i.media?.url)}" alt="${esc(i.description ?? '')}">`).join('')}</div>`;
    case 13:
      return `<div class="file">📎 <a href="${esc(c.file?.url)}">${esc(c.file?.url?.split('/').pop()?.split('?')[0] ?? 'file')}</a></div>`;
    default:
      return '';
  }
}

function renderEmbed(e, r) {
  const color = hex(e.color) ?? '#4e5058';
  const fields = (e.fields ?? [])
    .map((f) => `<div class="embed-field${f.inline ? ' inline' : ''}"><div class="embed-field-name">${esc(f.name)}</div><div>${renderMarkdown(f.value, r)}</div></div>`)
    .join('');
  return `<div class="embed" style="border-left-color:${color}">
    ${e.author?.name ? `<div class="embed-author">${esc(e.author.name)}</div>` : ''}
    ${e.title ? `<div class="embed-title">${e.url ? `<a href="${esc(e.url)}">${esc(e.title)}</a>` : esc(e.title)}</div>` : ''}
    ${e.description ? `<div class="embed-desc">${renderMarkdown(e.description, r)}</div>` : ''}
    ${fields ? `<div class="embed-fields">${fields}</div>` : ''}
    ${e.image?.url ? `<img class="attach-img" src="${esc(e.image.url)}" alt="">` : ''}
    ${e.footer?.text ? `<div class="embed-footer">${esc(e.footer.text)}</div>` : ''}
  </div>`;
}

function renderAttachment(a) {
  if (/^image\//i.test(a.type ?? '') || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.url ?? '')) {
    return `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer"><img class="attach-img" src="${esc(a.url)}" alt="${esc(a.name)}"></a>`;
  }
  const size = a.size ? ` <span class="muted">(${a.size > 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`})</span>` : '';
  return `<div class="file">📎 <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.name ?? 'file')}</a>${size}</div>`;
}

/* -------------------------------- messages -------------------------------- */

/** discord.js Message -> plain object (everything the renderer needs). */
export function toMessageData(m) {
  const color = m.member?.displayHexColor;
  return {
    id: m.id,
    at: m.createdTimestamp,
    edited: Boolean(m.editedTimestamp),
    author: {
      id: m.author.id,
      name: m.member?.displayName ?? m.author.displayName ?? m.author.username,
      avatar: (m.member ?? m.author).displayAvatarURL?.({ size: 64, extension: 'png' }) ?? null,
      bot: Boolean(m.author.bot),
      color: color && color !== '#000000' ? color : null,
    },
    content: m.content ?? '',
    attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url, type: a.contentType, size: a.size })),
    embeds: m.embeds.map((e) => e.toJSON()),
    components: m.components.map((c) => c.toJSON()),
  };
}

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayLabel = (ms) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const full = (ms) => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`;

function renderMessages(messages, r) {
  const out = [];
  let prev = null;
  for (const m of messages) {
    if (!prev || dayKey(prev.at) !== dayKey(m.at)) out.push(`<div class="day"><span>${esc(dayLabel(m.at))}</span></div>`);
    // Consecutive messages from the same author within 7 minutes share one header, like Discord.
    const grouped = prev && prev.author.id === m.author.id && dayKey(prev.at) === dayKey(m.at) && m.at - prev.at < 7 * 60 * 1000;
    const body = [
      m.content ? `<div class="content">${renderMarkdown(m.content, r)}${m.edited ? '<span class="edited">(edited)</span>' : ''}</div>` : '',
      ...(m.attachments ?? []).map(renderAttachment),
      ...(m.embeds ?? []).map((e) => renderEmbed(e, r)),
      ...(m.components ?? []).map((c) => renderComponent(c, r)),
    ].join('');
    if (grouped) {
      out.push(`<div class="msg grouped"><span class="gtime" title="${esc(full(m.at))}">${esc(clock(m.at))}</span><div class="body">${body}</div></div>`);
    } else {
      const initials = esc((m.author.name ?? '?').trim().slice(0, 1).toUpperCase());
      out.push(`<div class="msg">
        <div class="avatar" data-initial="${initials}">${m.author.avatar ? `<img src="${esc(m.author.avatar)}" alt="" onerror="this.remove()">` : ''}</div>
        <div class="body">
          <div class="meta"><span class="name"${m.author.color ? ` style="color:${esc(m.author.color)}"` : ''}>${esc(m.author.name)}</span>${m.author.bot ? '<span class="app-tag">✓ APP</span>' : ''}<span class="stamp" title="${esc(full(m.at))}">${esc(dayLabel(m.at))} ${esc(clock(m.at))}</span></div>
          ${body}
        </div>
      </div>`);
    }
    prev = m;
  }
  return out.join('\n');
}

const CSS = `
:root{--bg:#0b0a12;--panel:#15131f;--panel2:#1c1a28;--text:#dbdee1;--muted:#949ba4;--accent:#7c5cff;--link:#00a8fc;--line:#2a2838}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.375 "gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.app{max-width:980px;margin:0 auto;padding:24px 16px 48px}
.head{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:18px 20px;margin-bottom:20px}
.head h1{margin:0 0 4px;font-size:22px;color:#fff}
.head .sub{color:var(--muted);margin-bottom:12px}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px 24px;font-size:14px}
.facts b{display:block;color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:1px}
.chan{color:var(--muted);font-weight:600;padding:0 4px 10px;border-bottom:1px solid var(--line);margin-bottom:6px}
.day{display:flex;align-items:center;gap:12px;margin:18px 0 6px;color:var(--muted);font-size:12px;font-weight:600}
.day:before,.day:after{content:"";flex:1;height:1px;background:var(--line)}
.msg{position:relative;display:flex;gap:16px;padding:2px 8px;margin-top:16px;border-radius:4px}
.msg:hover{background:rgba(255,255,255,.025)}
.msg.grouped{margin-top:0;padding-left:72px}
.gtime{position:absolute;left:8px;width:56px;text-align:right;font-size:11px;color:var(--muted);opacity:0;line-height:22px}
.msg.grouped:hover .gtime{opacity:1}
.avatar{flex:none;width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;overflow:hidden;position:relative;margin-top:2px}
.avatar:before{content:attr(data-initial)}
.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.body{min-width:0;flex:1}
.meta{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.name{font-weight:600;color:#fff}
.app-tag{background:#5865f2;color:#fff;font-size:10px;font-weight:600;border-radius:4px;padding:1px 5px;position:relative;top:-1px}
.stamp{font-size:12px;color:var(--muted)}
.content{word-wrap:break-word;overflow-wrap:anywhere}
.edited{font-size:10px;color:var(--muted);margin-left:4px}
.mention{background:rgba(88,101,242,.3);color:#c9cdfb;border-radius:3px;padding:0 2px;font-weight:500}
.time-chip{background:rgba(255,255,255,.08);border-radius:3px;padding:0 4px}
code.inline{background:#1e1f22;border-radius:4px;padding:2px 5px;font:85% Consolas,"Courier New",monospace}
pre{background:#1e1f22;border:1px solid #2b2d31;border-radius:4px;padding:8px;margin:6px 0;overflow:auto;font:13px Consolas,"Courier New",monospace;white-space:pre-wrap}
.h1{font-size:1.5em;font-weight:700;margin:6px 0 2px;color:#fff}.h2{font-size:1.25em;font-weight:700;margin:6px 0 2px;color:#fff}.h3{font-size:1.1em;font-weight:700;margin:4px 0 2px;color:#fff}
.subtext{font-size:12px;color:var(--muted)}
.quote{border-left:4px solid #4e5058;padding-left:10px;margin:2px 0}
.li:before{content:"• ";color:var(--muted)}
.blank{height:1em}
.spoiler{background:#202225;color:transparent;border-radius:3px;padding:0 2px}.spoiler:hover{color:inherit}
.emoji{width:22px;height:22px;vertical-align:-5px}
.container{background:var(--panel2);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:12px 16px;margin:6px 0;max-width:620px}
.container .text+.text{margin-top:6px}
.sep{border:0;border-top:1px solid #3a384a;margin:10px 0}.gap{height:8px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.btn{display:inline-flex;align-items:center;gap:6px;border-radius:6px;padding:6px 14px;font-size:14px;font-weight:500;color:#fff;cursor:default;user-select:none}
.btn.primary{background:#5865f2}.btn.secondary{background:#4e5058}.btn.success{background:#248046}.btn.danger{background:#da373c}.btn.link{background:#4e5058}
.btn.disabled{opacity:.5}.btn.select{background:#1e1f22;border:1px solid #3a3c43;min-width:220px;justify-content:space-between}
.btn-emoji{font-size:16px}
.section{display:flex;gap:12px;align-items:flex-start}.section-text{flex:1}.thumb{width:72px;height:72px;border-radius:8px;object-fit:cover}
.embed{background:var(--panel2);border-left:4px solid #4e5058;border-radius:4px;padding:8px 12px 12px;margin:6px 0;max-width:520px}
.embed-title{font-weight:700;color:#fff;margin-top:4px}.embed-author{font-size:13px;font-weight:600}.embed-footer{font-size:12px;color:var(--muted);margin-top:8px}
.embed-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:8px}.embed-field-name{font-weight:700;font-size:14px}
.attach-img{display:block;max-width:100%;max-height:340px;border-radius:6px;margin:4px 0}
.file{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:4px 0;display:inline-block}
.muted{color:var(--muted)}
.foot{margin-top:32px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;text-align:center}
@media(max-width:600px){.msg{gap:10px}.msg.grouped{padding-left:58px}}
@media print{body{background:#fff;color:#000}}
`;

/**
 * Builds the full HTML page.
 * meta: { guildName, channelName, number, subject, openedBy, handler, openedAt, closedAt, closedBy }
 * r:    { user(id), role(id), channel(id) } -> display names for mentions.
 */
export function renderTranscript({ meta, messages, r = {} }) {
  const title = `Ticket #${String(meta.number).padStart(4, '0')} — ${meta.subject}`;
  const fact = (label, value) => `<div><b>${esc(label)}</b>${esc(value)}</div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · transcript</title><style>${CSS}</style></head>
<body><div class="app">
<div class="head">
  <h1>🎫 ${esc(title)}</h1>
  <div class="sub">${esc(meta.guildName)} · transcript</div>
  <div class="facts">
    ${fact('Opened by', meta.openedBy)}
    ${fact('Handled by', meta.handler ?? '—')}
    ${fact('Opened', full(meta.openedAt))}
    ${meta.closedAt ? fact('Closed', full(meta.closedAt)) : fact('Status', 'Still open')}
    ${meta.closedAt ? fact('Closed by', meta.closedBy ?? '—') : ''}
    ${fact('Messages', String(messages.length))}
  </div>
</div>
<div class="chan"># ${esc(meta.channelName)}</div>
<main>
${renderMessages(messages, r)}
</main>
<div class="foot">${esc(meta.botName ?? 'Selyn Support Tickets')} · times shown in UTC · generated ${esc(full(Date.now()))}</div>
</div></body></html>`;
}
