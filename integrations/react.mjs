import { fileComponentName, sourceKey } from './identity.mjs';

function conditionName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const parent = conditionName(node.object);
    if (parent) return `${parent}.${node.property.name}`;
  }
}

function componentName(fn, filename) {
  if (fn.parentPath.isVariableDeclarator() && fn.parentPath.node.id.type === 'Identifier') {
    const name = fn.parentPath.node.id.name;
    return /^[A-Z]/.test(name) ? name : null;
  }
  if (fn.isFunctionDeclaration() && fn.node.id) {
    const name = fn.node.id.name;
    if (/^[A-Z]/.test(name)) return name;
  }
  if (fn.parentPath.isExportDefaultDeclaration()) return fileComponentName(filename);
  return null;
}

function returnedRoot(fn) {
  const body = fn.get('body');
  if (!body.isBlockStatement()) return { root: body };
  const returns = [];
  body.traverse({
    Function(nested) { nested.skip(); },
    ReturnStatement(statement) { returns.push(statement); }
  });
  if (returns.length !== 1 || returns[0].parentPath !== body ||
      body.node.body.at(-1) !== returns[0].node) return { reason: 'ambiguous-return' };
  return { root: returns[0].get('argument') };
}

export default function componentIdentity(api, options = {}) {
  api.assertVersion(7);
  const types = api.types;
  return {
    name: 'ui-parity-react-component-identity',
    manipulateOptions(_options, parser) {
      if (!parser.plugins.includes('jsx')) parser.plugins.push('jsx');
    },
    visitor: {
      Program(program, state) {
        const filename = state.filename ?? null;
        const diagnostics = state.file.metadata.componentIdentity = [];
        function report(node, component, status, reason) {
          const event = { filename, component, status, reason, line: node.loc?.start.line ?? null };
          diagnostics.push(event);
          options.onDiagnostic?.(event);
        }
        program.traverse({
          Function(fn) {
            const component = componentName(fn, filename);
            if (!component) return;
            if (fn.getFunctionParent()) {
              const binding = fn.parentPath.scope.getBinding(component);
              if (!binding?.referencePaths.length || !binding.referencePaths.every(ref =>
                ref.key === 'name' && (ref.parentPath.isJSXOpeningElement() || ref.parentPath.isJSXClosingElement()))) {
                report(fn.node, component, 'skipped', 'ambiguous-local-use');
                return;
              }
            }
            if (fn.node.generator) {
              report(fn.node, component, 'skipped', 'generator');
              return;
            }
            const { root, reason } = returnedRoot(fn);
            if (!root?.isJSXElement()) {
              report(fn.node, component, 'skipped', reason ?? (root?.isJSXFragment() ? 'fragment' : 'indirect-root'));
              return;
            }
            const opening = root.node.openingElement;
            if (opening.name.type !== 'JSXIdentifier' || !/^[a-z]/.test(opening.name.name)) {
              report(opening, component, 'skipped', 'component-root');
              return;
            }
            const attrs = opening.attributes;
            if (attrs.some(attr => attr.type === 'JSXAttribute' &&
                attr.name.type === 'JSXIdentifier' && attr.name.name.toLowerCase() === 'data-component')) {
              report(opening, component, 'preserved', 'explicit-attribute');
            } else if (attrs.some(attr => attr.type === 'JSXSpreadAttribute')) {
              report(opening, component, 'skipped', 'spread-props');
            } else {
              attrs.push(types.jsxAttribute(types.jsxIdentifier('data-component'), types.stringLiteral(component)));
              const key = sourceKey(filename, component, options.root ?? state.file.opts.root);
              function mark(host, value) {
                if (host.attributes.some(attr => attr.type === 'JSXSpreadAttribute' || attr.name.name === 'data-mirror-key')) return;
                host.attributes.push(types.jsxAttribute(types.jsxIdentifier('data-mirror-key'), types.stringLiteral(value)));
              }
              if (key) {
                mark(opening, key);
                root.traverse({
                  Function(nested) { nested.skip(); },
                  JSXElement(element) {
                    const host = element.node.openingElement;
                    if (host.name.type !== 'JSXIdentifier' || !/^[a-z]/.test(host.name.name)) return element.skip();
                    const parent = element.parentPath;
                    const test = parent.isConditionalExpression() ? parent.node.test :
                      parent.isLogicalExpression({ operator: '&&' }) && element.key === 'right' ? parent.node.left : null;
                    const condition = test && conditionName(test);
                    if (condition) mark(host, `${key}/${condition}/${element.key}`);
                  }
                });
              }
              report(opening, component, 'injected', 'host-root');
            }
          },
          VariableDeclarator(declaration) {
            const { id, init } = declaration.node;
            if (id.type === 'Identifier' && /^[A-Z]/.test(id.name) && init?.type === 'CallExpression' &&
                init.arguments.some(arg => types.isFunction(arg) || types.isIdentifier(arg))) {
              report(declaration.node, id.name, 'skipped', 'indirect-component');
            }
          },
          ExportDefaultDeclaration(declaration) {
            if (types.isCallExpression(declaration.node.declaration)) {
              report(declaration.node, fileComponentName(filename), 'skipped', 'indirect-component');
            }
          },
          Class(declaration) {
            if (declaration.node.superClass && declaration.node.body.body.some(member =>
              types.isClassMethod(member) && types.isIdentifier(member.key, { name: 'render' }))) {
              report(declaration.node, declaration.node.id?.name ?? fileComponentName(filename), 'skipped', 'class-render');
            }
          }
        });
      }
    }
  };
}
