const test = require("node:test");
const assert = require("node:assert/strict");
const { validate, boardFiles, importProject, exportProject, saveBaseline, readBaseline } = require("./code.js");
const fixture = require("./example.json");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const vm = require("node:vm");

test("inbox capture bundle round trip via the parent CLI audit", async context => {
  const { audit } = await import("../audit.mjs");
  const bytes = readFileSync(join(__dirname, process.env.UI_PARITY_INBOX_AUDIT
    ? "../build/inbox/bundle.json" : "../tests/fixtures/field-notes.json"));
  const bundle = JSON.parse(bytes);
  const { api, blockedGeometry } = testApi({ boundsHeader: true });
  const result = await importProject(api, bundle, createHash("sha256").update(bytes).digest("hex"));
  let designDiff;
  await exportProject(api, (name, mime, content) => {
    if (name === "design-diff.json") designDiff = JSON.parse(content);
  });
  const checked = audit(bundle, designDiff);
  context.diagnostic(JSON.stringify({ ...checked, issues: checked.issues.slice(0, 8), importWarnings: result.warnings.slice(0, 5) }));
  assert.equal(checked.passed, true);
  assert.deepEqual(blockedGeometry, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual([checked.matchedInstances, checked.matchedEdges, checked.matchedLayers], [36, 16, 180]);
  for (const [figmaId, ref] of readBaseline(api.currentPage).refs) {
    let layer = await api.getNodeByIdAsync(figmaId);
    while (layer && layer.type !== "PAGE") {
      assert.equal(layer.visible, true, `${ref.boardId} / ${ref.id} bound to a hidden layer`);
      layer = layer.parent;
    }
    assert.equal(layer, api.currentPage);
  }
  const home = api.currentPage.children.find(node => node.name === "phone/open");
  function findTitle(node) {
    if (node.type === "TEXT" && node.characters === "Field notes") return node;
    for (const child of node.children || []) {
      const title = findTitle(child);
      if (title) return title;
    }
  }
  const title = findTitle(home);
  assert.deepEqual([title.textAutoResize, title.textAlignVertical, title.y, title.height], ["NONE", "CENTER", 19, 17]);
});

const html = readFileSync(join(__dirname, "ui.html"), "utf8");
const fileTools = vm.createContext({ TextEncoder, Blob, Uint8Array, Uint32Array });
vm.runInContext(html.match(/<script id="file-tools">([\s\S]*?)<\/script>/)[1], fileTools);

test("iframe SHA-256 without Web Crypto, including padding boundaries and UTF-8", () => {
  const vectors = [Buffer.from("abc"), Buffer.from(JSON.stringify(fixture)), ...[0, 55, 56, 63, 64, 65, 65536].map(size => Buffer.alloc(size, 207))];
  for (const bytes of vectors) assert.equal(fileTools.sha256(bytes), createHash("sha256").update(bytes).digest("hex"));
});

test("ZIP STORE emits UTF-8 names, correct CRC and central directory offsets", async () => {
  const files = [{ name: "首页.png", content: Uint8Array.from([1, 2, 3]) }, { name: "design-diff.json", content: "123456789" }];
  const zip = Buffer.from(await fileTools.zipStore(files).arrayBuffer());
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), files.length);
  let central = zip.readUInt32LE(end + 16);
  for (const [index, file] of files.entries()) {
    const local = zip.readUInt32LE(central + 42);
    assert.equal(zip.readUInt32LE(central), 0x02014b50);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt16LE(local + 6), 0x800);
    assert.equal(zip.readUInt16LE(local + 8), 0);
    assert.equal(zip.readUInt32LE(local + 14), [0x55bc801d, 0xcbf43926][index]);
    const start = local + 30 + zip.readUInt16LE(local + 26);
    assert.equal(zip.subarray(local + 30, start).toString(), file.name);
    assert.deepEqual(zip.subarray(start, start + zip.readUInt32LE(local + 18)), Buffer.from(file.content));
    central += 46 + zip.readUInt16LE(central + 28);
  }
  assert.equal(central, end);
});

function testApi({ boundsHeader = false } = {}) {
  let serial = 0;
  const nodes = new Map();
  const blockedGeometry = [];
  const groups = new Map();
  const variables = new Map();
  const api = { mixed: Symbol(), root: { children: [] }, variables: {} };
  function scene(type, parent) {
    const data = new Map();
    const node = {
      id: String(++serial), key: "key-" + serial, type, parent, name: type,
      x: 0, y: 0, width: 100, height: 100, visible: true, constraints: { horizontal: "MIN", vertical: "MIN" }, fills: [], strokes: [], opacity: 1, reactions: [],
      resize(width, height) { Object.assign(this, { width, height }); },
      setPluginData(key, value) { data.set(key, value); },
      getPluginData(key) { return data.get(key) || ""; },
      async setReactionsAsync(reactions) { this.reactions = reactions; },
      async loadAsync() {},
      async exportAsync(settings) {
        if (settings.format === "JSON_REST_V1") {
          const json = item => ({
            id: item.id, name: item.name, characters: item.characters, rotation: item.rotation,
            children: item.children && item.children.map(json)
          });
          return { document: json(this) };
        }
        assert.equal(settings.format, "PNG");
        if (boundsHeader) {
          const header = Buffer.alloc(24);
          header.write("89504e470d0a1a0a0000000d49484452", "hex");
          header.writeUInt32BE(Math.round(this.width), 16);
          header.writeUInt32BE(Math.round(this.height), 20);
          return header;
        }
        return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=", "base64");
      },
      remove() {
        this.parent.children = this.parent.children.filter(other => other !== this);
        this.removed = true;
      }
    };
    if (type === "TEXT") Object.assign(node, {
      characters: "", fontName: { family: "Inter", style: "Regular" }, lineHeight: { unit: "AUTO" },
      textAutoResize: "WIDTH_AND_HEIGHT", textAlignVertical: "TOP",
      getRangeAllFontNames() { return [this.fontName]; }
    });
    else Object.assign(node, {
      children: [], clipsContent: true, cornerRadius: 0,
      appendChild(child) {
        if (child.parent) child.parent.children = child.parent.children.filter(other => other !== child);
        this.children.push(child);
        child.parent = this;
      }
    });
    if (type === "COMPONENT") node.createInstance = () => {
      const instance = scene("INSTANCE", api.currentPage);
      instance.componentProperties = {};
      instance.getMainComponentAsync = async () => node;
      Object.assign(instance, { width: node.width, height: node.height, fills: node.fills, strokes: node.strokes });
      function cloneLayer(source, parent) {
        const copy = scene(source.type, parent);
        for (const field of ["name", "x", "y", "width", "height", "visible", "constraints", "fills", "strokes", "characters", "fontName", "fontSize", "lineHeight", "letterSpacing", "textAutoResize", "textAlignVertical", "componentProperties", "getMainComponentAsync"]) {
          if (field in source) copy[field] = source[field];
        }
        function rejectWrite(field) {
          blockedGeometry.push([copy.id, field]);
          throw new Error(`instance descendant ${field} is read-only`);
        }
        for (const field of ["x", "y"]) {
          const position = copy[field];
          Object.defineProperty(copy, field, { get: () => position, set: () => rejectWrite(field) });
        }
        copy.resize = () => rejectWrite("resize");
        for (const child of source.children || []) cloneLayer(child, copy);
      }
      for (const child of node.children) cloneLayer(child, instance);
      return instance;
    };
    if (parent) parent.children.push(node);
    nodes.set(node.id, node);
    return node;
  }
  for (const [method, type] of [["createFrame", "FRAME"], ["createText", "TEXT"], ["createComponent", "COMPONENT"]]) {
    api[method] = () => scene(type, api.currentPage);
  }
  api.createPage = () => scene("PAGE", api.root);
  api.setCurrentPageAsync = async page => { api.currentPage = page; };
  api.currentPage = api.createPage();
  api.getNodeByIdAsync = async id => nodes.get(id);
  api.combineAsVariants = (children, parent) => {
    const set = scene("COMPONENT_SET", parent);
    children.forEach(child => set.appendChild(child));
    return set;
  };
  api.loadFontAsync = async () => {};
  api.variables.createVariableCollection = name => {
    const group = { name, id: String(++serial), modes: [{ modeId: "mode", name: "Default" }], defaultModeId: "mode", variableIds: [], remove() { groups.delete(this.id); } };
    groups.set(group.id, group);
    return group;
  };
  api.variables.createVariable = (name, group) => {
    const variable = { name, id: String(++serial), resolvedType: "COLOR", variableCollectionId: group.id, valuesByMode: {}, setValueForMode(mode, color) { this.valuesByMode[mode] = color; } };
    variables.set(variable.id, variable);
    group.variableIds.push(variable.id);
    return variable;
  };
  api.variables.setBoundVariableForPaint = (paint, field, variable) => Object.assign({}, paint, { boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: variable.id } } });
  api.variables.getVariableCollectionByIdAsync = async id => groups.get(id);
  api.variables.getVariableByIdAsync = async id => variables.get(id);
  return { api, groups, variables, blockedGeometry };
}

test("board-scoped identity and same-viewport prototype lookup", () => {
  const input = structuredClone(fixture);
  input.edges[0].from = "home";
  input.edges[0].to = "detail";
  assert.equal(validate(input)[0].to, "mobile/detail");
  input.boards[0].children[1].id = "open";
  assert.throws(() => validate(input), /mobile\/home.*重复 open/);
  assert.deepEqual(boardFiles([{ id: "a/b" }, { id: "A--B" }]), ["board-a--b.png", "board-A--B-2.png"]);
});

test("native instance descendants reject even equal coordinates; two placements reuse one main and keep their own visible geometry", async () => {
  const { api, blockedGeometry } = testApi();
  const input = structuredClone(fixture);
  const primary = input.boards[0].children[0];
  const other = input.boards[1].children[0];
  other.width = primary.width;
  other.stableId = "business:second-placement";
  other.identity = { tag: "button" };
  other.children[0].logicalId = "other/text-1";
  Object.assign(other.children[0], { x: 32, y: 4, width: 76, height: 17 });
  const result = await importProject(api, input, "two-layouts");
  const page = api.currentPage;
  const instances = input.boards.map(board => page.children.find(node => node.name === board.id).children[0]);
  assert.equal(await instances[0].getMainComponentAsync(), await instances[1].getMainComponentAsync());
  const expected = [primary, other];
  for (const [index, instance] of instances.entries()) {
    const layers = instance.children.filter(layer => layer.visible);
    assert.equal(layers.length, 1);
    const actual = layers[0];
    const spec = expected[index].children[0];
    assert.deepEqual([actual.x, actual.y, actual.width, actual.height, actual.characters], [spec.x, spec.y, spec.width, spec.height, spec.text]);
  }
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(blockedGeometry, []);
  const child = instances[0].children[0];
  for (const field of ["x", "y"]) assert.throws(() => { child[field] = child[field]; }, /read-only/);
  assert.throws(() => { child.resize(child.width, child.height); }, /read-only/);
});

test("reimporting a pre-fix component page rebuilds once and preserves the designer's original", async () => {
  const { api } = testApi();
  await importProject(api, fixture, "same-source");
  const old = api.currentPage;
  old.setPluginData("instanceLayout", "");
  old.children[0].name = "设计师原稿";
  const fresh = await importProject(api, fixture, "same-source");
  const page = api.currentPage;
  assert.equal(fresh.revision, 2);
  assert.notEqual(old.id, page.id);
  await api.setCurrentPageAsync(old);
  assert.ok((await exportProject(api, () => {})).changes.some(change => change.after.name === "设计师原稿"));
  assert.equal((await importProject(api, fixture, "same-source")).reused, true);
  assert.equal(api.currentPage, page);
});

test("baseline chunks round-trip long Unicode text", () => {
  const { api } = testApi();
  const data = { text: "📐设计".repeat(26000) };
  saveBaseline(api.currentPage, data);
  assert.ok(Number(api.currentPage.getPluginData("Acount")) > 1);
  assert.deepEqual(readBaseline(api.currentPage), data);
});

test("variants, instance overrides, three click actions, revision isolation and PNG manifest", async () => {
  const { api } = testApi();
  const original = api.currentPage;
  await importProject(api, fixture, "first");
  const page = api.currentPage;
  const [home, shelf, detail] = [page.children.find(node => node.name === "mobile/home"), page.children.find(node => node.name === "Local components"), page.children.find(node => node.name === "mobile/detail")];
  assert.equal(shelf.children[0].type, "COMPONENT_SET");
  assert.equal(shelf.children[0].children.length, 2);
  const [open, overlay] = home.children;
  const back = detail.children[0];
  const backLabel = back.children.find(layer => layer.visible);
  assert.equal(await open.getMainComponentAsync(), await back.getMainComponentAsync());
  assert.equal(back.width, 184);
  assert.equal(backLabel.characters, "返回首页");
  assert.equal(backLabel.width, 156);
  assert.equal(open.reactions[0].actions[0].destinationId, detail.id);
  assert.equal(overlay.reactions[0].actions[0].navigation, "OVERLAY");
  assert.deepEqual(back.reactions[0].actions, [{ type: "BACK" }]);
  assert.ok(open.fills[0].boundVariables);
  assert.equal(open.strokes[0].opacity, 128 / 255);
  assert.deepEqual((await exportProject(api, () => {})).changes, []);
  backLabel.characters = "设计师文案";
  overlay.remove();
  const extra = api.createText();
  home.appendChild(extra);
  const files = new Map();
  const report = await exportProject(api, (name, mime, content) => files.set(name, content));
  assert.deepEqual(JSON.parse(files.get("design-diff.json")), JSON.parse(JSON.stringify(report)));
  assert.equal(files.get(report.boards[0].file).readUInt32BE(), 0x89504e47);
  assert.equal(report.boards[0].width, 1);
  assert.ok(report.changes.some(row => row.id === "label" && row.boardId === "mobile/detail" && row.after.text === "设计师文案"));
  assert.ok(report.changes.some(row => row.id === "help" && row.op === "remove"));
  assert.ok(report.changes.some(row => row.id === "figma:" + extra.id && row.op === "add"));
  assert.equal((await importProject(api, fixture, "first")).changes, report.changes.length);
  assert.equal(api.root.children.length, 2);
  const edited = structuredClone(fixture);
  edited.boards[1].children[0].children[0].text = "源文件更新";
  assert.equal((await importProject(api, edited, "second")).revision, 2);
  assert.equal(backLabel.characters, "设计师文案");
  await api.setCurrentPageAsync(page);
  detail.remove();
  assert.equal((await exportProject(api, () => {})).boards[1].file, null);
  await api.setCurrentPageAsync(original);
  await assert.rejects(exportProject(api, () => {}), /项目版本页/);
});

test("tracking edits are compared only against baselines that observed tracking", async () => {
  const { api } = testApi();
  const input = structuredClone(fixture);
  input.boards[0].children[0].children[0].style.letterSpacing = 1.5;
  await importProject(api, input, "spacing-baseline");
  const page = api.currentPage;
  const board = page.children.find(node => node.name === input.boards[0].id);
  const label = board.children[0].children.find(node => node.type === "TEXT" && node.visible);
  label.letterSpacing = { unit: "PIXELS", value: -0.5 };
  const [edit] = (await exportProject(api, () => {})).changes;
  assert.deepEqual([edit.before.letterSpacing, edit.after.letterSpacing], [1.5, -0.5]);
  const legacy = readBaseline(page);
  delete legacy.trackSpacing;
  for (const row of legacy.rows) delete row.value.letterSpacing;
  saveBaseline(page, legacy);
  assert.deepEqual((await exportProject(api, () => {})).changes, []);
});

test("transparent text, strokes, fills and variables keep distinct alpha from node opacity", async () => {
  const { api, variables } = testApi();
  const input = structuredClone(fixture);
  input.tokens.Shade = "#12345640";
  const text = input.boards[0].children[0].children[0];
  const frame = input.boards[0].children[0];
  delete frame.component;
  text.style.color = "#00000000";
  frame.style.fill = "#12345640";
  frame.style.opacity = 0.5;
  await importProject(api, input, "alpha");
  const layer = api.currentPage.children[0].children[0];
  assert.equal(layer.opacity, 0.5);
  assert.equal(layer.children[0].fills[0].opacity, 0);
  assert.equal(layer.strokes[0].opacity, 128 / 255);
  const variable = variables.get(layer.fills[0].boundVariables.color.id);
  assert.equal(variable.valuesByMode.mode.a, 64 / 255);
  layer.strokes = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 0.25 }];
  const report = await exportProject(api, () => {});
  const change = report.changes.find(row => row.id === "open");
  assert.equal(change.before.stroke, "#16224080");
  assert.equal(change.after.stroke, "#FF000040");
});

test("observed reports live clicks, main component IDs, and parent-relative geometry with stable source IDs", async () => {
  const { api } = testApi();
  await importProject(api, fixture, "observed");
  const page = api.currentPage;
  const home = page.children.find(node => node.name === "mobile/home");
  const detail = page.children.find(node => node.name === "mobile/detail");
  const [open] = home.children;
  const files = new Map();
  const exportObserved = async () => {
    await exportProject(api, (name, mime, content) => files.set(name, content));
    return JSON.parse(files.get("design-diff.json")).observed;
  };
  const initial = await exportObserved();
  assert.deepEqual(initial.edges, [
    { from: "mobile/home", source: "open", action: "NAVIGATE", to: "mobile/detail" },
    { from: "mobile/home", source: "help", action: "OVERLAY", to: "mobile/detail" },
    { from: "mobile/detail", source: "back", action: "BACK", to: null }
  ]);
  const mainId = (await open.getMainComponentAsync()).id;
  assert.deepEqual(initial.instances.filter(row => row.mainId === mainId), [
    { boardId: "mobile/home", id: "open", mainId },
    { boardId: "mobile/detail", id: "back", mainId }
  ]);
  assert.deepEqual(initial.geometry.find(row => row.boardId === "mobile/detail" && row.id === "label"),
    { boardId: "mobile/detail", id: "label", x: 12, y: 8, width: 156, height: 24, type: "TEXT", text: "返回首页", parentId: "back" });
  assert.deepEqual(initial.geometry.find(row => row.boardId === "mobile/home" && row.id === "label"),
    { boardId: "mobile/home", id: "label", x: 12, y: 8, width: 103, height: 24, type: "TEXT", text: open.children[0].characters, parentId: "open" });
  assert.equal(initial.geometry.find(row => row.id === "open").parentId, "mobile/home");
  assert.equal(Object.hasOwn(initial.geometry.find(row => row.id === "mobile/home"), "parentId"), false);

  open.resize(201, 42);
  open.getMainComponentAsync = async () => null;
  const visit = { type: "NODE", navigation: "NAVIGATE", destinationId: home.id };
  await open.setReactionsAsync([
    { trigger: { type: "ON_CLICK" }, action: visit },
    { trigger: { type: "ON_HOVER" }, actions: [{ type: "BACK" }] }
  ]);
  const updated = await exportObserved();
  assert.deepEqual(updated.edges, [{ ...initial.edges[0], to: "mobile/home" }, ...initial.edges.slice(1)]);
  assert.deepEqual(updated.instances.find(row => row.id === "open"), { boardId: "mobile/home", id: "open", mainId: null });
  assert.equal(updated.geometry.find(row => row.id === "open").width, 201);
  detail.remove();
  const removed = await exportObserved();
  assert.deepEqual(removed.edges, [updated.edges[0], { ...initial.edges[1], to: null }]);
  assert.ok(removed.geometry.every(row => row.boardId === "mobile/home"));
  assert.ok(removed.instances.every(row => row.boardId === "mobile/home"));
});

test("observed preserves exact text and direct source parents, and differences locate new design layers", async () => {
  const { api } = testApi();
  const input = structuredClone(fixture);
  delete input.boards[0].children[0].component;
  await importProject(api, input, "design-layers");
  const home = api.currentPage.children.find(node => node.name === "mobile/home");
  const detail = api.currentPage.children.find(node => node.name === "mobile/detail");
  const label = home.children[0].children[0];
  const draft = api.createFrame();
  const text = api.createText();
  draft.name = "Design draft";
  draft.appendChild(text);
  home.appendChild(draft);
  draft.appendChild(label);
  label.characters = "  原样 \n文本  ";
  text.characters = "";
  const report = await exportProject(api, () => {});
  const actual = report.observed.geometry.find(row => row.boardId === home.name && row.id === "label");
  assert.equal(actual.text, label.characters);
  assert.equal(Object.hasOwn(actual, "parentId"), false);
  assert.equal(report.observed.geometry.some(row => row.id === "figma:" + draft.id), false);
  const additions = report.changes.filter(row => row.scope === "design" && row.op === "add");
  assert.deepEqual(additions.map(row => [row.boardId, row.id, row.after.parent.id]), [
    [home.name, "figma:" + draft.id, home.name],
    [home.name, "figma:" + text.id, "figma:" + draft.id]
  ]);
  assert.equal(additions[1].after.text, "");

  detail.appendChild(draft);
  const moved = await exportProject(api, () => {});
  assert.deepEqual(moved.observed.geometry.filter(row => row.id === "label").map(row => [row.boardId, row.parentId]), [[detail.name, "back"]]);
  assert.equal(moved.changes.find(row => row.id === "figma:" + draft.id).boardId, detail.name);
});

test("export pins the owning revision by page ID even when page names match", async () => {
  const { api } = testApi();
  await importProject(api, fixture, "revision-one");
  const first = api.currentPage;
  const input = structuredClone(fixture);
  input.boards[0].children[0].children[0].text = "新版";
  await importProject(api, input, "revision-two");
  const second = api.currentPage;
  second.name = first.name;
  const firstBoard = first.children.find(node => node.name === "mobile/home");
  const originalExport = firstBoard.exportAsync;
  firstBoard.exportAsync = async function (settings) {
    await api.setCurrentPageAsync(second);
    return originalExport.call(this, settings);
  };
  await api.setCurrentPageAsync(first);
  const report = await exportProject(api, () => {});
  assert.deepEqual([report.pageId, report.sourceSha256, report.boards[0].figmaId], [first.id, "revision-one", firstBoard.id]);
  const latest = await exportProject(api, () => {});
  assert.deepEqual([latest.pageId, latest.sourceSha256], [second.id, "revision-two"]);

  const copy = api.createPage();
  copy.name = first.name;
  copy.setPluginData("owner", first.id);
  saveBaseline(copy, readBaseline(first));
  await api.setCurrentPageAsync(copy);
  await assert.rejects(exportProject(api, () => {}), /项目版本页/);
});

test("an exported board must still belong to the pinned page after rendering", async () => {
  const { api } = testApi();
  const other = api.currentPage;
  await importProject(api, fixture, "moved-board");
  const board = api.currentPage.children.find(node => node.name === "mobile/home");
  const originalExport = board.exportAsync;
  board.exportAsync = async function (settings) {
    other.appendChild(this);
    return originalExport.call(this, settings);
  };
  const files = [];
  await assert.rejects(exportProject(api, name => files.push(name)), /mobile\/home 在导出期间被移动或删除/);
  assert.deepEqual(files, []);
  const report = await exportProject(api, () => {});
  assert.equal(report.boards[0].status, "missing");
  assert.equal(report.observed.geometry.some(row => row.boardId === "mobile/home"), false);
});

test("flow starting points use the first board of each viewport in bundle order", async () => {
  const { api } = testApi();
  const input = structuredClone(fixture);
  const otherBoards = ["welcome", "settings"].map(state => ({
    id: "desktop/" + state, state, viewport: "desktop", width: 1024, height: 768, children: []
  }));
  input.boards.splice(1, 0, otherBoards[0]);
  input.boards.push(otherBoards[1]);
  const original = api.currentPage;
  original.flowStartingPoints = [{ nodeId: "existing", name: "Existing" }];
  await importProject(api, input, "starting-points");
  const page = api.currentPage;
  assert.deepEqual(page.flowStartingPoints, [
    { nodeId: page.children.find(node => node.name === "mobile/home").id, name: "mobile" },
    { nodeId: page.children.find(node => node.name === "desktop/welcome").id, name: "desktop" }
  ]);
  assert.deepEqual(original.flowStartingPoints, [{ nodeId: "existing", name: "Existing" }]);
});

test("failed render rolls back only its own page and variable collection", async () => {
  const { api, groups } = testApi();
  const original = api.currentPage;
  api.createText = () => { throw new Error("font host failure"); };
  await assert.rejects(importProject(api, fixture, "bad"), /font host failure/);
  assert.equal(api.currentPage, original);
  assert.deepEqual(api.root.children, [original]);
  assert.equal(groups.size, 0);
});

test("token-only refresh keeps page, instances and native IDs, refreshes baseline, then forks for designer edits", async () => {
  const { api, variables } = testApi();
  await importProject(api, fixture, "one");
  const original = api.currentPage;
  const ids = readBaseline(original).refs;
  function recolor(color) {
    return JSON.parse(JSON.stringify(fixture).replaceAll("#2459D6", color));
  }
  const updated = await importProject(api, recolor("#FF111180"), "two");
  assert.equal(updated.tokenUpdate, true);
  assert.equal(api.currentPage, original);
  assert.deepEqual(readBaseline(original).refs, ids);
  const accent = Array.from(variables.values()).find(variable => variable.name === "Accent");
  assert.equal(accent.valuesByMode.mode.a, 128 / 255);
  const next = await exportProject(api, () => {});
  assert.deepEqual(next.changes, []);
  assert.equal(next.sourceSha256, "two");
  original.children[0].rotation = 3;
  const branched = await importProject(api, recolor("#FF3311"), "three");
  assert.equal(branched.revision, 2);
  assert.equal(original.children[0].rotation, 3);
  assert.equal(accent.valuesByMode.mode.a, 128 / 255);
});

test("a coincident literal, unbound paint or partial source replacement cannot authorize a token refresh", async () => {
  const { api } = testApi();
  await importProject(api, fixture, "one");
  const input = structuredClone(fixture);
  input.tokens.Accent = "#AA0000";
  const result = await importProject(api, input, "two");
  assert.equal(result.revision, 2);
  assert.equal(result.reused, false);
});

test("published component set binds both instances by key, keeps copy overrides, and leaves the source intact", async () => {
  const { api } = testApi();
  const library = api.createComponent();
  library.name = "State=Enabled";
  library.variantProperties = { State: "Enabled" };
  const label = api.createText();
  label.name = "Library label";
  label.characters = "原文";
  library.appendChild(label);
  let imports = 0;
  api.importComponentByKeyAsync = async () => { throw new Error("expected set key"); };
  api.importComponentSetByKeyAsync = async key => {
    assert.equal(key, "library-set-key");
    imports++;
    return { children: [library], defaultVariant: library };
  };
  const input = structuredClone(fixture);
  for (const board of input.boards) {
    const button = board.children[0];
    button.figmaKey = "library-set-key";
    button.variant = "Enabled";
    button.children[0].name = "Library label";
  }
  await importProject(api, input, "library");
  const detail = api.currentPage.children.find(node => node.name === "mobile/detail").children[0];
  assert.equal(await detail.getMainComponentAsync(), library);
  assert.equal(detail.children[0].characters, "返回首页");
  assert.equal(label.characters, "原文");
  assert.equal(imports, 1);
});

test("tight single-line boxes center in captured coordinates on text, components and referenced instances", async () => {
  const { api } = testApi();
  const library = api.createComponent();
  const original = api.createText();
  original.name = "Label";
  original.characters = "Library copy";
  Object.assign(original, { x: 12, y: 9 });
  original.resize(110, 18);
  original.fontName = { family: "Arial", style: "Bold" };
  library.appendChild(original);
  api.importComponentByKeyAsync = async () => library;
  api.loadFontAsync = async font => { if (font.family === "Arial") throw new Error("unavailable"); };
  const input = structuredClone(fixture);
  const [home, detail] = input.boards;
  const template = home.children[0].children[0];
  const captured = Object.assign(template, {
    text: "#Field notes", height: 18, width: 110, y: 9,
    style: { fontFamily: "Arial", fontStyle: "Bold", fontSize: 16, lineHeight: 26, letterSpacing: -0.5 }
  });
  home.children.push({ ...captured, id: "plain" }, { ...captured, id: "tall", height: 56 },
    { ...captured, id: "hard-break", text: "two\nlines" }, { ...captured, id: "soft-wrap", height: 37, text: "several words that wrap" });
  detail.children[0].figmaKey = "library-key";
  delete detail.children[0].variant;
  detail.children[0].children = [structuredClone(captured)];
  const result = await importProject(api, input, "font-calibration");
  const [homeFrame, detailFrame] = [home, detail].map(board => api.currentPage.children.find(node => node.name === board.id));
  const instance = homeFrame.children[0];
  const main = await instance.getMainComponentAsync();
  const libraryInstance = detailFrame.children[0];
  assert.equal(await libraryInstance.getMainComponentAsync(), library);
  for (const node of [main.children[0], instance.children[0], homeFrame.children[2], libraryInstance.children[0]]) {
    assert.equal(node.textAutoResize, "NONE");
    assert.equal(node.textAlignVertical, "CENTER");
    assert.deepEqual([node.width, node.height], [110, 18]);
    assert.deepEqual(node.letterSpacing, { unit: "PIXELS", value: -0.5 });
    assert.deepEqual(node.fontName, { family: "Arimo", style: "Bold" });
  }
  assert.equal(original.textAlignVertical, "TOP");
  assert.deepEqual(original.fontName, { family: "Arial", style: "Bold" });
  assert.equal(homeFrame.children[2].y, 9);
  for (const node of homeFrame.children.slice(3)) assert.equal(node.textAlignVertical, "TOP");
  assert.ok(result.warnings.some(message => message.includes("Arial Bold 不可用，使用 Arimo Bold")));
});

test("font fallback tries matching style before Inter Regular and records the actual substitution", async () => {
  for (const [available, attempts] of [
    ["Arial Bold Italic", ["Arial Bold Italic"]],
    ["Arimo Bold Italic", ["Arial Bold Italic", "Arimo Bold Italic"]],
    ["Inter Bold Italic", ["Arial Bold Italic", "Arimo Bold Italic", "Inter Bold Italic"]],
    ["Inter Regular", ["Arial Bold Italic", "Arimo Bold Italic", "Inter Bold Italic", "Inter Regular"]]
  ]) {
    const { api } = testApi();
    const tried = [];
    api.loadFontAsync = async font => {
      const label = `${font.family} ${font.style}`;
      tried.push(label);
      if (label !== available) throw new Error("unavailable");
    };
    const input = structuredClone(fixture);
    const board = input.boards[0];
    const text = board.children[0].children[0];
    Object.assign(text.style, { fontFamily: "Arial", fontStyle: "Bold Italic" });
    board.children = [text];
    input.boards = [board];
    input.edges = [];
    const result = await importProject(api, input, "font-order");
    assert.deepEqual(tried, attempts);
    const node = api.currentPage.children[0].children[0];
    assert.equal(`${node.fontName.family} ${node.fontName.style}`, available);
    assert.deepEqual(result.warnings, attempts.length > 1 ? [`label · 字体 Arial Bold Italic 不可用，使用 ${available}`] : []);
  }
});

test("unpublished components on another page resolve by node ID, with explicit and default variants", async () => {
  const { api } = testApi();
  const sourcePage = api.currentPage;
  const main = api.createComponent();
  main.name = "State=Enabled";
  main.variantProperties = { State: "Enabled" };
  const label = api.createText();
  label.name = "Library label";
  label.characters = "主组件原文";
  Object.assign(label, { x: 12, y: 8 });
  label.resize(103, 24);
  main.appendChild(label);
  const alternate = api.createComponent();
  alternate.name = "State=Disabled";
  alternate.variantProperties = { State: "Disabled" };
  const set = api.combineAsVariants([main, alternate], sourcePage);
  set.defaultVariant = main;
  const originalLookup = api.getNodeByIdAsync;
  api.getNodeByIdAsync = async id => {
    if (id === "12:34") return main;
    if (id === "12:35") return set;
    return originalLookup(id);
  };
  let libraryCalls = 0;
  api.importComponentByKeyAsync = api.importComponentSetByKeyAsync = async () => { libraryCalls++; };
  const input = structuredClone(fixture);
  const [open, help] = input.boards[0].children;
  const [back] = input.boards[1].children;
  for (const button of [open, back]) button.children[0].name = label.name;
  Object.assign(open, { figmaKey: "12:34", variant: "Enabled" });
  Object.assign(back, { figmaKey: "12:35", variant: undefined });
  Object.assign(help, { figmaKey: "12:35", variant: "Disabled", children: [] });
  const result = await importProject(api, input, "existing");
  assert.deepEqual(result.warnings, ["label · 引用组件保留原生布局：width=103（采集 156）"]);
  assert.equal(libraryCalls, 0);
  const report = await exportProject(api, () => {});
  assert.deepEqual(report.observed.instances, [
    { boardId: "mobile/home", id: "open", mainId: main.id },
    { boardId: "mobile/home", id: "help", mainId: alternate.id },
    { boardId: "mobile/detail", id: "back", mainId: main.id }
  ]);
  const detail = api.currentPage.children.find(node => node.name === "mobile/detail");
  assert.equal(detail.children[0].children[0].characters, "返回首页");
  assert.equal(report.observed.geometry.find(row => row.boardId === detail.name && row.id === "label").width, 103);
  assert.equal(label.characters, "主组件原文");
  assert.deepEqual(sourcePage.children, [set]);
});

test("node ID rejects wrong type, inaccessible components and missing variants with a fallback warning", async () => {
  const { api } = testApi();
  const frame = api.createFrame();
  const denied = api.createComponent();
  denied.name = "Enabled";
  denied.createInstance = () => { throw new Error("permission denied"); };
  const originalLookup = api.getNodeByIdAsync;
  api.getNodeByIdAsync = async id => {
    if (id === "12:1") return frame;
    if (id === "12:2" || id === "12:3") return denied;
    return originalLookup(id);
  };
  const input = structuredClone(fixture);
  const [open, help] = input.boards[0].children;
  const [back] = input.boards[1].children;
  Object.assign(open, { figmaKey: "12:1" });
  Object.assign(help, { figmaKey: "12:2" });
  Object.assign(back, { figmaKey: "12:3", variant: "Enabled" });
  const result = await importProject(api, input, "unavailable");
  assert.ok(result.warnings.some(warning => warning.includes("12:1") && warning.includes("FRAME")));
  assert.ok(result.warnings.some(warning => warning.includes("12:2") && warning.includes("无匹配变体")));
  assert.ok(result.warnings.some(warning => warning.includes("12:3") && warning.includes("permission denied")));
  const report = await exportProject(api, () => {});
  assert.equal(report.observed.instances.length, 3);
  assert.ok(report.observed.instances.every(instance => instance.mainId !== denied.id));
});

test("image and SVG nodes import original asset bytes and survive clean export", async () => {
  const { api } = testApi();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h10v10"/></svg>';
  api.createRectangle = () => Object.assign(api.createFrame(), { type: "RECTANGLE" });
  api.base64Decode = value => Buffer.from(value, "base64");
  api.createImage = bytes => { assert.deepEqual(bytes, Buffer.from(png, "base64")); return { hash: "image-hash" }; };
  api.createNodeFromSvg = value => { assert.equal(value, svg); return api.createFrame(); };
  const input = structuredClone(fixture);
  input.boards[0].children.push(
    { id: "img", name: "Photo", kind: "image", x: 3, y: 4, width: 10, height: 12, data: png, style: {} },
    { id: "vec", name: "Icon", kind: "svg", x: 8, y: 4, width: 24, height: 24, svg, style: {} }
  );
  await importProject(api, input, "media");
  const [image, vector] = api.currentPage.children[0].children.slice(-2);
  assert.equal(image.fills[0].imageHash, "image-hash");
  assert.equal(vector.width, 24);
  assert.deepEqual((await exportProject(api, () => {})).changes, []);
});
