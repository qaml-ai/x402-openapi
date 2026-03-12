/**
 * x402-openapi: Single source of truth for x402 route definitions.
 *
 * Define your routes once → get paymentMiddleware config + describeRoute middleware + OpenAPI spec.
 *
 * Usage:
 *   const routes = x402Routes({
 *     "GET /generate": {
 *       price: "$0.001",
 *       description: "Generate a QR code",
 *       mimeType: "image/svg+xml",
 *       query: {
 *         text: { type: "string", description: "Text to encode", required: true },
 *         size: { type: "integer", description: "Size in pixels" },
 *       },
 *       responses: {
 *         200: { description: "SVG image", content: { "image/svg+xml": {} } },
 *       },
 *     },
 *   });
 *
 *   // Payment middleware (auto-generates Bazaar inputSchema)
 *   app.use(paymentMiddleware(routes.paymentConfig(payTo), resourceServer));
 *
 *   // Route middleware (auto-generates OpenAPI description)
 *   app.get("/generate", routes.describe("GET /generate"), handler);
 *
 *   // OpenAPI spec endpoint
 *   app.get("/.well-known/openapi.json", routes.openapi(app, { title, server }));
 */

import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import type { Hono } from "hono";

// --- Types ---

interface FieldDef {
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

interface ResponseDef {
  description: string;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

interface RouteDef {
  price: string;
  description: string;
  mimeType?: string;
  query?: Record<string, FieldDef>;
  body?: Record<string, FieldDef>;
  path?: Record<string, FieldDef>;
  responses?: Record<number, ResponseDef>;
}

type RouteMap = Record<string, RouteDef>;

interface OpenAPIOptions {
  title: string;
  description?: string;
  server: string;
  version?: string;
}

// --- Field conversion helpers ---

function fieldsToOpenAPIParams(
  fields: Record<string, FieldDef>,
  location: "query" | "path"
) {
  return Object.entries(fields).map(([name, def]) => ({
    name,
    in: location,
    required: def.required ?? (location === "path"),
    description: def.description,
    schema: {
      type: def.type,
      ...(def.default !== undefined && { default: def.default }),
      ...(def.enum && { enum: def.enum }),
      ...(def.minimum !== undefined && { minimum: def.minimum }),
      ...(def.maximum !== undefined && { maximum: def.maximum }),
    },
  }));
}

function fieldsToBazaarSchema(fields: Record<string, FieldDef>) {
  const out: Record<string, { type: string; description?: string; required?: boolean }> = {};
  for (const [name, def] of Object.entries(fields)) {
    out[name] = {
      type: def.type,
      ...(def.description && { description: def.description }),
      ...(def.required !== undefined && { required: def.required }),
    };
  }
  return out;
}

function fieldsToJsonSchema(fields: Record<string, FieldDef>) {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const [name, def] of Object.entries(fields)) {
    properties[name] = {
      type: def.type,
      ...(def.description && { description: def.description }),
      ...(def.default !== undefined && { default: def.default }),
      ...(def.enum && { enum: def.enum }),
      ...(def.minimum !== undefined && { minimum: def.minimum }),
      ...(def.maximum !== undefined && { maximum: def.maximum }),
    };
    if (def.required) required.push(name);
  }

  return {
    type: "object" as const,
    properties,
    ...(required.length > 0 && { required }),
  };
}

// --- Main API ---

export function x402Routes(routes: RouteMap) {
  return {
    /**
     * Generate paymentMiddleware config with Bazaar inputSchema derived from route definitions.
     */
    paymentConfig(payTo: string, network = "eip155:8453") {
      const config: Record<string, any> = {};

      for (const [key, def] of Object.entries(routes)) {
        const bazaarInputSchema: Record<string, any> = {};
        if (def.query) bazaarInputSchema.queryParams = fieldsToBazaarSchema(def.query);
        if (def.body) bazaarInputSchema.bodyFields = fieldsToBazaarSchema(def.body);
        if (def.path) bazaarInputSchema.pathFields = fieldsToBazaarSchema(def.path);

        config[key] = {
          accepts: [
            {
              scheme: "exact",
              price: def.price,
              network,
              payTo: payTo as `0x${string}`,
            },
          ],
          description: def.description,
          ...(def.mimeType && { mimeType: def.mimeType }),
          extensions: {
            bazaar: {
              discoverable: true,
              openApiUrl: "/.well-known/openapi.json",
              ...(Object.keys(bazaarInputSchema).length > 0 && {
                inputSchema: bazaarInputSchema,
              }),
            },
          },
        };
      }

      return config;
    },

    /**
     * Get describeRoute middleware for a specific route key (e.g. "GET /generate").
     * Auto-generates OpenAPI parameters, requestBody, and responses from the route definition.
     */
    describe(routeKey: string) {
      const def = routes[routeKey];
      if (!def) throw new Error(`Unknown route: ${routeKey}`);

      const parameters: any[] = [];
      if (def.query) parameters.push(...fieldsToOpenAPIParams(def.query, "query"));
      if (def.path) parameters.push(...fieldsToOpenAPIParams(def.path, "path"));

      const responses: Record<string, any> = {};

      // Add defined responses
      if (def.responses) {
        for (const [code, resp] of Object.entries(def.responses)) {
          responses[code] = resp;
        }
      }

      // Always add 402 for paid routes
      if (!responses["402"]) {
        responses["402"] = { description: "Payment required (x402)" };
      }

      // Build requestBody for body fields
      let requestBody: any = undefined;
      if (def.body) {
        requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: fieldsToJsonSchema(def.body),
            },
          },
        };
      }

      return describeRoute({
        description: `${def.description} (${def.price} via x402)`,
        ...(parameters.length > 0 && { parameters }),
        ...(requestBody && { requestBody }),
        responses,
      });
    },

    /**
     * Get the OpenAPI route handler for serving the spec at /.well-known/openapi.json
     */
    openapi(app: Hono<any, any, any>, opts: OpenAPIOptions) {
      return openAPIRouteHandler(app, {
        documentation: {
          info: {
            title: opts.title,
            description: (opts.description || opts.title) + ". Pay-per-use via x402 protocol on Base mainnet.",
            version: opts.version || "1.0.0",
          },
          servers: [{ url: `https://${opts.server}` }],
        },
      });
    },
  };
}
