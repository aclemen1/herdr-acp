import * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { listLiveSessions, Session, type SessionConfig } from "./session.ts";

export function createAgent(config: SessionConfig, version: string) {
  const sessions = new Map<string, Session>();

  const getSession = (sessionId: string): Session => {
    const session = sessions.get(sessionId);
    if (!session) throw RequestError.resourceNotFound(sessionId);
    return session;
  };

  const app = acp
    .agent({ name: "herdr-acp" })
    .onRequest("initialize", ({ params }) => {
      config.client.capabilities = params.clientCapabilities ?? null;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "herdr-acp", title: `${config.driver.title} via herdr`, version },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, close: {} },
        },
        authMethods: [],
      };
    })
    .onRequest("authenticate", () => ({}))
    .onRequest("session/new", async ({ params, client, requestId }) => {
      const session = await Session.create(config, params, { client, requestId });
      sessions.set(session.sessionId, session);
      return { sessionId: session.sessionId, _meta: { herdr: { paneId: session.pane } } };
    })
    .onRequest("session/load", async ({ params, client, requestId }) => {
      let session = sessions.get(params.sessionId);
      if (!session) {
        session = (await Session.load(config, params, { client, requestId })) ?? undefined;
        if (!session) throw RequestError.resourceNotFound(params.sessionId);
        sessions.set(session.sessionId, session);
      }
      await session.replayHistory();
      return { _meta: { herdr: { paneId: session.pane } } };
    })
    .onRequest("session/list", async ({ params }) => ({ sessions: await listLiveSessions(config, params.cwd) }))
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
