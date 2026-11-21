// SYNTHETIC Run Records (prototype only). Seeded, so every build shows the same numbers.
// The shape is v0 plus the fields #393 decided (cause per human step) and the ones this prototype
// found missing (run.repo, run.operator, run.team_run, Delegation started_at/ended_at).
function rng(seed){ return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hex(R){ return Math.floor(R()*0xfffffff).toString(16).padStart(7,'0').slice(0,7); }

function synthRun(o){
  const R = rng(o.seed), btw = (a,b) => a + Math.floor(R()*(b-a+1)), t0 = Date.parse(o.start);
  const iso = m => new Date(t0 + m*60000).toISOString();
  const hs = [], dels = [], reviews = [], ci = [], prs = [];
  const touch = (m, kind, cause, x = {}) => hs.push({ at: iso(m), kind, cause, delegation: x.delegation || null, waited_minutes: x.wait ?? btw(0, 10), ...x.extra });
  touch(0, 'plan-approval', 'by-design', { wait: btw(2, 15) });
  const per = o.landing === 'per-ticket';
  let waveStart = btw(4, 9), waveEnd = waveStart, wave = 1, end = 0;
  const tickets = Array.from({ length: o.n }, (_, i) => (o.ticketBase ?? o.spec) + 1 + i);
  tickets.forEach((iss, i) => {
    if (i > 0 && i % o.parallel === 0) { waveStart = waveEnd + btw(2, 6); wave++; }
    const id = 'd' + iss; let s = waveStart + btw(0, 4);
    const card = R() < o.cardRate;
    if (card) { const w = btw(3, 18); touch(s + w, 'card-start', 'harness-limit', { delegation: id, wait: w }); s += w; }
    const dur = btw(18, 75); let e = s + dur, drs = 0;
    if (R() < o.gapRate) { const w = btw(3, 25); touch(s + btw(5, dur - 5) + w, 'decision-request', 'spec-gap', { delegation: id, wait: w, extra: { topic: 'fence-widening' } }); e += w; drs++; }
    if (R() < o.permRate) touch(s + btw(3, dur), 'permission-refusal', 'permission-refusal', { delegation: id, wait: btw(1, 9) });
    if (R() < o.bugRate) touch(s + btw(3, dur), 'stale-relay', 'skill-bug', { delegation: id, wait: btw(1, 6) });
    const abandoned = o.abandonAt === i;
    const sb = !abandoned && R() < 0.3 ? 1 : 0;
    dels.push({ id, issue: iss, kind: 'building', executor: 'live-session', model: 'default', wave, start_route: card ? 'card' : 'direct',
      started_at: iso(s), ended_at: iso(e), landed_at: abandoned ? null : iso(e), outcome: abandoned ? 'abandoned' : 'landed',
      send_backs: sb, decision_requests: drs, rulings: 0, commits: btw(2, 9), head: hex(R) });
    let last = e;
    if (per && !abandoned) {
      const pr = o.prBase + i; prs.push(pr);
      const rounds = btw(1, 3);
      for (let r = 1; r <= rounds; r++) { const f = r === rounds ? 0 : btw(1, 5); reviews.push({ pr, head: hex(R), round: r, triggered_at: iso(last + 1), finished_at: iso(last + 4), findings: f, fixed: f, answered: 0 }); last += btw(6, 15); }
      const fail = R() < 0.18; ci.push({ pr, head: hex(R), created_at: iso(last), result: fail ? 'fail' : 'pass', failed_checks: fail ? 1 : 0 });
      if (o.qa) {
        const qid = id + '-qa', qs = last + btw(1, 4), qd = btw(12, 30);
        dels.push({ id: qid, issue: iss, kind: 'qa', executor: 'live-session', model: 'default', wave: 'after-' + id, start_route: R() < o.cardRate ? 'card' : 'direct', started_at: iso(qs), ended_at: iso(qs + qd), outcome: 'qa-pass', send_backs: 0, decision_requests: 1, rulings: 0 });
        if (R() < o.qaTyped) { touch(qs + 1, 'qa-typed-command', 'harness-limit', { delegation: qid, extra: { command: 'qa-plan' } }); touch(qs + 8, 'qa-typed-command', 'harness-limit', { delegation: qid, extra: { command: 'manual-qa' } }); }
        if (R() < o.qaTyped) touch(qs + 3, 'qa-readiness-answer', 'missing-config', { delegation: qid });
        if (R() < 0.25) touch(qs + 5, 'qa-stack-start', 'tool-missing', { delegation: qid });
        touch(qs + qd, 'qa-review-box', 'human-choice', { delegation: qid, wait: btw(2, 30) });
        last = qs + qd;
      }
      touch(last + btw(3, 25), 'merge', 'human-choice', { delegation: id, extra: { pr } });
    }
    waveEnd = Math.max(waveEnd, last); end = Math.max(end, last);
  });
  if (!per) {
    const pr = o.prBase; prs.push(pr); let t = waveEnd + 3;
    if (R() < o.cfgRate) touch(t + 2, 'decision-request', 'missing-config', { wait: btw(1, 12), extra: { topic: 'review-trigger' } });
    const rounds = btw(1, 3);
    for (let r = 1; r <= rounds; r++) { const f = r === rounds ? 0 : btw(1, 7); reviews.push({ pr, head: hex(R), round: r, triggered_at: iso(t + 3), finished_at: iso(t + 6), findings: f, fixed: f, answered: 0 });
      if (f && R() < o.cfgRate) touch(t + 9, 'decision-request', 'missing-config', { wait: btw(2, 30), extra: { topic: 'post-replies-and-retrigger-review' } });
      t += btw(15, 40); }
    ci.push({ pr, head: hex(R), created_at: iso(t), result: 'pass', failed_checks: 0 });
    if (o.outcome !== 'abandoned') touch(t + btw(4, 15), 'merge', 'human-choice', { wait: btw(2, 15), extra: { pr } });
    end = t + 16;
  }
  touch(end + 2, 'close-out', 'by-design', { wait: btw(0, 4) });
  return { schema: 'run-record/0', _synthetic: true,
    run: { id: o.id, repo: o.repo, operator: o.operator || 'you', team_run: o.team || null, kind: o.team ? 'team' : 'spec', spec: o.spec, tickets,
      harness: 'claude-code-desktop', support_level: 'verified', decision_authority: o.authority, landing: o.landing,
      started_at: iso(0), plan_approved_at: iso(hs[0].waited_minutes), closed_at: iso(end + 3), outcome: o.outcome || 'merged', pull_requests: prs },
    plan: { routine_writes_approved: o.cfgRate < 0.3 ? ['open-final-pr', 'add-review-label', 'post-review-replies'] : ['open-final-pr'], routine_writes_declined: o.cfgRate >= 0.3 ? ['add-review-label'] : [],
      qa_required: o.qa ? 'report' : 'none', waves: wave, concurrency_limit: o.parallel },
    delegations: dels, human_interventions: hs, reviews, ci, rulings: { made: Math.floor(R()*2), upheld: 0, overturned: 0 },
    heartbeats: { firings: btw(6, 30), no_change: btw(3, 12) } };
}

// Repos: each repo is a Consumer; runs get better over time (rates fall), so trends are visible.
const SYNTH_REPOS = [
  { repo: 'mnaimfaizy/agent-kit', note: 'Real runs from 17 and 19 Nov, plus synthetic runs before them for a trend', runs: [
    { date: '2026-10-21T01:00:00Z', spec: 150, n: 4, authority: 'relay', landing: 'per-ticket', qa: false, parallel: 2, k: 1.0 },
    { date: '2026-11-02T03:00:00Z', spec: 180, n: 5, authority: 'relay', landing: 'per-ticket', qa: false, parallel: 3, k: .9 },
    { date: '2026-11-10T00:30:00Z', spec: 214, n: 3, authority: 'autonomous', landing: 'integration-branch', qa: false, parallel: 1, k: .8 } ] },
  { repo: 'example-org/storefront-web', note: 'Web app with QA on every ticket', runs: [
    { date: '2026-10-06T22:00:00Z', spec: 400, n: 3, authority: 'relay', landing: 'per-ticket', qa: true, parallel: 2, k: 1.0 },
    { date: '2026-10-14T23:00:00Z', spec: 420, n: 4, authority: 'relay', landing: 'per-ticket', qa: true, parallel: 2, k: .95 },
    { date: '2026-10-23T21:30:00Z', spec: 440, n: 5, authority: 'relay', landing: 'per-ticket', qa: true, parallel: 3, k: .85, operator: 'teammate-ana' },
    { date: '2026-11-01T22:10:00Z', spec: 460, n: 4, authority: 'autonomous', landing: 'per-ticket', qa: true, parallel: 2, k: .7 },
    { date: '2026-11-08T20:00:00Z', spec: 480, n: 6, authority: 'autonomous', landing: 'per-ticket', qa: true, parallel: 3, k: .55, operator: 'teammate-ana' },
    { date: '2026-11-14T21:45:00Z', spec: 500, n: 3, authority: 'autonomous', landing: 'per-ticket', qa: true, parallel: 3, k: .4 },
    { date: '2026-11-19T22:30:00Z', spec: 520, n: 5, authority: 'autonomous', landing: 'per-ticket', qa: true, parallel: 3, k: .3 } ] },
  { repo: 'example-org/billing-api', note: 'Backend service; one abandoned run and one Team Run', runs: [
    { date: '2026-10-09T02:00:00Z', spec: 600, n: 5, authority: 'relay', landing: 'integration-branch', qa: false, parallel: 1, k: 1.0 },
    { date: '2026-10-20T03:00:00Z', spec: 620, n: 4, authority: 'autonomous', landing: 'integration-branch', qa: false, parallel: 2, k: .9, outcome: 'abandoned', abandonAt: 2 },
    { team: 'team-billing-640', spec: 640, date: '2026-11-04T01:00:00Z', members: [
        { operator: 'you', n: 3, off: 0 }, { operator: 'teammate-ana', n: 2, off: 25 }, { operator: 'teammate-ben', n: 3, off: 40 } ],
      authority: 'autonomous', landing: 'integration-branch', qa: false, parallel: 1, k: .75 },
    { date: '2026-11-12T02:20:00Z', spec: 660, n: 6, authority: 'autonomous', landing: 'integration-branch', qa: false, parallel: 2, k: .55, operator: 'teammate-ben' },
    { date: '2026-11-18T01:10:00Z', spec: 680, n: 4, authority: 'autonomous', landing: 'integration-branch', qa: false, parallel: 2, k: .45 } ] },
  { repo: 'example-org/docs-site', note: 'Small docs repo, short runs', runs: [
    { date: '2026-10-12T05:00:00Z', spec: 800, n: 2, authority: 'autonomous', landing: 'integration-branch', qa: false, parallel: 2, k: .6 },
    { date: '2026-10-26T04:00:00Z', spec: 810, n: 3, authority: 'autonomous', landing: 'integration-branch', qa: false, parallel: 3, k: .5 },
    { date: '2026-11-06T06:00:00Z', spec: 820, n: 2, authority: 'autonomous', landing: 'integration-branch', qa: false, parallel: 2, k: .35 },
    { date: '2026-11-19T05:30:00Z', spec: 344, n: 3, authority: 'autonomous', landing: 'integration-branch', qa: false, parallel: 3, k: .25 } ] },
];

const SYNTH_RECORDS = [];
SYNTH_REPOS.forEach((r, ri) => r.runs.forEach((x, i) => {
  const rates = k => ({ cardRate: .55*k, gapRate: .35*k, permRate: .12*k, bugRate: .1*k, qaTyped: .9*k + .1, cfgRate: .6*k });
  const base = { repo: r.repo, authority: x.authority, landing: x.landing, qa: x.qa, parallel: x.parallel, prBase: x.spec + 50, ...rates(x.k) };
  if (x.team) {
    let start = 0;
    x.members.forEach((m, j) => { const st = new Date(Date.parse(x.date) + m.off*60000).toISOString();
      SYNTH_RECORDS.push(synthRun({ ...base, id: `${st.slice(0,10)}-spec-${x.spec}-${m.operator}`, spec: x.spec, ticketBase: x.spec + start, team: x.team, operator: m.operator, n: m.n, start: st, prBase: x.spec + 50 + j, seed: 1000*ri + 100*i + j + 7 }));
      start += m.n; });
    return;
  }
  SYNTH_RECORDS.push(synthRun({ ...base, id: `${x.date.slice(0,10)}-spec-${x.spec}`, spec: x.spec, n: x.n, start: x.date, operator: x.operator, outcome: x.outcome, abandonAt: x.abandonAt, seed: 1000*ri + 100*i + 1 }));
}));
