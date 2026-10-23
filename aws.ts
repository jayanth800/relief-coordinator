// AWS integrations. Each feature is OFF unless enabled in .env, and every
// failure falls back to the in-memory demo so the app never breaks on stage.
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import * as store from "./data.js";

const region = process.env.AWS_REGION;
const cfg = region ? { region } : {};
const TABLE = process.env.DYNAMODB_TABLE ?? "relief-coordinator";

const ddb = new DynamoDBClient(cfg);
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });
const bedrock = new BedrockRuntimeClient(cfg);
const sns = new SNSClient(cfg);

let dynamoOn = false;
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// ---------- DynamoDB ----------
export async function persist(removeAssignmentIds: string[] = []): Promise<void> {
  if (!dynamoOn) return;
  try {
    const d = store.exportDb();
    const items = [
      ...d.shelters.map((s) => ({ pk: `shelter#${s.id}`, data: s })),
      ...d.volunteers.map((v) => ({ pk: `volunteer#${v.id}`, data: v })),
      { pk: "depot", data: d.depot },
      ...d.assignments.map((a) => ({ pk: `assignment#${a.id}`, data: a })),
    ];
    await Promise.all([
      ...items.map((Item) => doc.send(new PutCommand({ TableName: TABLE, Item }))),
      ...removeAssignmentIds.map((id) => doc.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `assignment#${id}` } }))),
    ]);
  } catch (e) {
    console.warn("[DynamoDB] save failed, continuing in memory:", errText(e));
  }
}

export async function initPersistence(): Promise<void> {
  if (process.env.USE_DYNAMODB !== "true") {
    console.log("[DynamoDB] disabled (set USE_DYNAMODB=true in .env to enable)");
    return;
  }
  try {
    try {
      await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
    } catch (e) {
      if ((e as { name?: string }).name !== "ResourceNotFoundException") throw e;
      console.log(`[DynamoDB] creating table "${TABLE}"...`);
      await ddb.send(
        new CreateTableCommand({
          TableName: TABLE,
          AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          BillingMode: "PAY_PER_REQUEST",
        }),
      );
      await waitUntilTableExists({ client: ddb, maxWaitTime: 90 }, { TableName: TABLE });
    }

    const scan = await doc.send(new ScanCommand({ TableName: TABLE }));
    const items = (scan.Items ?? []) as { pk: string; data: never }[];
    const cur = store.exportDb();
    const shelters = items.filter((i) => i.pk.startsWith("shelter#")).map((i) => i.data);
    const volunteers = items.filter((i) => i.pk.startsWith("volunteer#")).map((i) => i.data);
    const depot = items.find((i) => i.pk === "depot")?.data;
    const assignments = items.filter((i) => i.pk.startsWith("assignment#")).map((i) => i.data);

    dynamoOn = true;
    if (shelters.length && volunteers.length && depot) {
      store.importDb({ shelters, volunteers, depot, assignments } as typeof cur);
      console.log(`[DynamoDB] loaded ${shelters.length} shelters, ${volunteers.length} volunteers from table "${TABLE}"`);
    } else {
      await persist();
      console.log(`[DynamoDB] table "${TABLE}" was empty, seeded with demo data`);
    }
  } catch (e) {
    dynamoOn = false;
    console.warn("[DynamoDB] unavailable, using in-memory data:", errText(e));
  }
}

// ---------- Bedrock ----------
export async function bedrockSuggest(shelterId?: string): Promise<store.Suggestion | null> {
  if (process.env.USE_BEDROCK !== "true") return null;
  const base = store.suggest(shelterId);
  if (!base) return null;

  const st = store.snapshot();
  const target = st.shelters.find((s) => s.id === base.shelterId)!;
  const free = st.volunteers
    .filter((v) => v.status === "free")
    .map((v) => ({
      id: v.id,
      name: v.name,
      skill: v.skill,
      distance: Math.round(Math.hypot(v.x - target.x, v.y - target.y)),
    }));

  const prompt =
    `You are an emergency relief logistics assistant. Decide what to send to one shelter.\n` +
    `Shelter: ${JSON.stringify({ name: target.name, occupancy: target.occupancy, capacity: target.capacity, urgency: target.urgency, supplies: target.supplies })}\n` +
    `Free volunteers (distance = minutes away): ${JSON.stringify(free)}\n` +
    `Depot stock: ${JSON.stringify(st.depot.stock)}\n` +
    `Rules: choose 2 to 3 volunteer ids from the list (prefer a medic if medical supplies are short, prefer close ones). ` +
    `Supplies to send must not exceed depot stock or the shelter's shortage (need - have).\n` +
    `Reply with ONLY JSON like {"volunteerIds":["V1"],"supplies":{"water":100,"food":50,"medical":10,"blankets":40},"reason":"one or two sentences"}`;

  const res = await bedrock.send(
    new ConverseCommand({
      modelId: process.env.BEDROCK_MODEL_ID ?? "amazon.nova-lite-v1:0",
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 500, temperature: 0.2 },
    }),
  );
  const text = res.output?.message?.content?.[0]?.text ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Model did not return JSON");
  const parsed = JSON.parse(m[0]) as { volunteerIds?: unknown; supplies?: Record<string, unknown>; reason?: unknown };

  const freeIds = new Set(free.map((v) => v.id));
  const ids = Array.isArray(parsed.volunteerIds)
    ? (parsed.volunteerIds as unknown[]).filter((x): x is string => typeof x === "string" && freeIds.has(x)).slice(0, 5)
    : [];
  if (ids.length === 0) throw new Error("Model chose no valid volunteers");

  const supplies: Partial<Record<store.SupplyKey, number>> = {};
  for (const k of store.SUPPLY_KEYS) {
    const want = Math.floor(Number(parsed.supplies?.[k] ?? 0));
    const shortage = Math.max(0, target.supplies[k].need - target.supplies[k].have);
    const amt = Math.max(0, Math.min(want || 0, st.depot.stock[k], shortage));
    if (amt > 0) supplies[k] = amt;
  }
  const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 400) : base.reason;
  return { shelterId: target.id, volunteerIds: ids, supplies, reason, source: "bedrock" };
}

// ---------- SNS ----------
export async function notify(subject: string, message: string): Promise<boolean> {
  const arn = process.env.SNS_TOPIC_ARN;
  if (!arn) return false;
  try {
    await sns.send(new PublishCommand({ TopicArn: arn, Subject: subject.slice(0, 99), Message: message }));
    return true;
  } catch (e) {
    console.warn("[SNS] publish failed:", errText(e));
    return false;
  }
}
