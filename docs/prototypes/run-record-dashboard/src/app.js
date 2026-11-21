// ═══════════════════════ vocabulary: every colour has a name, a meaning and a fix ═══════════════════════
const CAUSE_INFO = {
  'by-design':          { color:'#8a9099', avoidable:false, label:'By design',          meaning:'A step the process asks for on purpose: approving the Dispatch Plan, the landing choice, close-out.', fix:'Nothing to fix. Shown so the total adds up.' },
  'human-choice':       { color:'#4c6ef5', avoidable:false, label:'Your choice',        meaning:'A decision that is yours to make: merging, choosing to merge main in, passing QA Review boxes.', fix:'Keep, or approve it ahead of time if you always answer the same way.' },
  'harness-limit':      { color:'#f76707', avoidable:true,  label:'Harness limit',      meaning:'The harness would not let the Chief of Staff do it: a session start refused on a background turn became a card click; QA commands had to be typed.', fix:'Start Delegations from a user turn, or batch the starts; start QA from a brief.' },
  'permission-refusal': { color:'#e03131', avoidable:true,  label:'Permission refusal', meaning:'A tool call was refused by the permission mode and needed you.', fix:'Add the tool to the allow list before the run.' },
  'missing-config':     { color:'#e8b100', avoidable:true,  label:'Missing config',     meaning:'You were asked for something the config or the Dispatch Plan could have answered: a review label, posting replies, readiness answers.', fix:'Approve it as a routine write in the Dispatch Plan or set it in orchestrate.config.yml.' },
  'spec-gap':           { color:'#0ca678', avoidable:true,  label:'Spec gap',           meaning:'The spec or ticket did not cover it: a scope fence too tight, an unclear review scope.', fix:'Widen the fences or state the scope when writing tickets.' },
  'skill-bug':          { color:'#ae3ec9', avoidable:true,  label:'Skill bug',          meaning:'The skill did the wrong thing and you caught it, or it asked twice.', fix:'File it against the skill; the cause can carry the issue id.' },
  'tool-missing':       { color:'#15aabf', avoidable:true,  label:'Tool missing',       meaning:'A tool the run needed was not there (e.g. no way to start the stack), so you did it by hand.', fix:'Install or configure the tool, or teach the skill to start it.' },
  'other':              { color:'#5c5f66', avoidable:true,  label:'Other',              meaning:'Not yet classified.', fix:'Classify it; a new cause may be needed.' },
};
const CAUSES = Object.keys(CAUSE_INFO);
const KIND_INFO = {
  'plan-approval':'You approved the Dispatch Plan.', 'landing-choice':'You chose how work lands (integration branch or per ticket).', 'plan-change':'You changed the plan before approving it.',
  'card-start':'You clicked a card to start a Delegation the Chief of Staff could not start itself.', 'decision-request':'You answered a Decision Request.',
  'permission-refusal':'A tool call was refused and needed you.', 'merge':'You merged a pull request.', 'close-out':'You did a close-out step (summary, archive, branches).',
  'mark-ready':'A PR was marked ready for review.', 'stale-relay':'You relayed a message that was already out of date.', 'human-caught-error':'You caught a mistake.',
  'session-housekeeping':'You tidied sessions by hand.', 'qa-typed-command':'You typed a QA command (/qa-plan, /manual-qa) into a session.',
  'qa-readiness-answer':'You answered a QA readiness question.', 'qa-plan-confirm':'You confirmed a QA Plan.', 'qa-residue-choice':'You chose what to do with QA leftovers.',
  'qa-review-box':'You passed QA Review boxes.', 'qa-deferral':'You deferred a QA scenario.', 'qa-card-start':'You clicked a card to start a QA Delegation.', 'qa-stack-start':'You started the stack by hand for QA.',
  'write-as-human':'The Chief of Staff made a write on your behalf after you answered (actor: chief-of-staff). Not counted as a human step.',
};
const TOPIC_CAUSE = { 'fence-widening':'spec-gap','review-scope':'spec-gap','review-trigger':'missing-config','post-replies-and-retrigger-review':'missing-config',
  'behind-default-branch':'human-choice','merge-behind':'human-choice','branch-update':'human-choice','review-gate':'skill-bug',
  'qa-readiness':'missing-config','qa-plan-confirm':'human-choice','qa-residue-choice':'human-choice','qa-deferral':'human-choice' };

// ═══════════════════════ normalising a Run Record ═══════════════════════
const ISO = s => typeof s === 'string' && s.length > 10 ? Date.parse(s) : null;
const DAY = s => typeof s === 'string' && s.length === 10 ? s : null;
function when(o){
  if (ISO(o.at)) return { t: ISO(o.at), p: 'exact' };
  if (o.at_bounds){ const lo = ISO(o.at_bounds[0]), hi = ISO(o.at_bounds[1]); return { t: lo&&hi ? (lo+hi)/2 : (hi||lo), lo, hi, p: 'bounds' }; }
  if (DAY(o.at)) return { day: o.at, p: 'date' };
  return { p: 'unknown' };
}
function kindOf(h, isQa){
  let k = h.kind === 'other' ? (h.proposed_kind || 'other') : h.kind;
  if (h.kind === 'decision-request' && h.subject && h.subject.startsWith('qa-')) k = h.subject;
  if (k === 'review-box-pass') k = 'qa-review-box';
  if (isQa && !k.startsWith('qa-') && ['typed-command','readiness-answer','card-start'].includes(k)) k = 'qa-' + k;
  return k;
}
// The hand-derived records predate `cause`; this assigns one (marked "assumed" in the UI). Synthetic records carry their own.
function causeOf(h, k, drSubject){
  const topic = h.topic || h.subject || drSubject;
  if (/plan-approval|landing-choice|plan-change|close-out/.test(k)) return 'by-design';
  if (/card-start|typed-command|session-housekeeping/.test(k)) return 'harness-limit';
  if (k === 'permission-refusal' || (k === 'merge' && h.result === 'refused')) return 'permission-refusal';
  if (/readiness-answer|qa-readiness/.test(k)) return h.duplicate_of_previous ? 'skill-bug' : 'missing-config';
  if (/stale-relay|human-caught-error/.test(k)) return 'skill-bug';
  if (k === 'merge') return 'human-choice';
  if (topic && TOPIC_CAUSE[topic]) return TOPIC_CAUSE[topic];
  if (/qa-/.test(k)) return 'human-choice';
  return 'other';
}
function normalize(r){
  const run = r.run, dels = r.delegations || [];
  const drSub = Object.fromEntries((r.decision_requests||[]).filter(d=>d.id).map(d=>[d.id,d.subject]));
  const qaIds = new Set(dels.filter(d=>d.kind==='qa').map(d=>d.id));
  const steps = (r.human_interventions||[]).map((h,i) => {
    const k = kindOf(h, qaIds.has(h.delegation));
    const actor = h.kind === 'write-as-human' ? 'chief-of-staff' : (h.covered_by || h.human_needed === false) ? 'covered' : 'human';
    const cause = actor === 'human' ? (h.cause || causeOf(h, k, drSub[h.dr])) : null;
    return { n: h.n || i+1, k, w: when(h), del: h.delegation || (h.delegations||[])[0] || null, raw: h, actor, cause, assumed: actor==='human' && !h.cause,
      wait: h.waited_minutes ?? null, waitMax: h.waited_minutes_max ?? null, hb: h.heartbeats_waiting || 0,
      topic: h.topic || h.subject || drSub[h.dr] || h.command || h.write || h.action || null };
  });
  const touches = steps.filter(s=>s.actor==='human');
  const D = dels.map(d => {
    const s = ISO(d.started_at) || ISO(d.first_commit_at) || ISO(d.pr_opened_at);
    const e = ISO(d.ended_at) || ISO(d.landed_at) || ISO((d.landed_bounds_second||[])[1]) || ISO(d.head_committed_at);
    return { id:d.id, issue:d.issue, kind:d.kind, route:d.start_route, outcome:d.outcome, s, e, raw:d,
      sSrc: ISO(d.started_at) ? 'started' : ISO(d.first_commit_at) ? 'first commit' : ISO(d.pr_opened_at) ? 'PR opened' : null,
      eSrc: ISO(d.ended_at) ? 'ended' : ISO(d.landed_at) ? 'landed' : d.landed_bounds_second ? 'landed (bound)' : ISO(d.head_committed_at) ? 'last commit' : null,
      day: DAY(d.started_at), sendBacks: d.send_backs||0, drs: d.decision_requests||0, commits: d.commits, wave: d.wave, pr: d.pr,
      touches: touches.filter(t=>t.del===d.id) };
  });
  const times = [];
  D.forEach(d=>{ if(d.s) times.push(d.s); if(d.e) times.push(d.e); });
  steps.forEach(t=>{ if(t.w.t) times.push(t.w.t); });
  const start = ISO(run.started_at) || ISO((run.started_at_bounds||[])[0]) || ISO(run.plan_approved_at) || Math.min(...times);
  const end = ISO(run.closed_at) || Math.max(...times);
  const reviews = (r.reviews||[]).map(v=>({ ...v, t:ISO(v.triggered_at), e:ISO(v.finished_at) }));
  const ci = (r.ci||[]).map(c=>({ ...c, t:ISO(c.created_at) }));
  const N = { id:run.id, repo: run.repo || 'mnaimfaizy/agent-kit', operator: run.operator || 'you', team: run.team_run || null,
    spec:run.spec, kind:run.kind, authority:run.decision_authority, landing:run.landing, outcome:run.outcome, harness: run.harness,
    tickets:run.tickets||[], prs:run.pull_requests||[], start, end, startBound: !ISO(run.started_at), plan:r.plan||{},
    dels:D, steps, touches, reviews, ci, heartbeats:r.heartbeats||{}, rulings: r.rulings||{}, synthetic: !!r._synthetic, raw:r };
  N.avoidable = touches.filter(t=>CAUSE_INFO[t.cause].avoidable);
  N.knownWait = touches.reduce((a,t)=>a+(t.wait ?? 0),0);
  N.events = buildEvents(N, run);
  return N;
}
function buildEvents(r, run){
  const ev = [], add = (w, who, what, extra={}) => ev.push({ w, who, what, ...extra });
  const X = t => ({ t, p:'exact' });
  if (ISO(run.started_at)) add(X(ISO(run.started_at)), 'chief-of-staff', 'run-started');
  else if (run.started_at_bounds) add(when({at_bounds:run.started_at_bounds}), 'chief-of-staff', 'run-started');
  else if (DAY(run.started_at)) add({day:run.started_at,p:'date'}, 'chief-of-staff', 'run-started');
  r.dels.forEach(d => {
    if (d.s) add(X(d.s), 'delegation', d.sSrc==='started'?'delegation-started':'delegation-'+d.sSrc.replace(' ','-'), { del:d.id, detail:`${d.kind} #${d.issue} start=${d.route}` });
    else if (d.day) add({day:d.day,p:'date'}, 'delegation', 'delegation-ran', { del:d.id, detail:`${d.kind} #${d.issue} (no times recorded)` });
    if (d.e) add(X(d.e), 'delegation', 'delegation-'+d.eSrc.replace(/[ ()]+/g,'-').replace(/-$/,''), { del:d.id, detail:`outcome=${d.outcome} send_backs=${d.sendBacks}` });
  });
  r.steps.forEach(s => add(s.w, s.actor==='human'?'human':s.actor, s.k, { del:s.del, step:s.n, cause:s.cause,
    detail: [s.topic && `topic=${s.topic}`, s.cause && `cause=${s.cause}`, s.wait!=null ? `waited=${s.wait}m` : s.waitMax!=null ? `waited<=${s.waitMax}m` : (s.actor==='human'?'waited=?':null), s.hb && `heartbeats_waiting=${s.hb}`].filter(Boolean).join(' ') }));
  r.reviews.forEach(v => { if (v.t) add(X(v.t), 'review', 'review-triggered', { detail:`pr=${v.pr} round=${v.round} head=${v.head||'?'}` });
    if (v.e) add(X(v.e), 'review', 'review-finished', { detail:`pr=${v.pr} round=${v.round} findings=${v.findings} fixed=${v.fixed}` });
    if (!v.t) add({p:'unknown'}, 'review', 'review-round', { detail:`pr=${v.pr} round=${v.round} findings=${v.findings} (no time)` }); });
  r.ci.forEach(c => add(c.t ? X(c.t) : {p:'unknown'}, 'ci', 'ci-'+c.result, { detail:`pr=${c.pr} head=${c.head||'?'} failed_checks=${c.failed_checks??'?'}` }));
  if (ISO(run.pr_opened_at)) add(X(ISO(run.pr_opened_at)), 'chief-of-staff', 'pr-opened', { detail:`pr=${(run.pull_requests||[]).join(',')}` });
  if (ISO(run.merged_at)) add(X(ISO(run.merged_at)), 'github', 'pr-merged', { detail:`merge_commit=${run.merge_commit||'?'}` });
  if (ISO(run.closed_at)) add(X(ISO(run.closed_at)), 'chief-of-staff', 'run-closed', { detail:`outcome=${run.outcome}` });
  const key = e => e.w.t ?? (e.w.day ? Date.parse(e.w.day+'T23:59:00Z') : 9e15);
  return ev.map((e,i)=>({...e,i})).sort((a,b)=>key(a)-key(b) || a.i-b.i);
}

// ═══════════════════════ data ═══════════════════════
const REAL = JSON.parse(document.getElementById('records').textContent);
const LOGS = JSON.parse(document.getElementById('logs').textContent);
const RUNS = REAL.concat(SYNTH_RECORDS).map(normalize).sort((a,b)=>b.start-a.start);
const RUN = Object.fromEntries(RUNS.map(r=>[r.repo+'::'+r.id,r]));   // run ids repeat across repositories: the key is the namespace
const enc = encodeURIComponent;
const rp = r => `/repo/${enc(r.repo)}/run/${r.id}`;
const TEAM_REPO = Object.fromEntries(RUNS.filter(r=>r.team).map(r=>[r.team,r.repo]));
const tp = t => `/repo/${enc(TEAM_REPO[t])}/team/${t}`;
const sinkPath = r => `run-records/${r.repo}/${r.id}.json`;
const REPO_NAMES = [...new Set(SYNTH_REPOS.map(r=>r.repo).concat(RUNS.map(r=>r.repo)))];
const REPO_NOTE = Object.fromEntries(SYNTH_REPOS.map(r=>[r.repo,r.note]));
const runsOf = repo => RUNS.filter(r=>r.repo===repo);
const TEAMS = [...new Set(RUNS.filter(r=>r.team).map(r=>r.team))];

// ═══════════════════════ helpers ═══════════════════════
const esc = s => String(s ?? '').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const hrs = ms => ms==null||isNaN(ms) ? '?' : ms < 3600e3 ? Math.round(ms/60000)+'m' : (ms/3600e3).toFixed(1)+'h';
const mins = ms => ms==null||isNaN(ms) ? '?' : Math.round(ms/60000)+'m';
const hm = t => t ? new Date(t).toISOString().slice(11,16) : '—';
const ymd = t => t ? new Date(t).toISOString().slice(0,10) : '';
const fmtDate = t => t ? new Date(t).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'}) : '';
const median = a => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const pct = (a,b) => b ? Math.round(a/b*100)+'%' : '—';
const ci = c => CAUSE_INFO[c] || CAUSE_INFO.other;
const chip = c => `<span class="chip" title="${esc(ci(c).meaning)}"><span class="sw" style="background:${ci(c).color}"></span>${esc(ci(c).label)}</span>`;
const avoidTag = c => c ? (ci(c).avoidable ? '<span class="tag avoid">avoidable</span>' : '<span class="tag exp">expected</span>') : '';
const syn = r => r && r.synthetic ? ' <span class="syn">synthetic</span>' : '';
const outTag = o => `<span class="tag ${o==='merged'||o==='landed'||o==='qa-pass'?'ok':o==='abandoned'||o==='qa-fail'?'bad':''}">${esc(o)}</span>`;
const whenTxt = w => w.p==='exact' ? `${ymd(w.t)} ${hm(w.t)}` : w.p==='bounds' ? `~${hm(w.t)} <span class="muted small">(${w.lo?hm(w.lo):'?'}–${w.hi?hm(w.hi):'?'})</span>` : w.p==='date' ? `${w.day} <span class="muted small">(date only)</span>` : '<span class="muted">unknown</span>';
const waitTxt = t => t.wait!=null ? `${t.wait}m` : t.waitMax!=null ? `≤${t.waitMax}m` : '<span class="muted">?</span>';
const link = (href, txt) => `<a href="#${href}">${txt}</a>`;
const runLink = r => link(`${rp(r)}`, esc(r.id));
const causeCounts = ts => { const c = Object.fromEntries(CAUSES.map(k=>[k,0])); ts.forEach(t=>c[t.cause]++); return c; };
function legend(counts){ return `<div class="legend">${CAUSES.filter(c=>!counts||counts[c]).map(c=>chip(c)+(counts?`<span class="small mono" style="margin:0 8px 0 -2px">${counts[c]}</span>`:'')).join('')}<a class="small" href="#/key" style="margin-left:6px">What do the colours mean?</a></div>`; }
function causeBars(touches, total){
  const cc = causeCounts(touches), max = Math.max(1, ...Object.values(cc));
  return CAUSES.filter(c=>cc[c]).sort((a,b)=>cc[b]-cc[a]).map(c=>`<div class="bar"><span class="lbl">${chip(c)}</span><div class="track"><span style="width:${cc[c]/max*100}%;background:${ci(c).color}"></span></div><span class="val">${cc[c]}</span>${avoidTag(c)}</div>`).join('') || '<div class="muted">No human steps.</div>';
}
function stackTrack(touches, width){
  const cc = causeCounts(touches), tot = touches.length || 1;
  return `<div class="track" style="${width?`width:${width}px;flex:none`:''}">${CAUSES.filter(c=>cc[c]).map(c=>`<span title="${ci(c).label}: ${cc[c]}" style="width:${cc[c]/tot*100}%;background:${ci(c).color}"></span>`).join('')}</div>`;
}
function spark(vals, w=110, h=26){
  if (!vals.length) return '';
  const max = Math.max(1,...vals), dx = vals.length>1 ? w/(vals.length-1) : 0;
  const pts = vals.map((v,i)=>`${(i*dx).toFixed(1)},${(h-2-v/max*(h-4)).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>${vals.map((v,i)=>`<circle cx="${i*dx}" cy="${h-2-v/max*(h-4)}" r="2" fill="var(--accent)"/>`).join('')}</svg>`;
}
const kpi = (v, l, e='') => `<div class="kpi"><b>${v}</b><span>${l}</span>${e?`<em>${e}</em>`:''}</div>`;

// ═══════════════════════ what to improve next run ═══════════════════════
function nextRun(r){
  const out = [], by = f => r.touches.filter(f);
  const cards = by(t=>/card-start/.test(t.k));
  if (cards.length) out.push({ n:cards.length, cause:'harness-limit', what:`${cards.length} Delegation start${cards.length>1?'s':''} needed your click on a card`, fix:'Start Delegations from a user turn, or batch the starts behind one click.' });
  const typed = by(t=>/typed-command/.test(t.k));
  if (typed.length) out.push({ n:typed.length, cause:'harness-limit', what:`${typed.length} QA commands typed by hand`, fix:'Start QA Delegations with a brief instead of the typed route.' });
  const cfg = by(t=>t.cause==='missing-config'), declined = r.plan.routine_writes_declined || [];
  if (cfg.length) out.push({ n:cfg.length, cause:'missing-config', what:`${cfg.length} question${cfg.length>1?'s':''} that config could answer`, fix: declined.length ? `Approve ${declined.join(', ')} as a routine write in the Dispatch Plan (declined this run).` : 'Put the answer in the brief or orchestrate.config.yml.' });
  const spec = by(t=>t.cause==='spec-gap');
  if (spec.length) out.push({ n:spec.length, cause:'spec-gap', what:`${spec.length} fence widening${spec.length>1?'s':''} or scope question${spec.length>1?'s':''}`, fix:'Scope fences were too tight; widen them while writing tickets.' });
  ['skill-bug','permission-refusal','tool-missing'].forEach(c => { const x = by(t=>t.cause===c); if (x.length) out.push({ n:x.length, cause:c, what:`${x.length} × ${ci(c).label.toLowerCase()}`, fix:ci(c).fix }); });
  const untimed = r.touches.filter(t=>t.w.p!=='exact').length;
  if (untimed) out.push({ n:untimed, cause:null, what:`${untimed} of ${r.touches.length} human steps have no exact time`, fix:'Run Events would record each one as it happens (old Activity Logs have dates only).' });
  return out.sort((a,b)=>b.n-a.n);
}
const nextRunHtml = r => nextRun(r).map(n=>`<div class="todo"><span class="n" style="color:${n.cause?ci(n.cause).color:'var(--muted)'}">${n.n}</span><div><b>${esc(n.what)}</b> ${n.cause?chip(n.cause):'<span class="tag">data</span>'}<div class="small muted">${esc(n.fix)}</div></div></div>`).join('') || '<div class="muted">Nothing avoidable. 🎉</div>';

// ═══════════════════════ timeline (Gantt) ═══════════════════════
function gantt(rows, t0, t1, opts={}){
  const W = opts.w || 1150, L = 170, R = 86, RH = opts.rh || 26, H = rows.length*RH + 30;
  const x = t => L + (t - t0) / (t1 - t0 || 1) * (W - L - R);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:760px">`;
  const span = t1 - t0, step = span > 20*3600e3 ? 3*3600e3 : span > 6*3600e3 ? 3600e3 : span > 2*3600e3 ? 30*60e3 : 15*60e3;
  for (let t = Math.ceil(t0/step)*step; t <= t1; t += step) s += `<line x1="${x(t)}" x2="${x(t)}" y1="16" y2="${H}" stroke="var(--line)"/><text x="${x(t)}" y="11" text-anchor="middle" class="mt">${hm(t)}</text>`;
  s += `<text x="${W-R+10}" y="11" class="mt">date only</text><line x1="${W-R+4}" x2="${W-R+4}" y1="16" y2="${H}" stroke="var(--line)" stroke-dasharray="3 3"/>`;
  rows.forEach((row,i) => {
    const y = 20 + i*RH, cy = y + RH/2;
    if (i % 2 === 0) s += `<rect x="0" y="${y}" width="${W-R}" height="${RH}" fill="var(--soft)" opacity=".5"/>`;
    if (row.group) { s += `<text x="4" y="${cy+4}" style="font-weight:700">${esc(row.label)}</text>`; return; }
    const label = `<text x="${row.indent?18:6}" y="${cy+4}" ${row.dim?'class="mt"':''} ${row.bold?'style="font-weight:600"':''}>${esc(row.label)}</text>`;
    s += row.href ? `<a href="#${row.href}">${label}</a>` : label;
    (row.bars||[]).forEach(b => { if (!b.s || !b.e) return;
      const rect = `<rect x="${x(b.s)}" y="${y+6}" width="${Math.max(3,x(b.e)-x(b.s))}" height="${RH-12}" rx="3" fill="${b.fill||'var(--accent)'}" ${b.proxy?`fill-opacity=".35" stroke="${b.fill||'var(--accent)'}" stroke-dasharray="4 2"`:''}><title>${esc(b.title||'')}</title></rect>`;
      s += b.href ? `<a href="#${b.href}">${rect}</a>` : rect; });
    let dateOnly = 0;
    (row.marks||[]).forEach(m => {
      const c = m.color || 'var(--muted)'; let g;
      if (m.w.p === 'exact') g = `<circle cx="${x(m.w.t)}" cy="${cy}" r="6" fill="${c}" stroke="var(--panel)" stroke-width="1.5"><title>${esc(m.title)}</title></circle>`;
      else if (m.w.p === 'bounds' && m.w.t) g = `<g><title>${esc(m.title)} — time only known ${m.w.lo?'after '+hm(m.w.lo):''} ${m.w.hi?'before '+hm(m.w.hi):''}</title>${m.w.lo&&m.w.hi?`<line x1="${x(m.w.lo)}" x2="${x(m.w.hi)}" y1="${cy}" y2="${cy}" stroke="${c}" stroke-width="2.5" stroke-dasharray="3 2"/>`:''}<circle cx="${x(m.w.t)}" cy="${cy}" r="5" fill="var(--panel)" stroke="${c}" stroke-width="2.5"/></g>`;
      else { g = `<rect x="${W-R+9+(dateOnly%9)*8}" y="${cy-4+Math.floor(dateOnly/9)*0}" width="6" height="8" rx="1" fill="${c}"><title>${esc(m.title)} (${m.w.day||'no time'})</title></rect>`; dateOnly++; }
      s += m.href ? `<a href="#${m.href}">${g}</a>` : g;
    });
    (row.ticks||[]).forEach(k => { if (k.t) s += `<line x1="${x(k.t)}" x2="${x(k.t)}" y1="${y+5}" y2="${y+RH-5}" stroke="${k.color}" stroke-width="3"><title>${esc(k.title)}</title></line>`; });
  });
  return s + '</svg>';
}
const DEL_FILL = { building:'#3b5bdb', fix:'#ae3ec9', qa:'#0ca678', analysis:'#868e96' };
function ganttRows(r, prefix=''){
  const rows = [];
  rows.push({ label: prefix+'You (human steps)', bold:true, marks: r.touches.map(t=>({ w:t.w, color:ci(t.cause).color, href:`${rp(r)}/step/${t.n}`, title:`Step ${t.n}: ${t.k} · ${ci(t.cause).label} · waited ${t.wait ?? (t.waitMax!=null?'≤'+t.waitMax:'?')}m${t.del?' · '+t.del:''}` })) });
  rows.push({ label: prefix+'Chief of Staff', dim:true,
    marks: r.steps.filter(s=>s.actor!=='human').map(w=>({ w:w.w, color:'#868e96', href:`${rp(r)}/step/${w.n}`, title:`Step ${w.n}: ${w.k} (actor: ${w.actor})` })),
    ticks: r.reviews.map(v=>({t:v.t,color:'#7048e8',title:`Review round ${v.round} on PR ${v.pr}: ${v.findings} findings`})).concat(r.ci.map(c=>({t:c.t,color:c.result==='pass'?'#2b8a3e':'#c92a2a',title:`CI ${c.result} on PR ${c.pr}`}))) });
  r.dels.forEach(d => rows.push({ label:`${prefix}${d.id}${d.route==='card'?'  ▣ card':''}`, indent:true, href:`${rp(r)}/delegation/${d.id}`,
    bars:[{ s:d.s, e:d.e, proxy: d.sSrc!=='started', fill: DEL_FILL[d.kind]||'#3b5bdb', href:`${rp(r)}/delegation/${d.id}`,
      title:`${d.id} (${d.kind}, #${d.issue}) ${hm(d.s)}–${hm(d.e)} = ${mins(d.e-d.s)}. Start from ${d.sSrc}, end from ${d.eSrc}.` }],
    marks: (!d.s && d.day) ? [{ w:{p:'date',day:d.day}, color:DEL_FILL[d.kind], title:`${d.id} ran on ${d.day}, no times` }] : [] }));
  return rows;
}
const ganttKey = () => `<div class="small muted" style="display:flex;flex-wrap:wrap;gap:14px;margin:6px 0">
  <span><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="#f76707"/></svg> exact time</span>
  <span><svg width="34" height="14"><line x1="2" x2="32" y1="7" y2="7" stroke="#f76707" stroke-width="2.5" stroke-dasharray="3 2"/><circle cx="17" cy="7" r="4" fill="var(--panel)" stroke="#f76707" stroke-width="2.5"/></svg> only known between two times</span>
  <span><svg width="12" height="14"><rect x="3" y="3" width="6" height="8" fill="#f76707"/></svg> date only (right gutter)</span>
  <span><svg width="30" height="14"><rect x="1" y="3" width="28" height="8" rx="2" fill="#3b5bdb"/></svg> Delegation, real start/end</span>
  <span><svg width="30" height="14"><rect x="1" y="3" width="28" height="8" rx="2" fill="#3b5bdb" fill-opacity=".35" stroke="#3b5bdb" stroke-dasharray="4 2"/></svg> start/end guessed from commits or PR</span>
  <span>Bar colour: <b style="color:#3b5bdb">building</b> · <b style="color:#ae3ec9">fix</b> · <b style="color:#0ca678">QA</b></span>
  <span><svg width="10" height="14"><line x1="5" x2="5" y1="1" y2="13" stroke="#7048e8" stroke-width="3"/></svg> review round <svg width="10" height="14"><line x1="5" x2="5" y1="1" y2="13" stroke="#2b8a3e" stroke-width="3"/></svg> CI pass <svg width="10" height="14"><line x1="5" x2="5" y1="1" y2="13" stroke="#c92a2a" stroke-width="3"/></svg> CI fail</span>
  <span>Click any mark or bar to open it.</span></div>`;

// ═══════════════════════ text: the record as a log ═══════════════════════
const pad = (s,n) => (String(s ?? '')+' '.repeat(n)).slice(0,n);
function logTime(w){
  if (w.p==='exact') return new Date(w.t).toISOString().replace('T',' ').slice(0,19)+'Z';
  if (w.p==='bounds') return `~${new Date(w.t).toISOString().replace('T',' ').slice(0,16)}Z (${w.lo?hm(w.lo):'?'}-${w.hi?hm(w.hi):'?'})`;
  if (w.p==='date') return `${w.day} (date only)`;
  return '(no time)';
}
function textLog(r, events = r.events){
  const head = `# Run ${r.id}${r.synthetic?'  [SYNTHETIC]':''}\n# repo=${r.repo} operator=${r.operator} spec=${r.spec} authority=${r.authority} landing=${r.landing} outcome=${r.outcome}\n# Derived from the Run Record: ids, times, kinds and causes only. No issue text or command output.\n\n`;
  return head + events.map(e => `${pad(logTime(e.w),36)} ${pad(e.who,15)} ${pad(e.del||'-',11)} ${pad(e.what,28)} ${e.step?`step=${e.step} `:''}${e.detail||''}`).join('\n') + '\n';
}
function reportText(r){
  const cc = causeCounts(r.touches), W = 50;
  const bar = d => { if(!d.s||!d.e) return '·'.repeat(W); const a=Math.round((d.s-r.start)/(r.end-r.start)*W), b=Math.max(a+1,Math.round((d.e-r.start)/(r.end-r.start)*W)); return ' '.repeat(Math.max(0,a))+(d.sSrc==='started'?'█':'▓').repeat(Math.max(1,b-a))+' '.repeat(Math.max(0,W-b)); };
  let o = `$ orchestrate --report ${r.id}\n\nRun ${r.id}${r.synthetic?'  [synthetic]':''}\n  ${r.repo} · spec #${r.spec} · ${r.authority} · ${r.landing} · ${r.outcome} · ${hrs(r.end-r.start)}\n\nDelegations\n`;
  r.dels.forEach(d=>{ o += `  ${pad(d.id,11)} ${pad(d.kind,9)} ${pad(d.route,7)}|${bar(d)}| ${pad(d.s&&d.e?mins(d.e-d.s):'?',5)} ${d.touches.length?d.touches.length+' human':''}\n`; });
  o += `  █ real start/end  ▓ from commits  · no times\n\nHuman steps: ${r.touches.length} (${r.avoidable.length} avoidable)\n`;
  CAUSES.filter(c=>cc[c]).sort((a,b)=>cc[b]-cc[a]).forEach(c=>{ o += `  ${pad(ci(c).label,20)} ${pad(cc[c],4)}${'■'.repeat(cc[c])}${ci(c).avoidable?'':'  (expected)'}\n`; });
  o += `\nNext run\n` + nextRun(r).map((n,i)=>`  ${i+1}. ${n.what}\n     → ${n.fix}`).join('\n') + '\n';
  return o;
}
function copyFrom(id){ const el = document.getElementById(id), txt = el.innerText;
  const done = () => { const b = document.querySelector(`[data-copy="${id}"]`); if (b) { b.textContent = 'Copied'; setTimeout(()=>b.textContent='Copy',1200); } };
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(done).catch(()=>{ const rg=document.createRange(); rg.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(rg); try{document.execCommand('copy');done();}catch(e){} }); }
function downloadFrom(id, name){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([document.getElementById(id).innerText],{type:'text/plain'})); a.download=name; a.click(); }
const textBox = (id, txt, name, cls='') => `<div style="display:flex;gap:6px;justify-content:flex-end;margin-bottom:6px"><button class="btn" data-copy="${id}" onclick="copyFrom('${id}')">Copy</button><button class="btn" onclick="downloadFrom('${id}','${name}')">Download .txt</button></div><pre class="log ${cls}" id="${id}">${esc(txt)}</pre>`;

// ═══════════════════════ pages ═══════════════════════
function pageOverview(){
  const all = RUNS, touches = all.flatMap(r=>r.touches), av = all.flatMap(r=>r.avoidable);
  const recent = all.slice(0, 12);
  const byRepo = REPO_NAMES.map(n=>({ n, runs: runsOf(n) }));
  return { crumbs: [['All repositories']], html: `<h1>All repositories</h1><div class="muted" style="margin-bottom:12px">${REPO_NAMES.length} Consumers · ${all.length} runs since ${fmtDate(Math.min(...all.map(r=>r.start)))} · <span class="syn">synthetic</span> data mixed with 2 real Run Records</div>
  <div class="kpis" style="margin-bottom:14px">${kpi(all.length,'runs', `${all.filter(r=>r.outcome==='merged').length} merged`)}${kpi(all.reduce((a,r)=>a+r.dels.length,0),'Delegations')}${kpi(touches.length,'human steps',`${(touches.length/all.length).toFixed(1)} per run`)}${kpi(pct(av.length,touches.length),'avoidable',`${av.length} steps`)}${kpi(hrs(median(all.map(r=>r.end-r.start))),'median run time')}${kpi(hrs(all.reduce((a,r)=>a+r.knownWait,0)*60000),'known waiting on you')}${kpi(TEAMS.length,'Team Runs')}</div>
  <div class="panel"><h2>Repos</h2><div class="scroll"><table><tr><th>Repo</th><th class="num">Runs</th><th>Last run</th><th class="num">Merged</th><th class="num">Human steps / run</th><th>Avoidable steps per run, oldest → newest</th><th>Top avoidable cause</th><th>Mix of causes</th></tr>
  ${byRepo.map(({n,runs})=>{ const chron=[...runs].reverse(), ts=runs.flatMap(r=>r.avoidable), cc=causeCounts(ts), top=CAUSES.filter(c=>cc[c]).sort((a,b)=>cc[b]-cc[a])[0];
    return `<tr class="click" data-go="/repo/${encodeURIComponent(n)}"><td>${link('/repo/'+encodeURIComponent(n), `<b>${esc(n)}</b>`)}<div class="small muted">${esc(REPO_NOTE[n]||'')}</div></td><td class="num">${runs.length}</td><td class="nowrap">${fmtDate(runs[0]?.start)}</td><td class="num">${pct(runs.filter(r=>r.outcome==='merged').length,runs.length)}</td><td class="num">${(runs.reduce((a,r)=>a+r.touches.length,0)/runs.length).toFixed(1)}</td><td>${spark(chron.map(r=>r.avoidable.length))}</td><td>${top?chip(top):'—'}</td><td style="min-width:140px">${stackTrack(runs.flatMap(r=>r.touches))}</td></tr>`}).join('')}</table></div>${legend()}</div>
  <div class="grid2"><div class="panel"><h2>Avoidable human steps, by repo</h2>${byRepo.map(({n,runs})=>{const a=runs.flatMap(r=>r.avoidable);return `<div class="bar"><span class="lbl small">${esc(n.split('/')[1])}</span>${stackTrack(a, Math.max(4,a.length*5))}<span class="val">${a.length}</span></div>`}).join('')}<div class="small muted">Bar length = number of avoidable steps; segments = causes.</div></div>
  <div class="panel"><h2>Most common avoidable causes</h2>${causeBars(av)}</div></div>
  <div class="panel"><h2>Compare repositories over time</h2><div class="small muted">Avoidable human steps per Delegation, one line per repository, one point per run. Lines are told apart by dash pattern and end label, not colour (colour means cause elsewhere).</div><div class="scroll">${compareChart()}</div></div>
  <div class="panel"><h2>Recent runs, every repository</h2>${runsTable(recent, true)}</div>
  <div class="panel"><h2>The shared sink</h2><div class="small muted" style="margin-bottom:8px">One sink holds every repository's Run Records, each in its own namespace. Run ids are only unique inside a namespace: <code>2026-11-19-spec-344</code> exists in two repositories here.</div>
  <pre class="log">${esc(sinkTree())}</pre></div>` };
}
function sinkTree(){
  let o = 'run-records/\n';
  REPO_NAMES.forEach((n,i) => { const last = i===REPO_NAMES.length-1, [own, name] = n.split('/'), runs = runsOf(n);
    o += `${last?'└──':'├──'} ${own}/${name}/   (${runs.length} records${runs.some(r=>!r.synthetic)?'':', synthetic'})\n`;
    runs.slice(0,3).forEach((r,j) => o += `${last?'    ':'│   '}${j===Math.min(2,runs.length-1)&&runs.length<=3?'└──':'├──'} ${r.id}.json\n`);
    if (runs.length > 3) o += `${last?'    ':'│   '}└── … ${runs.length-3} more\n`; });
  return o;
}
function compareChart(){
  const W = 1100, H = 240, L = 40, R = 190, all = RUNS, t0 = Math.min(...all.map(r=>r.start)), t1 = Math.max(...all.map(r=>r.start));
  const val = r => r.avoidable.length / Math.max(1, r.dels.length), max = Math.max(...all.map(val));
  const x = t => L + (t-t0)/(t1-t0)*(W-L-R), y = v => H - 10 - v/max*(H-30);
  const dashes = ['', '6 4', '2 3', '10 3 2 3'];
  let s = `<svg viewBox="0 0 ${W} ${H+20}" width="100%" style="min-width:640px">`;
  for (let v = 0; v <= max; v += .5) s += `<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end" class="mt">${v}</text>`;
  for (let t = Date.UTC(2026,9,1); t <= t1; t += 7*864e5) s += `<text x="${x(t)}" y="${H+12}" text-anchor="middle" class="mt">${fmtDate(t)}</text>`;
  REPO_NAMES.forEach((n,i) => { const runs = [...runsOf(n)].reverse().filter((r,j,a)=>!r.team || a.findIndex(q=>q.team===r.team)===j);
    const pts = runs.map(r=>[x(r.start), y(val(r)), r]);
    s += `<polyline points="${pts.map(p=>p[0]+','+p[1]).join(' ')}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-dasharray="${dashes[i%4]}"/>`;
    pts.forEach(([px,py,r]) => s += `<a href="#${rp(r)}"><circle cx="${px}" cy="${py}" r="4" fill="var(--panel)" stroke="var(--ink)" stroke-width="2"><title>${n} · ${r.id}: ${r.avoidable.length} avoidable / ${r.dels.length} Delegations</title></circle></a>`);
    const lp = pts[pts.length-1]; s += `<line x1="${W-R+10}" x2="${W-R+40}" y1="${20+i*22}" y2="${20+i*22}" stroke="var(--ink)" stroke-width="2" stroke-dasharray="${dashes[i%4]}"/><a href="#/repo/${enc(n)}"><text x="${W-R+46}" y="${24+i*22}">${esc(n)}</text></a>`; });
  return s + '</svg>';
}
function runsTable(list, showRepo){
  return `<div class="scroll"><table><tr><th>Started</th>${showRepo?'<th>Repo</th>':''}<th>Run</th><th>Who</th><th>Decisions</th><th class="num">Deleg.</th><th class="num">Time</th><th class="num">Human steps</th><th class="num">Avoidable</th><th style="min-width:120px">Causes</th><th>Outcome</th></tr>
  ${list.map(r=>`<tr class="click" data-go="${rp(r)}"><td class="nowrap">${fmtDate(r.start)}</td>${showRepo?`<td class="small">${esc(r.repo)}</td>`:''}<td>${runLink(r)}${syn(r)}${r.team?' <span class="tag">team</span>':''}</td><td>${esc(r.operator)}</td><td>${r.authority}</td><td class="num">${r.dels.length}</td><td class="num">${hrs(r.end-r.start)}</td><td class="num">${r.touches.length}</td><td class="num">${r.avoidable.length}</td><td>${stackTrack(r.touches)}</td><td>${outTag(r.outcome)}</td></tr>`).join('')}</table></div>`;
}
function pageRepo(name){
  const runs = runsOf(name); if (!runs.length) return notFound();
  const chron = [...runs].reverse(), ts = runs.flatMap(r=>r.touches);
  const W = 1100, H = 230, L = 40, bw = Math.min(60, (W-L-20)/chron.length - 10), max = Math.max(...chron.map(r=>r.touches.length));
  let svg = `<svg viewBox="0 0 ${W} ${H+40}" width="100%" style="min-width:600px">`;
  for (let v=0; v<=max; v+=Math.max(5,Math.ceil(max/5/5)*5)) { const y = H - v/max*(H-20); svg += `<line x1="${L}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${L-6}" y="${y+4}" text-anchor="end" class="mt">${v}</text>`; }
  chron.forEach((r,i) => { const x = L + 10 + i*((W-L-20)/chron.length); let y = H; const cc = causeCounts(r.touches);
    let g = ''; CAUSES.forEach(c => { if (!cc[c]) return; const h = cc[c]/max*(H-20); y -= h; g += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${ci(c).color}"><title>${r.id}: ${ci(c).label} ${cc[c]}</title></rect>`; });
    svg += `<a href="#${rp(r)}">${g}<text x="${x+bw/2}" y="${y-4}" text-anchor="middle" style="font-weight:600">${r.touches.length}</text><text x="${x+bw/2}" y="${H+14}" text-anchor="middle" class="mt">${fmtDate(r.start)}</text><text x="${x+bw/2}" y="${H+28}" text-anchor="middle" class="mt">${r.synthetic?'synthetic':'real'}${r.team?' · team':''}</text></a>`; });
  svg += '</svg>';
  const ops = [...new Set(runs.map(r=>r.operator))];
  return { crumbs: [['All repositories','/'],[name]], html: `<h1>${esc(name)}</h1><div class="muted" style="margin-bottom:12px">${esc(REPO_NOTE[name]||'')} · Showing only this repository's namespace (<code>run-records/${esc(name)}/</code>). ${link('/','See all repositories')}</div>
  <div class="kpis" style="margin-bottom:14px">${kpi(runs.length,'runs')}${kpi(pct(runs.filter(r=>r.outcome==='merged').length,runs.length),'merged')}${kpi(runs.reduce((a,r)=>a+r.dels.length,0),'Delegations')}${kpi(ts.length,'human steps')}${kpi(pct(runs.flatMap(r=>r.avoidable).length,ts.length),'avoidable')}${kpi(hrs(median(runs.map(r=>r.end-r.start))),'median run time')}${kpi(ops.length,'people running it')}</div>
  <div class="panel"><h2>Human steps per run, by cause</h2><div class="small muted">Oldest on the left. Click a bar to open the run.</div><div class="scroll">${svg}</div>${legend(causeCounts(ts))}</div>
  <div class="grid2"><div class="panel"><h2>All human steps in this repo</h2>${causeBars(ts)}</div>
  <div class="panel"><h2>People</h2><table><tr><th>Who</th><th class="num">Runs</th><th class="num">Delegations</th><th class="num">Human steps / Delegation</th><th class="num">Median run time</th></tr>${ops.map(o=>{const rs=runs.filter(r=>r.operator===o);const d=rs.reduce((a,r)=>a+r.dels.length,0);return `<tr><td>${esc(o)}</td><td class="num">${rs.length}</td><td class="num">${d}</td><td class="num">${(rs.reduce((a,r)=>a+r.touches.length,0)/d).toFixed(1)}</td><td class="num">${hrs(median(rs.map(r=>r.end-r.start)))}</td></tr>`}).join('')}</table>
  ${[...new Set(runs.filter(r=>r.team).map(r=>r.team))].map(t=>`<div class="callout">Team Run: ${link(tp(t), esc(t))}</div>`).join('')}</div></div>
  <div class="panel"><h2>Runs</h2>${runsTable(runs)}</div>` };
}
const RUN_TABS = [['summary','Summary'],['timeline','Timeline'],['delegations','Delegations'],['steps','Human steps'],['reviews','Reviews & CI'],['log','Log'],['record','Record (JSON)']];
let STEP_FILTER = { kind:'', cause:'', del:'', actor:'human' };
let LOG_MODE = 'events';
function pageRun(id, tab='summary'){
  const r = RUN[id]; if (!r) return notFound();
  const counts = { delegations:r.dels.length, steps:r.touches.length, reviews:r.reviews.length+r.ci.length, log:r.events.length };
  const head = `<h1>${esc(r.id)}${syn(r)} ${outTag(r.outcome)}</h1>
  <div class="sentence">Spec #${r.spec} in <b>${esc(r.repo)}</b>, run by ${esc(r.operator)}: ${r.tickets.length} tickets, ${r.dels.length} Delegations, ${r.authority} decisions, landing ${r.landing}. ${hrs(r.end-r.start)}${r.startBound?' at most':''} from start to close. You were needed <b>${r.touches.length}</b> times; <b style="color:#d9480f">${r.avoidable.length}</b> of them could go next run.${r.team?` Part of Team Run ${link(tp(r.team), esc(r.team))}.`:''}</div>
  <nav class="tabs">${RUN_TABS.map(([k,l])=>`<a href="#${rp(r)}/${k}" class="${k===tab?'on':''}">${l}${counts[k]!=null?`<span class="n">${counts[k]}</span>`:''}</a>`).join('')}</nav>`;
  const body = ({ summary: runSummary, timeline: runTimeline, delegations: runDelegations, steps: runSteps, reviews: runReviews, log: runLog, record: runRecord }[tab] || runSummary)(r);
  return { crumbs: [['All repositories','/'],[r.repo,'/repo/'+enc(r.repo)],[r.id]], html: head + body };
}
function runSummary(r){
  const fails = r.ci.filter(c=>c.result==='fail').length;
  const kinds = {}; r.touches.forEach(t=>kinds[t.k]=(kinds[t.k]||0)+1);
  return `<div class="kpis" style="margin-bottom:14px">${kpi(hrs(r.end-r.start)+(r.startBound?' ≤':''),'start → close', `${fmtDate(r.start)} ${hm(r.start)} → ${hm(r.end)} UTC`)}${kpi(r.dels.length,'Delegations', `${r.dels.filter(d=>d.route==='card').length} started from a card`)}${kpi(r.touches.length,'human steps',`${r.steps.length-r.touches.length} more done by the Chief of Staff`)}${kpi(`<i style="font-style:normal;color:#d9480f">${r.avoidable.length}</i>`,'avoidable')}${kpi(r.knownWait+'m','known waiting on you',`${r.touches.filter(t=>t.wait!=null).length} of ${r.touches.length} steps timed`)}${kpi(r.reviews.length,'review rounds',`${r.reviews.reduce((a,v)=>a+(v.findings||0),0)} findings`)}${kpi(r.ci.length,'CI runs',fails?`${fails} failed`:'all passed')}${kpi(r.dels.reduce((a,d)=>a+d.sendBacks,0),'send-backs')}${kpi(r.heartbeats.firings ?? '?','heartbeats',r.heartbeats.no_change!=null?`${r.heartbeats.no_change} with no change`:'')}</div>
  <div class="grid2"><div class="panel"><h2>What to improve next run</h2>${nextRunHtml(r)}</div>
  <div class="panel"><h2>Why you were needed</h2>${causeBars(r.touches)}<h3 style="margin-top:14px">By kind</h3>${Object.entries(kinds).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`<div class="bar"><span class="lbl mono small" title="${esc(KIND_INFO[k]||'')}">${esc(k)}</span><div class="track"><span style="width:${n/Math.max(...Object.values(kinds))*100}%;background:var(--muted)"></span></div><span class="val">${n}</span></div>`).join('')}
  ${r.touches.some(t=>t.assumed)?'<div class="small muted" style="margin-top:8px">Causes on this real record were assigned by the prototype: the hand-derived records predate the <code>cause</code> field.</div>':''}</div></div>
  <div class="grid2"><div class="panel"><h2>Plan</h2><dl class="dl"><dt>Decision authority</dt><dd>${r.authority}</dd><dt>Landing</dt><dd>${r.landing}</dd><dt>QA required</dt><dd>${r.plan.qa_required||'—'}</dd><dt>Waves</dt><dd>${r.plan.waves ?? '—'}${r.plan.wave_shape?` (${r.plan.wave_shape}${r.plan.serial_reason?', '+r.plan.serial_reason:''})`:''}</dd><dt>Routine writes approved</dt><dd>${(r.plan.routine_writes_approved||[]).map(w=>`<span class="tag">${w}</span>`).join(' ')||'—'}</dd><dt>Routine writes declined</dt><dd>${(r.plan.routine_writes_declined||[]).map(w=>`<span class="tag avoid">${w}</span>`).join(' ')||'—'}</dd><dt>Harness</dt><dd>${r.harness||'—'}</dd></dl></div>
  <div class="panel"><h2>Outcome</h2><dl class="dl"><dt>Outcome</dt><dd>${outTag(r.outcome)}</dd><dt>Pull requests</dt><dd>${r.prs.map(p=>`#${p}`).join(', ')||'—'}</dd><dt>Tickets</dt><dd>${r.tickets.map(t=>`#${t}`).join(', ')}</dd><dt>Rulings</dt><dd>${r.rulings.made ?? 0} made, ${r.rulings.overturned ?? 0} overturned</dd><dt>Sink namespace</dt><dd class="mono small">${esc(sinkPath(r))}</dd><dt>Closed</dt><dd>${r.end?new Date(r.end).toISOString().replace('T',' ').slice(0,16)+' UTC':'—'}</dd></dl></div></div>
  <div class="panel"><h2>Delegations</h2>${delTable(r)}</div>`;
}
function runTimeline(r){
  return `<div class="panel"><h2>The run on one clock</h2>${ganttKey()}<div class="scroll">${gantt(ganttRows(r), r.start, r.end)}</div>${legend(causeCounts(r.touches))}
  <div class="small muted">Human-step dots are coloured by <b>cause</b> (why you were needed). Hover for details, click to open the step.</div></div>`;
}
function delTable(r){
  return `<div class="scroll"><table><tr><th>Delegation</th><th>Kind</th><th class="num">Ticket</th><th>Started</th><th>Start</th><th class="num">Time</th><th>Timing from</th><th class="num">Human steps</th><th class="num">Send-backs</th><th class="num">Decision Requests</th><th>Outcome</th></tr>
  ${r.dels.map(d=>`<tr class="click" data-go="${rp(r)}/delegation/${d.id}"><td>${link(`${rp(r)}/delegation/${d.id}`, `<b class="mono">${d.id}</b>`)}</td><td><span class="sw" style="background:${DEL_FILL[d.kind]}"></span> ${d.kind}</td><td class="num">#${d.issue}</td><td class="nowrap">${d.s?hm(d.s):d.day||'?'}</td><td>${d.route==='card'?'<span class="tag avoid">card</span>':'direct'}</td><td class="num">${d.s&&d.e?mins(d.e-d.s):'?'}</td><td class="small muted">${d.sSrc?`${d.sSrc} → ${d.eSrc}`:'no times'}</td><td class="num"><b>${d.touches.length||''}</b></td><td class="num">${d.sendBacks||''}</td><td class="num">${d.drs||''}</td><td>${outTag(d.outcome)}</td></tr>`).join('')}</table></div>`;
}
const runDelegations = r => `<div class="panel"><h2>Delegations</h2><div class="small muted" style="margin-bottom:8px">Click a row for the Delegation's own page: its timing, its human steps and its log.</div>${delTable(r)}</div>`;
function stepsTable(r, list){
  return `<div class="scroll"><table><tr><th class="num">#</th><th>When</th><th>Who</th><th>Kind</th><th>Cause</th><th></th><th>Delegation</th><th>About</th><th class="num">Waited</th></tr>
  ${list.map(t=>`<tr class="click" data-go="${rp(r)}/step/${t.n}"><td class="num">${link(`${rp(r)}/step/${t.n}`, t.n)}</td><td class="nowrap">${whenTxt(t.w)}</td><td>${t.actor==='human'?'you':`<span class="muted">${t.actor}</span>`}</td><td class="mono small" title="${esc(KIND_INFO[t.k]||'')}">${esc(t.k)}</td><td>${t.cause?chip(t.cause):''}</td><td>${avoidTag(t.cause)}</td><td class="mono small">${t.del||'—'}</td><td class="small">${esc(t.topic||'')}</td><td class="num">${t.actor==='human'?waitTxt(t):''}</td></tr>`).join('')}</table></div>`;
}
function runSteps(r){
  const f = STEP_FILTER;
  const list = r.steps.filter(t => (f.actor==='all' || t.actor===f.actor || (f.actor==='other' && t.actor!=='human')) && (!f.kind||t.k===f.kind) && (!f.cause||t.cause===f.cause) && (!f.del||t.del===f.del));
  const opt = (name, vals, cur, all) => `<label class="small muted">${name} <select data-filter="${name.toLowerCase()}"><option value="">${all}</option>${vals.map(v=>`<option ${v===cur?'selected':''} value="${esc(v)}">${esc(v)}</option>`).join('')}</select></label>`;
  return `<div class="panel"><h2>Every step that involved you</h2>
  <div class="filters"><label class="small muted">Who <select data-filter="actor">${[['human','you (counted)'],['other','Chief of Staff / covered'],['all','everything']].map(([v,l])=>`<option value="${v}" ${f.actor===v?'selected':''}>${l}</option>`).join('')}</select></label>
  ${opt('Kind',[...new Set(r.steps.map(t=>t.k))].sort(),f.kind,'all kinds')}${opt('Cause',CAUSES.filter(c=>r.touches.some(t=>t.cause===c)),f.cause,'all causes')}${opt('Del',r.dels.map(d=>d.id),f.del,'all Delegations')}
  <span class="small muted">${list.length} shown</span> <button class="btn" onclick="STEP_FILTER={kind:'',cause:'',del:'',actor:'human'};render()">Reset</button></div>
  ${stepsTable(r, list)}<div class="small muted" style="margin-top:8px">One human step = one touch from you (an answer, a click, a typed command). Writes the Chief of Staff made after your answer carry <code>actor: chief-of-staff</code> and are not counted.</div></div>`;
}
function runReviews(r){
  return `<div class="grid2"><div class="panel"><h2>Review rounds</h2><table><tr><th>PR</th><th class="num">Round</th><th>Head</th><th>Triggered</th><th class="num">Took</th><th class="num">Findings</th><th class="num">Fixed</th><th class="num">Answered</th></tr>${r.reviews.map(v=>`<tr><td>#${v.pr}</td><td class="num">${v.round}</td><td class="mono small">${v.head||''}</td><td>${v.t?hm(v.t):'?'}</td><td class="num">${v.t&&v.e?mins(v.e-v.t):'?'}</td><td class="num">${v.findings??''}</td><td class="num">${v.fixed??''}</td><td class="num">${v.answered??''}</td></tr>`).join('')||'<tr><td colspan="8" class="muted">None</td></tr>'}</table></div>
  <div class="panel"><h2>CI</h2><table><tr><th>PR</th><th>Head</th><th>Created</th><th>Result</th><th class="num">Failed checks</th></tr>${r.ci.map(c=>`<tr><td>#${c.pr}</td><td class="mono small">${c.head||''}</td><td>${c.t?hm(c.t):'?'}</td><td>${outTag(c.result==='pass'?'landed':'qa-fail').replace(/landed|qa-fail/,c.result)}</td><td class="num">${c.failed_checks??''}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">None</td></tr>'}</table></div></div>`;
}
function runLog(r){
  const prose = LOGS[r.id];
  const modes = [['events','Run Events as text'],['report','Report (orchestrate --report)'],['activity','Activity Log (local only)']];
  let body;
  if (LOG_MODE === 'report') body = textBox('logtxt', reportText(r), `${r.id}-report.txt`);
  else if (LOG_MODE === 'activity') body = prose ? `<div class="callout small">This is the prose Activity Log from <code>tmp/orchestrate/${r.id}/activity.md</code>. It is only in a page built on this machine with <code>--local-logs</code>, and it is never part of an uploaded Run Record.</div>${textBox('logtxt', prose, `${r.id}-activity.md`, 'prose')}`
    : `<div class="callout">${r.synthetic?'Synthetic runs have no Activity Log.':`No Activity Log in this page. Build with <code>node docs/prototypes/run-record-dashboard/build.mjs --local-logs</code> to read <code>tmp/orchestrate/${r.id}/activity.md</code> into a local-only page (<code>dashboard.local.html</code>, gitignored).`} The Run Record holds no prose by design; the Run Events view shows everything it does hold.</div>`;
  else body = textBox('logtxt', textLog(r), `${r.id}-events.txt`);
  return `<div class="panel"><div class="filters">${modes.map(([k,l])=>`<button class="btn" style="${k===LOG_MODE?'background:var(--ink);color:var(--panel)':''}" onclick="LOG_MODE='${k}';render()">${l}</button>`).join('')}</div>${body}</div>`;
}
const runRecord = r => `<div class="panel"><div class="small muted" style="margin-bottom:6px">The Run Record exactly as stored${r.synthetic?' (synthetic)':''}, at <code>${esc(sinkPath(r))}</code> in the shared sink. Safe to publish: ids, times, counts, enums.</div>${textBox('rectxt', JSON.stringify(r.raw, null, 2), `${r.id}.json`)}</div>`;

function pageDelegation(id, did){
  const r = RUN[id], d = r && r.dels.find(x=>x.id===did); if (!d) return notFound();
  const evs = r.events.filter(e=>e.del===did);
  const rv = r.reviews.filter(v=>d.pr ? v.pr===d.pr : false), idx = r.dels.indexOf(d), prev = r.dels[idx-1], next = r.dels[idx+1];
  const t0 = Math.min(d.s||Infinity, ...d.touches.map(t=>t.w.lo||t.w.t||Infinity)), t1 = Math.max(d.e||0, ...d.touches.map(t=>t.w.hi||t.w.t||0));
  return { crumbs: [['All repositories','/'],[r.repo,'/repo/'+enc(r.repo)],[r.id,rp(r)+'/delegations'],[did]], html: `<h1><span class="mono">${did}</span>${syn(r)} ${outTag(d.outcome)}</h1>
  <div class="sentence">A <b>${d.kind}</b> Delegation for ticket #${d.issue}, started ${d.route==='card'?'<b>from a card you clicked</b>':'directly by the Chief of Staff'}${d.s&&d.e?`, ${mins(d.e-d.s)} from ${d.sSrc} to ${d.eSrc}`:d.day?`, on ${d.day} (no times recorded)`:''}. It needed you ${d.touches.length} time${d.touches.length===1?'':'s'}.</div>
  <div class="small" style="margin-bottom:10px">${prev?link(`${rp(r)}/delegation/${prev.id}`,'← '+prev.id):''} ${next?' · '+link(`${rp(r)}/delegation/${next.id}`,next.id+' →'):''}</div>
  <div class="grid2"><div class="panel"><h2>Facts</h2><dl class="dl">${Object.entries(d.raw).map(([k,v])=>`<dt class="mono small">${esc(k)}</dt><dd class="mono small">${esc(typeof v==='object'?JSON.stringify(v):v)}</dd>`).join('')}</dl></div>
  <div class="panel"><h2>Why it needed you</h2>${causeBars(d.touches)}${d.sSrc && d.sSrc!=='started'?`<div class="callout small">The record has no start time for this Delegation, so its time runs from the <b>${d.sSrc}</b>. It really started earlier.</div>`:''}</div></div>
  ${d.s&&isFinite(t0)?`<div class="panel"><h2>Timeline</h2>${gantt([ganttRows(r)[0], ...ganttRows(r).slice(2).filter(x=>x.href.endsWith('/'+did))].map((row,i)=>i===0?{...row,marks:row.marks.filter((m,j)=>r.touches[j].del===did)}:row), t0-5*60e3, t1+5*60e3, {rh:30})}</div>`:''}
  <div class="panel"><h2>Human steps</h2>${d.touches.length?stepsTable(r, d.touches):'<div class="muted">None. 🎉</div>'}</div>
  ${rv.length?`<div class="panel"><h2>Review rounds on PR #${d.pr}</h2><table><tr><th class="num">Round</th><th class="num">Findings</th><th class="num">Fixed</th></tr>${rv.map(v=>`<tr><td class="num">${v.round}</td><td class="num">${v.findings}</td><td class="num">${v.fixed}</td></tr>`).join('')}</table></div>`:''}
  <div class="panel"><h2>Log</h2>${textBox('dlog', textLog(r, evs), `${r.id}-${did}.txt`)}</div>` };
}
function pageStep(id, n){
  const r = RUN[id], s = r && r.steps.find(x=>String(x.n)===String(n)); if (!s) return notFound();
  const i = r.steps.indexOf(s), prev = r.steps[i-1], next = r.steps[i+1];
  const ei = r.events.findIndex(e=>e.step===s.n), near = r.events.slice(Math.max(0,ei-4), ei+5);
  const c = s.cause && ci(s.cause);
  const at = s.w.p==='exact' ? `At ${hm(s.w.t)} UTC on ${fmtDate(s.w.t)}` : s.w.p==='bounds' ? `Some time ${s.w.lo?'after '+hm(s.w.lo):''}${s.w.lo&&s.w.hi?' and ':''}${s.w.hi?'before '+hm(s.w.hi):''} UTC` : s.w.p==='date' ? `On ${s.w.day} (no time recorded)` : 'At an unknown time';
  return { crumbs: [['All repositories','/'],[r.repo,'/repo/'+enc(r.repo)],[r.id,rp(r)+'/steps'],['Step '+s.n]], html: `<h1>Step ${s.n}: <span class="mono">${esc(s.k)}</span>${syn(r)}</h1>
  <div class="sentence">${at}, ${s.actor==='human'?'you were needed':`the <b>${s.actor}</b> acted (not counted as a human step)`}: ${esc((KIND_INFO[s.k]||s.k).replace(/^You /,'').replace(/^./,x=>x.toLowerCase()))}${s.del?` For ${link(`${rp(r)}/delegation/${s.del}`, s.del)}.`:''}</div>
  <div class="small" style="margin-bottom:10px">${prev?link(`${rp(r)}/step/${prev.n}`,'← step '+prev.n):''} ${next?' · '+link(`${rp(r)}/step/${next.n}`,'step '+next.n+' →'):''} · ${link(`${rp(r)}/steps`,'all steps')}</div>
  <div class="grid2"><div class="panel"><h2>Fields</h2><dl class="dl"><dt>When</dt><dd>${whenTxt(s.w)}${s.raw.at_source?` <span class="small muted">from ${esc(s.raw.at_source)}</span>`:''}</dd><dt>Who</dt><dd>${s.actor==='human'?'you':s.actor}</dd><dt>Kind</dt><dd class="mono">${esc(s.k)}</dd><dt>Cause</dt><dd>${s.cause?chip(s.cause)+' '+avoidTag(s.cause)+(s.assumed?' <span class="small muted">(assigned by the prototype)</span>':''):'—'}</dd><dt>Delegation</dt><dd>${s.del?link(`${rp(r)}/delegation/${s.del}`,s.del):'— (run level)'}</dd><dt>About</dt><dd>${esc(s.topic||'—')}</dd><dt>Waited</dt><dd>${waitTxt(s)}${s.raw.waited_from?` <span class="small muted">since ${esc(s.raw.waited_from)}</span>`:''}</dd><dt>Heartbeats waiting</dt><dd>${s.hb||0}</dd></dl></div>
  <div class="panel"><h2>Why, and what to do</h2>${c?`<div class="callout" style="border-color:${c.color}"><b>${c.label}</b>: ${esc(c.meaning)}</div><div><b>Next run:</b> ${esc(c.fix)}</div>`:'<div class="muted">Not a human step, so no cause.</div>'}</div></div>
  <div class="panel"><h2>Around this step</h2>${textBox('slog', textLog(r, near).split('\n').slice(4).join('\n'), `${r.id}-step-${s.n}.txt`)}</div>
  <div class="panel"><h2>Raw entry</h2>${textBox('sraw', JSON.stringify(s.raw, null, 2), `${r.id}-step-${s.n}.json`)}</div>` };
}
function pageTeam(team){
  const list = RUNS.filter(r=>r.team===team).sort((a,b)=>a.start-b.start); if (!list.length) return notFound();
  const t0 = Math.min(...list.map(r=>r.start)), t1 = Math.max(...list.map(r=>r.end));
  const rows = []; list.forEach(r => { rows.push({ group:true, label:r.operator }); ganttRows(r,'  ').forEach(x=>rows.push(x)); });
  const ts = list.flatMap(r=>r.touches);
  return { crumbs: [['All repositories','/'],[list[0].repo,'/repo/'+encodeURIComponent(list[0].repo)],['Team Run '+team]], html: `<h1>Team Run ${esc(team)} <span class="syn">synthetic</span></h1>
  <div class="sentence">Spec #${list[0].spec} in <b>${esc(list[0].repo)}</b>: ${list.length} teammates, each running their own Chief of Staff over their own tickets, on one Shared Board. One Run Record each, merged here on one clock.</div>
  <div class="kpis" style="margin-bottom:14px">${kpi(list.length,'teammates')}${kpi(list.reduce((a,r)=>a+r.dels.length,0),'Delegations')}${kpi(hrs(t1-t0),'first start → last close')}${kpi(ts.length,'human steps')}${kpi(list.flatMap(r=>r.avoidable).length,'avoidable')}</div>
  <div class="panel"><h2>Everyone on one clock</h2>${ganttKey()}<div class="scroll">${gantt(rows,t0,t1)}</div>${legend(causeCounts(ts))}</div>
  <div class="panel"><h2>Teammates</h2><table><tr><th>Who</th><th>Run</th><th>Tickets</th><th class="num">Delegations</th><th class="num">Time</th><th class="num">Human steps</th><th class="num">Avoidable</th><th style="min-width:140px">Causes</th><th>Biggest fix</th></tr>
  ${list.map(r=>{const n=nextRun(r).find(x=>x.cause);return `<tr class="click" data-go="${rp(r)}"><td><b>${esc(r.operator)}</b></td><td>${runLink(r)}</td><td class="small">${r.tickets.map(t=>'#'+t).join(' ')}</td><td class="num">${r.dels.length}</td><td class="num">${hrs(r.end-r.start)}</td><td class="num">${r.touches.length}</td><td class="num">${r.avoidable.length}</td><td>${stackTrack(r.touches)}</td><td class="small">${n?esc(n.what):'—'}</td></tr>`}).join('')}</table></div>` };
}
function pageKey(){
  return { crumbs: [['All repositories','/'],['Key']], html: `<h1>What the colours and words mean</h1><div class="muted" style="margin-bottom:12px">Colour is never the only signal: every chip also says its name, and every human step says whether it was avoidable.</div>
  <div class="panel"><h2>Causes: why you were needed</h2><table><tr><th>Colour</th><th>Cause</th><th>Next run?</th><th>Meaning</th><th>Typical fix</th></tr>${CAUSES.map(c=>`<tr><td><span class="sw" style="background:${ci(c).color};width:28px;height:16px"></span></td><td><b>${ci(c).label}</b><div class="mono small muted">${c}</div></td><td>${avoidTag(c)}</td><td>${esc(ci(c).meaning)}</td><td class="small">${esc(ci(c).fix)}</td></tr>`).join('')}</table>
  <div class="small muted" style="margin-top:8px"><b>By design</b> and <b>Your choice</b> are expected; everything else counts as avoidable. <code>by-design</code> is a cause this prototype proposes adding to the curated list.</div></div>
  <div class="panel"><h2>Kinds: what you did</h2><table><tr><th>Kind</th><th>Meaning</th></tr>${Object.entries(KIND_INFO).map(([k,v])=>`<tr><td class="mono small">${k}</td><td>${esc(v)}</td></tr>`).join('')}</table></div>
  <div class="panel"><h2>Timeline marks</h2>${ganttKey()}</div>
  <div class="panel"><h2>Real and synthetic</h2>Two runs are real Run Records hand-derived from past runs (spec-344, spec-253); their times are often only bounds or dates, because the old Activity Logs had no times. Everything tagged <span class="syn">synthetic</span> is generated so the multi-repo, trend and Team Run pages have something to show.</div>` };
}
const notFound = () => ({ crumbs:[['All repositories','/'],['Not found']], html:'<h1>Not found</h1><a href="#/">Back to overview</a>' });

// ═══════════════════════ router, side nav ═══════════════════════
let ROUTE = location.hash.slice(1) || '/';
function go(path){ ROUTE = path; try { history.pushState(null, '', '#' + path); } catch (e) {} render(); scrollTo(0, 0); }
addEventListener('popstate', () => { ROUTE = location.hash.slice(1) || '/'; render(); });
document.addEventListener('click', e => {
  const a = e.target.closest('a'); const h = a && (a.getAttribute('href') || a.getAttribute('xlink:href'));
  if (h && h.startsWith('#/')) { e.preventDefault(); go(h.slice(1)); return; }
  const tr = e.target.closest('[data-go]'); if (tr && !a) go(tr.dataset.go);
});
document.addEventListener('change', e => { const f = e.target.dataset.filter; if (!f) return; STEP_FILTER[f] = e.target.value; render(); });
// Scope: "all repositories" at #/ and #/key; one repository anywhere under #/repo/<owner%2Fname>/...
const scopeOf = () => { const m = ROUTE.match(/^\/repo\/([^/]+)/); return m ? decodeURIComponent(m[1]) : ''; };
function side(){
  const on = p => ROUTE === p || ROUTE.startsWith(p + '/') ? 'on' : '', scope = scopeOf();
  let s = `<a href="#/" class="${ROUTE==='/'?'on':''}">All repositories <span class="muted small">${REPO_NAMES.length}</span></a>`;
  if (!scope) {
    s += `<div class="sec">Repositories</div>` + REPO_NAMES.map(n => `<a href="#/repo/${enc(n)}">${esc(n)} <span class="muted small">${runsOf(n).length}</span></a>`).join('');
    s += `<div class="sec">Team Runs</div>` + TEAMS.map(t => `<a href="#${tp(t)}">${esc(t)} <span class="muted small">${esc(TEAM_REPO[t].split('/')[1])}</span></a>`).join('');
  } else {
    const p = '/repo/' + enc(scope), runs = runsOf(scope), teams = TEAMS.filter(t=>TEAM_REPO[t]===scope);
    s += `<div class="sec">${esc(scope)}</div><a href="#${p}" class="${ROUTE===p?'on':''}">Repository overview</a><div class="sec">Runs (${runs.length})</div>`;
    s += runs.map(r => `<a class="sub ${ROUTE.startsWith(rp(r))?'on':''}" href="#${rp(r)}">${fmtDate(r.start)} · spec ${r.spec}${r.team?' · '+r.operator:''}${r.synthetic?'':' · real'}</a>`).join('');
    if (teams.length) s += `<div class="sec">Team Runs</div>` + teams.map(t => `<a href="#${tp(t)}" class="${on(tp(t))}">${esc(t)}</a>`).join('');
  }
  s += `<div class="sec">Help</div><a href="#/key" class="${on('/key')}">Key: colours &amp; words</a>`;
  return s;
}
function switcher(){
  const scope = scopeOf();
  return `<label class="small muted">Repository <select id="repoSel"><option value="">All repositories (${REPO_NAMES.length})</option>${REPO_NAMES.map(n=>`<option value="${esc(n)}" ${n===scope?'selected':''}>${esc(n)} (${runsOf(n).length} runs)</option>`).join('')}</select></label>`;
}
function render(){
  const p = ROUTE.split('/').filter(Boolean).map(decodeURIComponent);
  const key = p[0]==='repo' && p[2]==='run' ? p[1]+'::'+p[3] : null;
  const page = !p.length ? pageOverview() : p[0]==='key' ? pageKey()
    : p[0]==='repo' ? (p[2]==='team' ? pageTeam(p[3]) : p[2]==='run' ? (p[4]==='step' ? pageStep(key, p[5]) : p[4]==='delegation' ? pageDelegation(key, p[5]) : pageRun(key, p[4])) : pageRepo(p[1]))
    : notFound();
  document.getElementById('app').innerHTML = page.html;
  document.getElementById('crumbs').innerHTML = page.crumbs.map(([l,h],i)=> h && i < page.crumbs.length-1 ? `<a href="#${h}">${esc(l)}</a>` : `<b>${esc(l)}</b>`).join(' › ');
  document.getElementById('side').innerHTML = side();
  document.getElementById('switch').innerHTML = switcher();
  document.getElementById('repoSel').onchange = e => go(e.target.value ? '/repo/' + enc(e.target.value) : '/');
}
document.getElementById('theme').onclick = () => { const d = document.documentElement, dark = d.dataset.theme ? d.dataset.theme==='dark' : matchMedia('(prefers-color-scheme: dark)').matches; d.dataset.theme = dark ? 'light' : 'dark'; };
render();
