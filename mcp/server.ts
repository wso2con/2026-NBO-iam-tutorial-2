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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ansiColor, createLogger } from "./logger.js";
import {
    getRolesFromPermissions,
    Scope,
    UserRole,
} from "../webapp/app/lib/auth/utils.js";
import type { TravelPolicy } from "../webapp/app/lib/db/queries/travel-policies.js";

let requestCounter = 0;

const logger = createLogger({ service: "mcp-server" });

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath: string) {
    if (!existsSync(filePath)) {
        return;
    }

    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (!trimmedLine || trimmedLine.startsWith("#")) {
            continue;
        }

        const separatorIndex = trimmedLine.indexOf("=");

        if (separatorIndex <= 0) {
            continue;
        }

        const key = trimmedLine.slice(0, separatorIndex).trim();
        const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
        const value = rawValue.replace(/^\s*["']|["']\s*$/g, "");

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

const webappDir = resolve(__dirname, "../webapp");

loadEnvFile(resolve(__dirname, ".env"));
loadEnvFile(resolve(webappDir, ".env.local"));

if (!process.env.DB_PATH) {
    process.env.DB_PATH = resolve(webappDir, "data", "app.db");
}

// app/lib/db/connection.ts resolves its schema path relative to process.cwd(),
// so the webapp's working directory has to be active before that module loads.
process.chdir(webappDir);

const port = Number(process.env.PORT || process.env.MCP_PORT || 8001);
const host = process.env.HOST || "localhost";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

async function importWebappModule<T>(relativePath: string): Promise<T> {
    return import(pathToFileURL(resolve(webappDir, relativePath)).href) as Promise<T>;
}

const { getTravelPolicy, upsertTravelPolicy } = await importWebappModule<
    typeof import("../webapp/app/lib/db/queries/travel-policies.js")
>("app/lib/db/queries/travel-policies.ts");

const { listFlights, getFlightById } = await importWebappModule<
    typeof import("../webapp/app/lib/db/queries/flights.js")
>("app/lib/db/queries/flights.ts");

const { listOrgBookings, listMyOrgBookings, findDuplicateOrgBooking, createOrgBooking } = await importWebappModule<
    typeof import("../webapp/app/lib/db/queries/bookings.js")
>("app/lib/db/queries/bookings.ts");

interface TokenClaims {
    orgId: string;
    scopes: string[];
    sub: string;
    roles: string[];
}

class AuthError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
    ) {
        super(message);
        this.name = "AuthError";
    }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
    if (!jwks) {
        // NEXT_PUBLIC_BASE_URL is the name the webapp uses (see app/lib/auth/guard.ts);
        // NEXT_PUBLIC_ASGARDEO_BASE_URL is kept as a fallback for existing setups.
        const baseUrl = (
            process.env.NEXT_PUBLIC_BASE_URL
            || process.env.NEXT_PUBLIC_ASGARDEO_BASE_URL
            || ""
        ).replace(/\/$/, "");

        if (!baseUrl) {
            throw new Error(
                "NEXT_PUBLIC_BASE_URL is not set, so access tokens cannot be verified. "
                + "Set it in mcp/.env or webapp/.env.local."
            );
        }

        jwks = createRemoteJWKSet(new URL(`${baseUrl}/oauth2/jwks`));
    }

    return jwks;
}

// Mirrors webapp/app/lib/auth/guard.ts requireAuth/requireScope, since calling
// the service functions directly skips the route handlers that normally do this.
async function verifyClaims(authorization?: string): Promise<TokenClaims> {
    const token = getBearerToken(authorization);

    if (!token) {
        throw new AuthError("Missing authorization token.", 401);
    }

    let payload;

    try {
        ({ payload } = await jwtVerify(token, getJwks()));
    } catch (error) {
        // Log the underlying reason: signature, issuer, expiry and JWKS-fetch
        // failures all surface to the client as the same generic 401.
        logger.warn(
            `Token verification failed: ${error instanceof Error ? error.message : String(error)}`
        );
        throw new AuthError("Invalid or expired token.", 401);
    }

    const orgId = typeof payload.org_id === "string" ? payload.org_id : "";

    if (!orgId) {
        throw new AuthError("Token is missing org_id claim.", 401);
    }

    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    const rawRoles = payload.roles;
    const roles = Array.isArray(rawRoles)
        ? (rawRoles as unknown[]).map(String)
        : typeof rawRoles === "string" && rawRoles.length > 0
        ? [rawRoles]
        : [];

    return { orgId, scopes, sub, roles };
}

type ScopePolicy = "any" | "all";

function requireScope(claims: TokenClaims, requiredScopes: string[], policy: ScopePolicy = "any") {
    const check = policy === "all"
        ? requiredScopes.every((s) => claims.scopes.includes(s))
        : requiredScopes.some((s) => claims.scopes.includes(s));

    if (!check) {
        logger.warn(
            `Scope check failed: required ${policy} of [${requiredScopes.join(", ")}], `
            + `token has [${claims.scopes.join(", ")}]`
        );
        throw new AuthError("Insufficient permissions.", 403);
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

function getBearerToken(authorization?: string) {
    return authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function getAuthorizationHeader(request: IncomingMessage): string | undefined {
    const authorization = request.headers.authorization;

    return Array.isArray(authorization) ? authorization[0] : authorization;
}

function generateBookingReference(): string {
    return randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

function toToolContent(data: unknown) {
    return {
        content: [
            {
                type: "text" as const,
                text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
            },
        ],
    };
}

function getFailureMessage(error: unknown) {
    return error instanceof Error ? error.message : "The booking request failed.";
}

function toBookingFailureToolContent(error: unknown) {
    const message = getFailureMessage(error);
    const insufficientPermissions = /insufficient permissions/i.test(message);

    return toToolContent({
        authorizationRequired: insufficientPermissions,
        error: message,
        errorCode: insufficientPermissions ? "insufficient_permissions" : "booking_failed",
        message: insufficientPermissions
            ? "Insufficient permissions. User authorization is required before creating this booking."
            : "The flight booking could not be created.",
        statusCode: error instanceof AuthError ? error.statusCode : 500,
        success: false,
    });
}

function createEnterpriseMcpServer(authorization?: string, reqId?: number) {
    const accessToken = getBearerToken(authorization);
    const tokenPayload = decodeJwtPayload(accessToken);

    let claimsPromise: Promise<TokenClaims> | null = null;

    function getClaims(): Promise<TokenClaims> {
        if (!claimsPromise) {
            claimsPromise = verifyClaims(authorization);
        }

        return claimsPromise;
    }

    const subClaim = typeof tokenPayload?.sub === "string" ? tokenPayload.sub : null;
    const actClaim = tokenPayload?.act ?? null;
    const actSubClaim = actClaim && typeof actClaim === "object" && typeof (actClaim as { sub?: unknown }).sub === "string"
        ? (actClaim as { sub: string }).sub
        : null;

    const tokenContext = {
        sub: subClaim ?? undefined,
        actSub: actSubClaim ?? undefined,
        org_id: typeof tokenPayload?.org_id === "string" ? tokenPayload.org_id : undefined,
        roles: Array.isArray(tokenPayload?.roles)
            ? tokenPayload.roles.map(String)
            : typeof tokenPayload?.roles === "string"
            ? [tokenPayload.roles]
            : [],
        hasAct: actClaim != null,
    };

    const mcpLogger = logger.child({ component: "mcp", reqId });
    const toolLogger = logger.child({ component: "tool", reqId });

    const tokenPayloadFields = tokenPayload
        ? Object.entries(tokenPayload).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join("\n")
        : "  none";

    mcpLogger.info(`access token payload:\n${tokenPayloadFields}`);
    mcpLogger.info({ ...tokenContext }, "creating MCP server instance");

    const server = new McpServer({
        name: "wayfinder-enterprise-mcp",
        version: "1.0.0",
    });

    function logToolAuthFailure(name: string, err: unknown, durationMs: number) {
        if (err instanceof AuthError && err.statusCode === 403) {
            toolLogger.warn(
                { tool: name, durationMs, statusCode: err.statusCode, actSub: actSubClaim, sub: subClaim, err: err.message },
                "denied: insufficient permissions",
            );

            return true;
        }

        return false;
    }

    async function runTool<T>(name: string, args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
        toolLogger.info({ tool: name, args }, "invoked");
        toolLogger.info(
            `calling ${name} by ${ansiColor.green(`{act: ${actSubClaim ? JSON.stringify(actSubClaim) : "null"}, sub: ${subClaim ?? "null"}}`)}`,
        );
        const t0 = Date.now();
        try {
            const result = await fn();
            toolLogger.info({ tool: name, durationMs: Date.now() - t0 }, "completed");
            return result;
        } catch (err) {
            const durationMs = Date.now() - t0;

            if (!logToolAuthFailure(name, err, durationMs)) {
                toolLogger.error({ tool: name, durationMs, err }, "failed");
            }

            throw err;
        }
    }

    server.tool(
        "get_travel_policy",
        "Get the active travel policy for the authenticated organization. Use this before answering travel-policy questions and before creating a flight booking.",
        {},
        () => runTool("get_travel_policy", {}, async () => {
            const claims = await getClaims();
            requireScope(claims, ["mcp:" + Scope.TRAVEL_POLICY_VIEW]);

            return toToolContent({ policy: getTravelPolicy(claims.orgId) });
        }),
    );

    server.tool(
        "update_travel_policy",
        "Update the active travel policy for the authenticated organization.",
        {
            domestic_cabin: z.enum(["Economy", "Premium Economy", "Business", "First Class"]).optional(),
            max_flight_price: z.number().int().min(0).max(100000).optional(),
            price_cap_percent: z.number().int().min(0).max(200).optional(),
        },
        (policy) => runTool("update_travel_policy", policy as Record<string, unknown>, async () => {
            const claims = await getClaims();
            requireScope(claims, ["mcp:" + Scope.TRAVEL_POLICY_UPDATE]);

            const defaults = getTravelPolicy(claims.orgId);
            const updated: Omit<TravelPolicy, "id" | "org_id" | "updated_at"> = {
                domestic_cabin: policy.domestic_cabin ?? defaults?.domestic_cabin ?? "Economy",
                max_flight_price: policy.max_flight_price ?? defaults?.max_flight_price ?? 500,
                price_cap_percent: policy.price_cap_percent ?? defaults?.price_cap_percent ?? 20,
            };

            return toToolContent({ policy: upsertTravelPolicy(claims.orgId, updated) });
        }),
    );

    server.tool(
        "search_enterprise_flights",
        "Search available flight options from the Wayfinder booking database.",
        {
            from: z.string().optional().describe("Origin city, for example Nairobi."),
            to: z.string().optional().describe("Destination city, for example Mombasa."),
            cabin: z.enum(["Economy", "Premium Economy", "Business", "First Class"]).optional(),
        },
        ({ from, to, cabin }) =>
            runTool("search_enterprise_flights", { from, to, cabin }, async () => {
                await getClaims();

                return toToolContent({ flights: listFlights({ from, to, cabin }) });
            }),
    );

    server.tool(
        "list_flight_bookings",
        "List flight bookings visible to the authenticated user.",
        {
            all: z.boolean().optional().describe("When true, admins can list all organization bookings."),
        },
        ({ all }) => runTool("list_flight_bookings", { all }, async () => {
            const claims = await getClaims();
            requireScope(claims, ["mcp:" + Scope.BOOKING_VIEW]);

            const isAdmin = getRolesFromPermissions(claims.roles).includes(UserRole.ADMIN);
            const bookings = isAdmin && all
                ? listOrgBookings(claims.orgId)
                : listMyOrgBookings(claims.orgId, claims.sub);

            return toToolContent({ bookings });
        }),
    );

    server.tool(
        "create_flight_booking",
        "Create a flight booking for the authenticated user. Only use after get_travel_policy has been called in the current turn and a single matching flight is clear.",
        {
            bookedByName: z.string().optional().describe("Display name of the user making the booking."),
            bookedForName: z.string().optional().describe("Display name of the traveler when an admin books for someone else."),
            bookedForUserId: z.string().optional().describe("User ID of the traveler when an admin books for someone else."),
            flightId: z.string().describe("The ID of the flight to book."),
            travelers: z.number().int().min(1).max(9).optional().describe("Number of travelers."),
        },
        ({ bookedByName, bookedForName, bookedForUserId, flightId, travelers }) =>
            runTool("create_flight_booking", { bookedForUserId, flightId, travelers }, async () => {
                const t0 = Date.now();

                try {
                    const claims = await getClaims();
                    requireScope(claims, ["mcp:" + Scope.BOOKING_CREATE]);

                    const isAdmin = getRolesFromPermissions(claims.roles).includes(UserRole.ADMIN);
                    const travelerCount = travelers ?? 1;

                    const flight = getFlightById(flightId);
                    if (!flight) {
                        throw new Error("Flight not found.");
                    }

                    const resolvedBookedForUserId = isAdmin && bookedForUserId ? bookedForUserId : null;
                    const resolvedBookedForName = isAdmin && bookedForName ? bookedForName : null;
                    const targetSub = resolvedBookedForUserId ?? claims.sub;

                    const duplicate = findDuplicateOrgBooking(claims.orgId, targetSub, flightId);
                    if (duplicate) {
                        throw new Error("This flight is already booked.");
                    }

                    const booking = createOrgBooking({
                        id: `booking-${randomUUID()}`,
                        orgId: claims.orgId,
                        bookingReference: generateBookingReference(),
                        bookedForUserId: resolvedBookedForUserId,
                        bookedForName: resolvedBookedForName,
                        bookedBySub: claims.sub,
                        bookedByName: bookedByName ?? "AI-assisted user",
                        flightId,
                        travelers: travelerCount,
                        bookingPrice: flight.price * travelerCount,
                    });

                    return toToolContent({
                        data: { booking },
                        message: "Flight booking created successfully.",
                        success: true,
                    });
                } catch (error) {
                    logToolAuthFailure("create_flight_booking", error, Date.now() - t0);

                    return toBookingFailureToolContent(error);
                }
            }),
    );

    return server;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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

function sendJson(response: ServerResponse, statusCode: number, body: JsonValue) {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}

const httpLogger = logger.child({ component: "http" });

const httpServer = createServer(async (request, response) => {
    const reqId = ++requestCounter;
    const remoteAddr = request.socket.remoteAddress;
    const reqLogger = httpLogger.child({ reqId });

    reqLogger.info({ method: request.method, url: request.url, remoteAddr }, "incoming request");

    if (request.url === "/health") {
        sendJson(response, 200, { status: "ok" });
        reqLogger.debug("health check");

        return;
    }

    if (request.url !== "/mcp") {
        reqLogger.warn({ url: request.url }, "unknown route");
        sendJson(response, 404, { error: "Not found" });

        return;
    }

    if (request.method !== "POST") {
        reqLogger.warn({ method: request.method }, "method not allowed");
        sendJson(response, 405, { error: "Method not allowed" });

        return;
    }

    try {
        const server = createEnterpriseMcpServer(getAuthorizationHeader(request), reqId);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });
        const body = await readJsonBody(request);

        reqLogger.debug("connecting transport");

        response.on("close", () => {
            reqLogger.info("connection closed");
            transport.close();
        });

        await server.connect(transport);
        await transport.handleRequest(request, response, body);
    } catch (error) {
        reqLogger.error({ err: error }, "unhandled error");

        if (!response.headersSent) {
            sendJson(response, 500, {
                error: error instanceof Error ? error.message : "Failed to handle MCP request.",
            });
        }
    }
});

httpServer.listen(port, host, () => {
    logger.info({ url: `http://${host}:${port}/mcp` }, "MCP server listening");
    logger.info({ url: `http://${host}:${port}/health` }, "health check available");
});
