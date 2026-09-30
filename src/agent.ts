import * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  type InitialConfig,
  listSessions,
  Session,
  type RequestContext,
  type SessionConfig,
  type SteerOutcome,
} from "./session.ts";

type SteerParams = {
  sessionId: string;
  prompt: acp.ContentBlock[];
  _meta?: { steering?: { idleBehavior?: string } };
};

function parseInitialConfig(meta: unknown): InitialConfig | undefined {
  const raw = (meta as { herdr?: { config?: unknown } } | null | undefined)?.herdr?.config;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw RequestError.invalidParams({ config: raw }, "_meta.herdr.config must be an object");
  }
  const initial: InitialConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "mode" && key !== "model" && key !== "effort") {
      throw RequestError.invalidParams({ configId: key }, `unknown config option in _meta.herdr.config: ${key}`);
    }
    if (typeof value !== "string") {
      throw RequestError.invalidParams({ configId: key, value }, `_meta.herdr.config.${key} must be a string`);
    }
    initial[key] = value;
  }
  return initial;
}

function parseSteerParams(raw: unknown): SteerParams {
  const params = (raw ?? {}) as Partial<SteerParams>;
  if (typeof params.sessionId !== "string" || !params.sessionId) {
    throw RequestError.invalidParams(undefined, "steer params require a non-empty sessionId");
  }
  if (!Array.isArray(params.prompt) || params.prompt.length === 0) {
    throw RequestError.invalidParams(undefined, "steer params require a non-empty prompt array");
  }
  const idleBehavior = params._meta?.steering?.idleBehavior;
  if (idleBehavior !== undefined && idleBehavior !== "promptRequired") {
    throw RequestError.invalidParams(undefined, "unsupported steering idleBehavior");
  }
  return params as SteerParams;
}

export function createAgent(config: SessionConfig, version: string) {
  const sessions = new Map<string, Session>();

  const getSession = (sessionId: string): Session => {
    const session = sessions.get(sessionId);
    if (!session) throw RequestError.resourceNotFound(sessionId);
    return session;
  };

  const attach = async (
    params: { sessionId: string; cwd: string; mcpServers?: acp.McpServer[] | null; _meta?: unknown },
    ctx: RequestContext,
  ): Promise<Session> => {
    const existing = sessions.get(params.sessionId);
    if (existing) return existing;
    const takeover = (params._meta as { herdr?: { takeover?: unknown } } | null | undefined)?.herdr?.takeover === true;
    const session = await Session.load(config, { ...params, mcpServers: params.mcpServers ?? [], takeover }, ctx);
    if (!session) throw RequestError.resourceNotFound(params.sessionId);
    sessions.set(session.sessionId, session);
    return session;
  };

  const describe = (session: Session) => ({
    modes: session.modeState,
    configOptions: session.configOptions,
    _meta: { herdr: { paneId: session.pane, tabId: session.tab, ownsTab: session.ownsTab } },
  });

  const app = acp
    .agent({ name: "herdr-acp" })
    .onRequest("initialize", ({ params }) => {
      config.client.capabilities = params.clientCapabilities ?? null;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "herdr-acp", title: `${config.driver.title} via herdr`, version },
        agentCapabilities: {
          _meta: { claudeCode: { promptQueueing: true } },
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, close: {}, resume: {}, fork: {} },
        },
        authMethods: [],
        _meta: {
          steering: { supported: true },
          herdr: {
            version,
            agent: config.driver.kind,
            extensions: { sessionPlacement: 1, sessionConfig: 1, sessionOwnership: 1, ...config.driver.extensions },
          },
        },
      };
    })
    .onRequest("authenticate", () => ({}))
    .onRequest("session/new", async ({ params, client, requestId }) => {
      const initial = parseInitialConfig(params._meta);
      const session = await Session.create(config, { ...params, ...(initial ? { initial } : {}) }, { client, requestId });
      sessions.set(session.sessionId, session);
      return { sessionId: session.sessionId, ...describe(session) };
    })
    .onRequest("session/load", async ({ params, client, requestId }) => {
      const session = await attach(params, { client, requestId });
      await session.replayHistory();
      return describe(session);
    })
    .onRequest("session/resume", async ({ params, client, requestId }) => {
      const session = await attach(params, { client, requestId });
      await session.announceCommands();
      return describe(session);
    })
    .onRequest("session/fork", async ({ params, client, requestId }) => {
      const session = await Session.fork(config, { ...params, mcpServers: params.mcpServers ?? [] }, { client, requestId });
      if (!session) throw RequestError.resourceNotFound(params.sessionId);
      sessions.set(session.sessionId, session);
      await session.announceCommands();
      return { sessionId: session.sessionId, ...describe(session) };
    })
    .onRequest("session/set_mode", async ({ params }) => {
      await getSession(params.sessionId).setMode(params.modeId);
      return {};
    })
    .onRequest("session/set_config_option", async ({ params }) => {
      if (typeof params.value !== "string") {
        throw RequestError.invalidParams({ configId: params.configId }, "only select options are supported");
      }
      return { configOptions: await getSession(params.sessionId).setConfigOption(params.configId, params.value) };
    })
    .onRequest<SteerParams, SteerOutcome>("_session/steering", parseSteerParams, async ({ params }) =>
      getSession(params.sessionId).steer(params.prompt, params._meta?.steering?.idleBehavior),
    )
    .onRequest("session/list", async ({ params }) => ({ sessions: await listSessions(config, params.cwd) }))
    .onRequest("session/prompt", async ({ params }) => getSession(params.sessionId).prompt(params.prompt))
    .onNotification("session/cancel", async ({ params }) => {
      await sessions.get(params.sessionId)?.cancel();
    })
    .onRequest("session/close", async ({ params }) => {
      await getSession(params.sessionId).close();
      sessions.delete(params.sessionId);
      return {};
    });

  const disposeAll = async () => {
    await Promise.all([...sessions.values()].map((session) => session.shutdown()));
    sessions.clear();
  };

  return { app, disposeAll };
}
