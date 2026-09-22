import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveAgentAccent, resolveAgentName } from "../../lib/auth/agents";
import { requireScope } from "../../lib/auth/guard";
import { getRolesFromPermissions, Scope, UserRole } from "../../lib/auth/utils";
import { logRequestActor } from "../../lib/auth/log";
import {
  createOrgBooking,
  findDuplicateOrgBooking,
  listMyOrgBookings,
  listOrgBookings,
} from "../../lib/db/queries/bookings";
import { getFlightById } from "../../lib/db/queries/flights";

function generateReference(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

export async function GET(request: NextRequest) {
  logRequestActor("bookings", request);
  const auth = await requireScope(request, [Scope.BOOKING_VIEW]);
  if (auth instanceof NextResponse) return auth;

  const { orgId, sub, roles } = auth.claims;
  const isAdmin = getRolesFromPermissions(roles).includes(UserRole.ADMIN);
  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all") === "true";

  const rows = isAdmin && all
    ? listOrgBookings(orgId)
    : listMyOrgBookings(orgId, sub);

  // The agent's name and accent are resolved here rather than taken from the row, so
  // renaming or recolouring an agent in the environment applies to past bookings too.
  // booked_by_agent_name stays as the write-time snapshot the row was created with.
  const bookings = rows.map((row) => ({
    ...row,
    booked_by_agent_name: resolveAgentName(row.booked_by_agent_id) ?? row.booked_by_agent_name,
    booked_by_agent_accent: resolveAgentAccent(row.booked_by_agent_id),
  }));

  return NextResponse.json({ bookings });
}

export async function POST(request: NextRequest) {
  logRequestActor("bookings", request);
  const auth = await requireScope(request, [Scope.BOOKING_CREATE]);
  if (auth instanceof NextResponse) return auth;

  const { orgId, sub, roles, actSub } = auth.claims;
  const isAdmin = getRolesFromPermissions(roles).includes(UserRole.ADMIN);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const flightId = String(body.flightId ?? "").trim();
  const travelers = Number(body.travelers ?? 1);
  const bookedForUserId = isAdmin && body.bookedForUserId ? String(body.bookedForUserId).trim() : null;
  const bookedForName = isAdmin && body.bookedForName ? String(body.bookedForName).trim() : null;
  const bookedByName = String(body.bookedByName ?? "").trim() || "User";

  if (!flightId) {
    return NextResponse.json({ error: "flightId is required." }, { status: 400 });
  }

  if (!Number.isInteger(travelers) || travelers < 1 || travelers > 9) {
    return NextResponse.json({ error: "travelers must be between 1 and 9." }, { status: 400 });
  }

  const flight = getFlightById(flightId);
  if (!flight) {
    return NextResponse.json({ error: "Flight not found." }, { status: 404 });
  }

  const targetSub = bookedForUserId ?? sub;
  const duplicate = findDuplicateOrgBooking(orgId, targetSub, flightId);
  if (duplicate) {
    return NextResponse.json({ error: "This flight is already booked." }, { status: 409 });
  }

  const booking = createOrgBooking({
    id: `booking-${randomUUID()}`,
    orgId,
    bookingReference: generateReference(),
    bookedForUserId,
    bookedForName,
    bookedBySub: sub,
    bookedByName,
    // Normally null here — the web UI calls this with a plain user token — but an
    // agent calling the REST API directly gets attributed the same way as the MCP path.
    bookedByAgentId: actSub ?? null,
    bookedByAgentName: resolveAgentName(actSub ?? null),
    flightId,
    travelers,
    bookingPrice: flight.price * travelers,
  });

  return NextResponse.json({ booking }, { status: 201 });
}
