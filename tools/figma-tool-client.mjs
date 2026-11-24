import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function openFigmaClient(cwd, server = 'codex_apps') {
  const child = spawn('codex', ['app-server', '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 0;
  function stop(error) {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
  child.on('error', stop);
  child.stdin.on('error', stop);
  child.on('exit', () => stop(Error('Codex MCP client exited')));
  const lines = createInterface({ input: child.stdout });
  async function readResponses() {
    try {
      for await (const line of lines) {
        const message = JSON.parse(line);
        if (message.method) {
          if (message.id != null) child.stdin.write(JSON.stringify({
            id: message.id, error: { code: -32601, message: 'Interactive request requires the coordinating MCP host' }
          }) + '\n');
          continue;
        }
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.reject(Error(message.error.message));
        else waiter.resolve(message.result);
      }
    } catch (error) { stop(error); }
  }
  void readResponses();
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`Timed out waiting for ${method}. Inspect any outstanding write receipt.`));
      }, 120_000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); }
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'ui_parity', title: 'UI Parity', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const { thread } = await rpc('thread/start', { cwd, ephemeral: true });
    const scope = { threadId: thread.id, serverName: server, detail: 'full' };
    const entries = [];
    let cursor;
    do {
      const page = await rpc('mcpServerStatus/list', { ...scope, cursor });
      entries.push(...page.data.filter(entry => entry.name === server));
      cursor = page.nextCursor;
    } while (cursor);
    const names = {};
    for (const method of ['use_figma', 'download_assets']) {
      const hits = entries.flatMap(entry => Object.values(entry.tools).filter(tool =>
        tool.name === method || tool.name.endsWith(`figma__${method}`) || tool.name.endsWith(`figma_${method}`))
        .map(tool => ({ name: tool.name, environmentId: entry.environmentId, schema: tool.inputSchema })));
      if (hits.length !== 1 || (method === 'download_assets' && !hits[0].schema?.properties?.nodeId)) {
        throw Error(`Expected a registered Figma ${method} with the project connector schema in ${server}. Use next with the connected host.`);
      }
      names[method] = hits[0];
    }
    return {
      call(method, args) {
        return rpc('mcpServer/tool/call', { threadId: thread.id, server, environmentId: names[method].environmentId,
          tool: names[method].name, arguments: args });
      },
      close() { child.kill(); }
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}
