import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { PostmanParam, PostmanRequest } from '../../../config/types';

/**
 * Personalize has no Postman collection — same as Lytics, it publishes a
 * live OpenAPI 3.0 spec instead (confirmed: GET /openapi returns real JSON).
 * This fetches + flattens it into the same PostmanRequest[] shape the other
 * comparators consume, so comparePersonalize.ts can reuse the identical
 * matching/diff logic as compareLytics.ts.
 */
export async function fetchPersonalizeOpenApiSpec(baseHost: string, cacheFilename = 'openapi-spec-personalize.json'): Promise<any> {
  const cachePath = path.join(__dirname, '../../../reports', cacheFilename);
  try {
    const res = await axios.get(`https://${baseHost}/openapi`, { timeout: 15_000 });
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(res.data, null, 2));
    return res.data;
  } catch (err) {
    if (fs.existsSync(cachePath)) {
      console.warn('⚠️  Using cached Personalize OpenAPI spec (live fetch failed)');
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
    throw new Error(`OpenAPI spec unavailable at https://${baseHost}/openapi: ${(err as Error).message}`);
  }
}

function resolveSchema(spec: any, schema: any): any {
  if (!schema) return undefined;
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    return spec.components?.schemas?.[name];
  }
  if (schema.allOf) {
    return schema.allOf.map((s: any) => resolveSchema(spec, s)).reduce((acc: any, s: any) => ({ ...acc, ...s }), {});
  }
  return schema;
}

/** Flattens every path/method in the spec into PostmanRequest[], matched to the doc's own "summary" field (confirmed to match the doc's request names, same convention as Lytics). */
export function parseSwaggerRequests(spec: any): PostmanRequest[] {
  const requests: PostmanRequest[] = [];

  for (const [urlPath, methods] of Object.entries<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(methods)) {
      const name: string = op.summary ?? `${method.toUpperCase()} ${urlPath}`;

      const headerParams: PostmanParam[] = (op.parameters ?? [])
        .filter((p: any) => p.in === 'header')
        .map((p: any) => ({ key: p.name, value: '', description: p.description, disabled: false }));

      const queryParams: PostmanParam[] = (op.parameters ?? [])
        .filter((p: any) => p.in === 'query')
        .map((p: any) => ({ key: p.name, value: '', description: p.description, disabled: false }));

      let body: PostmanRequest['body'];
      const bodySchemaRaw = op.requestBody?.content?.['application/json']?.schema;
      const bodySchema = resolveSchema(spec, bodySchemaRaw);
      if (bodySchema?.properties) {
        const example: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries<any>(bodySchema.properties)) {
          example[propName] = propSchema.example ?? (propSchema.type === 'array' ? [] : propSchema.type === 'object' ? {} : 'string');
        }
        body = { mode: 'raw', raw: JSON.stringify(example) };
      }

      requests.push({
        name,
        method: method.toUpperCase(),
        url: `${urlPath}`,
        params: queryParams,
        headers: headerParams,
        body,
      });
    }
  }

  return requests;
}
