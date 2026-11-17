/*
 * Targeted offline checks for streaming text ownership and node compaction.
 * Runs the production writer with a DOM/clock fixture; no API requests or
 * stored translations are read. Browser animation/layout checks stay in
 * verify-motion.mjs.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL('../web/app.js', import.meta.url))).replace(/\r\n/g, '\n');
const start = source.indexOf('  function startWriter(el) {');
const end = source.indexOf('\n  function runText()', start);
assert.ok(start >= 0 && end > start, 'Production stream writer is present');
const writerSource = source.slice(start, end);

class FixtureNode {
  constructor(type = 1, text = '') {
    this.nodeType = type;
    this.data = text;
    this.parentNode = null;
    this.childNodes = [];
    this.className = '';
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => {
        const active = force == null ? !classes.has(name) : force;
        if (active) classes.add(name);
        else classes.delete(name);
        return active;
      },
    };
  }

  get previousSibling() {
    if (!this.parentNode) return null;
    const nodes = this.parentNode.childNodes;
    return nodes[nodes.indexOf(this) - 1] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const nodes = this.parentNode.childNodes;
    return nodes[nodes.indexOf(this) + 1] || null;
  }

  get textContent() {
    return this.nodeType === 3 ? this.data : this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(text) {
    if (this.nodeType === 3) { this.data = String(text); return; }
    this.clear();
    if (text) this.appendChild(new FixtureNode(3, String(text)));
  }

  set innerHTML(html) {
    assert.equal(html, '', 'Fixture only accepts clearing the production output');
    this.clear();
  }

  get scrollHeight() { return this.textContent.length; }

  clear() {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
  }

  appendData(text) {
    assert.equal(this.nodeType, 3, 'Only text nodes support appendData');
    this.data += text;
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, reference) {
    assert.ok(reference.parentNode === this, 'Cursor remains owned by the output');
    if (node.parentNode) node.parentNode.removeChild(node);
    this.childNodes.splice(this.childNodes.indexOf(reference), 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    assert.equal(node.parentNode, this, 'Removed node belongs to the output');
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }

  replaceChild(next, previous) {
    assert.equal(previous.parentNode, this, 'Replaced node belongs to the output');
    if (next.parentNode) next.parentNode.removeChild(next);
    this.childNodes[this.childNodes.indexOf(previous)] = next;
    previous.parentNode = null;
    next.parentNode = this;
    return previous;
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  emit(type) {
    for (const callback of [...(this.listeners.get(type) || [])]) callback({ target: this });
  }
}

function fixture() {
  let sequence = 0;
  let reduced = false;
  let durationReads = 0;
  const frames = new Map();
  const timers = new Map();
  const document = {
    createElement: () => new FixtureNode(),
    createTextNode: (text) => new FixtureNode(3, text),
  };
  const context = vm.createContext({
    document,
    requestAnimationFrame: (callback) => { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    motionReduced: () => reduced,
    cssDuration: () => { durationReads++; return 200; },
  });
  const startWriter = vm.runInContext(`
    var activeWriter = null;
    function stopActiveWriter() {
      if (activeWriter) { activeWriter.stop(); activeWriter = null; }
    }
    ${writerSource}
    startWriter;
  `, context);

  return {
    startWriter,
    output: new FixtureNode(),
    frames,
    timers,
    reduce: (value) => { reduced = value; },
    durationReads: () => durationReads,
    frame() {
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback();
    },
    expire() {
      const batch = [...timers.values()];
      timers.clear();
      for (const { callback } of batch) callback();
    },
  };
}

function segments(output) {
  return output.childNodes.filter((node) => node.className === 'st-seg');
}

{
  const test = fixture();
  const writer = test.startWriter(test.output);
  writer.push('按序显示，每一段都保留自己的淡入动画。'.repeat(12));
  test.frame();
  test.frame();
  test.frame();
  const spans = segments(test.output);
  assert.equal(spans.length, 3, 'Each painted frame retains its own animation segment');
  const rendered = test.output.textContent;
  spans[2].emit('animationend');
  assert.equal(test.output.textContent, rendered, 'A later animation cannot reorder text');
  assert.equal(spans[0].parentNode, test.output, 'An earlier active segment is untouched');
  assert.equal(spans[1].parentNode, test.output, 'An adjacent active segment is untouched');
  spans[0].emit('animationend');
  spans[1].emit('animationend');
  assert.equal(test.output.textContent, rendered);
  assert.equal(test.output.childNodes.length, 2, 'Settled text is one node followed by the cursor');
  assert.equal(test.timers.size, 0, 'Animation events cancel fallback timers');
  for (const span of spans) assert.equal(span.listeners.get('animationend').size, 0);
  writer.stop();
}

{
  const test = fixture();
  const writer = test.startWriter(test.output);
  const text = '长文流式输出，字符和段落不能丢失。\n'.repeat(500);
  writer.push(text);
  let frames = 0;
  while (test.frames.size && frames < 5000) {
    test.frame();
    frames++;
    if (frames % 5 === 0) test.expire();
    assert.ok(text.startsWith(test.output.textContent), 'Every intermediate frame is an exact input prefix');
    assert.ok(test.output.childNodes.length <= segments(test.output).length * 2 + 2,
      'Settled text nodes stay bounded by active segments');
  }
  assert.ok(frames < 5000, 'The queue drains');
  test.expire();
  assert.equal(test.output.textContent, text, 'Long output retains every character');
  assert.equal(test.output.childNodes.length, 2, 'Long output compacts after animation fallback');
  assert.equal(test.durationReads(), 1, 'Stream duration is read once for the writer');
  writer.commit(text, true);
  assert.equal(test.output.textContent, text);
  assert.equal(test.output.childNodes.length, 1, 'Final commit removes the cursor');
}

{
  const test = fixture();
  const writer = test.startWriter(test.output);
  writer.push('即将被校正的流式片段。'.repeat(20));
  test.frame();
  const span = segments(test.output)[0];
  const staleTimer = [...test.timers.values()][0].callback;
  writer.commit('校正后的完整段落\n\n', false);
  assert.equal(test.frames.size, 0);
  assert.equal(test.timers.size, 0);
  assert.equal(span.listeners.get('animationend').size, 0);
  staleTimer();
  span.emit('animationend');
  assert.equal(test.output.textContent, '校正后的完整段落\n\n', 'Old callbacks cannot modify a corrected paragraph');
  writer.push('下一段');
  test.frame();
  test.expire();
  assert.equal(test.output.textContent, '校正后的完整段落\n\n下一段', 'A continuing commit accepts the next paragraph');
  writer.commit('最终译文', true);
  staleTimer();
  assert.equal(test.output.textContent, '最终译文', 'Final content survives an old animation callback');
}

{
  const test = fixture();
  const writer = test.startWriter(test.output);
  writer.push('取消后不要继续输出队列。'.repeat(20));
  test.frame();
  const span = segments(test.output)[0];
  const rendered = test.output.textContent;
  writer.stop();
  assert.equal(writer.closed, true);
  assert.equal(test.frames.size, 0, 'Stop cancels the queued frame');
  assert.equal(test.timers.size, 0, 'Stop cancels segment timers');
  assert.equal(span.listeners.get('animationend').size, 0, 'Stop detaches segment listeners');
  writer.push('不能追加');
  test.frame();
  test.expire();
  assert.equal(test.output.textContent, rendered, 'Stop keeps only the content already shown');
}

{
  const test = fixture();
  test.reduce(true);
  const writer = test.startWriter(test.output);
  const text = '减少动态效果时即时显示。';
  for (const char of text) writer.push(char);
  assert.equal(test.output.textContent, text);
  assert.equal(test.output.childNodes.length, 2, 'Immediate chunks share one text node');
  assert.equal(test.frames.size, 0);
  assert.equal(test.timers.size, 0);
  assert.equal(test.durationReads(), 0, 'Immediate output needs no animation style lookup');
  test.reduce(false);
  writer.push('先排队的内容');
  test.reduce(true);
  writer.push('后到的内容');
  assert.equal(test.output.textContent, text + '先排队的内容后到的内容',
    'Changing the motion preference preserves queued chunk order');
  assert.equal(test.frames.size, 0, 'The pending animated frame is cancelled');
  test.reduce(false);
  writer.push('在下一帧前切换');
  test.reduce(true);
  test.frame();
  assert.equal(test.output.textContent, text + '先排队的内容后到的内容在下一帧前切换',
    'A motion change before paint also drains the queue immediately');
  assert.equal(segments(test.output).length, 0);
  writer.stop();
}

{
  const test = fixture();
  const first = test.startWriter(test.output);
  first.push('旧任务'.repeat(100));
  test.frame();
  const second = test.startWriter(test.output);
  assert.equal(first.closed, true, 'A new writer takes ownership from the old writer');
  assert.equal(test.timers.size, 0);
  second.push('新任务');
  test.frame();
  test.expire();
  assert.equal(test.output.textContent, '新任务');
  second.stop();
}

console.log('Stream writer checks passed: order, compaction, cleanup, ownership, dynamic reduced motion.');
