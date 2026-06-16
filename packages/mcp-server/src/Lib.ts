/**
 * Side-effect-free public API of the MCP server package. Use this from other
 * packages (e.g. @synaipse/web) when mounting MCP inside another process —
 * importing the CLI entrypoint `Index.js` would also start the server.
 */
export {buildMcpHttpHandler, startServer, type StartServerOptions, type TransportMode} from './Server.js';