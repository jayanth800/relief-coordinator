import "dotenv/config";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as aws from "./aws.js";
import * as store from "./data.js";

const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const resourceUri = "ui://relief-coordinator/map.html";

const supplyShape = z.object({
  water: z.number().int().min(0).optional(),
  food: z.number().int().min(0).optional(),
  medical: z.number().int().min(0).optional(),
  blankets: z.number().int().min(0).optional(),
});

function reply(text: string, payload: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text }], structuredContent: payload, isError };
}

function createServer(): McpServer {
  const server = new McpServer({ name: "relief-coordinator", version: "1.0.0" });

  // 1) The tool that opens the interactive map UI.
  registerAppTool(
    server,
    "show_relief_map",
    {
      title: "Show relief map",
      description:
        "Opens an interactive map of disaster relief shelters, volunteers and the supply depot. " +
        "The coordinator can click shelters, get allocation suggestions and confirm assignments.",
      inputSchema: {},
      _meta: { ui: { resourceUri } },
    },
    async () => {
      const state = store.snapshot();
      const critical = state.shelters.filter((s) => s.level === "critical").map((s) => s.name);
      return reply(
        `Relief map loaded. ${state.shelters.length} shelters, ${state.stats.criticalSites} critical` +
          (critical.length ? ` (${critical.join(", ")})` : "") +
          `. ${state.stats.volunteersFree} volunteers are free.`,
        { state },
      );
    },
  );

  // 2) Suggest who/what to send. Swap the rule-based logic in data.ts for Bedrock later.
  server.registerTool(
    "suggest_allocation",
    {
      title: "Suggest allocation",
      description:
        "Suggests which free volunteers and how many supplies to send to a shelter. " +
        "If shelterId is omitted, picks the most urgent shelter. This is a suggestion only; a human must confirm.",
      inputSchema: { shelterId: z.string().optional() },
    },
    async ({ shelterId }) => {
      let suggestion: store.Suggestion | null = null;
      try {
        suggestion = await aws.bedrockSuggest(shelterId);
      } catch (err) {
        console.warn("[Bedrock] failed, using rule-based suggestion:", err instanceof Error ? err.message : err);
      }
      suggestion = suggestion ?? store.suggest(shelterId);
      if (!suggestion) return reply("Shelter not found.", { message: "Shelter not found." }, true);
      return reply(suggestion.reason, { state: store.snapshot(), suggestion });
    },
  );

  // 3) Human-confirmed assignment.
  server.registerTool(
    "assign_resources",
    {
      title: "Assign resources",
      description: "Confirms an assignment: sends volunteers and depot supplies to a shelter.",
      inputSchema: {
        shelterId: z.string(),
        volunteerIds: z.array(z.string()),
        supplies: supplyShape.default({}),
      },
    },
    async ({ shelterId, volunteerIds, supplies }) => {
      const result = store.assign(shelterId, volunteerIds, supplies);
      if (!result.ok) return reply(result.error, { message: result.error }, true);
      await aws.persist();
      const snap = store.snapshot();
      const shelterName = snap.shelters.find((x) => x.id === shelterId)?.name ?? shelterId;
      const names = volunteerIds.map((id) => snap.volunteers.find((v) => v.id === id)?.name ?? id).join(", ");
      const sent = Object.entries(result.assignment.supplies).map(([k, n]) => `${n} ${k}`).join(", ") || "no supplies";
      const notified = await aws.notify(
        `Relief assignment: ${shelterName}`,
        `Assignment ${result.assignment.id}: ${names || "no volunteers"} go to ${shelterName}. Supplies: ${sent}.`,
      );
      const msg =
        `Assignment ${result.assignment.id} confirmed: ${volunteerIds.length} volunteer(s) and supplies sent.` +
        (notified ? " Notification sent via Amazon SNS." : "");
      return reply(msg, { state: store.snapshot(), suggestion: null, message: msg });
    },
  );

  // 4) Situation report.
  server.registerTool(
    "generate_sitrep",
    {
      title: "Generate situation report",
      description: "Produces a text situation report of all shelters, gaps, depot stock and assignments.",
      inputSchema: {},
    },
    async () => {
      const text = store.sitrep();
      return reply(text, { state: store.snapshot(), sitrep: text });
    },
  );

  // 5) Reset for repeatable demos.
  server.registerTool(
    "reset_demo",
    {
      title: "Reset demo data",
      description: "Resets all shelters, volunteers, stock and assignments to the starting scenario.",
      inputSchema: {},
    },
    async () => {
      const oldIds = store.exportDb().assignments.map((a) => a.id);
      store.resetStore();
      await aws.persist(oldIds);
      return reply("Demo data reset.", { state: store.snapshot(), suggestion: null, sitrep: "", message: "Demo reset." });
    },
  );

  // The bundled UI, served as an MCP resource.
  registerAppResource(server, resourceUri, resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
    return { contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
  });

  return server;
}

const app = express();
app.use(cors());
app.use(express.json());

// Stateless: a fresh MCP server per request. Demo data lives in data.ts (module scope).
app.all("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

await aws.initPersistence();
const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`Relief Coordinator MCP server running at http://localhost:${PORT}/mcp`);
});
