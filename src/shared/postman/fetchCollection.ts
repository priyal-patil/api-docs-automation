import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { PostmanRequest, PostmanParam } from '../../../config/types';

dotenv.config();

const POSTMAN_API_KEY = process.env.POSTMAN_API_KEY ?? '';
const POSTMAN_CDA_COLLECTION_ID = process.env.POSTMAN_CDA_COLLECTION_ID ?? '';

interface PostmanItem {
  name: string;
  request?: {
    method: string;
    url: { raw: string; query?: PostmanParam[]; path?: string[] };
    header?: PostmanParam[];
    body?: { mode: string; raw?: string; formdata?: PostmanParam[] };
  };
  item?: PostmanItem[]; // folders
}

/**
 * Fetches the Postman collection via Postman REST API and
 * flattens all requests into a normalised list.
 */
export async function fetchPostmanCollection(collectionId?: string, outputFilename?: string): Promise<PostmanRequest[]> {
  const id = collectionId ?? POSTMAN_CDA_COLLECTION_ID;

  if (!POSTMAN_API_KEY || !id) {
    throw new Error('POSTMAN_API_KEY and POSTMAN_CDA_COLLECTION_ID must be set in .env');
  }

  console.log(`📮  Fetching Postman collection: ${id}`);

  const response = await axios.get(
    `https://api.getpostman.com/collections/${id}`,
    { headers: { 'X-Api-Key': POSTMAN_API_KEY } }
  );

  const collection = response.data.collection;
  const requests: PostmanRequest[] = [];

  function flatten(items: PostmanItem[]) {
    for (const item of items) {
      if (item.item) {
        flatten(item.item); // recurse into folders
        continue;
      }
      if (!item.request) continue;

      const req = item.request;
      const url = typeof req.url === 'string' ? req.url : req.url?.raw ?? '';

      requests.push({
        name: item.name,
        method: req.method?.toUpperCase() ?? 'GET',
        url,
        params: (req.url as any)?.query ?? [],
        headers: req.header ?? [],
        body: req.body,
      });
    }
  }

  flatten(collection.item ?? []);

  // Cache to disk for offline use / debugging
  const filename = outputFilename ?? 'postman-collection.json';
  const outPath = path.join(__dirname, '../../../reports', filename);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(requests, null, 2));
  console.log(`✅  Fetched ${requests.length} Postman requests → ${outPath}`);

  return requests;
}
