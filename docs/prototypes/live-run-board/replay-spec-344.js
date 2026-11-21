// PROTOTYPE, throwaway (#407). The spec-344 run (2026-11-19) as a stream of Run Events, for replay as a fake live run.
// Times are real where the Run Record (prototype/run-record-fields) has them from git/gh; otherwise placed inside the
// record's at_bounds and marked `est: true`. Only safe fields: ids, kinds, causes, states. No issue text, no output.
//
// Event shape (a proposal for what the board reads):
//   { at, actor, kind, del?, state?, wait?: {id, open|close, cause, why, how}, note? }
//   actor: 'chief-of-staff' | 'human' | a Delegation id | 'ci' | 'review'
//   state: the Delegation's new board state (RUN.md "States"), when the event changes it.
//   wait.open: the run now waits on the human; wait.close: that wait ended (by the human, or by an actor on their yes).
window.RUN = {
  id: '2026-11-19-spec-344', repo: 'mnaimfaizy/agent-kit', spec: 344, authority: 'autonomous', landing: 'integration-branch',
  harness: 'claude-code-desktop', operator: 'mnaimfaizy',
  delegations: [
    { id: 'd348', issue: 348, kind: 'building', wave: 1, title: 'Open a Security Response Run, show its board' },
    { id: 'd349', issue: 349, kind: 'building', wave: 2, title: 'Reconcile and resume a Security Response Run' },
    { id: 'd350', issue: 350, kind: 'building', wave: 3, title: 'Land triage outcomes; triage stops writing ledger' },
    { id: 'd351', issue: 351, kind: 'building', wave: 4, title: 'Record human steps; publish, close, CVE' },
    { id: 'd352', issue: 352, kind: 'building', wave: 5, title: 'Show and close no-findings drafts' },
    { id: 'd353', issue: 353, kind: 'building', wave: 6, title: 'Close a run and write the findings ledger' },
    { id: '<integration>', issue: 344, kind: 'building', wave: 'after d353', title: 'Integration branch, PR #387' },
    { id: 'd344-fix1', issue: 344, kind: 'building (fix)', wave: 'after review', title: "Answer PR #387's review, merge main" },
  ],
};
const E = (at, actor, kind, o = {}) => ({ at: '2026-11-19T' + at + ':00Z', actor, kind, ...o });
const cards = [['d350', '03:27', '03:34', 'task_184e1773'], ['d351', '03:42', '03:50', 'task_ee8dfe89'],
  ['d352', '03:58', '04:04', 'task_2766ee4a'], ['d353', '04:08', '04:24', 'task_e0243937']];
const ev = [
  E('02:55', 'chief-of-staff', 'run-started', { note: 'config check ready; harness claude-code-desktop, verified' }),
  E('03:01', 'chief-of-staff', 'plan-shown', { note: '6 tickets, 6 serial waves (scope fences overlap)' }),
  E('03:01', 'chief-of-staff', 'wait-opened', { wait: { id: 'w-plan', open: true, cause: 'by-design', why: 'Approve the Dispatch Plan and the landing', how: 'Answer in the Chief of Staff chat: go, or go autonomous' } }),
  E('03:07', 'human', 'plan-approved', { wait: { id: 'w-plan', close: true }, note: 'go autonomous, 2' }),
  E('03:08', 'chief-of-staff', 'spawned', { del: 'd348', state: 'running', note: 'Live Session, direct start' }),
  E('03:10', 'd348', 'commit', { del: 'd348' }),
  E('03:14', 'd348', 'reported', { del: 'd348', state: 'reported' }),
  E('03:16', 'chief-of-staff', 'regate', { del: 'd348', note: 'all 6 pass' }),
  E('03:17', 'chief-of-staff', 'landed', { del: 'd348', state: 'landed', note: 'orchestrate/spec-344 → 6fc67d7' }),
  E('03:18', 'chief-of-staff', 'spawned', { del: 'd349', state: 'running', note: 'Live Session, direct start' }),
  E('03:21', 'd349', 'commit', { del: 'd349' }),
  E('03:26', 'd349', 'reported', { del: 'd349', state: 'reported' }),
  E('03:27', 'chief-of-staff', 'landed', { del: 'd349', state: 'landed', note: '→ f17e566' }),
];
const landed = { d350: ['03:41', '03:42', '7ea8b5d'], d351: ['03:57', '03:58', '5159081'], d352: ['04:07', '04:08', 'd02f591'], d353: ['04:29', '04:31', '75aa766'] };
for (const [d, open, close, card] of cards) {
  ev.push(E(open, 'chief-of-staff', 'start-refused', { del: d, note: 'start_session refused on a heartbeat turn; card proposed' }));
  ev.push(E(open, 'chief-of-staff', 'wait-opened', { del: d, wait: { id: 'w-' + d, open: true, cause: 'harness-limit', why: `Start ${d}: the harness only lets you start it`, how: `Click the New task card ${card} in the Chief of Staff session`, est: true } }));
  if (d === 'd353') ev.push(E('04:16', 'chief-of-staff', 'heartbeat', { note: 'card not started yet; no change' }));
  ev.push(E(close, 'human', 'card-started', { del: d, state: 'running', wait: { id: 'w-' + d, close: true }, est: true }));
  ev.push(E(landed[d][0], d, 'reported', { del: d, state: 'reported' }));
  ev.push(E(landed[d][1], 'chief-of-staff', 'landed', { del: d, state: 'landed', note: '→ ' + landed[d][2] }));
}
ev.push(
  E('04:41', 'chief-of-staff', 'pr-opened', { del: '<integration>', state: 'reported', note: 'routine write 2: pushed, draft PR #387' }),
  E('04:41', 'ci', 'ci-started', { del: '<integration>', note: 'head 75aa766' }),
  E('04:41', 'chief-of-staff', 'wait-opened', { del: '<integration>', wait: { id: 'w-rev1', open: true, cause: 'missing-config', why: 'Add the agent:review label to PR #387? (not approved as a routine write)', how: 'Answer in the Chief of Staff chat' } }),
  E('04:43', 'human', 'answered', { del: '<integration>', wait: { id: 'w-rev1', close: true }, note: 'yes, add the label' }),
  E('04:43', 'chief-of-staff', 'write-as-human', { del: '<integration>', note: 'label agent:review on #387' }),
  E('04:43', 'review', 'review-started', { del: '<integration>', note: 'round 1 on 75aa766' }),
  E('04:46', 'review', 'review-finished', { del: '<integration>', note: '7 threads: 5 in fence, 2 outside' }),
  E('04:47', 'chief-of-staff', 'wait-opened', { del: '<integration>', wait: { id: 'w-s1', open: true, cause: 'spec-gap', why: 'Widen the fence for finding S1 (outside every fence)?', how: 'Answer in the Chief of Staff chat' } }),
  E('04:47', 'chief-of-staff', 'wait-opened', { del: '<integration>', wait: { id: 'w-s3', open: true, cause: 'spec-gap', why: 'Widen the fence for finding S3 (outside every fence)?', how: 'Answer in the Chief of Staff chat' } }),
  E('04:47', 'chief-of-staff', 'wait-opened', { del: '<integration>', state: 'waiting', wait: { id: 'w-behind', open: true, cause: 'human-choice', why: 'PR #387 is BEHIND main: merge main in?', how: 'Answer in the Chief of Staff chat' } }),
  E('04:52', 'ci', 'ci-finished', { del: '<integration>', note: 'pass' }),
  E('05:03', 'human', 'answered', { wait: { id: 'w-s1', close: true }, est: true }),
  E('05:03', 'human', 'answered', { wait: { id: 'w-s3', close: true }, est: true }),
  E('05:03', 'human', 'answered', { del: '<integration>', state: 'sent back', wait: { id: 'w-behind', close: true }, est: true, note: 'merge main in' }),
  E('05:04', 'chief-of-staff', 'start-refused', { del: 'd344-fix1', note: 'AskUserQuestion answer is not a user turn; card proposed' }),
  E('05:04', 'chief-of-staff', 'wait-opened', { del: 'd344-fix1', wait: { id: 'w-fix1', open: true, cause: 'harness-limit', why: 'Start d344-fix1: the harness only lets you start it', how: 'Click the New task card task_3e11ec7d in the Chief of Staff session', est: true } }),
  E('05:06', 'human', 'card-started', { del: 'd344-fix1', state: 'running', wait: { id: 'w-fix1', close: true }, est: true }),
  E('05:20', 'd344-fix1', 'reported', { del: 'd344-fix1', state: 'reported', est: true }),
  E('05:22', 'chief-of-staff', 'landed', { del: 'd344-fix1', state: 'landed', est: true, note: '→ b3609bb, pushed' }),
  E('05:22', 'chief-of-staff', 'state', { del: '<integration>', state: 'reported', est: true }),
  E('05:23', 'ci', 'ci-started', { del: '<integration>', note: 'head b3609bb' }),
  E('05:23', 'd344-fix1', 'permission-refused', { del: 'd344-fix1', note: 'gh api POST of 7 drafted replies refused by its permission mode', est: true }),
  E('05:24', 'chief-of-staff', 'wait-opened', { del: '<integration>', wait: { id: 'w-rep1', open: true, cause: 'missing-config', why: 'Post 7 drafted review replies and re-add agent:review (writes as you)', how: 'Answer in the Chief of Staff chat', est: true } }),
  E('05:31', 'ci', 'ci-finished', { del: '<integration>', note: 'pass' }),
  E('05:38', 'chief-of-staff', 'heartbeat', { note: 'no change; waiting on you' }),
  E('05:46', 'chief-of-staff', 'heartbeat', { note: 'no change; waiting on you' }),
  E('05:54', 'chief-of-staff', 'heartbeat', { note: 'no change; waiting on you' }),
  E('05:58', 'human', 'answered', { del: '<integration>', wait: { id: 'w-rep1', close: true }, note: 'yes, do both' }),
  E('05:58', 'chief-of-staff', 'write-as-human', { del: '<integration>', note: '7 replies posted; label re-added' }),
  E('05:58', 'review', 'review-started', { del: '<integration>', note: 'round 2 on b3609bb' }),
  E('06:01', 'review', 'review-finished', { del: '<integration>', state: 'sent back', note: '1 new thread (nit), in d344-fix1 fence' }),
  E('06:02', 'chief-of-staff', 'messaged', { del: 'd344-fix1', state: 'running', note: 'fix the new thread, draft the reply' }),
  E('06:05', 'd344-fix1', 'reported', { del: 'd344-fix1', state: 'reported' }),
  E('06:07', 'chief-of-staff', 'landed', { del: 'd344-fix1', state: 'landed', note: '→ b779e0c, pushed', est: true }),
  E('06:08', 'ci', 'ci-started', { del: '<integration>', state: 'reported', note: 'head b779e0c' }),
  E('06:08', 'chief-of-staff', 'wait-opened', { del: '<integration>', wait: { id: 'w-rep2', open: true, cause: 'missing-config', why: 'Post 1 drafted reply and re-add agent:review (writes as you)', how: 'Answer in the Chief of Staff chat' } }),
  E('06:12', 'human', 'answered', { del: '<integration>', wait: { id: 'w-rep2', close: true }, note: 'yes, do both' }),
  E('06:12', 'review', 'review-started', { del: '<integration>', note: 'round 3 on b779e0c' }),
  E('06:14', 'review', 'review-finished', { del: '<integration>', note: 'no new threads; review settled' }),
  E('06:15', 'chief-of-staff', 'default-branch-check', { del: '<integration>', state: 'ready to merge', note: 'passed at main 9f24e15' }),
  E('06:15', 'chief-of-staff', 'wait-opened', { del: '<integration>', wait: { id: 'w-merge', open: true, cause: 'human-choice', why: 'PR #387 is Ready to Merge: merging is yours', how: 'Merge PR #387 on GitHub' } }),
  E('06:26', 'human', 'merged', { del: '<integration>', state: 'merged', wait: { id: 'w-merge', close: true }, note: 'PR #387, admin bypass' }),
);
for (const d of ['d348', 'd349', 'd350', 'd351', 'd352', 'd353', 'd344-fix1']) ev.push(E('06:26', 'chief-of-staff', 'state', { del: d, state: 'merged' }));
ev.push(
  E('06:26', 'chief-of-staff', 'wait-opened', { wait: { id: 'w-close', open: true, cause: 'by-design', why: 'Post the Run Summary on #344 and close it?', how: 'Answer in the Chief of Staff chat' } }),
  E('06:27', 'human', 'answered', { wait: { id: 'w-close', close: true }, note: 'post and close' }),
  E('06:27', 'chief-of-staff', 'run-closed', { note: 'Run Summary posted; #344 closed' }),
);
window.RUN.events = ev.sort((a, b) => a.at.localeCompare(b.at));
