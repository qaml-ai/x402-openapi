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
        const [method] = key.split(" ");
        const isBodyMethod = ["POST", "PUT", "PATCH"].includes(method);

        // Build bazaar info.input in official @x402/extensions format
        const input: Record<string, any> = { type: "http", method };
        if (def.query) input.queryParams = fieldsToBazaarSchema(def.query);
        if (def.body && isBodyMethod) {
          input.bodyType = "json";
          input.body = fieldsToBazaarSchema(def.body);
        }

        // Build bazaar schema in official format
        const inputSchemaProps: Record<string, any> = {
          type: { type: "string", const: "http" },
          method: { type: "string", enum: [method] },
        };
        if (def.query) {
          inputSchemaProps.queryParams = {
            type: "object",
            ...fieldsToJsonSchema(def.query),
          };
        }
        if (def.body && isBodyMethod) {
          inputSchemaProps.bodyType = { type: "string", enum: ["json"] };
          inputSchemaProps.body = {
            type: "object",
            ...fieldsToJsonSchema(def.body),
          };
        }

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
              info: {
                input,
                output: { type: def.mimeType?.includes("json") ? "json" : "raw" },
              },
              schema: {
                properties: {
                  input: {
                    properties: {
                      method: { type: "string", enum: [method] },
                    },
                    required: ["method"],
                  },
                },
              },
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

/**
 * Derive an OpenAPI spec from an existing cdpPaymentMiddleware config.
 *
 * Usage:
 *   import { openapiFromMiddleware } from "x402-openapi";
 *
 *   const PAYMENT_CONFIG = { "POST /": { ... } };
 *   app.use(cdpPaymentMiddleware((env) => PAYMENT_CONFIG));
 *   app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 QR Code", "qr.camelai.io", PAYMENT_CONFIG));
 */
export function openapiFromMiddleware(
  title: string,
  domain: string,
  config: Record<string, any>
) {
  const paths: Record<string, any> = {};

  for (const [key, def] of Object.entries(config)) {
    const [method, ...pathParts] = key.split(" ");
    const path = pathParts.join(" ") || "/";
    const httpMethod = method.toLowerCase();

    const price = def.accepts?.[0]?.price || "unknown";
    const description = def.description || title;
    const bazaarInput = def.extensions?.bazaar?.info?.input;
    const responseMime = def.mimeType || "application/json";

    const operation: Record<string, any> = {
      summary: description,
      description: `${description}. Requires x402 payment (${price} USDC on Base).`,
      responses: {
        "200": { description: "Success", content: { [responseMime]: {} } },
        "402": { description: "Payment Required — sign a USDC payment on Base and resend with the payment header" },
        "400": { description: "Bad request" },
      },
    };

    if (bazaarInput?.body && ["post", "put", "patch"].includes(httpMethod)) {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [field, fieldDef] of Object.entries(bazaarInput.body) as [string, any][]) {
        properties[field] = { type: fieldDef.type || "string" };
        if (fieldDef.description) properties[field].description = fieldDef.description;
        if (fieldDef.required) required.push(field);
      }
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", properties, ...(required.length > 0 && { required }) },
          },
        },
      };
    }

    if (!paths[path]) paths[path] = {};
    paths[path][httpMethod] = operation;
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title,
      version: "1.0.0",
      "x-pricing": { currency: "USDC", network: "Base (eip155:8453)" },
    },
    servers: [{ url: `https://${domain}` }],
    paths,
  };

  return (c: any) => c.json(spec);
}
