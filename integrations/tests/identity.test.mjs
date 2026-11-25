import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { transformAsync } from '@babel/core';
import { compileTemplate } from '@vue/compiler-sfc';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createServer } from 'vite';
import componentIdentity from '../react.mjs';
import { vueComponentIdentity } from '../vue.mjs';

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));

async function fixtureSources(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(entries.filter(entry => entry.isFile()).map(async entry =>
    [entry.name, await readFile(path.join(root, entry.name))]));
}

for (const framework of ['react', 'vue']) {
  test(`${framework} Vite fixture renders only attributable host roots and keeps original files byte-identical`, async () => {
    const root = path.join(fixtures, framework);
    const before = await fixtureSources(root);
    const extension = framework === 'react' ? 'jsx' : 'vue';
    const server = await createServer({
      root, configFile: path.join(root, 'vite.config.mjs'), logLevel: 'error',
      server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true }
    });
    try {
      const module = await server.ssrLoadModule(`/Inbox.${extension}`);
      const html = framework === 'react'
        ? renderToStaticMarkup(createElement(module.default)) : await renderToString(createSSRApp(module.default));
      const marked = [...html.matchAll(/<([a-z]+)\b[^>]*?\bdata-component="([^"]+)"/g)]
        .map(match => [match[1], match[2]]);
      assert.deepEqual(marked, [['main', 'Inbox'], ['article', 'MessageRow'], ['small', 'Authored'], ['aside', 'Caller']]);
      assert.match(html, /<article data-component="MessageRow" data-mirror-key="[^"]+:MessageRow:root"><span>Draft<\/span><\/article>/);
      assert.match(html, /<button>Open<\/button><button>Archive<\/button>/);
      assert.deepEqual(await fixtureSources(root), before);
    } finally {
      await server.close();
    }
  });
}

test('React reports Fragment, forwarded props, indirect roots and control flow without descending into arbitrary JSX', async () => {
  const input = `
    const CallerContent = props => props.children;
    const Forward = props => <section {...props}/>;
    const Fragment = () => <><div/><span/></>;
    const Alias = () => <Child/>;
    const Form = () => <Widgets.Form/>;
    function Early(props) { if (props.hidden) return null; return <nav/>; }
    const Manual = props => <article {...props} data-component={props.label}/>;
    const Pure = () => <section>{[1].map(() => <strong/>)}</section>;
    const Wrapped = React.memo(() => <div/>);
    const helper = () => <mark/>;
    export default () => <main/>;`;
  const events = [];
  const { code, metadata } = await transformAsync(input, {
    filename: 'dashboard-card/index.jsx', configFile: false, babelrc: false,
    plugins: [[componentIdentity, { onDiagnostic: event => events.push(event) }]]
  });
  assert.deepEqual(events, metadata.componentIdentity);
  assert.deepEqual(events.map(({ component, status, reason }) => [component, status, reason]), [
    ['CallerContent', 'skipped', 'indirect-root'], ['Forward', 'skipped', 'spread-props'],
    ['Fragment', 'skipped', 'fragment'], ['Alias', 'skipped', 'component-root'], ['Form', 'skipped', 'component-root'],
    ['Early', 'skipped', 'ambiguous-return'], ['Manual', 'preserved', 'explicit-attribute'],
    ['Pure', 'injected', 'host-root'], ['Wrapped', 'skipped', 'indirect-component'], ['DashboardCard', 'injected', 'host-root']
  ]);
  assert.equal(code.match(/data-component=/g).length, 3);
  assert.match(code, /<article \{\.\.\.props\} data-component=\{props.label\}/);
  assert.match(code, /<strong\s*\/>/);
  assert.ok(events.every(event => event.line > 0 && event.filename.endsWith('/index.jsx')));
});

test('Vue reports ambiguous templates and preserves static and developer-bound identity attributes', () => {
  const cases = [
    ['<article><span/></article>', 'injected', 'host-root'],
    ['<!-- comment --><article/>', 'injected', 'host-root'],
    ['<article data-component="Manual"/>', 'preserved', 'explicit-attribute'],
    ['<article :data-component="label"/>', 'preserved', 'explicit-attribute'],
    ['<article v-bind="props"/>', 'skipped', 'dynamic-bind'],
    ['<article :[key]="value"/>', 'skipped', 'dynamic-bind'],
    ['<article/><footer/>', 'skipped', 'fragment'],
    ['<Child><section/></Child>', 'skipped', 'component-or-template-root'],
    ['<slot/>', 'skipped', 'component-or-template-root'],
    ['<component :is="tag"/>', 'skipped', 'component-or-template-root'],
    ['<article v-if="active"/>', 'skipped', 'structural-root'],
    ['<article v-for="item in items"/>', 'skipped', 'structural-root'],
    ['{{ value }}', 'skipped', 'indirect-root']
  ];
  for (const [source, status, reason] of cases) {
    const events = [];
    const identity = vueComponentIdentity({ onDiagnostic: event => events.push(event) });
    const result = compileTemplate({
      filename: 'mail-list/index.vue', id: 'fixture', source,
      compilerOptions: { nodeTransforms: identity.nodeTransforms }
    });
    assert.deepEqual(result.errors, [], source);
    assert.deepEqual(events, identity.diagnostics);
    assert.deepEqual(events.map(event => [event.component, event.status, event.reason]), [['MailList', status, reason]], source);
    assert.equal(result.code.includes('"data-component": "MailList"'), status === 'injected', source);
  }
});

test('React leaves locally invoked render helpers and anonymous HOC callback JSX untouched', async () => {
  const input = `
    export function Inbox() {
      const Row = () => <article/>;
      const Format = () => <em/>;
      function Cell() { return <td/>; }
      return <main><Row/>{Format()}{[1].map(Cell)}</main>;
    }
    export default React.memo(() => <nav/>);`;
  const { code, metadata } = await transformAsync(input, {
    filename: 'Inbox.jsx', configFile: false, babelrc: false, plugins: [componentIdentity]
  });
  assert.deepEqual(metadata.componentIdentity.map(({ component, reason }) => [component, reason]), [
    ['Inbox', 'host-root'], ['Row', 'host-root'], ['Format', 'ambiguous-local-use'],
    ['Cell', 'ambiguous-local-use'], ['Inbox', 'indirect-component']
  ]);
  assert.equal(code.match(/data-component=/g).length, 2);
  assert.match(code, /<em\s*\/>/);
  assert.match(code, /<td\s*\/>/);
  assert.match(code, /<nav\s*\/>/);
});

test('conditional host keys survive an earlier sibling insertion and preserve authored keys', async () => {
  for (const prefix of ['', '<aside/>']) {
    const jsx = `function View(props) { return <main>${prefix}{props.ready ? <p/> : <p data-mirror-key="manual"/>}</main> }`;
    const react = await transformAsync(jsx, { filename: 'View.jsx', configFile: false, babelrc: false, plugins: [componentIdentity] });
    assert.match(react.code, /data-mirror-key="View.jsx:View:root\/props.ready\/consequent"/);
    assert.equal(react.code.match(/data-mirror-key=/g).length, 3);
    const vue = compileTemplate({ filename: 'View.vue', id: 'fixture',
      source: `<main>${prefix}<p v-if="ready"/><p v-else :data-mirror-key="manual"/></main>`,
      compilerOptions: { nodeTransforms: vueComponentIdentity().nodeTransforms } });
    assert.deepEqual(vue.errors, []);
    assert.match(vue.code, /View.vue:View:root\/ready\/if/);
    assert.doesNotMatch(vue.code, /ready\/else/);
  }
});
