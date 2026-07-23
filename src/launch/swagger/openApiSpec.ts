import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { PostmanParam, PostmanRequest } from '../../../config/types';

/**
 * Launch has no Postman collection — same as Lytics/Personalize, it
 * publishes a live OpenAPI 3.0 spec instead. This fetches + flattens it into
 * the same PostmanRequest[] shape the other comparators consume.
 */
export async function fetchLaunchOpenApiSpec(baseHost: string, cacheFilename = 'openapi-spec-launch.json'): Promise<any> {
  const cachePath = path.join(__dirname, '../../../reports', cacheFilename);
  try {
    const res = await axios.get(`https://${baseHost}/openapi`, { timeout: 15_000 });
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(res.data, null, 2));
    return res.data;
  } catch (err) {
    if (fs.existsSync(cachePath)) {
      console.warn('⚠️  Using cached Launch OpenAPI spec (live fetch failed)');
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
    throw new Error(`OpenAPI spec unavailable at https://${baseHost}/openapi: ${(err as Error).message}`);
  }
}

/** Flattens every path/method in the spec into PostmanRequest[], matched to the doc's own "summary" field. */
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
      const bodyContent = op.requestBody?.content?.['application/json'];
      const firstExample = bodyContent?.examples ? Object.values<any>(bodyContent.examples)[0]?.value : bodyContent?.example;
      if (firstExample !== undefined) {
        body = { mode: 'raw', raw: JSON.stringify(firstExample) };
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
