/*
Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com). All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";

import { AsgardeoJavaScriptClient } from "@asgardeo/javascript";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({
    path: resolve(__dirname, ".env"),
});

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    fatal: 50,
};

type LogContext = Record<string, unknown>;

function normalizeLogLevel(value: string | undefined): LogLevel {
    return value === "debug" || value === "info" || value === "warn" || value === "error" || value === "fatal"
        ? value
        : "info";
}

function redactLogValue(key: string, value: unknown): unknown {
    if (
        key.toLowerCase().includes("authorization") ||
        key.toLowerCase().includes("token") ||
        key.toLowerCase().includes("secret")
    ) {
        return "[redacted]";
    }

    if (value instanceof Error) {
        return summarizeError(value);
    }

    return value;
}

function formatLogContext(context: LogContext) {
    const entries = Object.entries(context)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => {
            const redactedValue = redactLogValue(key, value);
            const formattedValue = typeof redactedValue === "string"
                ? redactedValue.replace(/\s+/g, " ")
                : JSON.stringify(redactedValue);

            return `${key}=${formattedValue}`;
        });

    return entries.length > 0 ? ` ${entries.join(" ")}` : "";
}

// Mirror logs to a per-port file, since OBO callbacks land long after the terminal scrolls.
const logFilePath = getEnv("AGENT_LOG_FILE")
    || resolve(__dirname, "logs", `agent-${getEnv("AGENT_PORT") || "8791"}.log`);

try {
    mkdirSync(dirname(logFilePath), { recursive: true });
} catch {
    // A missing log file must never stop startup.
}

function appendLogFile(line: string) {
    try {
        appendFileSync(logFilePath, `${line}\n`);
    } catch {
        // Logging must never break a request.
    }
}

function createLogger(context: LogContext = {}) {
    const configuredLevel = normalizeLogLevel(process.env.LOG_LEVEL);

    function write(level: LogLevel, first: string | LogContext, second?: string) {
        if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[configuredLevel]) {
            return;
        }

        const message = typeof first === "string" ? first : second || "";
        const childContext = typeof first === "string" ? {} : first;
        const timestamp = new Date().toISOString();
        const contextText = formatLogContext({ ...context, ...childContext });
        const line = `${timestamp} ${level.toUpperCase()} ${message}${contextText}`;

        appendLogFile(line);

        if (level === "warn") {
            console.warn(line);
        } else if (level === "error" || level === "fatal") {
            console.error(line);
        } else {
            console.log(line);
        }
    }

    return {
        child: (childContext: LogContext) => createLogger({ ...context, ...childContext }),
        debug: (first: string | LogContext, second?: string) => write("debug", first, second),
        info: (first: string | LogContext, second?: string) => write("info", first, second),
        warn: (first: string | LogContext, second?: string) => write("warn", first, second),
        error: (first: string | LogContext, second?: string) => write("error", first, second),
        fatal: (first: string | LogContext, second?: string) => write("fatal", first, second),
    };
}

const logger = createLogger();

function summarizeError(error: Error) {
    const errorLike = error as Error & {
        code?: string;
        statusCode?: number;
        statusText?: string;
    };
    const collapsedMessage = error.message.replace(/\s+/g, " ");
    const truncatedMessage = collapsedMessage.length > 500
        ? `${collapsedMessage.slice(0, 500)}...`
        : collapsedMessage;

    return [
        error.name,
        errorLike.code,
        errorLike.statusCode ? `status=${errorLike.statusCode}` : "",
        errorLike.statusText,
        truncatedMessage,
    ].filter(Boolean).join(" ");
}

function getEnv(name: string) {
    return process.env[name]?.trim() || "";
}

// An organization-qualified base URL (.../t/<tenant>/o/<org-id>) signs the agent in natively
// inside that sub-organization instead of switching into it from the root tenant.
const asgardeoBaseUrl = getEnv("ASGARDEO_BASE_URL").replace(/\/$/, "");

// True when ASGARDEO_BASE_URL already points inside a sub-organization.
const isOrganizationQualifiedBaseUrl = /\/o\/[^/]+$/.test(asgardeoBaseUrl);

const asgardeoConfig = {
    afterSignInUrl: getEnv("REDIRECT_URI"),
    clientId: getEnv("CLIENT_ID"),
    clientSecret: getEnv("CLIENT_SECRET"),
    baseUrl: asgardeoBaseUrl,
    // A sub-org native agent never switches organizations, so it must request API scopes here.
    scopes: getEnv("AGENT_SIGN_IN_SCOPES"),
    // A sub-org's tokens are issued under the ROOT issuer, which the SDK cannot guess from
    // the base URL alone, so let it read the organization's discovery document instead.
    ...(isOrganizationQualifiedBaseUrl
        ? { wellKnownEndpoint: `${asgardeoBaseUrl}/oauth2/token/.well-known/openid-configuration` }
        : {}),
    // Escape hatch for apps configured to issue under the organization-qualified issuer.
    ...(getEnv("ASGARDEO_ISSUER") ? { endpoints: { issuer: getEnv("ASGARDEO_ISSUER") } } : {}),
};

const agentConfig = {
    agentID: getEnv("AGENT_ID"),
    agentSecret: getEnv("AGENT_SECRET"),
};


const appBaseUrl = (getEnv("APP_BASE_URL") || "http://localhost:3000").replace(/\/$/, "");
const autonomousTravelPolicyScopes = getEnv("AGENT_TRAVEL_POLICY_SCOPES") || "mcp:view_travel_policy";
const delegatedBookingScopes = getEnv("DELEGATED_BOOKING_SCOPES") || "mcp:create_booking mcp:view_travel_policy";
const oboRedirectUri = getEnv("OBO_REDIRECT_URI") || new URL("/obo/callback", asgardeoConfig.afterSignInUrl).toString();
const oboResource = getEnv("OBO_RESOURCE");
const oboRequiredMessage = "I need your authorization to perform this action. Please click the Authorize button to grant me access.";
const insufficientPermissionsPattern = /insufficient permissions/i;
const whatsappConfig = {
    token: getEnv("WHATSAPP_TOKEN"),
    phoneNumberId: getEnv("WHATSAPP_PHONE_NUMBER_ID"),
    verifyToken: getEnv("WHATSAPP_VERIFY_TOKEN"),
    appSecret: getEnv("WHATSAPP_APP_SECRET"),
    orgMap: getEnv("WHATSAPP_ORG_MAP"),
    dryRun: getEnv("WHATSAPP_DRY_RUN").toLowerCase() === "true",
};

// WhatsApp is opt-in: without a sender phone number ID its routes are never registered.
const isWhatsAppEnabled = Boolean(whatsappConfig.phoneNumberId);

const whatsappOrgMap: Record<string, string> = (() => {
    if (!isWhatsAppEnabled || !whatsappConfig.orgMap) {
        return {};
    }

    try {
        const parsed: unknown = JSON.parse(whatsappConfig.orgMap);

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            logger.warn("WHATSAPP_ORG_MAP must be a JSON object of phone number to organization ID");

            return {};
        }

        return Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        );
    } catch (error: unknown) {
        logger.error({ err: error }, "Failed to parse WHATSAPP_ORG_MAP");

        return {};
    }
})();

const allowedCorsOrigin = (() => {
    try {
        return new URL(appBaseUrl).origin;
    } catch {
        return appBaseUrl;
    }
})();

type ModelProvider = "gemini" | "openai" | "anthropic" | "deepseek";

async function anthropicFetch(url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    if (init?.body && typeof init.body === "string") {
        try {
            const body = JSON.parse(init.body);
            delete body.top_p;
            return fetch(url, { ...init, body: JSON.stringify(body) });
        } catch { /* fall through */ }
    }
    return fetch(url, init);
}

function createModel() {
    const provider = (getEnv("MODEL_PROVIDER") || "gemini").toLowerCase() as ModelProvider;
    const modelName = getEnv("MODEL_NAME");
    const defaultModelNames: Record<ModelProvider, string> = {
        openai: "gpt-4o-mini",
        anthropic: "claude-sonnet-4-6",
        deepseek: "deepseek-chat",
        gemini: "gemini-3.1-flash-lite",
    };
    const resolvedModel = modelName || defaultModelNames[provider] || defaultModelNames.gemini;

    logger.info({
        provider,
        model: resolvedModel,
    }, "LLM provider initialized");

    switch (provider) {
        case "openai":
            return new ChatOpenAI({
                apiKey: getEnv("OPENAI_API_KEY"),
                model: resolvedModel,
            });
        case "anthropic":
            return new ChatAnthropic({
                apiKey: getEnv("ANTHROPIC_API_KEY"),
                model: resolvedModel,
                temperature: undefined,
                topP: 1,
            });
        case "deepseek":
            return new ChatOpenAI({
                apiKey: getEnv("DEEPSEEK_API_KEY"),
                model: resolvedModel,
                configuration: { baseURL: "https://api.deepseek.com/v1" },
            });
        case "gemini":
        default:
            return new ChatGoogleGenerativeAI({
                apiKey: getEnv("GOOGLE_API_KEY"),
                model: resolvedModel,
            });
    }
}

const modelProvider = (getEnv("MODEL_PROVIDER") || "gemini").toLowerCase() as ModelProvider;
const model = createModel();

const agentPrompt = [
"You are Wayfinder Enterprise's AI assistant for business travel administrators and employees.",
"Help users manage business travel in a friendly, clear, and professional way.",
"You can help with travel policies, employee access, roles, flight options, and bookings.",
"Use the available tools whenever you need information instead of guessing.",
"Respond naturally, like a helpful travel coordinator or concierge, not a technical support system.",
"Keep conversations smooth and conversational. Avoid sounding procedural or overly rigid.",
"Never expose internal system details, technical identifiers, raw JSON, tokens, or implementation concepts to users.",
"When users ask about travel policies, check the current policy before answering or making decisions.",
"If no travel policy exists, continue helping the user normally and treat flights as unrestricted.",
"Before searching for flights, make sure you know the origin, destination, and preferred travel date.",
"If any booking details are missing, ask for all missing details together in one concise follow-up question.",
"When a user wants to book a flight, first identify the correct flight option before proceeding with the booking.",
"If multiple flight options match the request, ask a brief clarifying question instead of making assumptions.",
"When users request policy changes, only update the parts they clearly asked to modify.",
"When inviting employees, make sure an email address is provided before sending an invitation.",
"Acknowledge the user's request naturally before presenting information or results.",
"Present information clearly using markdown, tables, and bullet points when helpful.",
"Never dump raw tool output directly to the user. Summarize and explain information in a human-friendly way.",
"Always try to leave the conversation with a clear next step, recommendation, or question."
].join("\n");

type ChatMessage = {
    role: "user" | "assistant" | "system";
    content: string;
};

type ChatRequest = {
    message?: unknown;
    messages?: unknown;
    mode?: unknown;
    orgId?: unknown;
    orgName?: unknown;
};

type ChatInvocationMode = "agent" | "user";

type ParsedChatRequest = {
    messages: ChatMessage[];
    mode?: ChatInvocationMode;
    orgId?: string;
    orgName?: string;
};

type TravelPolicy = {
    domestic_cabin: string;
    max_flight_price: number;
    price_cap_percent: number;
};

type Flight = {
    id: string;
    from_city: string;
    to_city: string;
    airline: string;
    departure_time: string;
    arrival_time: string;
    duration: string;
    stops: number;
    price: number;
    currency: string;
    cabin: string;
    dates: string;
    tags: string[];
};

type PolicyStatus = "in-policy" | "approval-required" | "out-of-policy";

type SuggestedFlight = Flight & {
    policyStatus: PolicyStatus;
    policyNotes: string[];
};

type BookingSearchCriteria = {
    departureDate?: string;
    from?: string;
    to?: string;
};

type AgentInvokeResult = {
    messages: Array<{ content?: unknown }>;
};

type RunnableAgent = {
    invoke: (input: { messages: ChatMessage[] }) => Promise<AgentInvokeResult>;
};

type AgentRuntime = {
    agent: RunnableAgent;
    client: MultiServerMCPClient;
    tools: ToolWithSchema[];
};

type RootAgentRuntime = {
    /** Returns a valid agent actor token; pass a rejected token to force a re-sign-in. */
    getAgentActorToken: (staleToken?: string) => Promise<string>;
};

type AutonomousRuntimeEntry = {
    expiresAt: number;
    runtime: AgentRuntime;
};

type ReplyChannel = {
    send: (payload: Record<string, unknown>) => boolean;
    isAlive: () => boolean;
};

type PendingDelegation = {
    createdAt: number;
    flightId?: string;
    orgId?: string;
    request: ParsedChatRequest;
    scopes: string;
    reply: ReplyChannel;
};

type WebSocketFrame = {
    opcode: number;
    payload: Buffer<ArrayBufferLike>;
};

const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const JSON_SCHEMA_TYPE_VALUES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

type JsonSchemaObject = {
    [key: string]: unknown;
};

type ToolWithSchema = {
    name?: string;
    schema?: unknown;
    invoke?: (...args: any[]) => Promise<unknown> | unknown;
};

type PermissionTrackingContext = {
    hasInsufficientPermissions: boolean;
    toolName?: string;
};

const permissionTrackingContext = new AsyncLocalStorage<PermissionTrackingContext>();


function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getGeminiSchemaType(schema: JsonSchemaObject): string | undefined {
    const type = schema.type;

    if (typeof type === "string" && JSON_SCHEMA_TYPE_VALUES.has(type)) {
        return type;
    }

    if (Array.isArray(type)) {
        const nullable = type.includes("null");
        const schemaType = type.find((candidate): candidate is string => (
            typeof candidate === "string" &&
            candidate !== "null" &&
            JSON_SCHEMA_TYPE_VALUES.has(candidate)
        ));

        if (schemaType) {
            if (nullable && schema.nullable === undefined) {
                schema.nullable = true;
            }

            return schemaType;
        }
    }

    if (isJsonSchemaObject(schema.properties)) {
        return "object";
    }

    if (isJsonSchemaObject(schema.items)) {
        return "array";
    }

    if (Array.isArray(schema.enum)) {
        return "string";
    }

    return undefined;
}

function sanitizeGeminiSchema(schema: unknown): unknown {
    if (!isJsonSchemaObject(schema)) {
        return schema;
    }

    const type = getGeminiSchemaType(schema);
    const sanitized: JsonSchemaObject = {};

    if (type) {
        sanitized.type = type;
    }

    if (typeof schema.description === "string") {
        sanitized.description = schema.description;
    }

    if (typeof schema.nullable === "boolean") {
        sanitized.nullable = schema.nullable;
    }

    if (type === "string" && typeof schema.format === "string") {
        sanitized.format = schema.format;
    }

    if (type === "string" && Array.isArray(schema.enum)) {
        sanitized.enum = schema.enum.filter((value): value is string => typeof value === "string");
        sanitized.format = "enum";
    }

    if ((type === "number" || type === "integer") && typeof schema.format === "string") {
        sanitized.format = schema.format;
    }

    if (type === "array") {
        sanitized.items = sanitizeGeminiSchema(schema.items);

        if (typeof schema.minItems === "number") {
            sanitized.minItems = schema.minItems;
        }

        if (typeof schema.maxItems === "number") {
            sanitized.maxItems = schema.maxItems;
        }
    }

    if (type === "object") {
        const properties: JsonSchemaObject = {};

        if (isJsonSchemaObject(schema.properties)) {
            for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
                properties[propertyName] = sanitizeGeminiSchema(propertySchema);
            }
        }

        sanitized.properties = properties;

        if (Array.isArray(schema.required)) {
            sanitized.required = schema.required.filter((propertyName): propertyName is string => (
                typeof propertyName === "string" &&
                Object.hasOwn(properties, propertyName)
            ));
        }
    }

    return sanitized;
}

function sanitizeToolSchemasForGemini<T extends ToolWithSchema>(tools: T[]): T[] {
    return tools.map((tool) => {
        if (tool.schema) {
            tool.schema = sanitizeGeminiSchema(tool.schema);
        }

        return tool;
    });
}

function parseChatRequest(payload: string): ParsedChatRequest {

    try {
        const request = JSON.parse(payload) as ChatRequest;
        const orgId = typeof request.orgId === "string" && request.orgId.trim()
            ? request.orgId.trim()
            : undefined;
        const explicitOrgName = typeof request.orgName === "string" && request.orgName.trim()
            ? request.orgName.trim()
            : undefined;
        const mode = request.mode === "agent" || request.mode === "user"
            ? request.mode
            : undefined;

        if (typeof request.message === "string" && request.message.trim()) {
            const messages = [{ role: "user" as const, content: request.message }];

            return {
                messages,
                mode,
                orgId,
                orgName: explicitOrgName,
            };
        }

        if (Array.isArray(request.messages)) {
            const messages = request.messages.filter((message): message is ChatMessage => {
                if (typeof message !== "object" || message === null) {
                    return false;
                }

                const candidate = message as Partial<ChatMessage>;

                return (
                    typeof candidate.content === "string" &&
                    ["user", "assistant", "system"].includes(candidate.role || "")
                );
            });

            if (messages.length > 0) {
                return {
                    messages,
                    mode,
                    orgId,
                    orgName: explicitOrgName,
                };
            }
        }
    } catch {
        if (payload.trim()) {
            return { messages: [{ role: "user", content: payload }] };
        }
    }

    throw new Error("Send a non-empty text message or JSON payload with a `message` field.");
}

function getResponseContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    return JSON.stringify(content);
}

function addContextToFirstUserMessage(messages: ChatMessage[], context: string): ChatMessage[] {
    let contextAdded = false;

    return messages.map((message) => {
        if (contextAdded || message.role !== "user") {
            return message;
        }

        contextAdded = true;

        return {
            ...message,
            content: `${context}\n\n${message.content}`,
        };
    });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const [, payload] = token.split(".");

    if (!payload) {
        return null;
    }

    try {
        return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function getBearerToken(authorization?: string | string[]) {
    const value = Array.isArray(authorization) ? authorization[0] : authorization;

    return value?.startsWith("Bearer ") ? value.slice(7) : "";
}

function getWebSocketProtocolToken(protocolHeader?: string | string[]) {
    const value = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader;
    const protocols = value?.split(",").map((protocol) => protocol.trim()).filter(Boolean) ?? [];
    const bearerIndex = protocols.indexOf("bearer");

    return bearerIndex >= 0 ? protocols[bearerIndex + 1] ?? "" : "";
}

function getTokenOrganizationId(token: string): string {
    const payload = decodeJwtPayload(token);

    return typeof payload?.org_id === "string" ? payload.org_id : "";
}

// Expire tokens a minute early so one cannot lapse mid-request.
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_MS = 3_600_000;

function getTokenExpiryMs(token: string): number {
    const exp = decodeJwtPayload(token)?.exp;

    return typeof exp === "number" ? exp * 1000 : Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
}

function isTokenValid(expiresAt: number): boolean {
    return expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now();
}

// Asgardeo reports both an expired and a superseded actor token as "Invalid token received."
function isRejectedTokenError(error: unknown): boolean {
    return error instanceof Error && /invalid token|invalid_grant|token.*expired/i.test(error.message);
}

async function exchangeOrganizationToken({
    scopes,
    switchingOrganizationId,
    token,
}: {
    scopes: string;
    switchingOrganizationId: string;
    token: string;
}) {
    const credentials = Buffer.from(`${asgardeoConfig.clientId}:${asgardeoConfig.clientSecret}`).toString("base64");
    const response = await fetch(`${asgardeoConfig.baseUrl}/oauth2/token`, {
        body: new URLSearchParams({
            grant_type: "organization_switch",
            scope: scopes,
            switching_organization: switchingOrganizationId,
            token,
        }),
        headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        signal: AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => ({})) as {
        access_token?: string;
        error?: string;
        error_description?: string;
        scope?: string;
    };

    if (!response.ok || !body.access_token) {
        throw new Error(body.error_description ?? body.error ?? "Failed to exchange token for the organization.");
    }

    // Asgardeo silently drops scopes the application is not authorized for, so the
    // granted set can be narrower than what was requested (or empty).
    if (body.scope !== scopes) {
        logger.warn({
            requestedScopes: scopes,
            grantedScopes: body.scope || "(none)",
        }, "Asgardeo granted different scopes than requested");
    }

    return body.access_token;
}



function normalizeDateText(value: string) {
    return value
        .toLowerCase()
        .replace(/\bjanuary\b/g, "jan")
        .replace(/\bfebruary\b/g, "feb")
        .replace(/\bmarch\b/g, "mar")
        .replace(/\bapril\b/g, "apr")
        .replace(/\bjune\b/g, "jun")
        .replace(/\bjuly\b/g, "jul")
        .replace(/\baugust\b/g, "aug")
        .replace(/\bseptember\b/g, "sep")
        .replace(/\boctober\b/g, "oct")
        .replace(/\bnovember\b/g, "nov")
        .replace(/\bdecember\b/g, "dec")
        .replace(/[,]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function flightMatchesDepartureDate(flight: Flight, departureDate?: string) {
    if (!departureDate || /\b(today|tomorrow)\b/i.test(departureDate)) {
        return true;
    }

    return normalizeDateText(flight.dates).includes(normalizeDateText(departureDate));
}

const CABIN_RANK: Record<string, number> = {
    "Economy": 0,
    "Premium Economy": 1,
    "Business": 2,
    "First Class": 3,
};

function evaluateFlightPolicy(flight: Flight, policy: TravelPolicy | null): { notes: string[]; status: PolicyStatus } {
    if (!policy) {
        return { notes: [], status: "in-policy" };
    }

    const notes: string[] = [];
    const priceCap = policy.max_flight_price;
    const approvalCap = priceCap * (1 + policy.price_cap_percent / 100);
    const allowedCabinRank = CABIN_RANK[policy.domestic_cabin] ?? 0;
    const flightCabinRank = CABIN_RANK[flight.cabin] ?? 0;
    const priceOver = flight.price > priceCap;
    const priceWayOver = flight.price > approvalCap;
    const cabinOver = flightCabinRank > allowedCabinRank;
    const cabinWayOver = flightCabinRank > allowedCabinRank + 1;

    if (priceWayOver) notes.push(`price exceeds $${approvalCap.toFixed(0)} approval limit`);
    else if (priceOver) notes.push(`price exceeds $${priceCap} cap`);

    if (cabinWayOver) notes.push(`${flight.cabin} is not allowed by ${policy.domestic_cabin} policy`);
    else if (cabinOver) notes.push(`${flight.cabin} is above ${policy.domestic_cabin}`);

    if (priceWayOver || cabinWayOver) return { notes, status: "out-of-policy" };
    if (priceOver || cabinOver) return { notes, status: "approval-required" };

    return { notes: [], status: "in-policy" };
}


const pendingDelegations = new Map<string, PendingDelegation>();

function buildOboAuthorizeUrl(state: string, request: ParsedChatRequest, scopes = delegatedBookingScopes) {
    const params = new URLSearchParams({
        client_id: asgardeoConfig.clientId,
        redirect_uri: oboRedirectUri,
        requested_actor: agentConfig.agentID,
        response_type: "code",
        scope: scopes,
        state,
    });

    if (oboResource) {
        params.set("resource", oboResource);
    }

    // org / orgId / fidp route a user from the ROOT endpoint into their sub-organization;
    // an organization-qualified base URL is already there and would fail on them.
    if (!isOrganizationQualifiedBaseUrl) {
        if (request.orgName) {
            params.set("org", request.orgName);
        }

        if (request.orgId) {
            params.set("orgId", request.orgId);
        }

        params.set("fidp", "OrganizationSSO");
    }

    return `${asgardeoConfig.baseUrl}/oauth2/authorize?${params.toString()}`;
}

async function exchangeOboAuthorizationCode(code: string, agentActorToken: string) {
    logger.info("Exchanging OBO authorization code for delegated access token");

    const response = await fetch(`${asgardeoConfig.baseUrl}/oauth2/token`, {
        body: new URLSearchParams({
            actor_token: agentActorToken,
            client_id: asgardeoConfig.clientId,
            // A public client has no secret, and Asgardeo rejects an empty one outright.
            ...(asgardeoConfig.clientSecret ? { client_secret: asgardeoConfig.clientSecret } : {}),
            code,
            grant_type: "authorization_code",
            redirect_uri: oboRedirectUri,
            tokenBindingId: randomUUID(),
        }),
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        signal: AbortSignal.timeout(30000),
    });

    logger.info({ statusCode: response.status }, "OBO token exchange response received");

    const body = await response.json().catch(() => ({})) as {
        access_token?: string;
        error?: string;
        error_description?: string;
    };

    if (!response.ok || !body.access_token) {
        throw new Error(body.error_description ?? body.error ?? "Failed to exchange the OBO authorization code.");
    }

    // log OBO token payload for debugging purposes
    const payload = decodeJwtPayload(body.access_token);
    console.log("Decoded OBO token payload:", payload);
    logger.debug({ oboTokenPayload: payload }, "Decoded OBO token payload");

    return body.access_token;
}

function createWebSocketAcceptKey(key: string): string {
    return createHash("sha1")
        .update(`${key}${WEB_SOCKET_GUID}`)
        .digest("base64");
}

function encodeWebSocketFrame(payload: string, opcode = 0x1): Buffer {
    const payloadBuffer = Buffer.from(payload);
    const payloadLength = payloadBuffer.length;

    if (payloadLength <= 125) {
        return Buffer.concat([
            Buffer.from([0x80 | opcode, payloadLength]),
            payloadBuffer,
        ]);
    }

    if (payloadLength <= 65535) {
        const header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(payloadLength, 2);

        return Buffer.concat([header, payloadBuffer]);
    }

    const header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);

    return Buffer.concat([header, payloadBuffer]);
}

function parseWebSocketFrame(
    buffer: Buffer<ArrayBufferLike>
): { frame: WebSocketFrame; remaining: Buffer<ArrayBufferLike> } | null {
    if (buffer.length < 2) {
        return null;
    }

    const opcode = buffer[0] & 0x0f;
    const isMasked = (buffer[1] & 0x80) === 0x80;
    let payloadLength = buffer[1] & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
        if (buffer.length < offset + 2) {
            return null;
        }

        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
    } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) {
            return null;
        }

        const extendedPayloadLength = buffer.readBigUInt64BE(offset);

        if (extendedPayloadLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("WebSocket message is too large.");
        }

        payloadLength = Number(extendedPayloadLength);
        offset += 8;
    }

    const maskOffset = offset;

    if (isMasked) {
        offset += 4;
    }

    if (buffer.length < offset + payloadLength) {
        return null;
    }

    const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));

    if (isMasked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);

        for (let index = 0; index < payload.length; index += 1) {
            payload[index] = payload[index] ^ mask[index % 4];
        }
    }

    return {
        frame: { opcode, payload },
        remaining: buffer.subarray(offset + payloadLength),
    };
}

function isSocketWritable(socket: Duplex) {
    return !socket.destroyed && !socket.writableEnded;
}

function writeFrame(socket: Duplex, frame: Buffer) {
    if (!isSocketWritable(socket)) {
        return false;
    }

    try {
        socket.write(frame);

        return true;
    } catch (error) {
        logger.warn({ err: error }, "Unable to write WebSocket frame");

        return false;
    }
}

function sendJson(socket: Duplex, payload: Record<string, unknown>) {
    return writeFrame(socket, encodeWebSocketFrame(JSON.stringify(payload)));
}

function closeWebSocket(socket: Duplex) {
    if (isSocketWritable(socket)) {
        try {
            socket.end(encodeWebSocketFrame("", 0x8));
        } catch {
            socket.destroy();
        }
    }
}

const makeSocketReply = (socket: Duplex): ReplyChannel => ({
    send: (payload) => sendJson(socket, payload),
    isAlive: () => isSocketWritable(socket),
});

function redactSecret(value: string) {
    if (!value) {
        return "";
    }

    if (value.length <= 6) {
        return "***";
    }

    return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function includeClientSecretInAgentAuthorizeRequest(client: AsgardeoJavaScriptClient) {
    if (getEnv("INCLUDE_CLIENT_SECRET_IN_AUTHORIZE") === "false") {
        logger.warn("Skipping client_secret injection for the agent authorize request");

        return;
    }

    if (!asgardeoConfig.clientSecret) {
        return;
    }

    const sdkClient = client as unknown as {
        auth?: {
            getSignInUrl?: (requestConfig?: Record<string, unknown>, userId?: string) => Promise<string>;
        };
    };
    const getSignInUrl = sdkClient.auth?.getSignInUrl?.bind(sdkClient.auth);

    if (!getSignInUrl || !sdkClient.auth) {
        return;
    }

    sdkClient.auth.getSignInUrl = async (requestConfig = {}, userId?: string) => {
        const signInUrl = await getSignInUrl({
            ...requestConfig,
            client_secret: requestConfig.client_secret ?? "__include_client_secret__",
        }, userId);

        return signInUrl;
    };
}

function validateAgentConfiguration() {
    const providerApiKeyEnvVar: Record<ModelProvider, string> = {
        gemini: "GOOGLE_API_KEY",
        openai: "OPENAI_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
        deepseek: "DEEPSEEK_API_KEY",
    };
    const apiKeyEnvVar = providerApiKeyEnvVar[modelProvider] ?? "GOOGLE_API_KEY";

    // CLIENT_SECRET is deliberately absent: a sub-organization app is typically public.
    const requiredValues: Record<string, string | undefined> = {
        ASGARDEO_BASE_URL: asgardeoConfig.baseUrl,
        CLIENT_ID: asgardeoConfig.clientId,
        REDIRECT_URI: asgardeoConfig.afterSignInUrl,
        AGENT_ID: agentConfig.agentID,
        AGENT_SECRET: agentConfig.agentSecret,
        [apiKeyEnvVar]: getEnv(apiKeyEnvVar),
    };
    const missingValues = Object.entries(requiredValues)
        .filter(([, value]) => !value)
        .map(([name]) => name);

    if (missingValues.length > 0) {
        throw new Error(`Missing required AI agent environment values: ${missingValues.join(", ")}`);
    }

    if (!asgardeoConfig.clientSecret) {
        logger.warn({
            clientId: redactSecret(asgardeoConfig.clientId),
        }, "CLIENT_SECRET is not set - treating the application as a public client");
    }

    if (asgardeoConfig.baseUrl.includes("<") || asgardeoConfig.baseUrl.includes(">")) {
        throw new Error("ASGARDEO_BASE_URL still contains a placeholder value.");
    }

    try {
        new URL(asgardeoConfig.afterSignInUrl);
    } catch {
        throw new Error("REDIRECT_URI must be an absolute URL, for example http://localhost:8791.");
    }
}

function writeCorsHeaders(response: ServerResponse) {
    response.setHeader("Access-Control-Allow-Origin", allowedCorsOrigin);
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Vary", "Origin");
}

function writeHttpJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>) {
    writeCorsHeaders(response);
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}

function writeHttpHtml(response: ServerResponse, statusCode: number, body: string) {
    response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
}

async function readJsonRequestBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
        return undefined;
    }

    const body = Buffer.concat(chunks).toString("utf8");

    return body ? JSON.parse(body) : undefined;
}

const WHATSAPP_GRAPH_API_VERSION = "v21.0";
const WHATSAPP_HANDLED_MESSAGE_LIMIT = 500;

// Meta redelivers webhooks, so track handled message IDs, evicting the oldest ones.
const whatsappHandledMessageIds = new Set<string>();

function rememberWhatsAppMessageId(messageId: string): boolean {
    if (whatsappHandledMessageIds.has(messageId)) {
        return false;
    }

    whatsappHandledMessageIds.add(messageId);

    while (whatsappHandledMessageIds.size > WHATSAPP_HANDLED_MESSAGE_LIMIT) {
        const oldest = whatsappHandledMessageIds.values().next();

        if (oldest.done) {
            break;
        }

        whatsappHandledMessageIds.delete(oldest.value);
    }

    return true;
}

// WhatsApp sends no history with a webhook, so the conversation is kept server-side.
const WHATSAPP_HISTORY_MESSAGE_LIMIT = 20;
const WHATSAPP_HISTORY_IDLE_MS = 30 * 60_000;
const WHATSAPP_CONVERSATION_LIMIT = 200;

type WhatsAppConversation = {
    messages: ChatMessage[];
    updatedAt: number;
};

const whatsappConversations = new Map<string, WhatsAppConversation>();

function getWhatsAppConversation(from: string): WhatsAppConversation {
    const existing = whatsappConversations.get(from);

    // A conversation gone quiet is a new request, and stale results would mislead the model.
    if (existing && Date.now() - existing.updatedAt <= WHATSAPP_HISTORY_IDLE_MS) {
        return existing;
    }

    const conversation: WhatsAppConversation = { messages: [], updatedAt: Date.now() };

    whatsappConversations.set(from, conversation);

    while (whatsappConversations.size > WHATSAPP_CONVERSATION_LIMIT) {
        const oldest = whatsappConversations.keys().next();

        if (oldest.done || oldest.value === from) {
            break;
        }

        whatsappConversations.delete(oldest.value);
    }

    return conversation;
}

function rememberWhatsAppMessage(from: string, message: ChatMessage): ChatMessage[] {
    const conversation = getWhatsAppConversation(from);

    conversation.messages.push(message);
    conversation.updatedAt = Date.now();

    if (conversation.messages.length > WHATSAPP_HISTORY_MESSAGE_LIMIT) {
        conversation.messages = conversation.messages.slice(-WHATSAPP_HISTORY_MESSAGE_LIMIT);
    }

    // Snapshot the history: a pending delegation replays its copy long after this turn.
    return [...conversation.messages];
}

async function sendWhatsAppText(to: string, body: string): Promise<void> {
    if (whatsappConfig.dryRun) {
        logger.info({ to, body }, "WhatsApp DRY RUN outbound message");

        return;
    }

    const response = await fetch(
        `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${whatsappConfig.phoneNumberId}/messages`,
        {
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to,
                type: "text",
                // preview_url renders the authorization link as a tappable card.
                text: { body, preview_url: true },
            }),
            headers: {
                "Authorization": `Bearer ${whatsappConfig.token}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        }
    );

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");

        logger.error({
            status: response.status,
            statusText: response.statusText,
            body: errorBody.slice(0, 500),
            to,
        }, "Failed to send WhatsApp message");

        return;
    }

    logger.info({ to, bodyLength: body.length }, "WhatsApp message sent");
}

// The signature covers the exact bytes Meta sent, which readJsonRequestBody discards.
async function readRawRequestBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
}

function isValidWhatsAppSignature(rawBody: Buffer, signatureHeader: string | string[] | undefined): boolean {
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

    if (!signature || !signature.startsWith("sha256=")) {
        return false;
    }

    const expected = Buffer.from(
        `sha256=${createHmac("sha256", whatsappConfig.appSecret).update(rawBody).digest("hex")}`,
        "utf8"
    );
    const received = Buffer.from(signature, "utf8");

    if (expected.length !== received.length) {
        return false;
    }

    return timingSafeEqual(expected, received);
}

function handleWhatsAppVerification(url: URL, response: ServerResponse) {
    const mode = url.searchParams.get("hub.mode");
    const verifyToken = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && whatsappConfig.verifyToken && verifyToken === whatsappConfig.verifyToken) {
        logger.info("WhatsApp webhook verification succeeded");
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(challenge || "");

        return;
    }

    logger.warn({ mode }, "WhatsApp webhook verification failed");
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
}

type WhatsAppInboundTextMessage = {
    id: string;
    from: string;
    text: string;
};

type WhatsAppInboundMessage =
    | { kind: "text"; message: WhatsAppInboundTextMessage }
    | { kind: "unsupported"; id: string; from: string }
    | { kind: "ignore" };

// Meta posts status callbacks to the same URL, so payloads without messages[] are ignored.
function parseWhatsAppInboundMessage(payload: unknown): WhatsAppInboundMessage {
    const entries = (payload as { entry?: unknown })?.entry;

    if (!Array.isArray(entries)) {
        return { kind: "ignore" };
    }

    for (const entry of entries) {
        const changes = (entry as { changes?: unknown })?.changes;

        if (!Array.isArray(changes)) {
            continue;
        }

        for (const change of changes) {
            const value = (change as { value?: unknown })?.value as { messages?: unknown } | undefined;
            const messages = value?.messages;

            if (!Array.isArray(messages) || messages.length === 0) {
                continue;
            }

            const message = messages[0] as {
                id?: unknown;
                from?: unknown;
                type?: unknown;
                text?: { body?: unknown };
            };
            const id = typeof message.id === "string" ? message.id : "";
            const from = typeof message.from === "string" ? message.from : "";

            if (!id || !from) {
                continue;
            }

            if (message.type !== "text" || typeof message.text?.body !== "string") {
                return { kind: "unsupported", id, from };
            }

            return { kind: "text", message: { id, from, text: message.text.body } };
        }
    }

    return { kind: "ignore" };
}

function isInsufficientPermissionsResponse(value: unknown): boolean {
    if (typeof value === "string") {
        return insufficientPermissionsPattern.test(value);
    }

    if (value instanceof Error) {
        return insufficientPermissionsPattern.test(value.message);
    }

    try {
        return insufficientPermissionsPattern.test(JSON.stringify(value));
    } catch {
        return false;
    }
}

function markInsufficientPermissions(toolName?: string) {
    const context = permissionTrackingContext.getStore();

    if (!context) {
        return;
    }

    context.hasInsufficientPermissions = true;
    context.toolName = toolName;
}

function wrapMcpToolsForPermissionTracking<T extends ToolWithSchema>(tools: T[]): T[] {
    return tools.map((tool) => {
        const originalInvoke = tool.invoke?.bind(tool);

        if (!originalInvoke) {
            return tool;
        }

        tool.invoke = async (...args: unknown[]) => {
            try {
                const result = await originalInvoke(...args);

                if (isInsufficientPermissionsResponse(result)) {
                    markInsufficientPermissions(tool.name);
                    logger.warn({ tool: tool.name }, "MCP tool reported insufficient permissions");
                }

                return result;
            } catch (error) {
                if (isInsufficientPermissionsResponse(error)) {
                    markInsufficientPermissions(tool.name);
                    logger.warn({ tool: tool.name }, "MCP tool reported insufficient permissions");
                } else {
                    // Tool failures otherwise reach only the LLM, never the logs.
                    logger.error({
                        tool: tool.name,
                        err: error instanceof Error ? error.message : String(error),
                    }, "MCP tool invocation failed");
                }

                throw error;
            }
        };

        return tool;
    });
}

async function createMcpAgent(authorization: string, mode: ChatInvocationMode): Promise<AgentRuntime> {
    const client = new MultiServerMCPClient({
        travel: {
            transport: "http",
            url: process.env.MCP_SERVER_URL || "http://localhost:8001/mcp",
            headers: {
                Authorization: authorization,
            },
        },
    });

    const rawTools = await client.getTools();
    const sanitizedTools = modelProvider === "gemini" ? sanitizeToolSchemasForGemini(rawTools) : rawTools;
    const tools = wrapMcpToolsForPermissionTracking(sanitizedTools);
    logger.info({
        mode,
        tools: tools.map((tool) => tool.name).filter(Boolean),
    }, "Loaded MCP tools");

    const agent = createReactAgent({
        llm: model,
        tools: tools,
        prompt: agentPrompt,
    }) as RunnableAgent;

    return { agent, client, tools };
}

async function getAutonomousAgentOrganizationToken(rootRuntime: RootAgentRuntime, organizationId: string) {
    logger.info({
        organizationId,
        tokenType: "autonomous-agent",
        scopes: autonomousTravelPolicyScopes,
    }, `[org: ${organizationId}] Obtaining autonomous agent organization-scoped token`);

    const exchange = (rootAgentToken: string) => exchangeOrganizationToken({
        scopes: autonomousTravelPolicyScopes,
        switchingOrganizationId: organizationId,
        token: rootAgentToken,
    });

    const rootAgentToken = await rootRuntime.getAgentActorToken();

    // organization_switch into the organization the token already carries is rejected.
    if (getTokenOrganizationId(rootAgentToken) === organizationId) {
        logger.info({
            organizationId,
            tokenType: "autonomous-agent",
        }, `[org: ${organizationId}] Agent token is already scoped to the organization, skipping exchange`);

        return rootAgentToken;
    }

    let token: string;

    try {
        token = await exchange(rootAgentToken);
    } catch (error: unknown) {
        if (!isRejectedTokenError(error)) {
            throw error;
        }

        logger.warn({
            organizationId,
            err: error,
        }, `[org: ${organizationId}] Agent actor token was rejected - signing in again and retrying once`);

        token = await exchange(await rootRuntime.getAgentActorToken(rootAgentToken));
    }

    logger.info({ organizationId, tokenType: "autonomous-agent" }, `[org: ${organizationId}] Autonomous agent organization-scoped token obtained`);

    return token;
}

async function getDelegatedUserOrganizationToken(accessToken: string, orgId?: string, scopes = delegatedBookingScopes) {
    if (!orgId) {
        return accessToken;
    }

    if (getTokenOrganizationId(accessToken) === orgId) {
        logger.info({ organizationId: orgId }, `[org: ${orgId}] Delegated token already scoped to organization, skipping exchange`);

        return accessToken;
    }

    logger.info({
        organizationId: orgId,
        tokenType: "delegated-user",
        scopes,
    }, `[org: ${orgId}] Obtaining delegated user organization-scoped token`);

    const token = await exchangeOrganizationToken({
        scopes,
        switchingOrganizationId: orgId,
        token: accessToken,
    });

    logger.info({ organizationId: orgId, tokenType: "delegated-user" }, `[org: ${orgId}] Delegated user organization-scoped token obtained`);

    return token;
}

async function createRootAgentRuntime(): Promise<RootAgentRuntime> {
    logger.info("Starting Wayfinder Enterprise AI agent with Asgardeo and LangChain");
    validateAgentConfiguration();

    const asgardeoJavaScriptClient = new AsgardeoJavaScriptClient(asgardeoConfig);
    includeClientSecretInAgentAuthorizeRequest(asgardeoJavaScriptClient);

    // Agent sign-in is single-session, so mint through a single-flight cache to stop
    // concurrent requests invalidating each other's token.
    let pendingToken: Promise<{ expiresAt: number; token: string }> | null = null;

    const signIn = () => {
        logger.info({
            baseUrl: asgardeoConfig.baseUrl,
            clientId: redactSecret(asgardeoConfig.clientId),
            redirectUri: asgardeoConfig.afterSignInUrl,
            agentId: redactSecret(agentConfig.agentID),
        }, "Requesting Asgardeo agent token");

        const promise = (async () => {
            const agentToken = await asgardeoJavaScriptClient.getAgentToken(agentConfig);
            const expiresAt = getTokenExpiryMs(agentToken.accessToken);

            logger.info({
                agentId: redactSecret(agentConfig.agentID),
                expiresAt: new Date(expiresAt).toISOString(),
            }, "Asgardeo agent token obtained");

            return { expiresAt, token: agentToken.accessToken };
        })();

        pendingToken = promise;
        promise.catch(() => {
            // Never leave a rejected sign-in cached, or the agent stays broken until restart.
            if (pendingToken === promise) {
                pendingToken = null;
            }
        });

        return promise;
    };

    const getAgentActorToken = async (staleToken?: string): Promise<string> => {
        const inFlight = pendingToken;

        if (inFlight) {
            const current = await inFlight;

            if (isTokenValid(current.expiresAt) && current.token !== staleToken) {
                return current.token;
            }

            // Another caller may have re-signed-in while awaiting - or failed and cleared it.
            const refreshed = pendingToken;

            if (refreshed && refreshed !== inFlight) {
                return (await refreshed).token;
            }
        }

        return (await signIn()).token;
    };

    // Sign in eagerly so bad credentials fail startup, not the first chat message.
    await getAgentActorToken();

    return { getAgentActorToken };
}

async function createAutonomousAgentRuntime(
    rootRuntime: RootAgentRuntime,
    organizationId: string,
): Promise<AutonomousRuntimeEntry> {
    const organizationAccessToken = await getAutonomousAgentOrganizationToken(rootRuntime, organizationId);
    const runtime = await createMcpAgent(`Bearer ${organizationAccessToken}`, "agent");

    // MultiServerMCPClient fixes its Authorization header at construction, so the runtime
    // lives only as long as the token it was built with.
    return { expiresAt: getTokenExpiryMs(organizationAccessToken), runtime };
}


async function invokeWithDelegatedUserAccess(request: ParsedChatRequest, delegatedAccessToken: string) {
    logger.info({
        hasOrgId: Boolean(request.orgId),
        messageCount: request.messages.length,
    }, "Starting delegated user agent invocation");

    const accessToken = await getDelegatedUserOrganizationToken(delegatedAccessToken, request.orgId);
    logger.info("Delegated organization access token is ready");

    const runtime = await createMcpAgent(`Bearer ${accessToken}`, "user");
    logger.info("Delegated MCP agent runtime is ready");

    try {
        const messages = request.messages;

        logger.info("Invoking delegated MCP agent");
        const result = await withTimeout(
            runtime.agent.invoke({ messages }),
            60000,
            "Delegated MCP agent invocation"
        );
        logger.info("Delegated MCP agent invocation completed");

        return getResponseContent(result.messages.at(-1)?.content);
    } finally {
        await runtime.client.close();
        logger.info("Delegated MCP client closed");
    }
}

function registerPendingDelegation(
    reply: ReplyChannel,
    request: ParsedChatRequest,
    flightId?: string,
    scopes = delegatedBookingScopes
) {
    const state = randomUUID();

    pendingDelegations.set(state, {
        createdAt: Date.now(),
        flightId,
        orgId: request.orgId,
        request,
        scopes,
        reply,
    });

    return {
        authorizationRequestId: state,
        authorizationUrl: buildOboAuthorizeUrl(state, request, scopes),
        state,
    };
}

function removeExpiredPendingDelegations() {
    const expiresBefore = Date.now() - 10 * 60 * 1000;

    for (const [state, pending] of pendingDelegations) {
        if (pending.createdAt < expiresBefore) {
            pendingDelegations.delete(state);
        }
    }
}

async function handleOboAuthorizeUrlRequest(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "OPTIONS") {
        writeCorsHeaders(response);
        response.writeHead(204);
        response.end();

        return;
    }

    if (request.method !== "POST") {
        writeHttpJson(response, 405, { error: "Method not allowed" });

        return;
    }

    removeExpiredPendingDelegations();

    let body: unknown;

    try {
        body = await readJsonRequestBody(request);
    } catch {
        writeHttpJson(response, 400, { error: "Invalid JSON body." });

        return;
    }

    const authorizationRequestId = typeof body === "object" && body !== null
        ? (body as { authorizationRequestId?: unknown }).authorizationRequestId
        : undefined;
    const state = typeof authorizationRequestId === "string" ? authorizationRequestId.trim() : "";

    if (!state) {
        writeHttpJson(response, 400, { error: "authorizationRequestId is required." });

        return;
    }

    const pending = pendingDelegations.get(state);

    if (!pending) {
        writeHttpJson(response, 404, { error: "Authorization request not found or expired." });

        return;
    }

    const callerToken = getBearerToken(request.headers.authorization);
    const callerOrgId = getTokenOrganizationId(callerToken);

    if (!callerToken || !callerOrgId || (pending.orgId && pending.orgId !== callerOrgId)) {
        writeHttpJson(response, 401, { error: "Unauthorized." });

        return;
    }

    writeHttpJson(response, 200, {
        authorizationUrl: buildOboAuthorizeUrl(state, pending.request, pending.scopes),
    });
}

async function handleOboCallback(url: URL, response: ServerResponse, agentActorToken?: string) {
    removeExpiredPendingDelegations();

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    if (error) {
        writeHttpHtml(response, 400, `<p>Authorization failed: ${errorDescription || error}</p>`);
        return;
    }

    if (!code || !state) {
        writeHttpHtml(response, 400, "<p>Missing authorization code or state.</p>");
        return;
    }

    if (!agentActorToken) {
        writeHttpHtml(response, 500, "<p>The agent actor token is not available.</p>");
        return;
    }

    const pending = pendingDelegations.get(state);

    if (!pending) {
        writeHttpHtml(response, 410, "<p>This authorization request has expired. Please retry the action from the chat.</p>");
        return;
    }

    pendingDelegations.delete(state);
    writeHttpHtml(response, 200, "<p>Authorization complete. You can close this tab and return to Wayfinder.</p>");

    try {
        logger.info({
            hasPendingSocket: pending.reply.isAlive(),
            messageCount: pending.request.messages.length,
        }, "Completing delegated authorization callback");

        const delegatedAccessToken = await exchangeOboAuthorizationCode(code, agentActorToken);
        logger.info("Delegated access token received from OBO callback");

        const responseMessage = await invokeWithDelegatedUserAccess(pending.request, delegatedAccessToken);
        logger.info({
            responseLength: responseMessage.length,
            socketWritable: pending.reply.isAlive(),
        }, "Sending delegated agent response over WebSocket");

        const sent = pending.reply.send({
            type: "response",
            message: responseMessage,
        });
        logger.info({ sent }, "Delegated agent WebSocket response send completed");
    } catch (callbackError) {
        logger.error({ err: callbackError }, "Failed to complete delegated authorization callback");
        pending.reply.send({
            type: "error",
            message: "I couldn't complete the authorization. Please try approving the action again.",
        });
    }
}

async function handleChatTurn(params: {
    chatRequest: ParsedChatRequest;
    orgId: string;
    reply: ReplyChannel;
    isCancelled: () => boolean;
    markCancelled: () => void;
    getAutonomousRuntime: (orgId: string) => Promise<AgentRuntime>;
    logger: ReturnType<typeof createLogger>;
}): Promise<void> {
    const { chatRequest, orgId, reply, isCancelled, markCancelled, getAutonomousRuntime, logger: messageLogger } = params;

    const llmMessages = addContextToFirstUserMessage(
        chatRequest.messages,
        `Authenticated organization ID for this chat: ${orgId}`
    );

    if (!reply.send({ type: "processing" })) {
        markCancelled();
        return;
    }

    messageLogger.info("Processing chat message");

    let responseMessage: string;
    const permissionTracking: PermissionTrackingContext = {
        hasInsufficientPermissions: false,
    };

    try {
        const autonomousRuntime = await getAutonomousRuntime(orgId);
        const result = await permissionTrackingContext.run(
            permissionTracking,
            () => autonomousRuntime.agent.invoke({ messages: llmMessages })
        );

        responseMessage = getResponseContent(
            result.messages.at(-1)?.content
        );
    } catch (error) {
        if (isInsufficientPermissionsResponse(error)) {
            markInsufficientPermissions();
            permissionTracking.hasInsufficientPermissions = true;
        }

        if (permissionTracking.hasInsufficientPermissions) {
            const { authorizationRequestId } = registerPendingDelegation(
                reply,
                chatRequest,
                undefined,
                delegatedBookingScopes
            );

            reply.send({
                type: "obo_required",
                message: oboRequiredMessage,
                authorizationRequestId,
            });
            messageLogger.info({
                authorizationRequestId,
                toolName: permissionTracking.toolName,
            }, "Delegated authorization required after MCP permission error");

            return;
        }

        throw error;
    }

    if (isCancelled()) {
        return;
    }

    if (permissionTracking.hasInsufficientPermissions || isInsufficientPermissionsResponse(responseMessage)) {
        const { authorizationRequestId } = registerPendingDelegation(
            reply,
            chatRequest,
            undefined,
            delegatedBookingScopes
        );

        reply.send({
            type: "obo_required",
            message: oboRequiredMessage,
            authorizationRequestId,
        });
        messageLogger.info({
            authorizationRequestId,
            toolName: permissionTracking.toolName,
        }, "Delegated authorization required after MCP permission response");

        return;
    }

    reply.send({
        type: "response",
        message: responseMessage,
    });
    messageLogger.info({ responseLength: responseMessage.length }, "Chat message processed");
}

async function handleWhatsAppTurn(
    message: WhatsAppInboundTextMessage,
    getAutonomousRuntime: (orgId: string) => Promise<AgentRuntime>,
    messageLogger: ReturnType<typeof createLogger>
): Promise<void> {
    const from = message.from;
    // Map lookup only: an org ID from the payload would let any sender read another company's data.
    const orgId = whatsappOrgMap[from];

    if (!orgId) {
        messageLogger.warn("WhatsApp message from an unmapped number");
        await sendWhatsAppText(from, "This number isn't registered");

        return;
    }

    const chatRequest: ParsedChatRequest = {
        messages: rememberWhatsAppMessage(from, { role: "user", content: message.text }),
        orgId,
    };

    const reply: ReplyChannel = {
        send: (payload) => {
            if (payload.type === "processing") {
                return true;
            }

            const text = String(payload.message ?? "");

            if (payload.type === "obo_required") {
                const authorizeUrl = buildOboAuthorizeUrl(
                    String(payload.authorizationRequestId),
                    chatRequest,
                    delegatedBookingScopes
                );

                // The link is a one-off, so keep it out of the history the model sees.
                rememberWhatsAppMessage(from, { role: "assistant", content: text });
                void sendWhatsAppText(from, `${text}\n\n${authorizeUrl}`);

                return true;
            }

            // Errors are not part of the conversation the model should reason about.
            if (payload.type !== "error") {
                rememberWhatsAppMessage(from, { role: "assistant", content: text });
            }

            void sendWhatsAppText(from, text);

            return true;
        },
        // WhatsApp has no persistent connection to keep alive or cancel.
        isAlive: () => true,
    };

    await handleChatTurn({
        chatRequest,
        orgId,
        reply,
        isCancelled: () => false,
        markCancelled: () => {},
        getAutonomousRuntime,
        logger: messageLogger,
    });
}

async function handleWhatsAppWebhook(
    request: IncomingMessage,
    response: ServerResponse,
    getAutonomousRuntime: (orgId: string) => Promise<AgentRuntime>,
    requestLogger: ReturnType<typeof createLogger>
): Promise<void> {
    const rawBody = await readRawRequestBody(request);

    if (whatsappConfig.appSecret) {
        if (!isValidWhatsAppSignature(rawBody, request.headers["x-hub-signature-256"])) {
            requestLogger.warn("Rejected WhatsApp webhook with an invalid signature");
            response.writeHead(401, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: "Invalid signature." }));

            return;
        }
    } else {
        requestLogger.warn("WHATSAPP_APP_SECRET is not set; skipping WhatsApp webhook signature verification");
    }

    let payload: unknown;

    try {
        payload = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : undefined;
    } catch (error: unknown) {
        requestLogger.warn({ err: error }, "Received an unparsable WhatsApp webhook body");
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Invalid JSON." }));

        return;
    }

    const inbound = parseWhatsAppInboundMessage(payload);

    if (inbound.kind === "ignore") {
        requestLogger.debug("Ignoring WhatsApp webhook event without messages");
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "ignored" }));

        return;
    }

    const messageId = inbound.kind === "text" ? inbound.message.id : inbound.id;
    const from = inbound.kind === "text" ? inbound.message.from : inbound.from;

    if (!rememberWhatsAppMessageId(messageId)) {
        requestLogger.info({ messageId }, "Ignoring duplicate WhatsApp message");
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "duplicate" }));

        return;
    }

    // Meta retries slow webhooks, duplicating bookings, so acknowledge before processing.
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "received" }));

    const messageLogger = requestLogger.child({ channel: "whatsapp", messageId });

    void (async () => {
        try {
            if (inbound.kind === "unsupported") {
                messageLogger.info("Received an unsupported WhatsApp message type");
                await sendWhatsAppText(from, "I can only handle text messages");

                return;
            }

            await handleWhatsAppTurn(inbound.message, getAutonomousRuntime, messageLogger);
        } catch (error: unknown) {
            messageLogger.error({ err: error }, "Error handling WhatsApp message");

            try {
                await sendWhatsAppText(from, "Sorry, something went wrong while handling your message.");
            } catch (sendError: unknown) {
                messageLogger.error({ err: sendError }, "Failed to send WhatsApp error message");
            }
        }
    })();
}

async function runAgentServer() {
    const rootRuntime = await createRootAgentRuntime();
    const autonomousRuntimePromises = new Map<string, Promise<AutonomousRuntimeEntry>>();
    const port = Number(process.env.PORT || process.env.AGENT_PORT || 8791);
    const host = process.env.HOST || "localhost";

    const startAutonomousRuntime = (organizationId: string) => {
        const promise = createAutonomousAgentRuntime(rootRuntime, organizationId);

        autonomousRuntimePromises.set(organizationId, promise);
        promise.catch(() => {
            // A cached rejection would pin this organization to the same failure until restart.
            if (autonomousRuntimePromises.get(organizationId) === promise) {
                autonomousRuntimePromises.delete(organizationId);
            }
        });

        return promise;
    };

    const getAutonomousRuntime = async (organizationId: string): Promise<AgentRuntime> => {
        const cached = autonomousRuntimePromises.get(organizationId);

        if (cached) {
            const entry = await cached;

            if (isTokenValid(entry.expiresAt)) {
                return entry.runtime;
            }

            // The token has lapsed: drop the runtime and close its client so nothing leaks.
            if (autonomousRuntimePromises.get(organizationId) === cached) {
                autonomousRuntimePromises.delete(organizationId);
                logger.info({ organizationId }, `[org: ${organizationId}] Autonomous runtime token expired - rebuilding`);
                void entry.runtime.client.close().catch((error: unknown) => {
                    logger.warn({ organizationId, err: error }, "Failed to close the expired MCP client");
                });
            }
        }

        const entry = await (autonomousRuntimePromises.get(organizationId) ?? startAutonomousRuntime(organizationId));

        return entry.runtime;
    };

    const server = createServer(async (request, response) => {
        const requestId = randomUUID();
        const startedAt = performance.now();
        const requestLogger = logger.child({
            requestId,
            method: request.method,
            path: request.url,
        });

        response.setHeader("X-Request-Id", requestId);
        response.on("finish", () => {
            requestLogger.info({
                statusCode: response.statusCode,
                durationMs: Number((performance.now() - startedAt).toFixed(1)),
            }, "HTTP request completed");
        });
        requestLogger.info("HTTP request started");

        const url = new URL(request.url || "/", `http://${request.headers.host || host}`);

        if (url.pathname === "/obo/callback") {
            const agentActorToken = await rootRuntime.getAgentActorToken().catch((error: unknown) => {
                requestLogger.error({ err: error }, "Could not obtain an agent actor token for the OBO callback");

                return undefined;
            });

            await handleOboCallback(url, response, agentActorToken);

            return;
        }

        if (url.pathname === "/obo/authorize-url") {
            await handleOboAuthorizeUrlRequest(request, response);

            return;
        }

        if (isWhatsAppEnabled && url.pathname === "/whatsapp/webhook") {
            if (request.method === "GET") {
                handleWhatsAppVerification(url, response);

                return;
            }

            if (request.method === "POST") {
                await handleWhatsAppWebhook(request, response, getAutonomousRuntime, requestLogger);

                return;
            }

            writeHttpJson(response, 405, { error: "Method not allowed" });

            return;
        }

        if (url.pathname === "/health") {
            writeHttpJson(response, 200, {
                status: "ok",
                features: {
                    enterpriseTravelTools: true,
                    autonomousOrganizationToken: autonomousRuntimePromises.size > 0 ? "initialized" : "lazy",
                },
            });

            return;
        }

        writeHttpJson(response, 404, { error: "Not found" });
    });

    const handleConnection = (socket: Duplex, authenticatedOrgId: string) => {
        const connectionId = randomUUID();
        const connectionLogger = logger.child({ connectionId });
        const reply = makeSocketReply(socket);
        let isClosed = false;

        connectionLogger.info("WebSocket client connected");

        socket.on("close", () => {
            isClosed = true;
            connectionLogger.info("WebSocket client closed connection");
        });

        socket.on("end", () => {
            isClosed = true;
        });

        socket.on("error", (error) => {
            isClosed = true;
            connectionLogger.warn({ err: error }, "WebSocket client disconnected");
        });

        sendJson(socket, {
            type: "ready",
            message: "Connected to the Wayfinder Enterprise AI agent.",
        });

        let queue = Promise.resolve();
        let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

        socket.on("data", (data) => {
            buffer = Buffer.concat([buffer, data]);

            try {
                let parsed = parseWebSocketFrame(buffer);

                while (parsed) {
                    buffer = parsed.remaining;

                    if (parsed.frame.opcode === 0x8) {
                        closeWebSocket(socket);

                        return;
                    }

                    if (parsed.frame.opcode === 0x9) {
                        writeFrame(socket, encodeWebSocketFrame(parsed.frame.payload.toString(), 0xA));
                    }

                    if (parsed.frame.opcode === 0x1) {
                        const payload = parsed.frame.payload.toString("utf8");

                        queue = queue.then(async () => {
                            if (isClosed) {
                                return;
                            }

                            const parsedChatRequest = parseChatRequest(payload);
                            const chatRequest: ParsedChatRequest = {
                                ...parsedChatRequest,
                                orgId: authenticatedOrgId,
                            };
                            const messageLogger = connectionLogger.child({
                                messageCount: chatRequest.messages.length,
                            });

                            await handleChatTurn({
                                chatRequest,
                                orgId: authenticatedOrgId,
                                reply,
                                isCancelled: () => isClosed,
                                markCancelled: () => {
                                    isClosed = true;
                                },
                                getAutonomousRuntime,
                                logger: messageLogger,
                            });
                        }).catch((error: unknown) => {
                            if (isClosed) {
                                return;
                            }

                            connectionLogger.error({ err: error }, "Error handling chat message");
                            sendJson(socket, {
                                type: "error",
                                message: error instanceof Error ? error.message : "Failed to process chat message.",
                            });
                        });
                    }

                    parsed = parseWebSocketFrame(buffer);
                }
            } catch (error) {
                connectionLogger.error({ err: error }, "Error parsing WebSocket frame");
                sendJson(socket, {
                    type: "error",
                    message: error instanceof Error ? error.message : "Invalid WebSocket message.",
                });
                closeWebSocket(socket);
            }
        });
    };

    server.on("upgrade", (request, socket, head) => {
        socket.on("error", (error) => {
            logger.warn({ err: error }, "WebSocket upgrade socket error");
        });

        try {
            const url = new URL(request.url || "", `http://${request.headers.host || host}`);
            const key = request.headers["sec-websocket-key"];

            if (url.pathname !== "/chat" || typeof key !== "string") {
                if (!socket.destroyed && !socket.writableEnded) {
                    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                }
                socket.destroy();

                return;
            }

            const callerToken = getBearerToken(request.headers.authorization)
                || getWebSocketProtocolToken(request.headers["sec-websocket-protocol"]);
            const authenticatedOrgId = getTokenOrganizationId(callerToken);

            if (!callerToken || !authenticatedOrgId) {
                if (!socket.destroyed && !socket.writableEnded) {
                    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                }
                socket.destroy();

                return;
            }

            writeFrame(socket, Buffer.from([
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${createWebSocketAcceptKey(key)}`,
                "Sec-WebSocket-Protocol: bearer",
                "",
                "",
            ].join("\r\n")));

            if (head.length > 0) {
                socket.unshift(head);
            }

            handleConnection(socket, authenticatedOrgId);
        } catch (error) {
            logger.error({ err: error }, "Error upgrading WebSocket connection");
            socket.destroy();
        }
    });

    server.listen(port, host, () => {
        logger.info({
            chatUrl: `ws://${host}:${port}/chat`,
            healthUrl: `http://${host}:${port}/health`,
        }, "AI agent started");
    });

    const shutdown = async () => {
        logger.info("Shutting down AI agent");
        server.close();
        for (const autonomousRuntimePromise of autonomousRuntimePromises.values()) {
            try {
                const entry = await autonomousRuntimePromise;

                await entry.runtime.client.close();
            } catch (error: unknown) {
                logger.warn({ err: error }, "Failed to close an MCP client during shutdown");
            }
        }
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

runAgentServer().catch((error: unknown) => {
    logger.fatal({ err: error }, "AI agent failed to start");
    process.exit(1);
});
