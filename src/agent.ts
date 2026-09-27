import * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { listSessions, Session, type RequestContext, type SessionConfig } from "./session.ts";

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
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, close: {}, resume: {} },
        },
        authMethods: [],
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
    .onRequest("session/resume", async ({ params, client, requestId }) =>
      describe(await attach(params, { client, requestId })),
    )
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
    await Promise.all([...sessions.values()].map((session) => session.dispose()));
    sessions.clear();
  };

  return { app, disposeAll };
}
