const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const M = vm.createContext({});
vm.runInContext(fs.readFileSync('package/contents/ui/Model.js', 'utf8'), M);
const plain = value => JSON.parse(JSON.stringify(value));
const pane = (id, ws, state = 'idle', model) => Object.assign({pane_id: id, workspace_id: ws, agent: 'opencode', agent_status: state, cwd: '/a/project/'}, model === undefined ? {} : {model});
const ws = (id, linked = false, repo = '/repo/.git') => ({workspace_id: id, label: 'same label', worktree: {is_linked_worktree: linked, repo_key: repo, repo_name: 'repo'}});

test('snapshot envelope variants and malformed data', () => {
    for (const value of [{panes: []}, {snapshot: {panes: []}}, {result: {snapshot: {panes: []}}}])
        assert.equal(M.snapshot(JSON.stringify(value)).panes.length, 0);
    for (const value of ['bad', '{}', '{"panes":{}}', '{"error":{}}', '{"panes":[null]}', JSON.stringify({panes: [pane('a','w'),pane('a','w')]})])
        assert.throws(() => M.snapshot(value));
    assert.throws(() => M.records('{"workspaces":[{}]}', 'workspaces'));
});

test('group by IDs, nest child reported before parent, preserve agent order', () => {
    const snap = {panes: [pane('c','child'), pane('x','other'), pane('p1','parent','blocked'),pane('p2','parent','working')], workspaces: [ws('child',true),ws('parent'),ws('other',false,'/other/.git')]};
    const result = M.build(snap, [], {});
    assert.deepEqual(plain(result.rows.map(r => r.uid)), ['H:other','A:x','H:parent','A:p1','A:p2','H:child','A:c']);
    assert.deepEqual([result.count,result.blocked,result.working], [4,1,1]);
    assert.equal(result.rows[5].nested, true);
    assert.equal(result.rows[5].count, 1);
    assert.equal(result.rows[2].count, 2);
    assert.equal(result.rows[6].project, 'project');
});

test('orphan remains visible and metadata arrival is stable', () => {
    const snap = {panes: [pane('c','child'),pane('p','parent')]};
    assert.equal(M.build(snap, [], {}).rows[0].workspace, 'child');
    const metadata = [ws('child',true),ws('parent')];
    const first = M.build(snap, metadata, {});
    const second = M.build(snap, metadata.toReversed(), {});
    assert.deepEqual(plain(first), plain(second));
    assert.equal(Object.hasOwn(first.rows[0], 'workspaceId'), false);
    const orphan = M.build({panes: [pane('c','child')]}, metadata, {}).rows[0];
    assert.equal(orphan.nested, false);
    assert.equal(orphan.linked, true);
});

test('status normalization and empty/non-agent snapshots', () => {
    const snap = {panes: ['working','blocked','idle','done','weird'].map((s,i) => pane(String(i),'w',s))};
    snap.panes.push({pane_id: 'shell',workspace_id: 'w'});
    const result = M.build(snap, [], {});
    assert.equal(result.count, 5);
    assert.equal(result.rows.at(-1).agentStatus, 'unknown');
    assert.equal(M.build({panes: []}, [], {}).rows.length, 0);
    assert.equal(M.activeKey(snap), '["w"]');
    assert.equal(M.activeKey({panes: [pane('x','w')]}), '[]');
});

test('modelName fields use explicit snapshot data only and are stable on every row', () => {
    const first = Object.assign(pane('a', 'w', 'idle', 'legacy-model'), {
        tokens: {model: 'opus'}
    });
    const second = Object.assign(pane('b', 'w'), {
        model_name: 'model-b',
        tokens: {model: 42},
        terminal_title: 'model-title',
        agent_name: 'model-agent'
    });
    const rows = M.build({panes: [first, second], workspaces: [ws('w')]}, [], {}).rows;
    assert.deepEqual(plain(rows.map(row => ({kind: row.kind, modelName: row.modelName}))), [
        {kind: 'header', modelName: ''},
        {kind: 'agent', modelName: 'opus'},
        {kind: 'agent', modelName: 'model-b'}
    ]);
    const noModel = M.build({panes: [Object.assign(pane('c', 'w'), {
        tokens: null,
        terminal_title: 'title-without-a-model',
        agent_name: 'agent-without-a-model'
    }), Object.assign(pane('d', 'w'), {tokens: 'not-an-object'})]}, [], {}).rows;
    assert.equal(noModel[1].modelName, '');
    assert.equal(noModel[2].modelName, '');
});

test('one live agent emits exactly one workspace header and one agent row', () => {
    const result = M.build({
        panes: [pane('p1', 'w', 'working', 'gpt-5.6')],
        workspaces: [ws('w')],
    }, [], {});
    assert.deepEqual(plain(result.rows.map(row => row.uid)), ['H:w', 'A:p1']);
    assert.deepEqual(plain(result.rows.map(row => row.kind)), ['header', 'agent']);
    assert.equal(result.rows[1].modelName, 'gpt-5.6');
    assert.notEqual(result.rows[1].modelName, '');
});

test('subagent detection via tokens, explicit flags, title heuristics, and hierarchical grouping under primary', () => {
    // 1. Detection via tokens.subagent
    assert.equal(M.paneSubagent({tokens: {subagent: 'true'}}), true);
    assert.equal(M.paneSubagent({tokens: {subagent: true}}), true);
    assert.equal(M.paneSubagent({tokens: {subagent: '1'}}), true);
    assert.equal(M.paneSubagent({tokens: {subagent: 'false'}}), false);
    assert.equal(M.paneSubagent({tokens: {subagent: false}}), false);

    // 2. Detection via explicit fields
    assert.equal(M.paneSubagent({subagent: true}), true);
    assert.equal(M.paneSubagent({is_subagent: true}), true);
    assert.equal(M.paneSubagent({role: 'subagent'}), true);
    assert.equal(M.paneSubagent({parent_pane_id: 'p1'}), true);
    assert.equal(M.paneSubagent({parent_session_id: 'ses_123'}), true);
    assert.equal(M.paneSubagent({agent_session: {parent_id: 'ses_123'}}), true);

    // 3. Detection via OpenCode title pattern
    assert.equal(M.paneSubagent({terminal_title: 'OC | Hold designer model pane (@designer s…'}), true);
    assert.equal(M.paneSubagent({terminal_title_stripped: 'Hold designer (@designer subagent)'}), true);
    assert.equal(M.paneSubagent({label: 'Hold designer (@des'}), true);
    // User task prompt mentioning subagents should NOT be classified as subagent
    assert.equal(M.paneSubagent({terminal_title: 'OC | Plasmoid model name missing for subagents'}), false);
    assert.equal(M.paneSubagent(pane('p1', 'w')), false);

    // 4. Hierarchical nesting and ordering under primary agent
    const pPrimary = pane('p1', 'w', 'working', 'gpt-5.6');
    const pSub1 = Object.assign(pane('p_sub1', 'w', 'idle', 'gemini-3.8-flash'), {
        tokens: {subagent: 'true', model: 'gemini-3.8-flash'},
        terminal_title: 'OC | Hold designer (@designer subagent)'
    });
    const pSub2 = Object.assign(pane('p_sub2', 'w', 'idle', 'claude-sonnet'), {
        tokens: {subagent: 'true', model: 'claude-sonnet'},
        terminal_title: 'OC | Review changes (@oracle subagent)'
    });
    // Even if subagents are reported BEFORE primary in snapshot
    const snap = {panes: [pSub2, pSub1, pPrimary], workspaces: [ws('w')]};
    const result = M.build(snap, [], {});
    assert.equal(result.rows.length, 4); // 1 header + 3 agent rows
    assert.equal(result.rows[0].kind, 'header');

    // Primary row is first
    assert.equal(result.rows[1].uid, 'A:p1');
    assert.equal(result.rows[1].isSubagent, false);
    assert.equal(result.rows[1].modelName, 'gpt-5.6');

    // Subagent 1 is nested under primary, not last subagent
    assert.equal(result.rows[2].uid, 'A:p_sub2');
    assert.equal(result.rows[2].isSubagent, true);
    assert.equal(result.rows[2].isLastSubagent, false);
    assert.equal(result.rows[2].modelName, 'claude-sonnet');

    // Subagent 2 is last subagent
    assert.equal(result.rows[3].uid, 'A:p_sub1');
    assert.equal(result.rows[3].isSubagent, true);
    assert.equal(result.rows[3].isLastSubagent, true);
    assert.equal(result.rows[3].modelName, 'gemini-3.8-flash');
    for (const row of result.rows) {
        assert.equal(Object.hasOwn(row, 'workspaceId'), false);
        assert.equal(Object.hasOwn(row, 'parentPaneId'), false);
        assert.equal(Object.hasOwn(row, 'subagent'), false);
    }
});

test('git branches, upstream divergence, unborn and detached HEAD', () => {
    assert.deepEqual(plain(M.gitStatus('## feature...origin/feature [ahead 2, behind 3]\n M foo')), {branch:'feature',ahead:2,behind:3});
    assert.equal(M.gitStatus('## No commits yet on main').branch, 'main');
    assert.equal(M.gitStatus('## Initial commit on master').branch, 'master');
    assert.equal(M.gitStatus('## HEAD (no branch)').branch, '');
    assert.equal(M.gitStatus('## main...origin/main [gone]').ahead, 0);
    assert.throws(() => M.gitStatus('fatal: not a repository'));
    const snap = {panes:[pane('x','w'),pane('y','other'),pane('z','non-git')]};
    const rows = M.build(snap, [], {w:{branch:'main'},other:{branch:'feature'}}).rows;
    assert.deepEqual(plain(rows.filter(r => r.kind === 'agent').map(r => r.branch)), ['main','feature','']);
});

test('git paths prefer workspace checkout, then agent cwd', () => {
    const snap = {panes: [pane('a','w'),pane('b','unknown')], workspaces: [{workspace_id:'w',worktree:{checkout_path:'/checkout'}}]};
    assert.deepEqual(plain(M.paths(snap, [])), {w:'/checkout',unknown:'/a/project/'});
});

class FakeModel {
    data = []; writes = 0;
    get count() { return this.data.length; }
    get(i) { return this.data[i]; }
    insert(i, row) { this.data.splice(i,0,{...row}); this.writes++; }
    move(from,to) { this.data.splice(to,0,this.data.splice(from,1)[0]); this.writes++; }
    remove(i,n) { this.data.splice(i,n); this.writes++; }
    setProperty(i,k,v) { this.data[i][k]=v; this.writes++; }
}

test('reconcile preserves delegates and does not touch unchanged rows', () => {
    const model = new FakeModel();
    M.reconcile(model,[{uid:'a',value:1},{uid:'b',value:2}]);
    const first = model.data[0], second = model.data[1];
    model.writes = 0;
    M.reconcile(model,[{uid:'a',value:1},{uid:'b',value:2}]);
    assert.equal(model.writes,0);
    M.reconcile(model,[{uid:'b',value:3},{uid:'c',value:4},{uid:'a',value:1}]);
    assert.equal(model.data[0],second);
    assert.equal(model.data[2],first);
    M.reconcile(model,[{uid:'c',value:4}]);
    assert.deepEqual(model.data,[{uid:'c',value:4}]);
});

test('randomized reconciliation never leaves stale or duplicate rows', () => {
    const model = new FakeModel();
    let seed = 71;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2**32;
    for(let i=0;i<500;i++) {
        const next = Array.from({length:12},(_,j)=>({uid:String(j),value:i})).filter(()=>random()>0.4).sort(()=>random()-0.5);
        M.reconcile(model,next);
        assert.deepEqual(model.data,next);
    }
});

test('shell quoting safely preserves apostrophes, spaces, and metacharacters', () => {
    const {execFileSync} = require('node:child_process');
    const path = "/tmp/a'b $(false); name";
    assert.equal(execFileSync('/bin/sh',['-c', 'printf %s ' + M.quote(path)],{encoding:'utf8'}),path);
});
