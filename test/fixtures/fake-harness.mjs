#!/usr/bin/env node
// A fake harness CLI for the bench suite: emits a canned event stream in the shape of the
// harness named by SAUT_FAKE (claude-code | codex | opencode), so the runners' parsers and
// the orchestrator are exercised offline, deterministically and for free.
//
// SAUT_FAKE_SCRIPT selects the scenario:
//   fire     — the target skill fires and the run stays inside a Read/Write allowlist
//   violate  — the skill fires and then runs a shell command outside the allowlist
//   lost     — another skill fires instead (implicit prompt lost)
//   denied   — a tool call is refused by the harness
//   control  — nothing fires
//   error    — the harness reports a failure
//   unavailable — provider/credential failure (opencode shape)
import process from 'node:process';

const kind = process.env.SAUT_FAKE ?? 'claude-code';
const script = process.env.SAUT_FAKE_SCRIPT ?? 'fire';
const target = process.env.SAUT_FAKE_SKILL ?? 'fx-clean';
// The control case must behave like a real harness: nothing fires for an unrelated prompt.
const isControl = process.argv.slice(2).some((a) => /Reply with the single word PONG/i.test(a));
const act = isControl ? 'control' : script;
const w = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (kind === 'claude-code') {
  w({ type: 'system', subtype: 'init', model: 'fake', skills: [target, 'other-a', 'other-b'], tools: ['Read', 'Write', 'Bash'] });
  const use = (id, name, input) => w({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, content, isError) => w({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!isError }] } });
  const denials = [];
  if (act === 'fire' || act === 'violate' || act === 'denied') {
    use('t1', 'Skill', { skill: target });
    res('t1', 'skill loaded');
    use('t2', 'Read', { file_path: '/ws/README.md' });
    res('t2', '# readme');
  }
  if (act === 'lost') { use('t1', 'Skill', { skill: 'other-a' }); res('t1', 'other skill loaded'); }
  if (act === 'violate') { use('t3', 'Bash', { command: 'rm -rf /tmp/nope' }); res('t3', 'done'); }
  if (act === 'denied') {
    use('t4', 'Bash', { command: 'curl https://example.com' });
    res('t4', 'Permission denied for this command', true);
    denials.push({ tool_name: 'Bash', tool_input: { command: 'curl https://example.com' } });
  }
  w({
    type: 'result', subtype: act === 'error' ? 'error_max_turns' : 'success', is_error: act === 'error',
    num_turns: 2, total_cost_usd: 0.01, result: act === 'error' ? null : 'done',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
    permission_denials: denials,
  });
} else if (kind === 'codex') {
  w({ type: 'thread.started', thread_id: 'fake' });
  w({ type: 'turn.started' });
  const cmd = (command, output, code = 0) => {
    w({ type: 'item.started', item: { id: 'i', type: 'command_execution', command, status: 'in_progress' } });
    w({ type: 'item.completed', item: { id: 'i', type: 'command_execution', command, aggregated_output: output, exit_code: code, status: 'completed' } });
  };
  if (act === 'fire' || act === 'violate' || act === 'denied') cmd(`/bin/zsh -lc "sed -n '1,200p' .agents/skills/${target}/SKILL.md"`, '# the skill');
  if (act === 'fire') cmd("/bin/zsh -lc 'git status --short'", '## master');
  if (act === 'violate') cmd("/bin/zsh -lc 'rm -rf /tmp/nope'", '');
  if (act === 'denied') cmd("/bin/zsh -lc 'touch /etc/nope'", 'failed: read-only sandbox denied the write', 1);
  if (act === 'lost') w({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Using other-a instead.' } });
  if (act === 'error') { w({ type: 'error', message: 'model not supported' }); w({ type: 'turn.failed', error: { message: 'model not supported' } }); }
  else {
    w({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'done' } });
    w({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 30, cached_input_tokens: 50, cache_write_input_tokens: 0 } });
  }
} else {
  if (script === 'unavailable') { w({ type: 'error', error: { name: 'APIError', data: { message: 'Cannot connect to API: Unable to connect.' } } }); process.exit(0); }
  const tool = (name, input, status = 'completed', error = '') => w({ type: 'tool', part: { tool: name, state: { input, status, error } } });
  if (act === 'fire' || act === 'violate' || act === 'denied') { tool('skill', { name: target }); tool('read', { path: 'README.md' }); }
  if (act === 'lost') tool('skill', { name: 'other-a' });
  if (act === 'violate') tool('bash', { command: 'rm -rf /tmp/nope' });
  if (act === 'denied') tool('bash', { command: 'curl https://example.com' }, 'error', 'permission denied');
  w({ type: 'text', part: { text: 'done' } });
  w({ type: 'step-finish', tokens: { input: 10, output: 5, cache: { read: 1, write: 0 } } });
}
