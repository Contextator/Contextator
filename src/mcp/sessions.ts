import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Logger } from '../context.js';

export type SessionKind = 'streamable' | 'sse';

interface SessionBase {
  id: string;
  projectId: string;
  projectName: string;
  server: McpServer;
  createdAt: number;
  lastSeenAt: number;
}

export interface StreamableSession extends SessionBase {
  kind: 'streamable';
  transport: StreamableHTTPServerTransport;
}

export interface SseSession extends SessionBase {
  kind: 'sse';
  transport: SSEServerTransport;
}

export type Session = StreamableSession | SseSession;

/**
 * Registry of live MCP sessions (one McpServer + transport per client connection).
 * Lookups are kind-scoped so a legacy `/messages` POST can never be routed into a
 * Streamable HTTP transport or vice versa.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private reaper: NodeJS.Timeout | undefined;

  constructor(private readonly log: Logger) {}

  add(session: Session): void {
    this.sessions.set(session.id, session);
    this.log.info({ sessionId: session.id, kind: session.kind, project: session.projectName }, 'mcp session opened');
  }

  get(id: string, kind: 'streamable'): StreamableSession | undefined;
  get(id: string, kind: 'sse'): SseSession | undefined;
  get(id: string, kind: SessionKind): Session | undefined {
    const session = this.sessions.get(id);
    return session && session.kind === kind ? session : undefined;
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastSeenAt = Date.now();
  }

  /** Removes the registry entry only; transport teardown happens through `close()` or the transport's own onclose. */
  delete(id: string): void {
    const session = this.sessions.get(id);
    if (session && this.sessions.delete(id)) {
      this.log.info({ sessionId: id, kind: session.kind, project: session.projectName }, 'mcp session closed');
    }
  }

  async closeForProject(projectId: string): Promise<void> {
    const targets = [...this.sessions.values()].filter((s) => s.projectId === projectId);
    await Promise.all(targets.map((s) => this.close(s)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.close(s)));
  }

  /**
   * Streamable HTTP clients that die without sending DELETE leave their transport alive
   * forever; close sessions that have been idle longer than `ttlMs`.
   */
  startReaper(ttlMs: number, intervalMs = 60_000): void {
    this.stopReaper();
    this.reaper = setInterval(() => {
      const cutoff = Date.now() - ttlMs;
      for (const session of this.sessions.values()) {
        if (session.kind === 'streamable' && session.lastSeenAt < cutoff) {
          this.log.info({ sessionId: session.id, project: session.projectName }, 'closing idle mcp session');
          void this.close(session);
        }
      }
    }, intervalMs);
    this.reaper.unref();
  }

  stopReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
  }

  stats(): { total: number; streamable: number; sse: number } {
    let streamable = 0;
    let sse = 0;
    for (const s of this.sessions.values()) {
      if (s.kind === 'streamable') streamable++;
      else sse++;
    }
    return { total: this.sessions.size, streamable, sse };
  }

  private async close(session: Session): Promise<void> {
    try {
      await session.transport.close();
    } catch (err) {
      this.log.warn({ err, sessionId: session.id }, 'error while closing mcp session');
    } finally {
      this.delete(session.id);
    }
  }
}
