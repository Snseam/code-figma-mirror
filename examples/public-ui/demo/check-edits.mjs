import assert from 'node:assert/strict';

export function checkEdits(bundle, original, edited, expected) {
  for (const key of ['project', 'revision', 'pageId', 'sourceSha256']) assert.equal(edited[key], original[key], key);
  assert.deepEqual(edited.boards, original.boards);
  assert.deepEqual(edited.warnings, []);
  const [token, label] = expected.designChanges;
  const links = original.observed.componentLinks;
  const save = links.find(link => link.id === label.id.slice(0, label.id.lastIndexOf('/')));
  const tokenRow = edited.changes.find(change => change.scope === 'token' && change.id === token.id);
  assert.ok(tokenRow?.figmaId, 'Missing primary variable update');
  const fills = new Set();
  function visit(node) {
    if (node.style?.fill === bundle.tokens[token.id]) {
      const link = links.find(item => item.id === node.id);
      assert.ok(link, `Missing button instance ${node.id}`);
      fills.add(link.instanceId);
      fills.add(link.mainId);
      if (link.instanceId.includes(';')) fills.add(link.instanceId.split(';').at(-1));
    }
    node.children?.forEach(visit);
  }
  bundle.boards.forEach(board => board.children.forEach(visit));
  const required = new Set([...fills, tokenRow.figmaId, label.id]);
  const seen = new Set();
  function colorValue(color) {
    return Object.fromEntries(['r', 'g', 'b'].map((channel, index) => [channel, Math.fround(parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) / 255)]));
  }
  for (const row of edited.changes) {
    const { before, after, figmaId } = row;
    assert.equal(row.op, 'update', row.id);
    assert.ok(!seen.has(figmaId), `Duplicate edit ${row.id}`);
    seen.add(figmaId);
    if (row === tokenRow) {
      const modes = Object.keys(before.valuesByMode);
      assert.equal(modes.length, 1);
      for (const [value, color] of [[before, token.before.color], [after, token.after.color]]) {
        assert.deepEqual(value, { color, valuesByMode: { [modes[0]]: { ...colorValue(color), a: 1 } } });
      }
    } else if (fills.has(figmaId)) {
      const link = links.find(item => item.instanceId === figmaId);
      assert.equal(row.scope, link ? 'node' : 'design');
      assert.equal(row.id, link?.id ?? `figma:${figmaId}`);
      for (const [value, color] of [[before, token.before.color], [after, token.after.color]]) {
        assert.equal(value.fills.length, 1);
        const paint = before.fills[0];
        assert.deepEqual(paint.boundVariables.color, { type: 'VARIABLE_ALIAS', id: tokenRow.figmaId });
        const fields = { fill: color, fills: [{ ...paint, color: colorValue(color) }] };
        if (figmaId === save.instanceId) {
          fields.properties = structuredClone(save.properties);
          const keys = Object.keys(fields.properties).filter(key => fields.properties[key].type === 'TEXT');
          assert.equal(keys.length, 1);
          assert.equal(fields.properties[keys[0]].value, label.before.text);
          if (value === after) fields.properties[keys[0]].value = label.after.text;
        }
        assert.deepEqual(value, fields, row.id);
      }
    } else {
      assert.equal(row.boardId, label.boardId);
      assert.ok(figmaId.startsWith(`${save.instanceId};`), `Unexpected edit to ${row.id}`);
      assert.equal(row.id, row.scope === 'node' ? label.id : `figma:${figmaId}`);
      assert.ok(['node', 'design'].includes(row.scope));
      assert.deepEqual(before, label.before);
      assert.deepEqual(after, label.after);
      if (row.id === label.id) required.delete(label.id);
    }
    required.delete(figmaId);
  }
  assert.deepEqual([...required], [], 'Missing expected label or bound color changes');
}
