import * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { listSessions, Session, type RequestContext, type SessionConfig, type SteerOutcome } from "./session.ts";

type SteerParams = {
  sessionId: string;
  prompt: acp.ContentBlock[];
  _meta?: { steering?: { idleBehavior?: string } };
};

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
    params: { sessionId: string; cwd: string; mcpServers?: acp.McpServer[] | null },
    ctx: RequestContext,
  ): Promise<Session> => {
    const existing = sessions.get(params.sessionId);
    if (existing) return existing;
    const session = await Session.load(config, { ...params, mcpServers: params.mcpServers ?? [] }, ctx);
    if (!session) throw RequestError.resourceNotFound(params.sessionId);
    sessions.set(session.sessionId, session);
    return session;
  };

  const describe = (session: Session) => ({
    modes: session.modeState,
    configOptions: session.configOptions,
    _meta: { herdr: { paneId: session.pane } },
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
        _meta: { steering: { supported: true } },
      };
    })
    .onRequest("authenticate", () => ({}))
    .onRequest("session/new", async ({ params, client, requestId }) => {
      const session = await Session.create(config, params, { client, requestId });
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
