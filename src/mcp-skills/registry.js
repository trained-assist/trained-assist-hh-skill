'use strict';

const fs = require('fs');
const path = require('path');

const toolsDir = process.env.TOOLS_DIR || path.join(__dirname, 'tools');
const handlers = {};
const defs = [];
const allDefs = [];
// Host-only actions (module.hostOnly): invoked by core, never by the model.
// Kept out of listTools/listAllTools, so they appear in neither tools/list nor
// any manifest; callTool refuses them unless core spawned this process as a
// host action (MCP_HOST_ACTION=1). Epic trained-assist-agent#1470 P1.3.
const hostHandlers = {};
const hostDefs = [];

// Auto-discover all tool files in tools/
// Each module may export:
//   isReady()    — returns bool; if false, only setupTools are registered (default: true)
//   setupTools   — tool names always registered even when !isReady (for configure/status tools)
for (const file of fs.readdirSync(toolsDir).filter(f => f.endsWith('.js')).sort()) {
  const mod = require(path.join(toolsDir, file));
  const ready = typeof mod.isReady === 'function' ? mod.isReady() : true;
  const setupSet = new Set(mod.setupTools || []);

  if (mod.hostOnly) {
    for (const [name, tool] of Object.entries(mod.tools || {})) {
      if (hostHandlers[name]) { console.error(`[registry] duplicate host action: ${name} in ${file}`); continue; }
      hostHandlers[name] = tool.handler;
      hostDefs.push({ name, description: tool.description,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} } });
    }
    continue;
  }

  for (const [name, tool] of Object.entries(mod.tools || {})) {
    allDefs.push({ name, description: tool.description,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} } });
    if (!ready && !setupSet.has(name)) continue;
    if (handlers[name]) {
      console.error(`[registry] duplicate tool name: ${name} in ${file}`);
      continue;
    }
    handlers[name] = tool.handler;
    defs.push({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    });
  }
}

module.exports = {
  listTools: () => defs,
  // Build/test only: managed core reads provider-manifest.json instead.
  listAllTools: () => allDefs,
  listHostActions: () => hostDefs,
  callTool: (name, args) => {
    if (hostHandlers[name]) {
      if (process.env.MCP_HOST_ACTION !== '1') throw new Error(`Unknown tool: ${name}`);
      return hostHandlers[name](args, { userId: process.env.USER_ID });
    }
    const fn = handlers[name];
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    const ctx = { userId: process.env.USER_ID };
    return fn(args, ctx);
  },
};
