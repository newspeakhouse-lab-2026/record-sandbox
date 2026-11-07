// Runs the label-proposals workflow's own script against a stubbed GitHub API.
//
// The workflow uses pull_request_target, which GitHub always executes from the
// DEFAULT branch — so it cannot be exercised on the pull request that proposes
// it. Without this, its first real run would be after adoption. The script is
// read out of the workflow file rather than copied, so the two cannot drift.
//
//   node .github/scripts/test-label-proposals.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const yml = fs.readFileSync(path.join(here, '..', 'workflows', 'label-proposals.yml'), 'utf8');

const m = yml.match(/^[ \t]*script: \|\s*\n([\s\S]*)$/m);
if (!m) { console.error('could not find the script block in label-proposals.yml'); process.exit(1); }
const lines = m[1].split('\n');
const indent = Math.min(...lines.filter(l => l.trim()).map(l => l.length - l.trimStart().length));
const SCRIPT = lines.map(l => (l.trim() ? l.slice(indent) : '')).join('\n');

const DEFAULT_DATA = JSON.stringify({ procedures: {
  'tier-a': { days: 2 }, 'tier-b': { daysFromLabel: true }, 'tier-c': { days: 7 },
  'layer-3': { days: 7, needsApprovals: 1 }, 'layer-4': { days: 7, needsApprovals: 2 },
  'emergency': { days: 0.5 },
} });

async function run({ labels = [], pr, eventName = 'pull_request_target', action = 'opened',
                     timeline = [], reviews = [], comments = [], files = [], dataJson = DEFAULT_DATA }) {
  const added = [], dropped = [], posted = [], updated = [], warnings = [];
  const exists = n => { if (!labels.includes(n)) throw new Error('404'); return { data: { name: n } }; };
  const github = {
    rest: {
      issues: {
        get: async () => ({ data: { labels: labels.map(name => ({ name })) } }),
        getLabel: async ({ name }) => exists(name),
        createLabel: async () => ({}),
        addLabels: async ({ labels: l }) => { added.push(...l); return {}; },
        removeLabel: async ({ name }) => { dropped.push(name); return {}; },
        listComments: async () => ({ data: comments }),
        createComment: async ({ body }) => { posted.push(body); return {}; },
        updateComment: async ({ comment_id, body }) => { updated.push({ comment_id, body }); return {}; },
        listEventsForTimeline: 'TIMELINE',
      },
      pulls: { listReviews: 'REVIEWS', listFiles: 'FILES' },
      repos: {
        getContent: async ({ path }) => {
          if (path === 'docs/data.json') return { data: { content: Buffer.from(dataJson, 'utf8').toString('base64') } };
          throw Object.assign(new Error('404'), { status: 404 });
        },
      },
    },
    paginate: async fn => (fn === 'TIMELINE' ? timeline : fn === 'REVIEWS' ? reviews
      : fn === 'FILES' ? files.map(filename => ({ filename })) : []),
  };
  const context = { payload: { pull_request: pr, action, repository: { default_branch: 'main' } }, repo: { owner: 'o', repo: 'r' }, eventName };
  const core = { warning: msg => warnings.push(msg) };
  await new Function('github', 'context', 'core',
    'return (async()=>{' + SCRIPT + '})()')(github, context, core);
  return { added, dropped, posted: posted.length, bodies: posted, updated, warnings };
}

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};

const FILLED = [
  '## Proposal', '', '**Layer:** 2', '', '**Tier:** A', '',
  '**File(s):**', '`rules/rule-example.md`', '',
  '### Why this layer', 'Because it operates within an existing frame.', '',
].join('\n');

const base = { number: 1, draft: false, created_at: '2026-10-01T09:00:00Z' };
let r;

r = await run({ pr: { ...base, body: FILLED }, action: 'ready_for_review',
  timeline: [{ event: 'ready_for_review', created_at: '2026-10-03T20:15:30.000Z' }] });
check('a filled proposal marked ready is labelled, opened: from the timeline',
  r.added.sort(), ['layer-2', 'opened:2026-10-03T20:15:30Z', 'tier-a']);

r = await run({ pr: { ...base, body: 'A proposal with no metadata at all.' } });
check('no layer -> no layer label, and exactly one comment',
  { layers: r.added.filter(x => x.startsWith('layer')), posted: r.posted }, { layers: [], posted: 1 });

r = await run({ pr: { ...base, body: 'no layer here' },
  comments: [{ body: 'earlier note <!-- label-proposals -->' }] });
check('it does not comment twice', r.posted, 0);

r = await run({ pr: { ...base, body: FILLED, draft: true } });
check('a draft gets no opened: label', r.added.filter(x => x.startsWith('opened:')), []);

r = await run({ labels: ['opened:2026-10-03T20:15:30Z', 'layer-2'],
  pr: { ...base, body: FILLED, draft: true }, action: 'converted_to_draft' });
check('returning to draft removes opened:', r.dropped, ['opened:2026-10-03T20:15:30Z']);

r = await run({ pr: { ...base, body: '**Layer:** 4' } });
check('a gated tier gets its layer label but NO endorsed:/opened: — record-endorsement.yml owns those',
  { layer: r.added.filter(x => x.startsWith('layer')), endorsed: r.added.filter(x => x.startsWith('endorsed')),
    opened: r.added.filter(x => x.startsWith('opened:')) },
  { layer: ['layer-4'], endorsed: [], opened: [] });

r = await run({ pr: { ...base, body: '**Layer:** 2\n**Tier:** B\n**Deliberation period:** 5' } });
check('Tier B carries its stated period',
  r.added.filter(x => !x.startsWith('opened')).sort(), ['days-5', 'layer-2', 'tier-b']);

r = await run({ labels: ['layer-3', 'tier-c', 'days-9'], action: 'edited',
  pr: { ...base, body: '**Layer:** 2\n**Tier:** A' } });
check('editing the body drops labels it no longer claims',
  r.dropped.sort(), ['days-9', 'layer-3', 'tier-c']);

// The regression these anchors exist for: \s spans newlines, so a field left
// blank above prose beginning with a digit was read as the answer. The pull
// request template's own wording is "2 Ordinary · 3 Policy · 4 Constitutional".
r = await run({ pr: { ...base,
  body: '**Layer:**\n\n2 Ordinary · 3 Policy · 4 Constitutional. Classified by actual EFFECT.\n' } });
check('a blank Layer does not absorb the line beneath it',
  r.added.filter(x => x.startsWith('layer-')), []);

r = await run({ pr: { ...base,
  body: '**Tier:**\n\nA — 48h, passes absent a stated objection\n**Layer:** 2\n' } });
check('a blank Tier does not absorb the line beneath it',
  r.added.filter(x => x.startsWith('tier-')), []);

r = await run({ pr: { ...base,
  body: 'Preamble.\n\n**Layer:** 4\n**Tier:** C\n**Deliberation period:** 10\n' } });
check('fields still parse when they are filled in',
  r.added.filter(x => !x.startsWith('opened')).sort(), ['days-10', 'layer-4', 'tier-c']);

/* ---- inline guidance comments ------------------------------------------
 *
 * The pull request template puts its guidance in an HTML comment beside each
 * field. GitHub hides those when it RENDERS a description; it does not remove
 * them from the body, and this is the only reader in the repository that was
 * not stripping them. #21 was filed exactly as the template invited and got
 * "I could not read a Layer" — the parser reached "<" where it wanted a digit.
 */
r = await run({ pr: { ...base, body:
  '**Layer:** <!-- write just the number: 2, 3, 4 --> 3 \n' +
  '**Tier:** <!-- Layer 2 only. Write just the letter: A, B or C -->\n' } });
check('a value written AFTER the inline comment is read (this is #21)',
  r.added.filter(x => !x.startsWith('opened')).sort(), ['layer-3']);
check('and no "could not read a Layer" comment is posted', r.posted, 0);

r = await run({ pr: { ...base, body:
  '**Layer:** 2 <!-- write just the number --> \n**Tier:** A <!-- A, B or C -->\n' } });
check('a value written BEFORE the comment still works',
  r.added.filter(x => !x.startsWith('opened')).sort(), ['layer-2', 'tier-a']);

/* The one-line anchor must survive the stripping. Removing a comment must not
   let a field absorb the guidance that followed it on the NEXT line — the bug
   that once labelled a blank-Layer proposal layer-2 from "2 Ordinary · 3 Policy". */
r = await run({ pr: { ...base, body:
  '**Layer:**\n<!-- 2 Ordinary · 3 Policy · 4 Constitutional -->\n\n**Tier:** A\n' } });
check('a blank Layer still does not absorb its guidance after stripping',
  r.added.filter(x => x.startsWith('layer-')), []);

/* A field whose only content is the comment is blank, not readable. */
r = await run({ pr: { ...base, body: '**Layer:** <!-- 3 --> \n' } });
check('a digit inside the comment is not the answer',
  r.added.filter(x => x.startsWith('layer-')), []);

/* ---- gated tiers: this workflow stamps neither opened: nor endorsed: --------
 * A gated tier's clock starts at its Nth endorsement, and record-endorsement.yml
 * writes opened: and endorsed: then. This workflow only labels layer/tier/period
 * and never touches endorsement, so two writers can never race the same labels. */
r = await run({ pr: { ...base, body: '**Layer:** 4' }, action: 'ready_for_review',
  timeline: [{ event: 'ready_for_review', created_at: '2026-10-05T00:00:00Z' }] });
check('a gated tier marked ready gets its layer label but NO opened: (clock starts at endorsement)',
  { layer: r.added.filter(x => x.startsWith('layer')), opened: r.added.filter(x => x.startsWith('opened:')) },
  { layer: ['layer-4'], opened: [] });

r = await run({ pr: { ...base, body: '**Layer:** 3' }, action: 'ready_for_review',
  timeline: [{ event: 'ready_for_review', created_at: '2026-10-09T08:30:00Z' }] });
check('a Layer 3 marked ready gets NO opened: either', r.added.filter(x => x.startsWith('opened:')), []);

r = await run({ pr: { ...base, body: '**Layer:** 4' }, action: 'edited' });
check('a gated tier edited stamps NO opened: and NO endorsed: (record-endorsement owns them)',
  { opened: r.added.filter(x => x.startsWith('opened:')), endorsed: r.added.filter(x => x.startsWith('endorsed')) },
  { opened: [], endorsed: [] });

/* ---- Emergency resolutions (§2) ------------------------------------------
 * "Any member may propose with `[EMERGENCY]`." The tag in the title decides the
 * procedure. The first real one, #45, wrote **Tier:** Emergency (§2), which no
 * tier pattern reads, so it got no tier label, no countdown and no vote button.
 * Its real title, metadata and timing are used here. */
const PR45_BODY = [
  '## Proposal', '', '**Raised on behalf of an Anonymous Member.**', '',
  '**Layer:** 2', '', '**Tier:** Emergency (§2)', '',
  '**Deliberation period:** n/a — Emergency resolutions run 12 hours (§2), not a stated period of days', '',
  '**File(s):** rules/rule-ration-club-events.md', '',
].join('\n');
const PR45 = { number: 45, draft: false, created_at: '2026-11-02T18:30:22Z',
  title: '[EMERGENCY] Rule (Layer 2): Ration Club third-party events', body: PR45_BODY };

r = await run({ pr: PR45, files: ['rules/rule-ration-club-events.md'] });
check('#45 replayed: layer-2, emergency, opened: at creation — and no tier label',
  r.added.sort(), ['emergency', 'layer-2', 'opened:2026-11-02T18:30:22Z']);
check('#45 replayed: one note, quoting the §2 bans, naming no file', 
  { posted: r.posted, quotes: /may not amend this Constitution, impose a sanction/.test(r.bodies[0] || ''),
    flagged: /From the files/.test(r.bodies[0] || '') },
  { posted: 1, quotes: true, flagged: false });

r = await run({ pr: { ...PR45, title: '[emergency] lower case still counts', body: '**Layer:** 2\n**Tier:** A\n**Deliberation period:** 3' } });
check('the tag is case-insensitive, and a written Tier and period are not labelled while it is there',
  r.added.filter(x => !x.startsWith('opened')).sort(), ['emergency', 'layer-2']);

r = await run({ labels: ['layer-2', 'tier-a', 'days-3'], action: 'edited',
  pr: { ...PR45, body: '**Layer:** 2\n**Tier:** A\n**Deliberation period:** 3' } });
check('adding the tag to a labelled proposal drops its tier and period labels',
  { dropped: r.dropped.sort(), added: r.added.filter(x => !x.startsWith('opened')) },
  { dropped: ['days-3', 'tier-a'], added: ['emergency'] });

r = await run({ labels: ['layer-2', 'emergency', 'opened:2026-11-02T18:30:22Z'], action: 'edited',
  pr: { ...PR45, title: 'Rule (Layer 2): Ration Club third-party events', body: '**Layer:** 2\n**Tier:** A' } });
check('removing the tag drops emergency and labels the written tier',
  { dropped: r.dropped, added: r.added }, { dropped: ['emergency'], added: ['tier-a'] });

r = await run({ pr: { ...PR45, body: '**Layer:** 3' }, action: 'ready_for_review',
  timeline: [{ event: 'ready_for_review', created_at: '2026-11-05T08:00:00Z' }] });
check('an [EMERGENCY] Layer 3 is not endorsement-gated: opened: at ready, no endorsement wait',
  r.added.sort(), ['emergency', 'layer-3', 'opened:2026-11-05T08:00:00Z']);

r = await run({ pr: { ...PR45, body: '**Layer:** 4' }, files: ['constitution.md'] });
check('a constitution change is named against §2\'s first ban',
  /changes `constitution.md`.*may not amend this Constitution/.test(r.bodies[0] || ''), true);

r = await run({ pr: PR45, files: ['members.md', 'disputes/dispute-x.md'] });
check('members.md and disputes/ are each named',
  [/may not decide membership/.test(r.bodies[0] || ''), /may not determine an adjudication/.test(r.bodies[0] || '')],
  [true, true]);

r = await run({ pr: PR45, files: ['rules/rule-ration-club-events.md'],
  comments: [{ id: 7, body: '<!-- label-proposals:emergency -->\nan older version' }] });
check('the note is kept current rather than posted twice',
  { posted: r.posted, updated: r.updated.map(u => u.comment_id) }, { posted: 0, updated: [7] });

r = await run({ pr: { ...PR45, title: 'Rule (Layer 2): Ration Club third-party events' } });
check('"Tier: Emergency" without the tag is not an emergency, and says why once',
  { labels: r.added.filter(x => !x.startsWith('opened')), posted: r.posted,
    why: /makes a proposal an Emergency resolution by its tag/.test(r.bodies[0] || '') },
  { labels: ['layer-2'], posted: 1, why: true });

r = await run({ pr: { ...PR45, title: 'no tag' },
  comments: [{ id: 3, body: '<!-- label-proposals:emergency-tag -->' }] });
check('and does not say it twice', r.posted, 0);

r = await run({ pr: { ...PR45, body: 'nothing filled in' } });
check('an emergency with no Layer gets both notes, and its window is still opened',
  { posted: r.posted, opened: r.added.some(x => x.startsWith('opened:')), emergency: r.added.includes('emergency') },
  { posted: 2, opened: true, emergency: true });

r = await run({ pr: { ...base, body: FILLED, title: 'Ordinary rule (Tier A): something' } });
check('an ordinary proposal posts nothing new', r.posted, 0);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
